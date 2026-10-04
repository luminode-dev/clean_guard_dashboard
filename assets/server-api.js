// 실제 서버(Caddy → FastAPI) 연결 어댑터.
// app.js 는 demo-api.js 와 같은 request(url, options) 계약만 사용하므로, 여기서 서버 응답을 화면 모델로 맞춥니다.
// 서버가 아직 제공하지 않는 조회 엔드포인트(404)는 /api/events 목록으로 파생 계산합니다.
import {summary,day,hour} from './demo-api.js';

const DEFAULTS={mode:'auto',apiBase:'',wsPath:'/ws/events',mediaBase:'/snapshots',live:{protocol:'webrtc'},sites:[],devices:[],auth:null};
const STATES=['new','reviewing','confirmed','actioned','dismissed'];
const ACK_KEY='clean-guard-server-acks';
const get=(o,path)=>path.split('.').reduce((a,k)=>a==null?undefined:a[k],o);
const pick=(o,...paths)=>{for(const p of paths){const v=get(o,p);if(v!=null&&v!=='')return v;}return undefined;};
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
function iso(v,fallback){
 if(v==null)return fallback;
 if(typeof v==='number'){const d=new Date(v<1e12?v*1000:v);return isNaN(d)?fallback:d.toISOString();}
 const d=new Date(v);return isNaN(d)?fallback:d.toISOString();
}
export function unwrapList(data){
 if(Array.isArray(data))return {items:data,total:data.length,paged:false};
 if(data&&typeof data==='object'){
  const items=[data.items,data.events,data.results,data.data,data.rows].find(Array.isArray)||[];
  return {items,total:Number(data.total??data.count??items.length),paged:data.page!=null||data.size!=null||data.limit!=null};
 }
 return {items:[],total:0,paged:false};
}
export function createServerApi({config={},fetcher,now=()=>new Date(),storage}={}){
 const cfg={...DEFAULTS,...config,live:{...DEFAULTS.live,...(config.live||{})},sites:Array.isArray(config.sites)?config.sites:[],devices:Array.isArray(config.devices)?config.devices:[]};
 const base=String(cfg.apiBase||'').replace(/\/+$/,'');
 const doFetch=(...a)=>(fetcher||globalThis.fetch)(...a);
 const missing=new Set();
 const cache={at:0,items:null,promise:null};
 const nowMs=()=>+now();
 const authHeaders=()=>cfg.auth?.user?{Authorization:'Basic '+btoa(cfg.auth.user+':'+(cfg.auth.pass||''))}:{};

 function resolveUrl(v){
  if(!v)return null;v=String(v).replace(/\\/g,'/');
  if(/^(https?:|data:|blob:)/i.test(v))return v;
  if(v.startsWith('/'))return base+v;
  return base+String(cfg.mediaBase||'').replace(/\/$/,'')+'/'+v.replace(/^\.?\//,'');
 }
 function normalizeEvent(raw){
  const device_id=String(pick(raw,'device_id','device','jetson_id','camera_id','source','sender')??'unknown');
  const known=cfg.devices.find(d=>d.device_id===device_id);
  const site_id=String(pick(raw,'site_id','site')??known?.site_id??'unknown');
  const ts=iso(pick(raw,'ts','timestamp','time','event_time','detected_at','created_at'),now().toISOString());
  let conf=Number(pick(raw,'detection.conf','conf','confidence','score')??0);if(!Number.isFinite(conf))conf=0;if(conf>1)conf/=100;
  let state=String(pick(raw,'review.state','state','status')||'new').toLowerCase();if(!STATES.includes(state))state='new';
  const cls=String(pick(raw,'detection.class','class','label','class_name','category','object')??'미분류');
  const history=pick(raw,'review.history');
  return {
   event_id:String(pick(raw,'event_id','id','uuid','_id')??device_id+'-'+ts),
   device_id,site_id,ts,received_at:iso(pick(raw,'received_at','server_time','server_ts'),ts),version:Number(pick(raw,'version')??0)||0,
   detection:{class:cls,conf,night:pick(raw,'detection.night','night')??null,color:pick(raw,'detection.color','color')??null,frame_size:pick(raw,'detection.frame_size','frame_size')??null,bbox:pick(raw,'detection.bbox','bbox')??null},
   media:{snapshot:resolveUrl(pick(raw,'media.snapshot','snapshot','snapshot_url','snapshot_path','image','image_url')),clip:resolveUrl(pick(raw,'media.clip','clip','clip_url','video','video_url')),clip_status:pick(raw,'media.clip_status')??null,clip_note:pick(raw,'media.clip_note')??null,clip_range:pick(raw,'media.clip_range')??null,clip_source:pick(raw,'media.clip_source')??null},
   announce:{played:Boolean(pick(raw,'announce.played','announced','tts_played','played')),phrase:String(pick(raw,'announce.phrase','phrase','tts_text')||'')},
   outcome:{retrieved:Boolean(pick(raw,'outcome.retrieved','retrieved'))},
   review:{state,assignee:pick(raw,'review.assignee')??null,history:Array.isArray(history)?history:[],reason:pick(raw,'review.reason')??null,action:pick(raw,'review.action')??null},
   suspect:raw.suspect&&typeof raw.suspect==='object'?raw.suspect:null,
   raw
  };
 }
 // jetson_data.md §2/§3: 서버가 하트비트 최신값을 Device 에 병합해 보낼 수 있다 → 화면이 쓰는 heartbeat 하위 객체로 정리
 function normalizeDevice(d){
  const heartbeat=d.heartbeat||d.last_heartbeat||((d.pipeline||d.system||d.tts||d.issues)?{pipeline:d.pipeline||null,system:d.system||null,tts:d.tts||null,mosaic:d.mosaic||null,issues:d.issues||[],uptime_s:d.uptime_s}:null);
  const status=['online','degraded','offline','maintenance'].includes(d.status)?d.status:'offline';
  return {name:d.device_id,hw:null,demo:false,maintenance:status==='maintenance',...d,status,heartbeat,stream:d.stream||d.stream_path||cfg.devices.find(c=>c.device_id===d.device_id)?.stream,last_received_at:d.last_received_at||d.last_heartbeat_at||null};
 }
 // §5.1 썸네일 {url,ts,size} · §5.2 라이브 {protocol,url,variants,expires_at} 평면 응답을 화면 계약 {thumbnail,live} 로 정리
 function normalizeStream(s,device){
  if(!s||typeof s!=='object')return null;
  const out={connected:true,ts:s.ts||now().toISOString()};
  if(s.thumbnail?.url)out.thumbnail=s.thumbnail;
  if(s.live?.url)out.live={headers:{},...s.live};
  if(s.url&&s.protocol)out.live={protocol:s.protocol==='hls'?'hls':'webrtc',url:s.url,headers:{},stream:device?.stream,variants:s.variants,expires_at:s.expires_at,resolution:s.resolution};
  else if(s.url)out.thumbnail={url:s.url,size:s.size,overlay:s.overlay,ts:s.ts};
  if(!out.live&&!out.thumbnail)return null;
  if(!out.live){const live=liveFor(device);if(live)out.live=live;}
  // 서버가 시청 계정을 주지 않으면 config.js 의 live.user/pass 를 사용
  if(out.live&&!out.live.headers?.Authorization&&cfg.live.user)out.live.headers={...(out.live.headers||{}),Authorization:'Basic '+btoa(cfg.live.user+':'+(cfg.live.pass||''))};
  return out;
 }
 // §8 Stats 응답 {range,group_by,rows:[{site_id,...}]} 에 화면이 쓰는 summary / label / announce_cohorts 보강
 function normalizeStats(s,group,sites,events){
  if(!s||typeof s!=='object')return null;
  const rows=(Array.isArray(s.rows)?s.rows:[]).map(r=>({...r,label:r.label??(group==='site'?sites.find(x=>x.site_id===r.site_id)?.name||r.site_id:group==='region'?r.region?.dong||r.region_code||r.region:group==='day'?r.day||r.date:group==='hour'?(r.hour!=null?r.hour+'시':undefined):group==='class'?r.class:undefined)??r.site_id??r.key??'-',retrieved_rate:r.retrieved_rate??(r.confirmed?(r.retrieved||0)/r.confirmed:null)}));
  let sum=s.summary;
  if(!sum){
   const total=k=>rows.reduce((a,r)=>a+(Number(r[k])||0),0);
   const by_hour=Array(24).fill(0),by_class={};
   for(const r of rows){(r.by_hour||[]).forEach((n,i)=>by_hour[i]+=Number(n)||0);for(const [k,n] of Object.entries(r.by_class||{}))by_class[k]=(by_class[k]||0)+(Number(n)||0);}
   const events_=total('events'),confirmed=total('confirmed'),retrieved=total('retrieved');
   const nightWeighted=rows.reduce((a,r)=>a+(Number(r.night_share)||0)*(Number(r.events)||0),0);
   sum={events:events_,confirmed,retrieved,retrieved_rate:confirmed?retrieved/confirmed:null,actioned:total('actioned'),dismissed:total('dismissed'),pending:total('pending'),night_share:events_?nightWeighted/events_:null,by_hour,by_class};
  }
  const cohorts=Array.isArray(s.announce_cohorts)?s.announce_cohorts:events?[true,false].map(played=>({played,...summary(events.filter(e=>e.announce.played===played))})):[];
  return {...s,summary:sum,rows,announce_cohorts:cohorts};
 }
 async function http(path,options={}){
  let res;
  try{res=await doFetch(base+path,{method:options.method||'GET',credentials:base?'include':'same-origin',headers:{Accept:'application/json, text/csv;q=0.9, */*;q=0.8',...(options.body?{'Content-Type':'application/json'}:{}),...authHeaders()},body:options.body,signal:options.signal});}
  catch(e){throw Object.assign(new Error('서버에 연결할 수 없습니다: '+(e.message||'network error')),{code:'NETWORK'});}
  if(res.status===401||res.status===403)throw Object.assign(new Error('대시보드 계정 인증이 필요합니다. 페이지를 새로고침해 다시 로그인하세요.'),{code:'UNAUTHORIZED',status:res.status});
  if(res.status===404||res.status===405||res.status===501)throw Object.assign(new Error('서버에 없는 기능입니다: '+path),{code:'NOT_FOUND',status:res.status});
  if(!res.ok){let detail='';try{const body=await res.json();detail=body.detail?.[0]?.msg||body.detail||body.message||body.error||'';if(typeof detail!=='string')detail=JSON.stringify(detail);}catch{}throw new Error('서버 오류 ('+res.status+')'+(detail?' · '+detail:''));}
  if(res.status===204)return null;
  const type=res.headers?.get?.('content-type')||'';
  return type.includes('json')?res.json():res.text();
 }
 // 선택 엔드포인트: 404면 기억해 두고 undefined 반환 → 호출자가 파생 계산
 async function optional(key,path,options){
  if(missing.has(key))return undefined;
  try{return await http(path,options);}catch(e){if(e.code==='NOT_FOUND'){missing.add(key);return undefined;}throw e;}
 }
 async function allEvents(){
  if(cache.items&&nowMs()-cache.at<5000)return cache.items;
  if(!cache.promise)cache.promise=http('/api/events?size=1000&limit=1000').then(data=>{cache.items=unwrapList(data).items.map(normalizeEvent);cache.at=nowMs();return cache.items;}).catch(e=>{if(e.code==='NOT_FOUND')throw new Error('서버에서 /api/events 를 찾을 수 없습니다. FastAPI 실행 여부와 Caddy 경로(/api/*)를 확인하세요.');throw e;}).finally(()=>cache.promise=null);
  return cache.promise;
 }
 const sitesCache={at:0,items:null};
 // 지점 목록: 서버 /api/sites(있으면) + config.sites + 사건에 등장한 site_id 를 병합
 async function resolveSites(events=[]){
  if(!sitesCache.items||nowMs()-sitesCache.at>5000){const s=await optional('sites','/api/sites');sitesCache.items=s?unwrapList(s).items:[];sitesCache.at=nowMs();}
  return siteList(events,sitesCache.items);
 }
 function siteList(events=[],serverSites=[]){
  const sites=new Map(cfg.sites.map(s=>[s.site_id,{address:'',location:null,region:{},...s}]));
  for(const x of serverSites)if(x&&x.site_id)sites.set(x.site_id,{address:'',location:null,region:{},...(sites.get(x.site_id)||{}),...x});
  for(const e of events)if(!sites.has(e.site_id))sites.set(e.site_id,{site_id:e.site_id,name:e.site_id,address:'',location:null,region:{}});
  return [...sites.values()];
 }
 function deviceList(events,sites){
  const devices=new Map(cfg.devices.map(d=>[d.device_id,{...d}]));
  for(const e of events)if(!devices.has(e.device_id))devices.set(e.device_id,{device_id:e.device_id,site_id:e.site_id,name:e.device_id});
  return [...devices.values()].map(d=>{
   const last=events.filter(e=>e.device_id===d.device_id).map(e=>e.received_at||e.ts).sort().at(-1)||null;
   const fresh=last&&nowMs()-new Date(last).getTime()<86400000;
   const status=d.maintenance?'maintenance':d.status||(fresh?'online':'offline');
   return {name:d.device_id,hw:null,heartbeat:null,maintenance:false,demo:false,previous_status:'offline',...d,status,last_heartbeat_at:d.last_heartbeat_at||last,last_received_at:d.last_received_at||last,site:sites.find(s=>s.site_id===d.site_id)||null};
  });
 }
 // 장치 목록: 서버 /api/devices(있으면, 하트비트 병합 정리) 또는 config.devices + 사건 파생
 async function resolveDevices(events){
  const d=await optional('devices','/api/devices');
  if(!events){try{events=await allEvents();}catch(e){if(d)events=[];else throw e;}}
  const sites=await resolveSites(events);
  if(d)return unwrapList(d).items.map(normalizeDevice).map(attachSite(sites));
  return deviceList(events,sites);
 }
 const attachSite=sites=>v=>({...v,site:v.site||sites.find(s=>s.site_id===v.site_id)||null});
 function filterEvents(list,p,sites){
  const name=id=>sites.find(s=>s.site_id===id)?.name||'';
  return list.filter(e=>(!p.get('from')||day(e.ts)>=p.get('from'))&&(!p.get('to')||day(e.ts)<=p.get('to'))&&(!p.get('site_id')||e.site_id===p.get('site_id'))&&(!p.get('state')||e.review.state===p.get('state'))&&(!p.get('class')||e.detection.class===p.get('class'))&&(!p.get('q')||[e.event_id,e.device_id,e.detection.class,name(e.site_id)].join(' ').toLowerCase().includes(p.get('q').toLowerCase()))).sort((a,b)=>b.ts.localeCompare(a.ts)||a.event_id.localeCompare(b.event_id));
 }
 function acks(){try{return new Set(JSON.parse(storage?.getItem(ACK_KEY)||'[]'));}catch{return new Set();}}
 function derivedAlerts(devices){
  const acked=acks();
  return devices.filter(d=>d.status==='offline'&&!d.maintenance).map(d=>{const id='derived-offline-'+d.device_id;return {alert_id:id,device_id:d.device_id,kind:'device_offline',type:'offline',severity:'critical',title:'장치 사건 수신 없음',summary:'최근 24시간 동안 사건이 수신되지 않았습니다.',message:'장치 상태 API가 없어 사건 수신 여부로 판단합니다.',ts:d.last_received_at||now().toISOString(),created_at:now().toISOString(),acked:acked.has(id),acked_by:acked.has(id)?'관제 운영자':undefined,resolved:false};});
 }
 function liveFor(device){
  const stream=device?.stream||device?.stream_path;const liveBase=String(cfg.live.base||'').replace(/\/+$/,'');
  if(!stream||!liveBase)return null;
  const protocol=cfg.live.protocol==='hls'?'hls':'webrtc';
  const name=String(stream).replace(/^\/+/,'');
  const url=liveBase+'/'+name+(protocol==='hls'?'/index.m3u8':'/whep');
  const headers=cfg.live.user?{Authorization:'Basic '+btoa(cfg.live.user+':'+(cfg.live.pass||''))}:{};
  return {protocol,url,headers,stream:name,viewer:liveBase+'/'+name};
 }
 async function route(url,options){
  const u=new URL(url,'http://server.local'),p=u.searchParams,path=u.pathname,method=(options.method||'GET').toUpperCase(),qs=p.toString()?'?'+p.toString():'';
  if(method==='GET'){
   if(path==='/api/context'){const c=await optional('context','/api/context');return {user:'관제 운영자',demo:false,investigator:false,server_time:now().toISOString(),...(c&&typeof c==='object'?c:{})};}
   if(path==='/api/sites'){let events=[];try{events=await allEvents();}catch{events=[];}return resolveSites(events);}
   if(path==='/api/devices')return resolveDevices();
   if(path==='/api/alerts'){const a=await optional('alerts','/api/alerts');if(a)return unwrapList(a).items;return derivedAlerts(await resolveDevices());}
   if(path==='/api/overview'){
    const o=await optional('overview','/api/overview');if(o)return o;
    const events=await allEvents(),devices=await resolveDevices(events);
    return {summary:summary(events.filter(e=>day(e.ts)===day(now()))),device_counts:devices.reduce((a,d)=>(a[d.status]=(a[d.status]||0)+1,a),{}),all_pending:summary(events).pending,unacked_alerts:derivedAlerts(devices).filter(a=>!a.acked).length};
   }
   if(path==='/api/stats'){
    const group=p.get('group_by')||'site';
    const s=await optional('stats','/api/stats'+qs);
    if(s){let events=null;if(!Array.isArray(s.announce_cohorts)){try{events=filterEvents(await allEvents(),p,await resolveSites());}catch{events=null;}}return normalizeStats(s,group,await resolveSites(events||[]),events);}
    const all=await allEvents(),sites=await resolveSites(all),items=filterEvents(all,p,sites),groups=new Map();
    for(const e of items){const site=sites.find(x=>x.site_id===e.site_id),label=group==='day'?day(e.ts):group==='hour'?hour(e.ts)+'시':group==='class'?e.detection.class:group==='region'?site?.region?.dong||'미지정':site?.name||e.site_id;groups.set(label,[...(groups.get(label)||[]),e]);}
    return {summary:summary(items),rows:[...groups].map(([label,es])=>({label,...summary(es)})),announce_cohorts:[true,false].map(played=>({played,...summary(items.filter(e=>e.announce.played===played))}))};
   }
   if(path==='/api/events'){
    const data=await http('/api/events'+qs),{items,total,paged}=unwrapList(data);
    let list=items.map(normalizeEvent);const sites=await resolveSites(list);list=filterEvents(list,p,sites);
    const size=clamp(Number(p.get('size'))||12,1,100),page=Math.max(1,Number(p.get('page'))||1);
    if(paged)return {total:Number.isFinite(total)?total:list.length,page,size,items:list.map(attachSite(sites))};
    return {total:list.length,page,size,items:list.slice((page-1)*size,page*size).map(attachSite(sites))};
   }
   if(path==='/api/events.csv'){
    const csv=await optional('events.csv','/api/events.csv'+qs);if(typeof csv==='string')return csv;
    const all=await allEvents(),sites=await resolveSites(all),cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
    return '﻿'+[['사건 ID','발생 시각','지점','장치','종류','신뢰도','상태','회수'],...filterEvents(all,p,sites).map(e=>[e.event_id,e.ts,sites.find(s=>s.site_id===e.site_id)?.name||e.site_id,e.device_id,e.detection.class,e.detection.conf,e.review.state,e.outcome.retrieved])].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';
   }
   const event=path.match(/^\/api\/events\/([^/]+)$/);
   if(event){
    const id=decodeURIComponent(event[1]);const one=await optional('event','/api/events/'+encodeURIComponent(id));
    if(one&&typeof one==='object'){const e=normalizeEvent(one);return attachSite(await resolveSites([e]))(e);}
    const all=await allEvents(),e=all.find(x=>x.event_id===id);if(!e)throw new Error('사건을 찾을 수 없습니다.');return attachSite(await resolveSites(all))(e);
   }
   if(/^\/api\/events\/[^/]+\/raw$/.test(path))return http(path);
   const stream=path.match(/^\/api\/devices\/([^/]+)\/stream$/);
   if(stream){
    const id=decodeURIComponent(stream[1]);const device=cfg.devices.find(d=>d.device_id===id)||{device_id:id};
    const s=await optional('stream','/api/devices/'+encodeURIComponent(id)+'/stream');
    const normalized=normalizeStream(s,device);if(normalized)return normalized;
    const live=liveFor(device);
    return live?{connected:true,ts:now().toISOString(),live}:{connected:false};
   }
   if(/^\/api\/devices\/[^/]+\/roi$/.test(path)){try{return await http(path);}catch(e){if(e.code==='NOT_FOUND')throw new Error('서버가 ROI 기능을 지원하지 않습니다. 서버 app.py 를 업데이트하세요.');throw e;}}
   const uptime=path.match(/^\/api\/devices\/([^/]+)\/uptime$/);
   if(uptime){const r=await optional('uptime','/api/devices/'+uptime[1]+'/uptime');return r||{device_uptime_pct:null,observed_seconds:0};}
   return http(path+qs);
  }
  if(method==='POST'){
   cache.items=null;
   const ack=path.match(/^\/api\/alerts\/([^/]+)\/ack$/);
   if(ack&&ack[1].startsWith('derived-')){const set=acks();set.add(ack[1]);storage?.setItem(ACK_KEY,JSON.stringify([...set]));return {alert_id:ack[1],acked:true};}
   try{return await http(path,{method:'POST',body:options.body});}
   catch(e){if(e.code==='NOT_FOUND')throw new Error('서버에 아직 구현되지 않은 기능입니다 ('+path+'). FastAPI 에 해당 엔드포인트를 추가해야 합니다.');throw e;}
  }
  if(method==='PUT'){
   cache.items=null;
   try{return await http(path,{method:'PUT',body:options.body});}
   catch(e){if(e.code==='NOT_FOUND')throw new Error('서버에 아직 구현되지 않은 기능입니다 ('+path+'). 서버 app.py 를 업데이트하세요.');throw e;}
  }
  return http(path+qs,options);
 }
 async function probe(){
  try{await http('/api/events?size=1&limit=1');return {ok:true};}
  catch(e){if(e.code==='UNAUTHORIZED')return {ok:true,auth:true};return {ok:false,reason:e.message,code:e.code};}
 }
 function wsUrl(loc){
  const path=cfg.wsPath;if(!path)return null;if(/^wss?:/i.test(path))return path;
  const origin=base||(loc?loc.origin:'');if(!origin)return null;
  const url=origin.replace(/^http/i,'ws')+(path.startsWith('/')?path:'/'+path);
  // 브라우저는 WebSocket 업그레이드에 헤더를 못 붙이므로 config.auth 가 있으면 ?auth=base64(user:pass) 로 전달 (app.py 가 지원)
  return cfg.auth?.user?url+(url.includes('?')?'&':'?')+'auth='+encodeURIComponent(btoa(cfg.auth.user+':'+(cfg.auth.pass||''))):url;
 }
 function host(loc){try{return new URL(base||loc.origin).host;}catch{return base||'';}}
 return {request:(url,options={})=>route(url,options),probe,wsUrl,host,invalidate(){cache.items=null;},normalizeEvent,liveFor,config:cfg};
}
