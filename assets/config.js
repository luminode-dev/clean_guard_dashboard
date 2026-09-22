// Clean Guard 대시보드 연결 설정 · ip주소.md(2026-09-22) 기준
// 비밀번호·토큰은 이 파일에 적지 않습니다. 대시보드 비밀번호는 브라우저의 Basic Auth 창에서 입력합니다.
// 도메인: cleanguard.duckdns.org (DuckDNS) · 영상: live.cleanguard.duckdns.org
window.CLEAN_GUARD_CONFIG={
 // 'auto' : 서버(/api/events)가 응답하면 서버 모드, 아니면 브라우저 시연 데이터
 // 'server' : 항상 서버 모드 (서버가 없으면 오류 표시)
 // 'demo' : 항상 시연 데이터
 mode:'auto',

 // API 기준 주소. 비워 두면 대시보드를 연 주소(같은 출처)를 사용합니다.
 //  - 운영: Caddy가 https://cleanguard.duckdns.org 에서 대시보드와 /api, /ws 를 함께 서빙 → ''
 //  - 개발: npm start -- --api https://cleanguard.duckdns.org (프록시) → ''  · 서버 PC 에서는 --api http://127.0.0.1:8010
 //  - 다른 출처를 직접 호출하려면 'https://cleanguard.duckdns.org' (서버 CORS 허용 필요)
 apiBase:'',

 // 실시간 사건 WebSocket. 상대 경로면 apiBase(없으면 현재 출처)에 붙습니다. 비우면 사용 안 함.
 wsPath:'/ws/events',

 // 사건 스냅샷 상대 경로 앞에 붙일 경로 (서버 C:\server\app\snapshots\ 를 /snapshots 로 공개한다고 가정)
 mediaBase:'/snapshots',

 // 실시간 영상 (MediaMTX, Caddy 경유). WebRTC WHEP: {base}/{stream}/whep · HLS: {base}/{stream}/index.m3u8
 // viewer 계정을 비워 두면 영상 연결 시 브라우저에서 한 번 물어보고 이 탭에만 기억합니다.
 live:{base:'https://live.cleanguard.duckdns.org',protocol:'webrtc',user:'',pass:''},

// 서버에 /api/sites, /api/devices 가 없을 때 사용할 지점·장치 목록. ID 체계는 jetson_data.md (SITE-GN-0007 / JT-GN-0007) 를 따르고,
 // stream 은 MediaMTX 경로명(ip주소.md 의 site01_cam1)입니다. 젯슨이 실제로 보내는 device_id 와 반드시 같아야 합니다.
 // 사건의 device_id 가 여기 없으면 자동으로 추가됩니다. location 을 넣으면 지도에 표시됩니다.
 sites:[
  {site_id:'SITE-GN-0001',name:'현장 1 (site01)',address:'',location:null,region:{sido:'',sigungu:'',dong:'',code:''}}
 ],
 devices:[
  {device_id:'JT-GN-0001',site_id:'SITE-GN-0001',name:'젯슨 1호기 (jetson01 · cam1)',stream:'site01_cam1',hw:{model:'Jetson Orin Nano 8GB'}}
 ],

 // 참고용 (동작에는 사용하지 않음) · 내부 IP·공인 IP 는 서버 문서(ip주소.md)에만 둔다
 network:{
  domain:'cleanguard.duckdns.org',liveDomain:'live.cleanguard.duckdns.org',
  ports:{https:443,http:80,srt:'8890/udp',webrtc:'8189/udp',fastapi:'127.0.0.1:8010',mediamtxWebrtc:8889,mediamtxHls:8888}
 }
};
