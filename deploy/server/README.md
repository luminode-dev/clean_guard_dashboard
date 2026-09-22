# Clean Guard 수집·조회 API (FastAPI) — 서버 배포본 사본

`C:\server\app\` 에 실제로 배포된 파일의 사본입니다. 서버에서 수정하면 여기에도 복사해 두세요.

| 파일 | 역할 |
|---|---|
| `app.py` | FastAPI 앱 전체 (장치 수집 API + 대시보드 조회·처리 API + `/ws/events`) |
| `requirements.txt` | fastapi, uvicorn[standard], python-multipart |
| `settings.example.json` | `settings.json` 예시 (대시보드 계정, 도메인, 초기 지점·장치) |
| `run-app.cmd` | 실행 스크립트 · `C:\server\app\python\python.exe -m uvicorn app:app --port 8010` |
| `setup-admin.ps1` | 관리자 권한으로 부팅 시 자동 실행 작업(`CleanGuardAPI`) 등록 |

서버에는 임베디드 Python 3.12 를 `C:\server\app\python\` 에 두고 pip 로 requirements 를 설치했습니다. 장비 토큰은 `C:\server\app\device-tokens.txt`(`device_id=token` 한 줄씩), 데이터는 `events.db`(SQLite), 파일은 `snapshots\`(Caddy 가 `/snapshots/*` 로 공개).

## 저장·보존 규칙

- 서버는 **사건 증거만** 저장합니다(스냅샷·원본 스냅샷·전후 클립, `snapshots날짜사건ID`). 상시 녹화(MediaMTX record)는 켜지 않습니다. 실시간 영상은 지나가기만 하고, 상시 녹화 원본은 젯슨 NVMe 에 남습니다.
- 사건 수가 `settings.json` 의 `max_events`(기본 1000)를 넘으면 **먼저 들어온 사건(received_at 순)부터** DB 행, 미디어 폴더, 그 사건의 알림을 함께 삭제합니다. 처리 상태와 무관하게 순서대로 지웁니다. 새 사건이 들어올 때와 30초 감시 루프에서 검사합니다.
- 1건당 스냅샷 2장(수백 KB) + 클립(720p 20초, 약 4 MB) 기준으로 1000건이면 약 5 GB 입니다.
- 현재 건수와 상한은 `GET /api/context` 의 `retention` 으로 확인합니다.

## 계약 요약

장치(Bearer 토큰): `POST /api/events`, `POST /api/events/{id}/update`, `POST /api/events/{id}/media`(multipart), `POST /api/heartbeat`, `PUT /api/devices/{id}/thumbnail`
대시보드(Basic, realm "Clean Guard"): `/api/context`, `/api/sites`, `/api/devices`, `/api/events`, `/api/events.csv`, `/api/events/{id}`, `/api/events/{id}/raw`, `/api/overview`, `/api/stats`, `/api/alerts`, `/api/devices/{id}/stream|uptime`, `POST …/review|ack|maintenance|sites|devices`, `WS /ws/events`

자세한 페이로드는 `../../../jetson_handoff.md`, 데이터 정의는 `jetson_data.md` 를 따릅니다.

## 전자정부 프레임워크와의 관계

이 FastAPI 는 젯슨 이벤트 **수집 서비스**입니다. 발주처가 전자정부 표준프레임워크 적용을 요구하면 운영 업무(대시보드 백엔드, 결재·과태료 연계, 사용자 권한)는 eGovFrame(Spring) 으로 두고, 이 서비스는 (1) 그대로 별도 수집 서버로 두거나 (2) 같은 계약을 Spring 컨트롤러로 옮기면 됩니다. 대시보드는 `/api/*` 경로 계약만 보므로 어느 쪽이든 그대로 동작합니다.
