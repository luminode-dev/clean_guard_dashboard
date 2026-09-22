const KEY='clean-guard-ui-demo-v1';
const copy=v=>structuredClone(v);
export const day=v=>new Date(new Date(v).getTime()+32400000).toISOString().slice(0,10);
export const hour=v=>new Date(new Date(v).getTime()+32400000).getUTCHours();
const confirmed=e=>['confirmed','actioned'].includes(e.review.state);
function check(ok,message){if(!ok)throw new Error(message);}
function seed(now){
 const names=['역삼1동 수거함 앞','논현2동 공영주차장','대치2동 골목길','삼성1동 분리수거장','도곡1동 주민센터','청담동 근린공원','역삼2동 상가 뒷길','개포2동 자원회수소'];
 const coords=[[37.4979,127.0376],[37.5171,127.0374],[37.4997,127.0657],[37.5144,127.0604],[37.4909,127.043],[37.5237,127.0499],[37.495,127.0471],[37.483,127.0686]];
 const sites=names.map((name,i)=>({site_id:'SITE-GN-'+String(i+1).padStart(4,'0'),name,address:'서울특별시 강남구 '+name.split(' ')[0]+' (시연 지점)',location:{lat:coords[i][0],lng:coords[i][1]},region:{sido:'서울특별시',sigungu:'강남구',dong:name.split(' ')[0],code:'11680'+String(i+1).padStart(5,'0')}}));
 const devices=sites.map((s,i)=>({device_id:'JT-GN-'+String(i+1).padStart(4,'0'),site_id:s.site_id,name:s.name,status:i<5?'online':i===5?'degraded':i===6?'offline':'maintenance',maintenance:i===7,previous_status:'offline',demo:true,hw:{model:'Jetson Orin Nano (시연)'},last_heartbeat_at:now.toISOString(),last_received_at:now.toISOString(),heartbeat:i<6?{pipeline:{fps:i===5?4.2:14.3+i/10},system:{cpu_pct:45+i*3,gpu_pct:55+i*3,temp_c:{cpu:56+i,gpu:59+i},disk_free_mb:12400},tts:{worker:'ready',last_synth_ms:2400},issues:i===5?['low_fps']:[]}:null}));
 const states=['new','reviewing','confirmed','actioned','confirmed','dismissed','actioned'];
 const classes=['쓰레기봉투','종이박스','플라스틱','쓰레기봉투','페트','대형가구','스티로폼','캔'];
 const events=Array.from({length:84},(_,i)=>{
  const ts=new Date(now.getTime()-(i<24?i*2700000:(i-23)*7200000+86400000)).toISOString(),state=states[i%7];
  const steps=state==='new'?[]:state==='dismissed'?['dismissed']:['reviewing',...(state!=='reviewing'?['confirmed']:[]),...(state==='actioned'?['actioned']:[])];
  return {event_id:'DEMO-'+String(i+1).padStart(6,'0'),device_id:devices[i%8].device_id,site_id:sites[i%8].site_id,ts,received_at:ts,version:steps.length,detection:{class:classes[i%8],conf:.72+i%20/100,night:i%3===0?'IR':null,color:'흰색',frame_size:[1920,1080],bbox:[299,300,361,359]},media:{},announce:{played:i%5!==0,phrase:'올바른 분리배출에 동참해 주세요.'},outcome:{retrieved:['confirmed','actioned'].includes(state)&&i%3!==0},review:{state,history:steps.map((to,j)=>({from:j?steps[j-1]:'new',to,by:'시연 운영자',at:ts,note:'시연 처리 기록'})),reason:state==='dismissed'?'false_positive':null,action:state==='actioned'?{type:'collection',result:'시연 수거 완료'}:null}};
 });
 const alerts=[{alert_id:'DEMO-ALERT-1',device_id:devices[6].device_id,type:'offline',severity:'critical',title:'장치 연결 끊김',message:'시연 장치의 하트비트가 수신되지 않았습니다.'},{alert_id:'DEMO-ALERT-2',device_id:devices[5].device_id,type:'degraded',severity:'warning',title:'추론 속도 저하',message:'시연 장치의 처리 속도를 확인하세요.'}].map(a=>({...a,kind:'device_'+a.type,summary:a.title,ts:now.toISOString(),created_at:now.toISOString(),acked:false,resolved:false}));
 return {schema:1,sites,devices,events,alerts};
}
export function summary(items){
 const c=items.filter(confirmed),retrieved=c.filter(e=>e.outcome.retrieved).length;
 const by_hour=Array(24).fill(0),by_class={};
 for(const e of items){by_hour[hour(e.ts)]++;by_class[e.detection.class]=(by_class[e.detection.class]||0)+1;}
 return {events:items.length,confirmed:c.length,retrieved,retrieved_rate:c.length?retrieved/c.length:null,actioned:items.filter(e=>e.review.state==='actioned').length,dismissed:items.filter(e=>e.review.state==='dismissed').length,pending:items.filter(e=>['new','reviewing'].includes(e.review.state)).length,night_share:items.length?items.filter(e=>e.detection.night).length/items.length:null,by_hour,by_class};
}
export function createDemoApi({storage,now=()=>new Date()}={}){
 let state;
 try{state=JSON.parse(storage?.getItem(KEY)||'null');}catch{}
 if(state?.schema!==1||!['sites','devices','events','alerts'].every(k=>Array.isArray(state[k])))state=seed(now());
 const save=()=>storage?.setItem(KEY,JSON.stringify(state));
 const withSite=v=>({...v,site:state.sites.find(s=>s.site_id===v.site_id)});
 function filtered(p){
  for(const key of ['from','to'])check(!p.get(key)||/^\d{4}-\d{2}-\d{2}$/.test(p.get(key)),'날짜 형식이 올바르지 않습니다.');
  check(!p.get('from')||!p.get('to')||p.get('from')<=p.get('to'),'시작일이 종료일보다 늦습니다.');
  return state.events.filter(e=>(!p.get('from')||day(e.ts)>=p.get('from'))&&(!p.get('to')||day(e.ts)<=p.get('to'))&&(!p.get('site_id')||e.site_id===p.get('site_id'))&&(!p.get('state')||e.review.state===p.get('state'))&&(!p.get('class')||e.detection.class===p.get('class'))&&(!p.get('q')||[e.event_id,e.device_id,e.detection.class,withSite(e).site?.name].join(' ').toLowerCase().includes(p.get('q').toLowerCase()))).sort((a,b)=>b.ts.localeCompare(a.ts)||a.event_id.localeCompare(b.event_id));
 }
 function route(url,options){
  const u=new URL(url,'http://demo.local'),p=u.searchParams,path=u.pathname,method=options.method||'GET',body=options.body?JSON.parse(options.body):{};
  if(method==='GET'){
   if(path==='/api/context')return {user:'시연 운영자',demo:true,investigator:false,server_time:now().toISOString()};
   if(path==='/api/sites')return state.sites;
   if(path==='/api/devices')return state.devices.map(withSite);
   if(path==='/api/alerts')return state.alerts;
   if(path==='/api/overview')return {summary:summary(state.events.filter(e=>day(e.ts)===day(now()))),device_counts:state.devices.reduce((a,d)=>(a[d.status]=(a[d.status]||0)+1,a),{}),all_pending:summary(state.events).pending,unacked_alerts:state.alerts.filter(a=>!a.acked&&!a.resolved).length};
   if(path==='/api/stats'){
    const items=filtered(p),group=p.get('group_by')||'site',groups=new Map();
    for(const e of items){const s=withSite(e).site,label=group==='day'?day(e.ts):group==='hour'?hour(e.ts)+'시':group==='class'?e.detection.class:group==='region'?s?.region.dong:s?.name;groups.set(label,[...(groups.get(label)||[]),e]);}
    return {summary:summary(items),rows:[...groups].map(([label,es])=>({label,...summary(es)})),announce_cohorts:[true,false].map(played=>({played,...summary(items.filter(e=>e.announce.played===played))}))};
   }
   if(path==='/api/events'){const items=filtered(p),size=Math.max(1,Math.min(100,Number(p.get('size'))||12)),page=Math.max(1,Number(p.get('page'))||1);return {total:items.length,page,size,items:items.slice((page-1)*size,page*size).map(withSite)};}
   if(path==='/api/events.csv'){
    const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
    return '\uFEFF'+[['사건 ID','발생 시각','지점','종류','상태','회수'],...filtered(p).map(e=>[e.event_id,e.ts,withSite(e).site?.name,e.detection.class,e.review.state,e.outcome.retrieved])].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';
   }
   const event=path.match(/^\/api\/events\/([^/]+)$/);if(event){const e=state.events.find(e=>e.event_id===decodeURIComponent(event[1]));check(e,'사건을 찾을 수 없습니다.');return withSite(e);}
   if(/^\/api\/devices\/[^/]+\/stream$/.test(path))return {connected:false};
   if(/^\/api\/devices\/[^/]+\/uptime$/.test(path))return {device_uptime_pct:null,observed_seconds:0};
  }
  if(method==='POST'){
   const review=path.match(/^\/api\/events\/([^/]+)\/review$/);
   if(review){const e=state.events.find(e=>e.event_id===decodeURIComponent(review[1]));check(e,'사건을 찾을 수 없습니다.');check(body.version===e.version,'다른 변경이 있습니다. 다시 조회하세요.');const from=e.review.state;check(({new:['reviewing','dismissed'],reviewing:['confirmed','dismissed'],confirmed:['actioned']}[from]||[]).includes(body.state),'허용되지 않은 상태 변경입니다.');if(body.state==='dismissed')check(['false_positive','authorized','duplicate'].includes(body.reason),'제외 사유가 필요합니다.');if(body.state==='actioned')check(body.action?.type&&body.action?.result?.trim(),'조치 유형과 결과가 필요합니다.');e.review.state=body.state;e.review.history.push({from,to:body.state,at:now().toISOString(),by:'시연 운영자',note:body.note||''});if(body.state==='dismissed')e.review.reason=body.reason;if(body.state==='actioned')e.review.action=copy(body.action);e.version++;return withSite(e);}
   const ack=path.match(/^\/api\/alerts\/([^/]+)\/ack$/);if(ack){const a=state.alerts.find(a=>a.alert_id===ack[1]);check(a,'알림이 없습니다.');a.acked=true;a.acked_by='시연 운영자';return a;}
   const maintenance=path.match(/^\/api\/devices\/([^/]+)\/maintenance$/);if(maintenance){const d=state.devices.find(d=>d.device_id===maintenance[1]);check(d,'장치가 없습니다.');if(body.enabled&&!d.maintenance)d.previous_status=d.status;d.maintenance=!!body.enabled;d.status=d.maintenance?'maintenance':d.previous_status||'offline';state.alerts.filter(a=>a.device_id===d.device_id).forEach(a=>a.resolved=d.maintenance);return withSite(d);}
   if(path==='/api/sites'){check(body.site_id&&body.name&&body.address,'필수 항목을 입력하세요.');check(!state.sites.some(s=>s.site_id===body.site_id),'이미 등록된 지점입니다.');check(Number.isFinite(body.location?.lat)&&Math.abs(body.location.lat)<=90&&Number.isFinite(body.location?.lng)&&Math.abs(body.location.lng)<=180,'위치가 올바르지 않습니다.');const s={site_id:body.site_id,name:body.name,address:body.address,location:body.location,region:body.region||{}};state.sites.push(s);return s;}
   if(path==='/api/devices'){check(body.device_id&&body.name&&state.sites.some(s=>s.site_id===body.site_id),'장치 정보와 설치 지점을 확인하세요.');check(!state.devices.some(d=>d.device_id===body.device_id),'이미 등록된 장치입니다.');const d={device_id:body.device_id,name:body.name,site_id:body.site_id,status:'offline',maintenance:false,demo:true,heartbeat:null};state.devices.push(d);return withSite(d);}
  }
  throw new Error('지원하지 않는 시연 요청입니다: '+path);
 }
 return {request:async(url,options={})=>{const stored=storage?.getItem(KEY);if(stored){const latest=JSON.parse(stored);if(latest.schema===1)state=latest;}const before=copy(state);try{const result=route(url,options);if(options.method==='POST')save();return copy(result);}catch(error){state=before;throw error;}},reset(){const fresh=seed(now());storage?.setItem(KEY,JSON.stringify(fresh));state=fresh;}};
}
