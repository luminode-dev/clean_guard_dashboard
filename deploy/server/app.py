"""Clean Guard 수집·조회 API (FastAPI)

역할
- 젯슨 → 서버: 이벤트 / 회수 후속 / 미디어 업로드 / 하트비트 / 썸네일 (Bearer 장비 토큰, device-tokens.txt)
- 대시보드 → 서버: 조회·처리 API + /ws/events 실시간 (Basic Auth, settings.json 의 dashboard 계정)
- 저장: SQLite events.db, 파일은 snapshots/ (Caddy 가 /snapshots/* 로 공개)

계약: jetson_handoff.md §3, jetson_data.md v0.1. 대시보드 어댑터(server-api.js)가 그대로 소비하는 응답 형태를 냅니다.
실행: uvicorn app:app --host 127.0.0.1 --port 8010  (run-app.cmd 참고)
"""
from __future__ import annotations

import asyncio
import base64
import csv
import io
import json
import os
import re
import secrets
import shutil
import sqlite3
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

BASE = Path(os.environ.get("CLEAN_GUARD_HOME") or Path(__file__).resolve().parent)
DB_PATH = BASE / "events.db"
SNAP_DIR = BASE / "snapshots"
SETTINGS_PATH = BASE / "settings.json"
TOKENS_PATH = BASE / "device-tokens.txt"
KST = timezone(timedelta(hours=9))
REALM = 'Basic realm="Clean Guard"'
STATES = ["new", "reviewing", "confirmed", "actioned", "dismissed"]
TRANSITIONS = {"new": ["reviewing", "dismissed"], "reviewing": ["confirmed", "dismissed"], "confirmed": ["actioned"]}
OFFLINE_AFTER_S = 90

DEFAULT_SETTINGS = {
    "dashboard_user": "admin",
    "dashboard_pass": "",  # settings.json 에서 반드시 설정. 비어 있으면 대시보드 API 로그인 불가

    "public_base": "https://cleanguard.duckdns.org",
    "live_base": "https://live.cleanguard.duckdns.org",
    "live_protocol": "webrtc",
    # 보존 규칙: 서버는 사건 증거(스냅샷·클립)만 저장하고 상시 녹화는 하지 않는다.
    # 사건 수가 max_events 를 넘으면 먼저 들어온 사건(received_at 순)부터 DB 행과 미디어 폴더를 함께 삭제한다.
    "max_events": 1000,
    "sites": [{"site_id": "SITE-GN-0001", "name": "현장 1 (site01)", "address": "", "location": None, "region": {"sido": "", "sigungu": "", "dong": "", "code": ""}}],
    "devices": [{"device_id": "JT-GN-0001", "site_id": "SITE-GN-0001", "name": "젯슨 1호기 (jetson01 · cam1)", "stream": "site01_cam1", "hw": {"model": "Jetson Orin Nano 8GB"}}],
}


def load_settings() -> dict:
    s = dict(DEFAULT_SETTINGS)
    if SETTINGS_PATH.exists():
        s.update(json.loads(SETTINGS_PATH.read_text(encoding="utf-8")))
    return s


def load_tokens() -> dict[str, str]:
    tokens: dict[str, str] = {}
    if TOKENS_PATH.exists():
        for line in TOKENS_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            tokens[v.strip()] = k.strip()  # token -> device_id
    return tokens


SETTINGS = load_settings()


# ---------------------------------------------------------------- 시간 유틸
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if dt else None


def parse_ts(v: Any) -> datetime:
    if v is None or v == "":
        return now_utc()
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000 if v > 1e12 else v, tz=timezone.utc)
    s = str(v).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, f"시각 형식이 올바르지 않습니다: {v}")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=KST)  # 오프셋 없는 장치 시각은 KST 로 간주
    return dt.astimezone(timezone.utc)


def kst_day(ts: str) -> str:
    return parse_ts(ts).astimezone(KST).strftime("%Y-%m-%d")


def kst_hour(ts: str) -> int:
    return parse_ts(ts).astimezone(KST).hour


# ---------------------------------------------------------------- DB
_db_lock = threading.Lock()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sites (site_id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, data TEXT NOT NULL, maintenance INTEGER DEFAULT 0, previous_status TEXT);
            CREATE TABLE IF NOT EXISTS heartbeats (device_id TEXT, ts TEXT, received_at TEXT, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS ix_hb ON heartbeats(device_id, received_at);
            CREATE TABLE IF NOT EXISTS events (
                event_id TEXT PRIMARY KEY, device_id TEXT, site_id TEXT, ts TEXT, received_at TEXT, day TEXT,
                state TEXT DEFAULT 'new', version INTEGER DEFAULT 0, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS ix_ev_ts ON events(ts);
            CREATE INDEX IF NOT EXISTS ix_ev_day ON events(day);
            CREATE TABLE IF NOT EXISTS alerts (alert_id TEXT PRIMARY KEY, ts TEXT, device_id TEXT, kind TEXT, data TEXT NOT NULL, acked INTEGER DEFAULT 0, resolved INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS raw_access (at TEXT, user TEXT, event_id TEXT);
            CREATE TABLE IF NOT EXISTS device_config (
                device_id TEXT PRIMARY KEY, version INTEGER DEFAULT 0, data TEXT NOT NULL, updated_at TEXT,
                applied_version INTEGER DEFAULT 0, applied_at TEXT, apply_error TEXT);
            """
        )
        for s in SETTINGS["sites"]:
            conn.execute("INSERT OR IGNORE INTO sites(site_id, data) VALUES (?, ?)", (s["site_id"], json.dumps(s, ensure_ascii=False)))
        for d in SETTINGS["devices"]:
            conn.execute("INSERT OR IGNORE INTO devices(device_id, data) VALUES (?, ?)", (d["device_id"], json.dumps(d, ensure_ascii=False)))


def rows_json(rows) -> list[dict]:
    return [json.loads(r["data"]) for r in rows]


# ---------------------------------------------------------------- 인증
def unauthorized(detail="대시보드 계정 인증이 필요합니다.") -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail, headers={"WWW-Authenticate": REALM})


def check_basic(header: str | None) -> str | None:
    if not header or not header.lower().startswith("basic "):
        return None
    try:
        user, _, pw = base64.b64decode(header.split(" ", 1)[1]).decode("utf-8").partition(":")
    except Exception:
        return None
    if not SETTINGS.get("dashboard_pass"):
        return None
    ok = secrets.compare_digest(user, SETTINGS["dashboard_user"]) and secrets.compare_digest(pw, SETTINGS["dashboard_pass"])
    return user if ok else None


def dashboard_user(request: Request) -> str:
    user = check_basic(request.headers.get("authorization"))
    if not user:
        raise unauthorized()
    return user


async def read_json(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "본문이 UTF-8 JSON 이 아닙니다.")
    if not isinstance(body, dict):
        raise HTTPException(400, "JSON 객체가 필요합니다.")
    return body


def device_auth(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(401, "장비 토큰(Bearer)이 필요합니다.")
    device_id = load_tokens().get(header.split(" ", 1)[1].strip())
    if not device_id:
        raise HTTPException(401, "장비 토큰이 올바르지 않습니다.")
    return device_id


# ---------------------------------------------------------------- 실시간 (WebSocket)
class Hub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    async def send(self, message: dict) -> None:
        text = json.dumps(message, ensure_ascii=False)
        for ws in list(self.clients):
            try:
                await ws.send_text(text)
            except Exception:
                self.clients.discard(ws)

    def publish(self, kind: str, data: dict) -> None:
        if self.loop and self.clients:
            asyncio.run_coroutine_threadsafe(self.send({"type": kind, "ts": iso(now_utc()), "data": data}), self.loop)


hub = Hub()


# ---------------------------------------------------------------- 장치 상태·알림
def site_of(conn, site_id: str) -> dict | None:
    r = conn.execute("SELECT data FROM sites WHERE site_id=?", (site_id,)).fetchone()
    return json.loads(r["data"]) if r else None


def latest_heartbeat(conn, device_id: str):
    return conn.execute("SELECT * FROM heartbeats WHERE device_id=? ORDER BY received_at DESC LIMIT 1", (device_id,)).fetchone()


def device_view(conn, row) -> dict:
    d = json.loads(row["data"])
    hb = latest_heartbeat(conn, row["device_id"])
    heartbeat = json.loads(hb["data"]) if hb else None
    last_received = hb["received_at"] if hb else d.get("last_received_at")
    age = (now_utc() - parse_ts(hb["received_at"])).total_seconds() if hb else None
    if row["maintenance"]:
        st = "maintenance"
    elif age is None or age > OFFLINE_AFTER_S:
        st = "offline"
    elif heartbeat and (heartbeat.get("issues") or (heartbeat.get("pipeline") or {}).get("stream") not in (None, "ok")):
        st = "degraded"
    else:
        st = "online"
    thumb = SNAP_DIR / "_thumbs" / row["device_id"] / "latest.jpg"
    return {
        **d,
        "status": st,
        "maintenance": bool(row["maintenance"]),
        "previous_status": row["previous_status"] or "offline",
        "heartbeat": heartbeat,
        "last_heartbeat_at": hb["ts"] if hb else d.get("last_heartbeat_at"),
        "last_received_at": last_received,
        "thumbnail_at": iso(datetime.fromtimestamp(thumb.stat().st_mtime, tz=timezone.utc)) if thumb.exists() else None,
        "site": site_of(conn, d.get("site_id", "")),
        "roi": roi_summary(conn, row["device_id"]),
        "last_seen_s": int(age) if age is not None else None,
        "video": stream_state(d.get("stream")),
    }


# ---------------------------------------------------------------- 영상 송출 상태 (MediaMTX 로컬 API, 127.0.0.1:9997)
MEDIAMTX_API = os.environ.get("MEDIAMTX_API", "http://127.0.0.1:9997")
_stream_cache: dict[str, tuple[float, dict | None]] = {}


def stream_state(stream: str | None) -> dict | None:
    """젯슨이 지금 SRT 로 송출 중인지. MediaMTX API 에 접근할 수 없으면 None (판단 불가)."""
    if not stream:
        return None
    now = now_utc().timestamp()
    hit = _stream_cache.get(stream)
    if hit and now - hit[0] < 3:
        return hit[1]
    import urllib.error
    import urllib.request
    try:
        with urllib.request.urlopen(f"{MEDIAMTX_API}/v3/paths/get/{stream}", timeout=1.5) as resp:
            p = json.loads(resp.read().decode("utf-8"))
        result = {"publishing": bool(p.get("ready")), "since": p.get("readyTime"), "readers": len(p.get("readers") or []),
                  "bytes_received": p.get("bytesReceived") or p.get("inboundBytes") or 0}
    except urllib.error.HTTPError as e:
        result = {"publishing": False, "since": None, "readers": 0, "bytes_received": 0} if e.code == 404 else None
    except Exception:
        result = None
    _stream_cache[stream] = (now, result)
    return result


# ---------------------------------------------------------------- ROI 원격 설정 (jetson_data.md §7 set_config 의 ROI 부분)
ROI_MAX_ZONES = 16
ROI_MAX_POINTS = 32


def roi_row(conn, device_id: str):
    return conn.execute("SELECT * FROM device_config WHERE device_id=?", (device_id,)).fetchone()


def roi_state(row) -> str:
    if not row or not row["version"]:
        return "none"
    if row["apply_error"] and (row["applied_version"] or 0) < row["version"]:
        return "failed"
    return "applied" if (row["applied_version"] or 0) >= row["version"] else "pending"


def roi_summary(conn, device_id: str) -> dict:
    r = roi_row(conn, device_id)
    if not r:
        return {"version": 0, "applied_version": 0, "apply_state": "none", "zones": 0}
    return {"version": r["version"], "applied_version": r["applied_version"] or 0, "apply_state": roi_state(r),
            "apply_error": r["apply_error"], "zones": len(json.loads(r["data"]).get("zones", []))}


def roi_document(conn, device_id: str) -> dict:
    r = roi_row(conn, device_id)
    doc = json.loads(r["data"]) if r else {"version": 0, "updated_at": None, "updated_by": None, "frame_ref": None, "zones": []}
    doc["device_id"] = device_id
    return doc


def validate_zones(zones: Any) -> list[dict]:
    if not isinstance(zones, list):
        raise HTTPException(422, "zones 는 배열이어야 합니다.")
    if len(zones) > ROI_MAX_ZONES:
        raise HTTPException(422, f"구역은 최대 {ROI_MAX_ZONES}개입니다.")
    out, seen = [], set()
    for i, z in enumerate(zones):
        if not isinstance(z, dict):
            raise HTTPException(422, f"{i + 1}번째 구역 형식이 올바르지 않습니다.")
        ztype = z.get("type")
        if ztype not in ("include", "exclude"):
            raise HTTPException(422, f"{i + 1}번째 구역 type 은 include | exclude 여야 합니다.")
        pts = z.get("points")
        if not isinstance(pts, list) or not (3 <= len(pts) <= ROI_MAX_POINTS):
            raise HTTPException(422, f"{i + 1}번째 구역은 꼭짓점 3~{ROI_MAX_POINTS}개가 필요합니다.")
        clean = []
        for p in pts:
            if not (isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in p)):
                raise HTTPException(422, f"{i + 1}번째 구역 좌표는 0~1 사이 [x, y] 여야 합니다.")
            clean.append([round(float(p[0]), 5), round(float(p[1]), 5)])
        zid = str(z.get("id") or f"z{i + 1}")[:32]
        if zid in seen:
            zid = f"{zid}_{i + 1}"
        seen.add(zid)
        out.append({"id": zid, "name": str(z.get("name") or ("감시 구역" if ztype == "include" else "제외 구역"))[:40], "type": ztype, "points": clean})
    return out


def mark_roi_applied(conn, device_id: str, version: int, ok: bool = True, error: str | None = None) -> bool:
    r = roi_row(conn, device_id)
    if not r or not isinstance(version, int):
        return False
    if ok:
        if version <= (r["applied_version"] or 0) or version > r["version"]:
            return False
        conn.execute("UPDATE device_config SET applied_version=?, applied_at=?, apply_error=NULL WHERE device_id=?", (version, iso(now_utc()), device_id))
    else:
        conn.execute("UPDATE device_config SET apply_error=? WHERE device_id=?", (str(error or "적용 실패")[:300], device_id))
    return True


def all_devices(conn) -> list[dict]:
    return [device_view(conn, r) for r in conn.execute("SELECT * FROM devices ORDER BY device_id")]


def raise_alert(conn, kind: str, severity: str, device_id: str | None, summary: str, detail: dict | None = None, event_id: str | None = None, dedupe: bool = True) -> None:
    """같은 종류의 미확인 알림이 이미 있으면 새로 만들지 않는다 (event_new 제외)."""
    if dedupe and device_id and conn.execute("SELECT 1 FROM alerts WHERE device_id=? AND kind=? AND acked=0 AND resolved=0", (device_id, kind)).fetchone():
        return
    ts = iso(now_utc())
    alert_id = f"AL-{now_utc().strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3)}"
    site_id = None
    if device_id:
        r = conn.execute("SELECT data FROM devices WHERE device_id=?", (device_id,)).fetchone()
        site_id = json.loads(r["data"]).get("site_id") if r else None
    data = {"alert_id": alert_id, "ts": ts, "created_at": ts, "severity": severity, "kind": kind, "type": kind.replace("device_", ""), "device_id": device_id, "site_id": site_id,
            "summary": summary, "title": summary, "message": summary, "detail": detail or {}, "event_id": event_id, "acked": False, "acked_by": None, "resolved": False}
    conn.execute("INSERT INTO alerts(alert_id, ts, device_id, kind, data) VALUES (?,?,?,?,?)", (alert_id, ts, device_id, kind, json.dumps(data, ensure_ascii=False)))
    hub.publish("alert", data)


def resolve_alerts(conn, device_id: str, kinds: list[str]) -> None:
    for kind in kinds:
        for r in conn.execute("SELECT alert_id, data FROM alerts WHERE device_id=? AND kind=? AND resolved=0", (device_id, kind)):
            data = json.loads(r["data"])
            data["resolved"] = True
            conn.execute("UPDATE alerts SET resolved=1, data=? WHERE alert_id=?", (json.dumps(data, ensure_ascii=False), r["alert_id"]))


def evaluate_device_alerts(conn, device_id: str) -> None:
    row = conn.execute("SELECT * FROM devices WHERE device_id=?", (device_id,)).fetchone()
    if not row:
        return
    d = device_view(conn, row)
    if d["maintenance"]:
        return
    hb = d.get("heartbeat") or {}
    if d["status"] == "offline":
        raise_alert(conn, "device_offline", "critical", device_id, "장치 연결 끊김 · 하트비트 90초 초과", {"last_received_at": d.get("last_received_at")})
    else:
        resolve_alerts(conn, device_id, ["device_offline"])
    issues = hb.get("issues") or []
    if issues:
        raise_alert(conn, "device_degraded", "warning", device_id, "장치 이상 · " + ", ".join(issues), {"issues": issues})
    else:
        resolve_alerts(conn, device_id, ["device_degraded"])
    sysinfo = hb.get("system") or {}
    if sysinfo.get("disk_free_mb") is not None and sysinfo["disk_free_mb"] < 2000:
        raise_alert(conn, "disk_low", "warning", device_id, f"디스크 여유 부족 · {sysinfo['disk_free_mb']} MB", {"disk_free_mb": sysinfo["disk_free_mb"]})
    else:
        resolve_alerts(conn, device_id, ["disk_low"])
    temps = (sysinfo.get("temp_c") or {})
    hot = [k for k, v in temps.items() if isinstance(v, (int, float)) and v >= 80]
    if hot:
        raise_alert(conn, "high_temp", "warning", device_id, "온도 경고 · " + ", ".join(f"{k} {temps[k]}°C" for k in hot), {"temp_c": temps})
    else:
        resolve_alerts(conn, device_id, ["high_temp"])
    if (hb.get("pipeline") or {}).get("stream") == "lost":
        raise_alert(conn, "stream_lost", "critical", device_id, "카메라 스트림 끊김 (RTSP lost)", {"pipeline": hb.get("pipeline")})
    else:
        resolve_alerts(conn, device_id, ["stream_lost"])


WATCHDOG_INTERVAL_S = 10
_last_device_state: dict[str, tuple] = {}


async def watchdog() -> None:
    """10초마다 장치 상태 재판정. 하트비트가 끊긴 장치는 이벤트가 생기지 않으므로 여기서 오프라인 전환을 감지하고,
    상태(online/offline/…)나 영상 송출 여부가 바뀌면 대시보드에 device_status 로 즉시 알린다."""
    while True:
        changes = []
        try:
            with _db_lock, db() as conn:
                for r in conn.execute("SELECT * FROM devices"):
                    evaluate_device_alerts(conn, r["device_id"])
                    v = device_view(conn, r)
                    state = (v["status"], (v.get("video") or {}).get("publishing"))
                    prev = _last_device_state.get(r["device_id"])
                    if prev is not None and prev != state:
                        changes.append({"device_id": r["device_id"], "status": v["status"], "previous": prev[0],
                                        "video": v.get("video"), "last_received_at": v.get("last_received_at"), "last_seen_s": v.get("last_seen_s")})
                    _last_device_state[r["device_id"]] = state
                enforce_retention(conn)
        except Exception as e:  # noqa: BLE001
            print("watchdog error:", e)
        for c in changes:
            hub.publish("device_status", c)
        await asyncio.sleep(WATCHDOG_INTERVAL_S)


# ---------------------------------------------------------------- 이벤트 모델
def event_view(conn, row) -> dict:
    e = json.loads(row["data"])
    e["site"] = site_of(conn, e.get("site_id", ""))
    return e


def normalize_incoming_event(body: dict, device_id: str) -> dict:
    if body.get("device_id") and body["device_id"] != device_id:
        raise HTTPException(403, f"토큰의 장치({device_id})와 본문의 device_id({body['device_id']})가 다릅니다.")
    det = body.get("detection") or {}
    if not det.get("class"):
        raise HTTPException(422, "detection.class 가 필요합니다.")
    ts = parse_ts(body.get("ts"))
    event_id = str(body.get("event_id") or f"{device_id}-{int(ts.timestamp() * 1000)}")
    media = body.get("media") or {}
    return {
        "event_id": event_id,
        "device_id": device_id,
        "site_id": body.get("site_id") or "",
        "ts": iso(ts),
        "received_at": iso(now_utc()),
        "version": 0,
        "detection": {"class": det["class"], "class_id": det.get("class_id"), "color": det.get("color"), "night": det.get("night"),
                      "conf": float(det.get("conf") or 0), "bbox": det.get("bbox"), "frame_size": det.get("frame_size")},
        "suspect": body.get("suspect"),
        "announce": {"played": bool((body.get("announce") or {}).get("played")), "phrase": (body.get("announce") or {}).get("phrase", ""),
                     "suppressed_reason": (body.get("announce") or {}).get("suppressed_reason")},
        "media": {"snapshot": media.get("snapshot") if str(media.get("snapshot", "")).startswith(("http", "/")) else None,
                  "snapshot_raw": None, "clip": media.get("clip") if str(media.get("clip", "")).startswith(("http", "/")) else None,
                  "clip_range_s": media.get("clip_range_s"), "pending": {k: media.get(k) for k in ("snapshot", "snapshot_raw", "clip") if media.get(k)}},
        "debug": body.get("debug"),
        "review": {"state": "new", "assignee": None, "history": [], "reason": None, "action": None},
        "outcome": {"retrieved": False, "retrieved_at": None, "after_s": None, "object_last_seen_at": None},
    }


def save_event(conn, e: dict) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO events(event_id, device_id, site_id, ts, received_at, day, state, version, data) VALUES (?,?,?,?,?,?,?,?,?)",
        (e["event_id"], e["device_id"], e["site_id"], e["ts"], e["received_at"], kst_day(e["ts"]), e["review"]["state"], e["version"], json.dumps(e, ensure_ascii=False)),
    )


def safe_id(v: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", v)


def media_folder(e: dict) -> Path:
    return SNAP_DIR / kst_day(e["ts"]) / safe_id(e["event_id"])


def enforce_retention(conn) -> int:
    """사건 수가 max_events 를 넘으면 먼저 들어온 것부터 삭제 (DB 행 + 미디어 폴더 + 관련 알림). 삭제한 건수를 돌려준다."""
    limit = int(SETTINGS.get("max_events") or 0)
    if limit <= 0:
        return 0
    total = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    excess = total - limit
    if excess <= 0:
        return 0
    victims = conn.execute("SELECT event_id, data FROM events ORDER BY received_at ASC, ts ASC LIMIT ?", (excess,)).fetchall()
    for r in victims:
        e = json.loads(r["data"])
        folder = media_folder(e)
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)
            day_dir = folder.parent
            try:
                if day_dir.exists() and not any(day_dir.iterdir()):
                    day_dir.rmdir()
            except OSError:
                pass
        conn.execute("DELETE FROM alerts WHERE json_extract(data,'$.event_id') = ?", (r["event_id"],))
        conn.execute("DELETE FROM events WHERE event_id=?", (r["event_id"],))
    print(f"retention: removed {len(victims)} oldest events (limit {limit})")
    return len(victims)


def filter_sql(p: dict) -> tuple[str, list]:
    where, args = ["1=1"], []
    for key in ("from", "to"):
        if p.get(key) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", p[key]):
            raise HTTPException(400, "날짜 형식이 올바르지 않습니다.")
    if p.get("from") and p.get("to") and p["from"] > p["to"]:
        raise HTTPException(400, "시작일이 종료일보다 늦습니다.")
    if p.get("from"):
        where.append("day >= ?"); args.append(p["from"])
    if p.get("to"):
        where.append("day <= ?"); args.append(p["to"])
    if p.get("site_id"):
        where.append("site_id = ?"); args.append(p["site_id"])
    if p.get("device_id"):
        where.append("device_id = ?"); args.append(p["device_id"])
    if p.get("state"):
        where.append("state = ?"); args.append(p["state"])
    if p.get("class"):
        where.append("json_extract(data,'$.detection.class') = ?"); args.append(p["class"])
    if p.get("q"):
        like = f"%{p['q'].lower()}%"
        where.append("(lower(event_id) LIKE ? OR lower(device_id) LIKE ? OR lower(json_extract(data,'$.detection.class')) LIKE ? OR site_id IN (SELECT site_id FROM sites WHERE lower(json_extract(data,'$.name')) LIKE ?))")
        args += [like, like, like, like]
    return " AND ".join(where), args


def summarize(events: list[dict]) -> dict:
    confirmed = [e for e in events if e["review"]["state"] in ("confirmed", "actioned")]
    retrieved = sum(1 for e in confirmed if e["outcome"].get("retrieved"))
    by_hour = [0] * 24
    by_class: dict[str, int] = {}
    for e in events:
        by_hour[kst_hour(e["ts"])] += 1
        by_class[e["detection"]["class"]] = by_class.get(e["detection"]["class"], 0) + 1
    return {
        "events": len(events), "confirmed": len(confirmed), "retrieved": retrieved,
        "retrieved_rate": retrieved / len(confirmed) if confirmed else None,
        "actioned": sum(1 for e in events if e["review"]["state"] == "actioned"),
        "dismissed": sum(1 for e in events if e["review"]["state"] == "dismissed"),
        "pending": sum(1 for e in events if e["review"]["state"] in ("new", "reviewing")),
        "night_share": (sum(1 for e in events if e["detection"].get("night")) / len(events)) if events else None,
        "by_hour": by_hour, "by_class": by_class,
    }


# ---------------------------------------------------------------- 앱
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
    hub.loop = asyncio.get_running_loop()
    task = asyncio.create_task(watchdog())
    yield
    task.cancel()


app = FastAPI(title="Clean Guard ingest & dashboard API", version="0.1.0", lifespan=lifespan)
app.mount("/snapshots", StaticFiles(directory=str(SNAP_DIR), check_dir=False), name="snapshots")


@app.exception_handler(HTTPException)
async def http_exc(request: Request, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers)


@app.get("/health")
def health():
    return {"status": "ok", "service": "clean-guard", "time": iso(now_utc())}


# ---------- 장치 → 서버 (Bearer)
@app.post("/api/events")
async def ingest_event(request: Request, device_id: str = Depends(device_auth)):
    body = await read_json(request)
    e = normalize_incoming_event(body, device_id)
    with _db_lock, db() as conn:
        existing = conn.execute("SELECT data FROM events WHERE event_id=?", (e["event_id"],)).fetchone()
        if existing:
            return JSONResponse({"event_id": e["event_id"], "duplicate": True}, status_code=200)
        if not e["site_id"]:
            d = conn.execute("SELECT data FROM devices WHERE device_id=?", (device_id,)).fetchone()
            e["site_id"] = json.loads(d["data"]).get("site_id", "") if d else ""
        if not conn.execute("SELECT 1 FROM devices WHERE device_id=?", (device_id,)).fetchone():
            conn.execute("INSERT INTO devices(device_id, data) VALUES (?, ?)", (device_id, json.dumps({"device_id": device_id, "site_id": e["site_id"], "name": device_id}, ensure_ascii=False)))
        save_event(conn, e)
        site = site_of(conn, e["site_id"])
        raise_alert(conn, "event_new", "info", device_id, f"새 사건 · {(site or {}).get('name', e['site_id'])} · {e['detection']['class']}", event_id=e["event_id"], dedupe=False)
        enforce_retention(conn)
        view = event_view(conn, conn.execute("SELECT * FROM events WHERE event_id=?", (e["event_id"],)).fetchone())
    hub.publish("event", view)
    return JSONResponse({"event_id": e["event_id"], "received_at": e["received_at"]}, status_code=201)


@app.post("/api/events/{event_id}/update")
async def event_update(event_id: str, request: Request, device_id: str = Depends(device_auth)):
    body = await read_json(request)
    with _db_lock, db() as conn:
        row = conn.execute("SELECT * FROM events WHERE event_id=?", (event_id,)).fetchone()
        if not row:
            raise HTTPException(404, "사건을 찾을 수 없습니다.")
        e = json.loads(row["data"])
        if e["device_id"] != device_id:
            raise HTTPException(403, "다른 장치의 사건입니다.")
        if body.get("update") == "retrieved":
            e["outcome"].update({"retrieved": True, "retrieved_at": iso(parse_ts(body.get("ts"))), "after_s": body.get("after_s")})
        elif body.get("update") == "object_seen":
            e["outcome"]["object_last_seen_at"] = iso(parse_ts(body.get("ts")))
        else:
            raise HTTPException(422, "update 는 retrieved | object_seen 이어야 합니다.")
        save_event(conn, e)
    hub.publish("event_update", {"event_id": event_id, "device_id": device_id, "update": body.get("update"), "after_s": body.get("after_s")})
    return {"event_id": event_id, "outcome": e["outcome"]}


@app.post("/api/events/{event_id}/media")
async def event_media(event_id: str, device_id: str = Depends(device_auth), snapshot: UploadFile | None = File(None), snapshot_raw: UploadFile | None = File(None), clip: UploadFile | None = File(None)):
    with _db_lock, db() as conn:
        row = conn.execute("SELECT * FROM events WHERE event_id=?", (event_id,)).fetchone()
        if not row:
            raise HTTPException(404, "사건을 먼저 등록(POST /api/events)하세요.")
        e = json.loads(row["data"])
        if e["device_id"] != device_id:
            raise HTTPException(403, "다른 장치의 사건입니다.")
        folder = media_folder(e)
        folder.mkdir(parents=True, exist_ok=True)
        saved = {}
        for name, up, fname in (("snapshot", snapshot, "snapshot.jpg"), ("snapshot_raw", snapshot_raw, "snapshot_raw.jpg"), ("clip", clip, "clip.mp4")):
            if up is None:
                continue
            data = await up.read()
            if len(data) > 200 * 1024 * 1024:
                raise HTTPException(413, f"{name} 파일이 너무 큽니다.")
            (folder / fname).write_bytes(data)
            saved[name] = f"/snapshots/{folder.relative_to(SNAP_DIR).as_posix()}/{fname}"
        if "snapshot" in saved:
            e["media"]["snapshot"] = saved["snapshot"]
        if "clip" in saved:
            e["media"]["clip"] = saved["clip"]
        if "snapshot_raw" in saved:
            e["media"]["snapshot_raw"] = saved["snapshot_raw"]  # 조회 API 에서는 숨기고 /raw 로만 발급
        e["media"]["pending"] = {k: v for k, v in (e["media"].get("pending") or {}).items() if k not in saved}
        save_event(conn, e)
    hub.publish("event_update", {"event_id": event_id, "device_id": device_id, "update": "media", "media": {k: v for k, v in saved.items() if k != "snapshot_raw"}})
    return saved


@app.post("/api/heartbeat")
async def heartbeat(request: Request, device_id: str = Depends(device_auth)):
    body = await read_json(request)
    ts = iso(parse_ts(body.get("ts")))
    received = iso(now_utc())
    with _db_lock, db() as conn:
        if not conn.execute("SELECT 1 FROM devices WHERE device_id=?", (device_id,)).fetchone():
            conn.execute("INSERT INTO devices(device_id, data) VALUES (?, ?)", (device_id, json.dumps({"device_id": device_id, "site_id": body.get("site_id", ""), "name": device_id}, ensure_ascii=False)))
        conn.execute("INSERT INTO heartbeats(device_id, ts, received_at, data) VALUES (?,?,?,?)", (device_id, ts, received, json.dumps(body, ensure_ascii=False)))
        conn.execute("DELETE FROM heartbeats WHERE device_id=? AND received_at < ?", (device_id, iso(now_utc() - timedelta(days=30))))
        # 장치가 보고한 hw/sw/config 는 Device 마스터에 반영
        row = conn.execute("SELECT data FROM devices WHERE device_id=?", (device_id,)).fetchone()
        d = json.loads(row["data"])
        for k in ("hw", "sw", "config", "name"):
            if body.get(k):
                d[k] = body[k]
        conn.execute("UPDATE devices SET data=? WHERE device_id=?", (json.dumps(d, ensure_ascii=False), device_id))
        # 장치가 실제 적용 중인 ROI 버전을 보고하면 반영 (ack 유실 대비, §2 "실제 적용 값 보고")
        reported = (body.get("config") or {}).get("roi_version") if isinstance(body.get("config"), dict) else None
        roi_changed = isinstance(reported, int) and mark_roi_applied(conn, device_id, reported)
        evaluate_device_alerts(conn, device_id)
        view = device_view(conn, conn.execute("SELECT * FROM devices WHERE device_id=?", (device_id,)).fetchone())
    hub.publish("heartbeat", {"device_id": device_id, "status": view["status"], "ts": ts, "pipeline": body.get("pipeline"), "issues": body.get("issues", [])})
    if roi_changed:
        hub.publish("device_config", {"device_id": device_id, **view["roi"]})
    return {"device_id": device_id, "status": view["status"], "received_at": received, "config": {"roi_version": view["roi"]["version"]}}


@app.get("/api/device/config")
def device_config_for_device(device_id: str = Depends(device_auth)):
    """젯슨용: 하트비트 응답의 config.roi_version 이 로컬보다 크면 이걸로 받아 config/roi.json 에 저장한다."""
    with db() as conn:
        return {"device_id": device_id, "roi": roi_document(conn, device_id)}


@app.post("/api/device/config/ack")
async def device_config_ack(request: Request, device_id: str = Depends(device_auth)):
    body = await read_json(request)
    version = body.get("roi_version")
    if not isinstance(version, int):
        raise HTTPException(422, "roi_version(정수)이 필요합니다.")
    ok = body.get("ok", True) is not False
    with _db_lock, db() as conn:
        r = roi_row(conn, device_id)
        if not r:
            raise HTTPException(404, "이 장치에 ROI 설정이 없습니다.")
        if version > r["version"]:
            raise HTTPException(409, f"서버 버전({r['version']})보다 큰 버전입니다.")
        mark_roi_applied(conn, device_id, version, ok, body.get("error"))
        summary = roi_summary(conn, device_id)
    hub.publish("device_config", {"device_id": device_id, **summary})
    return summary


@app.put("/api/devices/{device_id}/thumbnail")
async def put_thumbnail(device_id: str, request: Request, token_device: str = Depends(device_auth)):
    if token_device != device_id:
        raise HTTPException(403, "다른 장치의 썸네일입니다.")
    data = await request.body()
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(413, "썸네일이 너무 큽니다 (5 MB 초과).")
    folder = SNAP_DIR / "_thumbs" / re.sub(r"[^A-Za-z0-9_-]", "_", device_id)
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / "latest.tmp"
    tmp.write_bytes(data)
    os.replace(tmp, folder / "latest.jpg")
    return {"url": f"/snapshots/_thumbs/{device_id}/latest.jpg", "ts": iso(now_utc())}


# ---------- 대시보드 → 서버 (Basic)
@app.get("/api/context")
def context(user: str = Depends(dashboard_user)):
    with db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    return {"user": user, "demo": False, "investigator": True, "server_time": iso(now_utc()),
            "retention": {"mode": "events_only", "max_events": SETTINGS.get("max_events"), "events": total}}


@app.get("/api/sites")
def sites(user: str = Depends(dashboard_user)):
    with db() as conn:
        return rows_json(conn.execute("SELECT data FROM sites ORDER BY site_id"))


@app.post("/api/sites")
async def add_site(request: Request, user: str = Depends(dashboard_user)):
    b = await read_json(request)
    if not (b.get("site_id") and b.get("name") and b.get("address")):
        raise HTTPException(422, "필수 항목을 입력하세요.")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", b["site_id"]):
        raise HTTPException(422, "지점 ID 형식이 올바르지 않습니다.")
    loc = b.get("location") or {}
    if not (isinstance(loc.get("lat"), (int, float)) and abs(loc["lat"]) <= 90 and isinstance(loc.get("lng"), (int, float)) and abs(loc["lng"]) <= 180):
        raise HTTPException(422, "위치가 올바르지 않습니다.")
    s = {"site_id": b["site_id"], "name": b["name"], "address": b["address"], "location": {"lat": loc["lat"], "lng": loc["lng"]}, "region": b.get("region") or {}, "created_at": iso(now_utc())}
    with _db_lock, db() as conn:
        if conn.execute("SELECT 1 FROM sites WHERE site_id=?", (s["site_id"],)).fetchone():
            raise HTTPException(409, "이미 등록된 지점입니다.")
        conn.execute("INSERT INTO sites(site_id, data) VALUES (?, ?)", (s["site_id"], json.dumps(s, ensure_ascii=False)))
    return s


@app.get("/api/devices")
def devices(user: str = Depends(dashboard_user)):
    with db() as conn:
        return all_devices(conn)


@app.post("/api/devices")
async def add_device(request: Request, user: str = Depends(dashboard_user)):
    b = await read_json(request)
    if not (b.get("device_id") and b.get("name") and b.get("site_id")):
        raise HTTPException(422, "장치 정보와 설치 지점을 확인하세요.")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", b["device_id"]):
        raise HTTPException(422, "장치 ID 형식이 올바르지 않습니다.")
    d = {"device_id": b["device_id"], "site_id": b["site_id"], "name": b["name"], "stream": b.get("stream"), "registered_at": iso(now_utc())}
    with _db_lock, db() as conn:
        if not conn.execute("SELECT 1 FROM sites WHERE site_id=?", (d["site_id"],)).fetchone():
            raise HTTPException(422, "설치 지점이 없습니다.")
        if conn.execute("SELECT 1 FROM devices WHERE device_id=?", (d["device_id"],)).fetchone():
            raise HTTPException(409, "이미 등록된 장치입니다.")
        conn.execute("INSERT INTO devices(device_id, data) VALUES (?, ?)", (d["device_id"], json.dumps(d, ensure_ascii=False)))
        token = None
        if b.get("token") and len(str(b["token"])) >= 16:
            token = str(b["token"])
        else:
            token = "cg_" + secrets.token_urlsafe(24)
        with TOKENS_PATH.open("a", encoding="utf-8") as f:
            f.write(f"{d['device_id']}={token}\n")
        view = device_view(conn, conn.execute("SELECT * FROM devices WHERE device_id=?", (d["device_id"],)).fetchone())
    view["token_issued"] = True  # 토큰 값은 응답에 넣지 않는다. 서버의 device-tokens.txt 에서 확인.
    return view


@app.post("/api/devices/{device_id}/maintenance")
async def maintenance(device_id: str, request: Request, user: str = Depends(dashboard_user)):
    b = await read_json(request)
    with _db_lock, db() as conn:
        row = conn.execute("SELECT * FROM devices WHERE device_id=?", (device_id,)).fetchone()
        if not row:
            raise HTTPException(404, "장치가 없습니다.")
        enabled = bool(b.get("enabled"))
        prev = device_view(conn, row)["status"] if enabled and not row["maintenance"] else row["previous_status"]
        conn.execute("UPDATE devices SET maintenance=?, previous_status=? WHERE device_id=?", (1 if enabled else 0, prev, device_id))
        if enabled:
            resolve_alerts(conn, device_id, ["device_offline", "device_degraded", "stream_lost", "disk_low", "high_temp"])
        else:
            evaluate_device_alerts(conn, device_id)
        return device_view(conn, conn.execute("SELECT * FROM devices WHERE device_id=?", (device_id,)).fetchone())


@app.get("/api/devices/{device_id}/roi")
def get_roi(device_id: str, user: str = Depends(dashboard_user)):
    with db() as conn:
        if not conn.execute("SELECT 1 FROM devices WHERE device_id=?", (device_id,)).fetchone():
            raise HTTPException(404, "장치가 없습니다.")
        return {**roi_document(conn, device_id), **{k: v for k, v in roi_summary(conn, device_id).items() if k not in ("version", "zones")}}


@app.put("/api/devices/{device_id}/roi")
async def put_roi(device_id: str, request: Request, user: str = Depends(dashboard_user)):
    b = await read_json(request)
    zones = validate_zones(b.get("zones"))
    frame_ref = b.get("frame_ref")
    if frame_ref is not None and not (isinstance(frame_ref, list) and len(frame_ref) == 2 and all(isinstance(v, int) and v > 0 for v in frame_ref)):
        raise HTTPException(422, "frame_ref 는 [너비, 높이] 정수여야 합니다.")
    with _db_lock, db() as conn:
        if not conn.execute("SELECT 1 FROM devices WHERE device_id=?", (device_id,)).fetchone():
            raise HTTPException(404, "장치가 없습니다.")
        r = roi_row(conn, device_id)
        current = r["version"] if r else 0
        if b.get("base_version", current) != current:
            raise HTTPException(409, "다른 사용자가 ROI 를 먼저 수정했습니다. 다시 불러오세요.")
        version = current + 1
        doc = {"version": version, "updated_at": iso(now_utc()), "updated_by": user, "frame_ref": frame_ref, "zones": zones}
        if r:
            conn.execute("UPDATE device_config SET version=?, data=?, updated_at=?, apply_error=NULL WHERE device_id=?", (version, json.dumps(doc, ensure_ascii=False), doc["updated_at"], device_id))
        else:
            conn.execute("INSERT INTO device_config(device_id, version, data, updated_at, applied_version) VALUES (?,?,?,?,0)", (device_id, version, json.dumps(doc, ensure_ascii=False), doc["updated_at"]))
        result = {**roi_document(conn, device_id), **{k: v for k, v in roi_summary(conn, device_id).items() if k not in ("version", "zones")}}
    hub.publish("device_config", {"device_id": device_id, "version": version, "applied_version": result["applied_version"], "apply_state": result["apply_state"], "zones": len(zones)})
    return result


@app.get("/api/devices/{device_id}/stream")
def device_stream(device_id: str, user: str = Depends(dashboard_user)):
    with db() as conn:
        row = conn.execute("SELECT * FROM devices WHERE device_id=?", (device_id,)).fetchone()
        if not row:
            raise HTTPException(404, "장치가 없습니다.")
        d = device_view(conn, row)
    out: dict[str, Any] = {"device_id": device_id, "connected": False, "ts": iso(now_utc())}
    if d.get("thumbnail_at"):
        out["thumbnail"] = {"url": f"/snapshots/_thumbs/{device_id}/latest.jpg", "ts": d["thumbnail_at"]}
        out["ts"] = d["thumbnail_at"]
    stream = d.get("stream")
    video = d.get("video")
    out["video"] = video
    out["device_status"] = d["status"]
    if stream and SETTINGS.get("live_base"):
        proto = "hls" if SETTINGS.get("live_protocol") == "hls" else "webrtc"
        # 송출 여부를 알 수 있으면 그대로, MediaMTX API 를 못 읽으면(None) 연결 시도는 허용
        out["connected"] = video is None or bool(video.get("publishing"))
        out["live"] = {"protocol": proto, "url": f"{SETTINGS['live_base'].rstrip('/')}/{stream}/" + ("index.m3u8" if proto == "hls" else "whep"), "stream": stream,
                       "variants": [{"id": "annotated", "desc": "추적 박스·이벤트 표시 + 모자이크", "default": True}]}
    return out


@app.get("/api/devices/{device_id}/uptime")
def device_uptime(device_id: str, user: str = Depends(dashboard_user)):
    start = now_utc().astimezone(KST).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    with db() as conn:
        rows = conn.execute("SELECT received_at, data FROM heartbeats WHERE device_id=? AND received_at >= ? ORDER BY received_at", (device_id, iso(start))).fetchall()
    if len(rows) < 2:
        return {"device_uptime_pct": None, "observed_seconds": 0}
    observed = ok = 0.0
    for a, b in zip(rows, rows[1:]):
        gap = (parse_ts(b["received_at"]) - parse_ts(a["received_at"])).total_seconds()
        if gap > OFFLINE_AFTER_S * 2:
            continue  # 미관측 구간 제외
        observed += gap
        if not (json.loads(a["data"]).get("issues") or []):
            ok += gap
    return {"device_uptime_pct": (ok / observed * 100) if observed else None, "observed_seconds": int(observed)}


def public_event(e: dict) -> dict:
    e = dict(e)
    media = dict(e.get("media") or {})
    media.pop("snapshot_raw", None)
    media.pop("pending", None)
    e["media"] = media
    return e


@app.get("/api/events")
def list_events(request: Request, page: int = Query(1, ge=1), size: int = Query(12, ge=1, le=1000), user: str = Depends(dashboard_user)):
    p = dict(request.query_params)
    where, args = filter_sql(p)
    with db() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM events WHERE {where}", args).fetchone()[0]
        rows = conn.execute(f"SELECT * FROM events WHERE {where} ORDER BY ts DESC, event_id ASC LIMIT ? OFFSET ?", args + [size, (page - 1) * size]).fetchall()
        return {"total": total, "page": page, "size": size, "items": [public_event(event_view(conn, r)) for r in rows]}


@app.get("/api/events.csv")
def events_csv(request: Request, user: str = Depends(dashboard_user)):
    where, args = filter_sql(dict(request.query_params))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["사건 ID", "발생 시각", "서버 수신", "지점", "장치", "종류", "색상", "야간", "신뢰도", "방송", "상태", "회수"])
    with db() as conn:
        for r in conn.execute(f"SELECT * FROM events WHERE {where} ORDER BY ts DESC", args):
            e = event_view(conn, r)
            w.writerow([e["event_id"], e["ts"], e["received_at"], (e.get("site") or {}).get("name", e["site_id"]), e["device_id"], e["detection"]["class"], e["detection"].get("color"), e["detection"].get("night"), e["detection"]["conf"], e["announce"]["played"], e["review"]["state"], e["outcome"]["retrieved"]])
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": "attachment; filename=clean-guard-events.csv"})


@app.get("/api/events/{event_id}")
def get_event(event_id: str, user: str = Depends(dashboard_user)):
    with db() as conn:
        row = conn.execute("SELECT * FROM events WHERE event_id=?", (event_id,)).fetchone()
        if not row:
            raise HTTPException(404, "사건을 찾을 수 없습니다.")
        return public_event(event_view(conn, row))


@app.get("/api/events/{event_id}/raw")
def get_event_raw(event_id: str, user: str = Depends(dashboard_user)):
    with _db_lock, db() as conn:
        row = conn.execute("SELECT data FROM events WHERE event_id=?", (event_id,)).fetchone()
        if not row:
            raise HTTPException(404, "사건을 찾을 수 없습니다.")
        raw = (json.loads(row["data"]).get("media") or {}).get("snapshot_raw")
        if not raw:
            raise HTTPException(404, "원본 자료가 없습니다.")
        conn.execute("INSERT INTO raw_access(at, user, event_id) VALUES (?,?,?)", (iso(now_utc()), user, event_id))
    return {"url": raw, "logged": True}


@app.post("/api/events/{event_id}/review")
async def review(event_id: str, request: Request, user: str = Depends(dashboard_user)):
    b = await read_json(request)
    with _db_lock, db() as conn:
        row = conn.execute("SELECT * FROM events WHERE event_id=?", (event_id,)).fetchone()
        if not row:
            raise HTTPException(404, "사건을 찾을 수 없습니다.")
        e = json.loads(row["data"])
        if b.get("version") != e["version"]:
            raise HTTPException(409, "다른 변경이 있습니다. 다시 조회하세요.")
        frm, to = e["review"]["state"], b.get("state")
        if to not in TRANSITIONS.get(frm, []):
            raise HTTPException(422, "허용되지 않은 상태 변경입니다.")
        if to == "dismissed" and b.get("reason") not in ("false_positive", "authorized", "duplicate"):
            raise HTTPException(422, "제외 사유가 필요합니다.")
        action = b.get("action") or {}
        if to == "actioned" and not (action.get("type") and str(action.get("result", "")).strip()):
            raise HTTPException(422, "조치 유형과 결과가 필요합니다.")
        e["review"]["state"] = to
        e["review"]["assignee"] = user
        e["review"]["history"].append({"from": frm, "to": to, "by": user, "at": iso(now_utc()), "note": b.get("note") or ""})
        if to == "dismissed":
            e["review"]["reason"] = b["reason"]
        if to == "actioned":
            e["review"]["action"] = {"type": action["type"], "result": action["result"], "fine_issued": bool(action.get("fine_issued")), "at": iso(now_utc())}
        e["version"] += 1
        save_event(conn, e)
        view = public_event(event_view(conn, conn.execute("SELECT * FROM events WHERE event_id=?", (event_id,)).fetchone()))
    hub.publish("event_update", {"event_id": event_id, "update": "review", "state": to, "by": user})
    return view


@app.get("/api/alerts")
def alerts(user: str = Depends(dashboard_user)):
    with db() as conn:
        return rows_json(conn.execute("SELECT data FROM alerts ORDER BY ts DESC LIMIT 500"))


@app.post("/api/alerts/{alert_id}/ack")
def ack_alert(alert_id: str, user: str = Depends(dashboard_user)):
    with _db_lock, db() as conn:
        row = conn.execute("SELECT data FROM alerts WHERE alert_id=?", (alert_id,)).fetchone()
        if not row:
            raise HTTPException(404, "알림이 없습니다.")
        a = json.loads(row["data"])
        a.update({"acked": True, "acked_by": user, "acked_at": iso(now_utc())})
        conn.execute("UPDATE alerts SET acked=1, data=? WHERE alert_id=?", (json.dumps(a, ensure_ascii=False), alert_id))
        return a


@app.get("/api/overview")
def overview(user: str = Depends(dashboard_user)):
    today = now_utc().astimezone(KST).strftime("%Y-%m-%d")
    with db() as conn:
        todays = rows_json(conn.execute("SELECT data FROM events WHERE day=?", (today,)))
        pending = conn.execute("SELECT COUNT(*) FROM events WHERE state IN ('new','reviewing')").fetchone()[0]
        unacked = conn.execute("SELECT COUNT(*) FROM alerts WHERE acked=0 AND resolved=0").fetchone()[0]
        counts: dict[str, int] = {}
        for d in all_devices(conn):
            counts[d["status"]] = counts.get(d["status"], 0) + 1
    return {"summary": summarize(todays), "device_counts": counts, "all_pending": pending, "unacked_alerts": unacked}


@app.get("/api/stats")
def stats(request: Request, group_by: str = "site", user: str = Depends(dashboard_user)):
    where, args = filter_sql(dict(request.query_params))
    with db() as conn:
        items = [event_view(conn, r) for r in conn.execute(f"SELECT * FROM events WHERE {where}", args)]
    groups: dict[str, list[dict]] = {}
    for e in items:
        site = e.get("site") or {}
        label = {"day": kst_day(e["ts"]), "hour": f"{kst_hour(e['ts'])}시", "class": e["detection"]["class"], "region": (site.get("region") or {}).get("dong") or "미지정"}.get(group_by) or site.get("name") or e["site_id"]
        groups.setdefault(label, []).append(e)
    return {
        "range": {"from": request.query_params.get("from"), "to": request.query_params.get("to"), "tz": "Asia/Seoul"}, "group_by": group_by,
        "summary": summarize(items),
        "rows": [{"label": k, **summarize(v)} for k, v in groups.items()],
        "announce_cohorts": [{"played": played, **summarize([e for e in items if e["announce"]["played"] == played])} for played in (True, False)],
    }


@app.websocket("/ws/events")
async def ws_events(ws: WebSocket):
    # 브라우저는 같은 출처에서 캐시된 Basic 인증을 업그레이드 요청에 실어 보낸다. 없으면 ?auth=base64(user:pass) 도 허용.
    header = ws.headers.get("authorization")
    if not check_basic(header) and not check_basic("Basic " + (ws.query_params.get("auth") or "")):
        await ws.close(code=4401)
        return
    await ws.accept()
    hub.clients.add(ws)
    try:
        await ws.send_text(json.dumps({"type": "hello", "ts": iso(now_utc()), "data": {"clients": len(hub.clients)}}))
        while True:
            await ws.receive_text()  # ping/keepalive 용. 클라이언트 메시지는 무시
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)
