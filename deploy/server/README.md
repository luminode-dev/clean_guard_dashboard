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

## ROI 원격 설정

대시보드에서 그린 감시·제외 구역(0~1 정규화 다각형)을 `device_config` 테이블에 버전과 함께 저장합니다. 하트비트 응답의 `config.roi_version` 으로 젯슨에 알리고, 젯슨은 `GET /api/device/config` 로 받아 `config/roi.json` 에 저장한 뒤 `POST /api/device/config/ack` 로 결과를 보고합니다. 저장 시 `base_version` 이 다르면 409(동시 편집 방지). 적용 상태(`none|pending|applied|failed`)는 `/ws/events` 의 `device_config` 메시지로 대시보드에 실시간 반영됩니다.

## 방송 음성

미디어 업로드의 `announce_audio` 파트로 젯슨이 방송한 TTS 음성(WAV, RIFF/WAVE 헤더 확인, 10 MB 이하, 아니면 415)을 받아 사건 폴더의 `announce.wav` 로 저장합니다. `media.announce_audio`(URL)와 `announce_audio_s`(재생 길이)가 사건에 붙고, 대시보드 사건 상세와 목록 방송 칸에서 재생됩니다. 사건과 함께 1000건 보존 규칙으로 지워집니다.

## 설치 위치 원격 설정

대시보드 장치 상세의 설치 위치에서 지점명·주소·좌표를 저장하면(`PUT /api/sites/{site_id}`, `base_version` 충돌 시 409) 지점 `version` 이 올라가고, 하트비트 응답 `config.site_version` 으로 젯슨에 알립니다. 젯슨은 `GET /api/device/config` 의 `site` 를 `config/site.json` 에 저장하고 `POST /api/device/config/ack` 에 `site_version` 으로 보고합니다(적용 상태는 `device_site_applied` 테이블). 주소 검색은 `GET /api/geocode?q=`, 좌표→주소는 `GET /api/geocode/reverse` 로 서버가 OpenStreetMap Nominatim 을 대신 호출합니다(초당 1회, 결과 캐시). 하트비트에 `gps` 가 오면 장치에 저장되어 편집 화면에서 "젯슨 GPS 위치 사용" 으로 쓸 수 있습니다.

## 사건 클립 (서버 자동 추출)

젯슨은 클립을 만들거나 보관하지 않습니다. MediaMTX 가 SRT 로 들어오는 영상을 최근 30분만 순환 녹화하고(`recordDeleteAfter: 30m`), 사건이 들어오면 FastAPI 가 사건 시각 기준 앞 5초 ~ 뒤 5초를 로컬 재생 서버(`127.0.0.1:9996/get?format=mp4`)로 잘라 사건 폴더의 `clip.mp4` 로 저장합니다. 재인코딩이 없어 1~2초면 끝나며, 영상 클립은 용량이 커서 따로 **최대 500개**만 보관합니다. 넘으면 먼저 들어온 사건의 `clip.mp4` 만 지우고(`clip_status: expired`), 사건 기록과 사진은 `max_events`(1000건) 규칙대로 남깁니다.

- 상태: `media.clip_status` = `pending`(뒤 5초 대기) → `ready` | `missing`, 보관 개수 초과 시 `expired`. 대시보드 사건 상세가 실시간으로 영상으로 바뀝니다.
- 장치 시계가 서버 수신 시각과 120초 넘게 어긋나면 수신 시각 기준으로 자르고 `clip_note` 에 남깁니다.
- 구간 일부만 영상이 있으면 `clip_note` 에 "요청 10초 중 N초만 영상" 으로 표시, 전혀 없으면 `missing`.
- 사건이 30분 넘게 늦게 도착하면(오프라인 큐) 버퍼에서 이미 지워져 `missing`.
- 젯슨이 `clip` 을 직접 올리면 그 파일을 우선하되, 서버가 `clip_range_s` 를 기준으로 설정된 앞뒤 구간(기본 5초+5초)만 남기도록 잘라 저장합니다(ffmpeg 무손실 복사, `C:serverfmpeg`). 업로드 응답의 size/sha256 은 젯슨이 보낸 원본 기준입니다. 서버 추출 작업은 젯슨 클립이 이미 있으면 상태를 덮어쓰지 않습니다.
- 설정: `settings.json` 의 `clip: {pre_s, post_s, max_clips, buffer_s, skew_limit_s}` (기본 5, 5, 500, 1800, 120). 클립 1개는 약 2 MB 라 500개면 약 1 GB 입니다.
- 미디어 업로드 응답의 `files.{name}.size/sha256` 으로 젯슨이 업로드 성공을 검증한 뒤 로컬 파일을 지웁니다.

## 계약 요약

장치(Bearer 토큰): `POST /api/events`, `POST /api/events/{id}/update`, `POST /api/events/{id}/media`(multipart), `POST /api/heartbeat`(응답에 `config.roi_version`), `PUT /api/devices/{id}/thumbnail`, `GET /api/device/config`, `POST /api/device/config/ack`
대시보드(Basic, realm "Clean Guard"): `/api/context`, `/api/sites`, `/api/devices`, `/api/events`, `/api/events.csv`, `/api/events/{id}`, `/api/events/{id}/raw`, `/api/overview`, `/api/stats`, `/api/alerts`, `/api/devices/{id}/stream|uptime|roi`, `PUT /api/devices/{id}/roi`, `POST …/review|ack|maintenance|sites|devices`, `WS /ws/events`

자세한 페이로드는 `../../../jetson_handoff.md`, 데이터 정의는 `jetson_data.md` 를 따릅니다.

## 전자정부 프레임워크와의 관계

이 FastAPI 는 젯슨 이벤트 **수집 서비스**입니다. 발주처가 전자정부 표준프레임워크 적용을 요구하면 운영 업무(대시보드 백엔드, 결재·과태료 연계, 사용자 권한)는 eGovFrame(Spring) 으로 두고, 이 서비스는 (1) 그대로 별도 수집 서버로 두거나 (2) 같은 계약을 Spring 컨트롤러로 옮기면 됩니다. 대시보드는 `/api/*` 경로 계약만 보므로 어느 쪽이든 그대로 동작합니다.
