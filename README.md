# Clean Guard Dashboard · Frontend

Clean Guard 대시보드 화면만 분리한 독립 프런트엔드입니다. Java/eGovFrame 서버, 데이터베이스, 장치 프로그램, 실제 운영 데이터와 계정은 포함하지 않습니다.

## 실행

Node.js 20 이상에서 저장소를 내려받고 실행합니다. 패키지 설치나 빌드는 필요하지 않습니다.

```sh
npm start
```

브라우저에서 http://127.0.0.1:4173 을 엽니다. `index.html`을 직접 더블클릭하지 말고 HTTP 서버로 실행하세요.

서버(`/api/events`)가 응답하지 않으면 자동으로 브라우저 시연 데이터로 동작합니다. 실제 서버와 연결하는 방법은 아래 [실제 서버 연결](#실제-서버-연결)을 보세요.

정적 호스팅에는 `index.html`과 `assets/` 폴더를 함께 올리면 됩니다. 상대 경로를 사용하므로 저장소 이름이 붙는 하위 경로에서도 실행할 수 있습니다. GitHub 저장소 업로드 자체가 웹사이트 공개를 의미하지는 않습니다.

## 실제 서버 연결

서버 네트워크 구성(`ip주소.md`, 2026-09-22 기준)에 맞춰 대시보드가 통신하는 주소는 다음과 같습니다. 도메인은 DuckDNS `cleanguard.duckdns.org`입니다.

| 용도 | 주소 | 인증 | 대시보드 설정 |
|---|---|---|---|
| 사건 목록 / 상세 | `https://cleanguard.duckdns.org/api/...` (Caddy → FastAPI 127.0.0.1:8010) | 대시보드 계정 (Basic Auth) | `apiBase` |
| 실시간 사건 | `wss://cleanguard.duckdns.org/ws/events` | 대시보드 계정 | `wsPath` |
| 사건 스냅샷 | `https://cleanguard.duckdns.org/snapshots/...` | 대시보드 계정 | `mediaBase` |
| 실시간 영상 | `https://live.cleanguard.duckdns.org/site01_cam1/whep` (Caddy → MediaMTX 8889, 미디어 UDP 8189) | viewer 계정 | `live` |
| 젯슨 이벤트 수신 | `POST https://cleanguard.duckdns.org/api/events` | Bearer 장비토큰 | 대시보드와 무관 |

서버 내부 IP와 공인 IP는 서버 문서(ip주소.md)에만 두고, 공인 IP는 유동이므로 대시보드는 도메인만 사용합니다. 같은 와이파이에서 도메인 접속이 안 되면 NAT 루프백 문제이니 휴대폰 LTE로 확인하세요.

### 1. 연결 설정 · `assets/config.js`

```js
window.CLEAN_GUARD_CONFIG={
 mode:'auto',                 // 'auto' | 'server' | 'demo'
 apiBase:'',                  // '' = 대시보드를 연 주소와 같은 출처 (권장)
 wsPath:'/ws/events',
 mediaBase:'/snapshots',
 live:{base:'https://live.cleanguard.duckdns.org',protocol:'webrtc',user:'',pass:''},
 sites:[{site_id:'site01',name:'현장 1',location:{lat:37.5,lng:127.0}}],
 devices:[{device_id:'jetson01',site_id:'site01',name:'젯슨 1호기',stream:'site01_cam1'}]
};
```

- 비밀번호·토큰은 넣지 않습니다. 대시보드 계정은 브라우저 Basic Auth 창에서 입력하고, 영상 viewer 계정은 `live.user/pass`를 비워 두면 영상 연결 시 한 번 물어본 뒤 해당 탭에만 기억합니다.
- `sites`/`devices`는 서버에 `/api/sites`, `/api/devices`가 없을 때 사용하는 목록입니다. 사건에 새 `device_id`가 나타나면 자동으로 추가되며, `stream`이 MediaMTX 경로명입니다. `location`을 넣으면 지도에 표시됩니다.
- `apiBase`에 다른 출처를 적으면 FastAPI 쪽 CORS 허용과 `auth:{user,pass}` 설정이 필요합니다. 같은 출처(아래 2, 3)를 권장합니다.

### 2. 개발 PC에서 운영 서버에 붙이기 (프록시)

```sh
npm start -- --api https://cleanguard.duckdns.org
```

`/api`, `/ws`, `/snapshots` 요청을 운영 서버로 프록시하므로 CORS 없이 같은 출처처럼 동작하고 Basic Auth도 그대로 통과합니다. 서버 PC에서 FastAPI로 직접 붙이려면 `--api http://127.0.0.1:8010`, 같은 망의 휴대폰에서 열려면 `--host 0.0.0.0`을 추가합니다. 환경 변수 `API_TARGET`, `PORT`, `HOST`, `PROXY_PATHS`, `API_INSECURE=1`(자체 서명 인증서)로도 지정할 수 있습니다.

### 3. 운영 배포 (Caddy · MediaMTX · FastAPI)

`index.html`과 `assets/`를 서버의 `C:\server\dashboard`에 복사하고, `deploy/Caddyfile.example`을 참고해 `C:\server\caddy\Caddyfile`에서 정적 파일 + `/api/*`, `/ws/*` 프록시 + Basic Auth를 구성합니다. 수집·조회 API 는 `deploy/server/app.py`(FastAPI, 127.0.0.1:8010) 로, 서버의 `C:serverapp` 배포본 사본입니다. 젯슨 → 서버 계약과 대시보드 → 서버 계약을 모두 구현하므로 대시보드는 파생 계산 없이 서버 응답을 그대로 씁니다. `deploy/mediamtx.example.yml`은 서버에 실제 배포한 `C:servermediamtxmediamtx.yml`과 같은 구성(SRT 8890 수신, WebRTC 8889/8189, jetson01 송출·viewer 시청 계정)입니다. 서버 배포본의 `config.js`에는 viewer 계정을 넣어 두었고, 저장소의 `config.js`는 비워 둡니다.

### 서버 API 계약

데이터 정의는 `jetson_data.md`(초안 v0.1, 2026-09-19)를 따릅니다. Site/Device/Heartbeat/Event/Stream/Alert/Stats 예시 JSON을 그대로 넣어 검증하는 테스트가 `tests/server-api.test.js`에 있습니다. 대시보드는 `assets/server-api.js`를 통해 서버와 통신합니다. 필수 엔드포인트는 `GET /api/events` 하나이며, 배열 또는 `{items|events|results, total, page, size}` 형태를 모두 받습니다. 사건 필드는 `event_id|id`, `device_id`, `ts|timestamp|created_at`, `class|label|detection.class`, `conf|confidence|score`(0~1 또는 0~100), `snapshot|snapshot_url|media.snapshot`, `state|review.state` 등 흔한 이름을 자동으로 맞춥니다(`normalizeEvent`).

문서와 화면 계약이 다른 부분은 어댑터가 맞춥니다. Device에 병합된 하트비트 값(`pipeline`, `system`, `tts`, `issues`)은 `heartbeat` 객체로, §5의 평면 스트림 응답(`{protocol,url,variants}` / `{url,size,overlay}`)은 `{live,thumbnail}`로, §8의 `rows[{site_id,…}]` 통계는 `label`·`summary`·`announce_cohorts`를 채워 넘깁니다. WebSocket 메시지는 사건 / `event_update`(회수 보고) / 하트비트 / 알림 / 트랙으로 구분해 처리합니다.

다음 엔드포인트는 서버에 있으면 그대로 쓰고, 404이면 사건 목록으로 파생 계산합니다: `/api/context`, `/api/sites`, `/api/devices`, `/api/overview`, `/api/stats`, `/api/alerts`, `/api/events.csv`, `/api/events/{id}`, `/api/devices/{id}/stream`, `/api/devices/{id}/uptime`. 장치 상태 API가 없으면 최근 24시간 사건 수신 여부로 정상/오프라인을 표시합니다.

쓰기 요청(`POST /api/events/{id}/review`, `/api/alerts/{id}/ack`, `/api/devices/{id}/maintenance`, `/api/sites`, `/api/devices`)은 서버로 그대로 전달하며, 서버에 없으면 어떤 엔드포인트가 필요한지 화면에 안내합니다. `/ws/events`로 JSON 사건이 오면 알림을 띄우고 화면을 새로 조회합니다.

## 포함 화면과 시연 동작

- 통합 관제: 지도, 장치 상태, 탐지 현황, 최근 사건
- 장치 · 영상: 검색, 상세 상태, 점검 모드, 지점/장치 등록, 라이브 영상 위 ROI(감시·제외 구역) 그리기 → 젯슨 전송
- 사건 관리: 검색/필터, 페이지 이동, 처리 상태 변경과 이력, CSV 다운로드, 투기 장면 영상(서버가 SRT 버퍼에서 앞뒤 10초 자동 추출)
- 통계 분석: 기간/분류별 집계, 회수율, 방송 여부별 비교
- 알림 센터: 알림 확인, 미확인/확인 완료 필터

`assets/demo-api.js`가 브라우저 안에서 8개 지점과 84건의 가상 사건을 생성합니다. 변경 사항은 해당 브라우저의 localStorage에만 저장됩니다. 좌측 하단 ↺ 버튼으로 시연 데이터를 초기화할 수 있습니다. 저장된 사건 날짜가 오래되었다면 초기화하여 오늘 기준 데이터를 새로 만드세요.

시연 모드에서는 실제 인증, 장치 통신, 영상 송출, 운영 감사 기록을 제공하지 않습니다. 영상과 증거 이미지는 미연결 상태를 표시합니다. 실제 토큰이나 개인정보를 입력하지 마세요. 시연 등록 폼에 입력한 토큰은 저장하지 않습니다. 지도 배경은 OpenStreetMap 인터넷 연결이 필요하며 나머지 데이터 동작은 로컬에서 처리합니다.

## 구성

```text
index.html             화면 레이아웃
assets/app.css         반응형 스타일
assets/app.js          화면 흐름과 사용자 동작 (서버/시연 모드 자동 선택)
assets/ui.js           공통 UI와 차트
assets/config.js       서버 연결 설정 (도메인, API/WS 경로, 영상 서버, 지점·장치 목록)
assets/server-api.js   실제 서버 어댑터 (응답 정규화, 없는 엔드포인트 파생 계산)
assets/realtime.js     /ws/events 실시간 수신 (자동 재접속)
assets/demo-api.js     로컬 시연 데이터 어댑터
assets/live.js         실시간 영상 플레이어 (MediaMTX WebRTC WHEP / HLS, viewer 인증)
assets/roi-editor.js   ROI 다각형 편집기 (캔버스 오버레이, 0~1 정규화 좌표, 판정 규칙)
assets/vendor/         Leaflet, hls.js 및 라이선스
scripts/serve.mjs      개발용 정적 파일 서버 + API/WS 프록시
deploy/                Caddy, MediaMTX 설정 예시 · server/ (FastAPI 수집·조회 API 배포본)
tests/                 시연 데이터 · 서버 어댑터 · 실시간 수신 테스트
```

서버 계약이 확정되면 `assets/server-api.js`의 `normalizeEvent`와 파생 계산 부분을 서버 응답에 맞춰 줄이면 됩니다. 인증/권한과 CSRF는 Caddy/FastAPI 쪽 정책을 따릅니다.

## 검증

```sh
npm test
```

화면별 데이터, 상태 전이와 이력 저장, 동시 변경 거절, 검색/CSV/초기화, 토큰 저장 제외, 회수율 분모를 검증합니다. 서버 어댑터 테스트는 젯슨형 평면 사건 응답의 정규화, 404 엔드포인트 파생 계산, 페이지 응답 통과, WHEP/HLS 주소 생성, 인증/미연결 판별, WebSocket 재접속을 검증합니다.
