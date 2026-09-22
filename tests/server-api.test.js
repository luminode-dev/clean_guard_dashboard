import test from 'node:test';
import assert from 'node:assert/strict';
import {createServerApi,unwrapList} from '../assets/server-api.js';
import {connectEvents} from '../assets/realtime.js';

const NOW=new Date('2026-09-22T04:00:00Z'); // 13:00 KST
const config={apiBase:'',wsPath:'/ws/events',mediaBase:'/snapshots',live:{base:'https://live.example.duckdns.org',protocol:'webrtc'},sites:[{site_id:'site01',name:'현장 1'}],devices:[{device_id:'jetson01',site_id:'site01',name:'젯슨 1호기',stream:'site01_cam1'}]};
const jetsonEvents=[
 {id:17,device_id:'jetson01',timestamp:'2026-09-22T03:50:00Z',label:'쓰레기봉투',confidence:0.91,snapshot:'2026-09-22/17.jpg'},
 {id:16,device_id:'jetson01',timestamp:'2026-09-21T20:10:00Z',label:'종이박스',confidence:88,snapshot_url:'https://cdn.example/16.jpg',state:'confirmed',retrieved:true},
 {id:15,device_id:'jetson02',ts:1758400000,class:'대형가구',conf:0.6}
];
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
const response=(status,body,type='application/json')=>({ok:status>=200&&status<300,status,headers:{get:h=>h.toLowerCase()==='content-type'?type:null},json:async()=>body,text:async()=>typeof body==='string'?body:JSON.stringify(body)});
// FastAPI 흉내: /api/events 만 있고 나머지는 404
function fakeServer({events=jetsonEvents,extra={}}={}){
 const calls=[];
 const fetcher=async(url,init={})=>{
  calls.push({url,init});
  const u=new URL(url,'http://localhost');
  if(extra[u.pathname])return extra[u.pathname](u,init);
  if(u.pathname==='/api/events'&&(init.method||'GET')==='GET')return response(200,events);
  return response(404,{detail:'Not Found'});
 };
 return {fetcher,calls};
}
const make=(opts={})=>{const s=fakeServer(opts);return {api:createServerApi({config,fetcher:s.fetcher,now:()=>NOW,storage:memory()}),calls:s.calls};};

test('unwrapList accepts arrays and wrapped lists',()=>{
 assert.deepEqual(unwrapList([1,2]),{items:[1,2],total:2,paged:false});
 assert.equal(unwrapList({items:[1],total:9,page:1}).paged,true);
 assert.equal(unwrapList({events:[1,2,3]}).total,3);
 assert.equal(unwrapList(null).total,0);
});
test('flat Jetson payloads are normalized to the dashboard event shape',async()=>{
 const {api}=make();const {items,total}=await api.request('/api/events');
 assert.equal(total,3);assert.equal(items[0].event_id,'17');
 assert.equal(items[0].site_id,'site01');assert.equal(items[0].site.name,'현장 1');
 assert.equal(items[0].detection.class,'쓰레기봉투');assert.equal(items[0].detection.conf,0.91);
 assert.equal(items[0].media.snapshot,'/snapshots/2026-09-22/17.jpg');
 assert.equal(items[0].review.state,'new');assert.deepEqual(items[0].review.history,[]);
 const second=items.find(e=>e.event_id==='16');
 assert.equal(second.detection.conf,0.88);assert.equal(second.media.snapshot,'https://cdn.example/16.jpg');
 assert.equal(second.review.state,'confirmed');assert.equal(second.outcome.retrieved,true);
 const third=items.find(e=>e.event_id==='15');
 assert.equal(third.ts,new Date(1758400000*1000).toISOString());assert.equal(third.site_id,'unknown');
});
test('missing endpoints are derived from /api/events and the config',async()=>{
 const {api,calls}=make();
 const sites=await api.request('/api/sites');assert.deepEqual(sites.map(s=>s.site_id),['site01','unknown']);
 const devices=await api.request('/api/devices');
 assert.deepEqual(devices.map(d=>d.device_id),['jetson01','jetson02']);
 assert.equal(devices[0].status,'online');assert.equal(devices[0].site.name,'현장 1');
 assert.equal(devices[1].status,'offline');
 const overview=await api.request('/api/overview');
 assert.equal(overview.summary.events,2);assert.equal(overview.device_counts.online,1);assert.equal(overview.all_pending,2);assert.equal(overview.unacked_alerts,1); // 사건 17(12:50 KST)·16(05:10 KST) 모두 오늘
 const stats=await api.request('/api/stats?group_by=class');
 assert.equal(stats.rows.length,3);assert.equal(stats.summary.retrieved_rate,1);
 const alerts=await api.request('/api/alerts');assert.equal(alerts[0].device_id,'jetson02');
 await api.request('/api/alerts/'+alerts[0].alert_id+'/ack',{method:'POST'});
 assert.equal((await api.request('/api/alerts'))[0].acked,true);
 const one=await api.request('/api/events/17');assert.equal(one.detection.class,'쓰레기봉투');
 const csv=await api.request('/api/events.csv?q=jetson02');assert.equal(csv.split('\r\n').filter(Boolean).length,2);
 // 404 를 받은 엔드포인트는 한 번만 시도한다
 await api.request('/api/sites');
 assert.equal(calls.filter(c=>c.url==='/api/sites').length,1);
});
test('server-side filters are applied locally when the server ignores them',async()=>{
 const {api}=make();
 assert.equal((await api.request('/api/events?state=confirmed')).total,1);
 assert.equal((await api.request('/api/events?q=대형')).items[0].event_id,'15');
 assert.equal((await api.request('/api/events?size=2&page=2')).items.length,1);
});
test('paginated server responses are passed through',async()=>{
 const {api}=make({extra:{'/api/events':()=>response(200,{items:jetsonEvents.slice(0,2),total:50,page:3,size:2})}});
 const data=await api.request('/api/events?page=3&size=2');
 assert.equal(data.total,50);assert.equal(data.page,3);assert.equal(data.items.length,2);
});
test('server-provided endpoints win over derivation',async()=>{
 const {api}=make({extra:{'/api/overview':()=>response(200,{summary:{events:99},device_counts:{},all_pending:0,unacked_alerts:0}),'/api/context':()=>response(200,{user:'홍길동'})}});
 assert.equal((await api.request('/api/overview')).summary.events,99);
 const context=await api.request('/api/context');assert.equal(context.user,'홍길동');assert.equal(context.demo,false);
});
test('live stream URL is built from config for MediaMTX WHEP',async()=>{
 const {api}=make();
 const s=await api.request('/api/devices/jetson01/stream');
 assert.equal(s.live.protocol,'webrtc');assert.equal(s.live.url,'https://live.example.duckdns.org/site01_cam1/whep');
 assert.deepEqual(await api.request('/api/devices/jetson02/stream'),{connected:false});
 const hls=createServerApi({config:{...config,live:{...config.live,protocol:'hls',user:'viewer',pass:'pw'}},fetcher:fakeServer().fetcher,now:()=>NOW});
 const h=await hls.request('/api/devices/jetson01/stream');
 assert.equal(h.live.url,'https://live.example.duckdns.org/site01_cam1/index.m3u8');
 assert.equal(h.live.headers.Authorization,'Basic '+Buffer.from('viewer:pw').toString('base64'));
});
test('writes go to the server and unsupported writes explain what is missing',async()=>{
 let posted=null;
 const {api}=make({extra:{'/api/events/17/review':(u,init)=>{posted=JSON.parse(init.body);return response(200,{ok:true});}}});
 await api.request('/api/events/17/review',{method:'POST',body:JSON.stringify({state:'reviewing',version:0})});
 assert.equal(posted.state,'reviewing');
 await assert.rejects(()=>api.request('/api/devices/jetson01/maintenance',{method:'POST',body:'{}'}),/구현되지 않은/);
});
test('probe distinguishes reachable, unauthorized and missing servers',async()=>{
 assert.equal((await make().api.probe()).ok,true);
 const unauthorized=createServerApi({config,fetcher:async()=>response(401,{detail:'Unauthorized'}),now:()=>NOW});
 assert.deepEqual(await unauthorized.probe(),{ok:true,auth:true});
 const down=createServerApi({config,fetcher:async()=>{throw new TypeError('Failed to fetch');},now:()=>NOW});
 assert.equal((await down.probe()).ok,false);
 const other=createServerApi({config,fetcher:async()=>response(404,{}),now:()=>NOW});
 assert.equal((await other.probe()).code,'NOT_FOUND');
 await assert.rejects(()=>other.request('/api/overview'),/\/api\/events 를 찾을 수 없습니다/);
});
test('apiBase and wsPath resolve absolute and same-origin URLs',()=>{
 const same=createServerApi({config});
 assert.equal(same.wsUrl({origin:'https://sub.duckdns.org'}),'wss://sub.duckdns.org/ws/events');
 assert.equal(same.host({origin:'https://sub.duckdns.org'}),'sub.duckdns.org');
 const remote=createServerApi({config:{...config,apiBase:'https://sub.duckdns.org/'}});
 assert.equal(remote.wsUrl({origin:'http://127.0.0.1:4173'}),'wss://sub.duckdns.org/ws/events');
 assert.equal(remote.host({origin:'http://127.0.0.1:4173'}),'sub.duckdns.org');
 assert.equal(createServerApi({config:{...config,wsPath:''}}).wsUrl({origin:'https://x'}),null);
});
test('realtime client parses JSON and reconnects after close',async()=>{
 const sockets=[];
 class FakeSocket{constructor(url){this.url=url;sockets.push(this);setTimeout(()=>this.onopen?.(),0);}close(){this.onclose?.();}}
 const events=[],states=[];
 const client=connectEvents({url:'wss://x/ws/events',WebSocketImpl:FakeSocket,onEvent:e=>events.push(e),onStatus:s=>states.push(s)});
 await new Promise(r=>setTimeout(r,5));
 sockets[0].onmessage({data:'{"event_id":"1","class":"캔"}'});sockets[0].onmessage({data:'ping'});
 assert.deepEqual(events,[{event_id:'1',class:'캔'},'ping']);
 sockets[0].onclose();
 await new Promise(r=>setTimeout(r,1100));
 assert.equal(sockets.length,2);
 client.close();
 await new Promise(r=>setTimeout(r,1100));
 assert.equal(sockets.length,2);assert.ok(states.includes('open')&&states.includes('closed'));
});

// ---- jetson_data.md (초안 v0.1) 스키마 검증 ----
const specEvent={event_id:'01J8ZK3V9Q6X2N4M8P0R5S7T9V',device_id:'JT-GN-0007',site_id:'SITE-GN-0007',ts:'2026-09-19T14:02:41+09:00',received_at:'2026-09-19T14:02:43+09:00',
 detection:{class:'쓰레기봉투',class_id:0,color:'검은색',night:null,conf:0.75,bbox:[299,300,361,359],frame_size:[1920,1080]},
 suspect:{obj_id:4,owner_pid:4,owner_matched:false,person_bbox_at_drop:[280,210,330,340]},
 announce:{played:true,phrase:'역삼1동 수거함 앞에 검은색 쓰레기봉투를 무단으로 버리셨습니다.',suppressed_reason:null},
 media:{snapshot:'https://cdn/ev/01J8ZK/snapshot.jpg',snapshot_raw:'https://cdn/ev/01J8ZK/snapshot_raw.jpg',clip:'https://cdn/ev/01J8ZK/clip.mp4',clip_range_s:[-10,10]},
 review:{state:'confirmed',assignee:'user:kim',history:[{at:'2026-09-19T14:10:00+09:00',by:'user:kim',from:'new',to:'reviewing'},{at:'2026-09-19T14:12:30+09:00',by:'user:kim',from:'reviewing',to:'confirmed',note:'검정 봉투 1개'}],action:{type:'field_visit',at:'2026-09-19T16:00:00+09:00',result:'수거 완료',fine_issued:false}},
 outcome:{retrieved:false,retrieved_at:null,object_last_seen_at:'2026-09-19T15:58:10+09:00'},debug:{frame:403120,local_seq:38,model_format:'engine'}};
const specDevice={device_id:'JT-GN-0007',site_id:'SITE-GN-0007',name:'역삼1동 #1',hw:{model:'Jetson Orin Nano 8GB',serial:'1421xxxx',jetpack:'6.2'},sw:{version:'clean_guard 2026.09.19',models:{waste:{format:'engine'}}},status:'degraded',status_since:'2026-09-19T06:12:00+09:00',last_heartbeat_at:'2026-09-19T14:03:00+09:00',
 pipeline:{fps:14.2,infer_ms:{person:21,waste:19},stream:'ok'},tts:{worker:'ready',last_synth_ms:2400},system:{cpu_pct:61,gpu_pct:74,temp_c:{cpu:58.5,gpu:61},disk_free_mb:12400},issues:['model_fallback']};
const specSite={site_id:'SITE-GN-0007',name:'역삼1동 수거함 앞',region:{sido:'서울특별시',sigungu:'강남구',dong:'역삼1동',code:'1168064000'},address:'서울 강남구 역삼로 123',location:{lat:37.4979,lng:127.0276},dept:'청소행정과'};
const specStats={range:{from:'2026-09-01',to:'2026-09-19',tz:'Asia/Seoul'},group_by:'site',rows:[{site_id:'SITE-GN-0007',events:41,confirmed:33,dismissed:6,actioned:20,retrieved:18,retrieved_rate:0.44,by_class:{'쓰레기봉투':30,'종이박스':7,'대형가구':4},by_hour:[0,0,1,0,0,0,2,5,4,3,2,1,1,2,3,4,6,5,2,0,0,0,0,0],night_share:0.39,device_uptime_pct:99.2}]};
const specStream={device_id:'JT-GN-0007',protocol:'webrtc',url:'https://media.example/whep/JT-GN-0007',variants:[{id:'annotated',default:true}],resolution:[1280,720],fps:10,expires_at:'2026-09-19T14:33:00+09:00'};
const specThumb={device_id:'JT-GN-0007',ts:'2026-09-19T14:03:05+09:00',url:'https://media.example/thumb/JT-GN-0007/latest.jpg',size:[640,360],overlay:{persons:2,objects:1,events_today:3}};
const specAlert={alert_id:'01J8ZKALERT',ts:'2026-09-19T14:05:00+09:00',severity:'warning',kind:'device_degraded',device_id:'JT-GN-0007',site_id:'SITE-GN-0007',summary:'모델 폴백 (.engine → .onnx) — FPS 14 → 4',detail:{issue:'model_fallback'},acked:false,acked_by:null};
const specServer=()=>make({events:[specEvent],extra:{
 '/api/sites':()=>response(200,[specSite]),'/api/devices':()=>response(200,[specDevice]),'/api/alerts':()=>response(200,[specAlert]),
 '/api/stats':()=>response(200,specStats),'/api/devices/JT-GN-0007/stream':()=>response(200,specStream),'/api/devices/JT-GN-0008/stream':()=>response(200,specThumb)}});

test('spec §4 event passes through with nested fields, offsets and workflow intact',async()=>{
 const {api}=specServer();const e=(await api.request('/api/events')).items[0];
 assert.equal(e.event_id,'01J8ZK3V9Q6X2N4M8P0R5S7T9V');assert.equal(e.ts,'2026-09-19T05:02:41.000Z');assert.equal(e.received_at,'2026-09-19T05:02:43.000Z');
 assert.deepEqual(e.detection,{class:'쓰레기봉투',conf:0.75,night:null,color:'검은색',frame_size:[1920,1080],bbox:[299,300,361,359]});
 assert.equal(e.media.snapshot,'https://cdn/ev/01J8ZK/snapshot.jpg');assert.equal(e.media.clip,'https://cdn/ev/01J8ZK/clip.mp4');
 assert.equal(e.announce.played,true);assert.match(e.announce.phrase,/역삼1동/);
 assert.equal(e.review.state,'confirmed');assert.equal(e.review.history.length,2);assert.equal(e.review.action.type,'field_visit');assert.equal(e.review.assignee,'user:kim');
 assert.equal(e.outcome.retrieved,false);assert.equal(e.suspect.owner_matched,false);assert.equal(e.raw.media.snapshot_raw,'https://cdn/ev/01J8ZK/snapshot_raw.jpg');
 assert.equal(e.site.name,'역삼1동 수거함 앞');
});
test('spec §2/§3 device with merged heartbeat fields gets a heartbeat object',async()=>{
 const {api}=specServer();const [d]=await api.request('/api/devices');
 assert.equal(d.status,'degraded');assert.equal(d.heartbeat.pipeline.fps,14.2);assert.equal(d.heartbeat.system.temp_c.gpu,61);assert.equal(d.heartbeat.tts.worker,'ready');assert.deepEqual(d.heartbeat.issues,['model_fallback']);
 assert.equal(d.site.region.dong,'역삼1동');assert.equal(d.hw.model,'Jetson Orin Nano 8GB');
 const overview=await api.request('/api/overview');assert.equal(overview.device_counts.degraded,1);
});
test('spec §5 flat live/thumbnail responses become {live,thumbnail}',async()=>{
 const {api}=specServer();
 const live=await api.request('/api/devices/JT-GN-0007/stream');
 assert.equal(live.live.protocol,'webrtc');assert.equal(live.live.url,'https://media.example/whep/JT-GN-0007');assert.equal(live.live.variants[0].id,'annotated');
 const thumb=await api.request('/api/devices/JT-GN-0008/stream');
 assert.equal(thumb.thumbnail.url,'https://media.example/thumb/JT-GN-0007/latest.jpg');assert.equal(thumb.ts,'2026-09-19T14:03:05+09:00');assert.equal(thumb.live,undefined);
});
test('spec §8 stats rows gain label, summary and announce cohorts',async()=>{
 const {api}=specServer();const s=await api.request('/api/stats?from=2026-09-01&to=2026-09-19&group_by=site');
 assert.equal(s.rows[0].label,'역삼1동 수거함 앞');assert.equal(s.rows[0].retrieved_rate,0.44);
 assert.equal(s.summary.events,41);assert.equal(s.summary.confirmed,33);assert.equal(s.summary.retrieved_rate,18/33);assert.equal(s.summary.by_hour[7],5);assert.equal(s.summary.by_class['쓰레기봉투'],30);assert.equal(s.summary.night_share,0.39);
 assert.equal(s.announce_cohorts.length,2);assert.equal(s.announce_cohorts[0].played,true);
});
test('spec §6 alerts render fields the alert list needs',async()=>{
 const {api}=specServer();const [a]=await api.request('/api/alerts');
 assert.equal(a.kind,'device_degraded');assert.equal(a.severity,'warning');assert.match(a.summary,/모델 폴백/);assert.equal(a.acked,false);
});
test('server-provided live URL still gets viewer credentials from config',async()=>{
 const withCreds=createServerApi({config:{...config,live:{...config.live,user:'viewer',pass:'pw'}},fetcher:fakeServer({extra:{'/api/devices/JT-GN-0007/stream':()=>response(200,specStream)}}).fetcher,now:()=>NOW});
 const s=await withCreds.request('/api/devices/JT-GN-0007/stream');
 assert.equal(s.live.url,'https://media.example/whep/JT-GN-0007');
 assert.equal(s.live.headers.Authorization,'Basic '+Buffer.from('viewer:pw').toString('base64'));
});

test('wsUrl carries config auth as a query parameter for browsers',()=>{
 const withAuth=createServerApi({config:{...config,auth:{user:'admin',pass:'admin'}}});
 assert.equal(withAuth.wsUrl({origin:'https://sub.duckdns.org'}),'wss://sub.duckdns.org/ws/events?auth='+encodeURIComponent(Buffer.from('admin:admin').toString('base64')));
});
