# 젯슨 작업 요청 — 2026-10-04

> 대상: 젯슨(`dump_monitor_jetson.py`) 담당자
> 기준: 젯슨 연동 핸드오프 문서(별도 전달, 장비 토큰·송출 계정 포함), `jetson_data.md` v0.1
> 서버: `https://cleanguard.duckdns.org` · 장치 `JT-GN-0001` · 영상 경로 `site01_cam1`

## 현재 연동 상태

2026-10-04 서버 기록 기준입니다.

| 항목 | 상태 |
|---|---|
| SRT 영상 송출 | 연결 정상 · **타임스탬프가 실제 시간의 절반 속도** (0번 항목) |
| 30초 하트비트 | 정상 (fps, 온도, TTS, issues 수신) |
| 사건 등록 | 정상 · 45건 |
| 스냅샷 업로드 | 정상 · 44건, 업로드 81회 모두 성공 |
| 회수 후속 보고 (`event_update`) | **미수신** · 0건 |
| 사건 전후 클립 | 서버가 자동 생성 (2026-10-04 변경, 젯슨 작업 불필요) |
| ROI 버전 보고 | **미구현** · 오늘 추가된 기능 |
| 썸네일 | 수신 시작 (2026-10-04 16:04 확인) |

요청 사항은 우선순위 순입니다.

## 0. [긴급] SRT 영상 타임스탬프가 실제 시간보다 느립니다

서버 녹화기가 젯슨 영상에 대해 10~13초마다 다음 오류를 냅니다.

```
[path site01_cam1] [recorder] detected drift between recording duration and absolute time, resetting
```

실측하면 벽시계 12~13초 동안 영상 타임스탬프는 약 6초만 진행합니다. 실제로는 초당 4~5장을 보내면서 타임스탬프는 10 fps 로 찍는 것으로 보입니다. 이 때문에 다음 문제가 생깁니다.

- 서버 순환 버퍼에 시간의 절반 정도만 영상이 남습니다. 사건 클립이 "요청 10초 중 3초만 영상"처럼 잘립니다.
- 라이브 화면과 클립이 실제보다 빨리 재생됩니다.

**고칠 방법** (송출 프로세스에서 프레임마다 실제 시각을 타임스탬프로 쓰기)

- FFmpeg 로 파이프라인 프레임을 넣는 경우 입력 옵션에 `-use_wallclock_as_timestamps 1` 을 추가하고, 고정 `-r 10` 대신 출력 쪽에서 `-fps_mode cfr -r 10`(빈 프레임 복제) 또는 `-fps_mode vfr` 를 씁니다.
  ```sh
  ffmpeg -use_wallclock_as_timestamps 1 -f rawvideo -pix_fmt bgr24 -s 1280x720 -i - \
    -fps_mode cfr -r 10 -c:v h264_nvenc -preset p4 -tune ll -bf 0 -g 10 -b:v 1500k -f mpegts "srt://..."
  ```
- GStreamer `appsrc` 를 쓰는 경우 `is-live=true do-timestamp=true format=time` 을 설정합니다.
- 하트비트 `pipeline.fps` 가 10.0 으로 오는데, 송출에 실제로 들어가는 프레임 수와 같은지도 확인해 주세요.

**확인**: 서버 로그에서 위 drift 오류가 사라지고, 대시보드 사건 클립이 "요청 10초 중 N초만" 안내 없이 10초로 나오면 정상입니다.

## 1. [신규] ROI 원격 설정 — 핸드오프 §3.6

운영자가 대시보드의 라이브 영상 위에 감시 구역과 제외 구역을 다각형으로 그려 저장하면, 서버가 버전을 올리고 다음 하트비트 응답으로 젯슨에 알립니다. 새 포트나 인바운드 연결은 필요 없고 지연은 최대 30초입니다.

**흐름**

1. 하트비트 본문의 `config` 객체에 현재 적용 중인 `roi_version` 을 넣습니다. 처음에는 0 입니다.
   ```json
   { "device_id": "JT-GN-0001", "ts": "...", "pipeline": {...}, "config": { "roi_version": 3 } }
   ```
2. 하트비트 응답에 서버의 최신 버전이 옵니다.
   ```json
   { "device_id": "JT-GN-0001", "status": "online", "received_at": "...", "config": { "roi_version": 4 } }
   ```
3. 응답 버전이 로컬 버전보다 크면 설정을 받아 옵니다.
   ```
   GET /api/device/config
   Authorization: Bearer <장비 토큰>
   → { "device_id": "JT-GN-0001", "roi": { ...ROI 문서... } }
   ```
4. `roi` 를 `config/roi.json` 에 저장합니다. 임시 파일에 쓴 뒤 rename 하고, 저장 직후 파이프라인에 다시 읽어 적용합니다.
5. 적용 결과를 보고합니다. 실패 사유는 대시보드에 그대로 표시됩니다.
   ```
   POST /api/device/config/ack
   { "roi_version": 4, "ok": true }
   { "roi_version": 4, "ok": false, "error": "polygon parse error" }
   ```
   ack 가 유실돼도 다음 하트비트의 `config.roi_version` 으로 서버가 적용 상태를 갱신합니다.

**ROI 문서**

```json
{
  "version": 4,
  "updated_at": "2026-10-04T05:29:10Z",
  "updated_by": "admin",
  "frame_ref": [1280, 720],
  "zones": [
    { "id": "z1", "name": "수거함 앞", "type": "include", "points": [[0.148,0.346],[0.698,0.296],[0.65,0.9],[0.12,0.92]] },
    { "id": "z2", "name": "도로",     "type": "exclude", "points": [[0.005,0.005],[0.995,0.005],[0.995,0.2],[0.005,0.2]] }
  ]
}
```

| 항목 | 규칙 |
|---|---|
| 좌표 | 0~1 정규화 `[x, y]`, 프레임 왼쪽 위가 원점. 픽셀 = `x × 프레임 너비`, `y × 프레임 높이`. 송출 해상도와 추론 해상도가 달라도 그대로 사용 |
| `frame_ref` | 운영자가 그릴 때 본 영상 해상도. 참고용이며 판정에는 쓰지 않음 |
| 개수 | 구역 최대 16개, 구역당 꼭짓점 3~32개 |
| `include` | 감시 구역. 하나도 없으면 화면 전체가 감시 구역 |
| `exclude` | 제외 구역. 감시 구역보다 우선 |

**판정 규칙** (대시보드 `assets/roi-editor.js` 의 `isMonitored` 와 동일)

기준점은 물체 bbox 의 하단 중앙 `((x1+x2)/2, y2)` 을 정규화한 값입니다.

```python
def point_in_polygon(x, y, poly):
    inside, j = False, len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside

def is_monitored(bbox, frame_w, frame_h, zones):
    x, y = (bbox[0] + bbox[2]) / 2 / frame_w, bbox[3] / frame_h
    if any(point_in_polygon(x, y, z["points"]) for z in zones if z["type"] == "exclude"):
        return False
    inc = [z for z in zones if z["type"] == "include"]
    return not inc or any(point_in_polygon(x, y, z["points"]) for z in inc)
```

**운영 규칙**

- 서버에 연결되지 않아도 마지막 `config/roi.json` 으로 계속 동작합니다. 파일이 없으면 화면 전체를 감시합니다.
- 송출 영상(annotated)에 현재 ROI 를 반투명으로 그려 주면 운영자가 적용 결과를 바로 확인할 수 있습니다(권장).
- 구역이 바뀌면 기존 적치물(baseline) 판정을 다시 해야 할 수 있습니다.

## 2. [미수신] 회수 후속 보고 — 핸드오프 §3.2

`POST /api/events/{event_id}/update` 가 아직 한 번도 들어오지 않았습니다. 그래서 대시보드의 회수율 KPI 가 0% 로 나옵니다.

사건 후 객체가 10분 안에 사라지고 다시 식별되지 않으면 보내 주세요.

```
POST /api/events/{event_id}/update
Authorization: Bearer <장비 토큰>
{ "event_id": "01M42NFWQ0P2H82MV72DWCVTSD", "device_id": "JT-GN-0001", "ts": "2026-10-04T14:20:00+09:00", "update": "retrieved", "after_s": 312 }
```

## 3. [변경] 사건 전후 클립은 서버가 만듭니다 — 젯슨 작업 불필요

젯슨 저장 공간 문제로 방식을 바꿨습니다. **젯슨은 클립을 만들거나 보관하지 않습니다.**

- 서버가 SRT 로 받는 영상을 최근 30분만 순환 녹화하고, 사건이 들어오면 사건 시각 기준 앞 5초 ~ 뒤 5초를 잘라 저장합니다. 서버는 영상 클립을 최대 500개까지 보관하고 오래된 것부터 지웁니다.
- 클립 품질은 SRT 타임스탬프가 정확해야 합니다. 0번 항목을 먼저 고쳐 주세요.
- 그래서 젯슨에 필요한 것은 두 가지입니다.
  - **SRT 송출을 끊지 않고 유지**하기. 사건 순간에 송출이 끊겨 있으면 그 사건은 클립이 없습니다.
  - **NTP 시계 동기화**. 사건 `ts` 기준으로 자르기 때문입니다. 2분 넘게 어긋나면 서버가 수신 시각 기준으로 보정하지만 정확도가 떨어집니다.
- 이미 `clip` 을 올리는 코드를 만들었다면 그대로 둬도 됩니다. 젯슨이 올린 클립이 있으면 서버는 그 파일을 쓰고, `clip_range_s` 기준으로 **앞 5초 ~ 뒤 5초만 남기도록 잘라** 보관합니다. 업로드량과 젯슨 저장 공간을 줄이려면 처음부터 `[-5, 5]` 구간으로 만들어 `clip_range_s: [-5, 5]` 로 보내 주세요. 현재는 `[-10, 10]` 20초로 오고 있습니다.

### 업로드 후 로컬 파일 삭제 규칙

스냅샷은 업로드에 성공한 것을 확인한 뒤에만 지워 주세요. 미디어 업로드 응답에 파일별 크기와 sha256 이 추가됐습니다.

```json
{
  "snapshot": "/snapshots/2026-10-04/01M42.../snapshot.jpg",
  "snapshot_raw": "/snapshots/2026-10-04/01M42.../snapshot_raw.jpg",
  "files": {
    "snapshot":     { "url": "...", "size": 17145, "sha256": "1b15a237..." },
    "snapshot_raw": { "url": "...", "size": 20311, "sha256": "9c0e4f12..." }
  }
}
```

1. 사건 JSON 을 보내 `201` 또는 `200(중복)` 을 받습니다.
2. 미디어를 업로드해 `200` 을 받습니다.
3. `files.<이름>.size` 와 `sha256` 이 로컬 파일과 같을 때만 그 파일을 지웁니다.
4. 실패하거나 응답이 없으면 지우지 않고 재전송 큐에 둡니다.

기존 응답 키(`snapshot`, `snapshot_raw`)는 그대로 있으므로 지금 코드는 깨지지 않습니다.

## 4. [확인 요청] 디스크 여유 부족

마지막 하트비트의 `disk_free_mb` 가 약 1,246 MB 입니다. 2,000 MB 미만이라 서버에 "디스크 부족" 경고가 떠 있습니다.

- `output/` 순환 삭제가 동작하는지 확인해 주세요. 보존 기준안은 모자이크본 90일, 원본 30일입니다.
- 서버는 사건 증거만 1,000건까지 보관하고 오래된 것부터 지웁니다. 장기 보관 원본은 젯슨 녹화본이 기준입니다.

## 5. [수신 확인] 썸네일 — 핸드오프 §3.4

2026-10-04 16:04 부터 들어오고 있습니다. 아래는 참고용입니다.

5초마다 최신 프레임을 올려 주면 대시보드 장치 카드와 지도에 화면이 나옵니다. 우선순위는 낮습니다.

```
PUT /api/devices/JT-GN-0001/thumbnail
Authorization: Bearer <장비 토큰>
Content-Type: image/jpeg
(본문: JPEG 바이트, 640×360 권장, 5 MB 이하)
```

## 참고

- 하트비트의 `system.gpu_pct` 가 계속 0 으로 옵니다. 추론이 GPU 에서 돌고 있다면 수집 방법을 확인해 주세요. Jetson 은 `tegrastats` 의 `GR3D_FREQ` 값이 GPU 사용률입니다.
- 하트비트가 90초 넘게 오지 않으면 대시보드에 "오프라인"과 연결 끊김 알림이 뜹니다. 점검으로 멈출 때는 대시보드에서 점검 모드로 바꾸면 알림이 억제됩니다.
- GStreamer 로 SRT 를 보낸다면 `srtsink` 의 `latency` 는 밀리초 단위(`200`)입니다. FFmpeg 은 마이크로초(`200000`)입니다.

## 완료 확인 방법

| 항목 | 확인 |
|---|---|
| ROI | 대시보드 장치 상세에서 ROI 를 저장하면 30초 안에 배지가 "젯슨 적용됨 · vN" 으로 바뀜 |
| 회수 보고 | 대시보드에 "회수 보고" 알림, 통계 화면 회수율이 0% 가 아님 |
| 클립 | SRT 송출 중 사건이 생기면 약 10초 뒤 사건 상세에 10초짜리 영상 표시 (젯슨 작업 없음) |
| 타임스탬프 | 서버 로그에 recorder drift 오류가 없음 |
| 스냅샷 삭제 | 업로드 응답의 size·sha256 확인 후 로컬 삭제 |
| 디스크 | 하트비트 `disk_free_mb` 2,000 이상, "디스크 부족" 경고 해제 |
| 썸네일 | 장치 목록 카드에 화면 표시 |
