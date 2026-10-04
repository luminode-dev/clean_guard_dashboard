import test from 'node:test';
import assert from 'node:assert/strict';
import {contentRect,toNormalized,toPixel,pointInPolygon,isMonitored,validateZones,ROI_LIMITS} from '../assets/roi-editor.js';
import {createDemoApi} from '../assets/demo-api.js';
import {createServerApi} from '../assets/server-api.js';

const memory=()=>{const v=new Map();return {getItem:k=>v.get(k)||null,setItem:(k,x)=>v.set(k,x),removeItem:k=>v.delete(k)};};
const square=[[0.2,0.2],[0.8,0.2],[0.8,0.8],[0.2,0.8]];

test('contentRect letterboxes 16:9 media inside a 4:3 box',()=>{
 assert.deepEqual(contentRect(800,600,1280,720),{x:0,y:75,w:800,h:450});
 assert.deepEqual(contentRect(400,400,720,1280),{x:87.5,y:0,w:225,h:400});
 assert.deepEqual(contentRect(300,200,0,0),{x:0,y:0,w:300,h:200});
});

test('normalized ↔ pixel conversion round-trips and rejects the letterbox',()=>{
 const rect=contentRect(800,600,1280,720);
 assert.deepEqual(toNormalized(400,300,rect),[0.5,0.5]);
 assert.equal(toNormalized(400,40,rect),null);
 assert.deepEqual(toNormalized(400,40,rect,true),[0.5,0]);
 const [x,y]=toPixel([0.25,0.75],rect);assert.deepEqual(toNormalized(x,y,rect),[0.25,0.75]);
});

test('pointInPolygon and isMonitored follow the include/exclude rules',()=>{
 assert.equal(pointInPolygon([0.5,0.5],square),true);
 assert.equal(pointInPolygon([0.1,0.5],square),false);
 assert.equal(isMonitored([0.1,0.1],[]),true,'no zones → whole frame monitored');
 const zones=[{type:'include',points:square},{type:'exclude',points:[[0.4,0.4],[0.6,0.4],[0.6,0.6],[0.4,0.6]]}];
 assert.equal(isMonitored([0.3,0.3],zones),true);
 assert.equal(isMonitored([0.5,0.5],zones),false,'exclude wins over include');
 assert.equal(isMonitored([0.9,0.9],zones),false,'outside every include');
 assert.equal(isMonitored([0.5,0.5],[{type:'exclude',points:square}]),false);
 assert.equal(isMonitored([0.1,0.1],[{type:'exclude',points:square}]),true);
});

test('validateZones mirrors the server limits',()=>{
 assert.equal(validateZones([{type:'include',points:square}]),null);
 assert.match(validateZones([{type:'other',points:square}]),/종류/);
 assert.match(validateZones([{type:'include',points:[[0,0],[1,1]]}]),/꼭짓점/);
 assert.match(validateZones([{type:'include',points:[[0,0],[1.2,0],[1,1]]}]),/0~1/);
 assert.match(validateZones(Array(ROI_LIMITS.zones+1).fill({type:'include',points:square})),/최대/);
 assert.match(validateZones('x'),/배열/);
});

test('demo mode stores ROI per device, bumps version and rejects stale saves',async()=>{
 const storage=memory(),demo=createDemoApi({storage}),api=demo.request;
 const [device]=await api('/api/devices');
 const empty=await api('/api/devices/'+device.device_id+'/roi');
 assert.equal(empty.version,0);assert.equal(empty.apply_state,'none');assert.deepEqual(empty.zones,[]);
 const put=body=>api('/api/devices/'+device.device_id+'/roi',{method:'PUT',body:JSON.stringify(body)});
 const saved=await put({base_version:0,frame_ref:[1280,720],zones:[{id:'z1',name:'수거함 앞',type:'include',points:square}]});
 assert.equal(saved.version,1);assert.equal(saved.apply_state,'applied');assert.equal(saved.zones[0].name,'수거함 앞');
 await assert.rejects(()=>put({base_version:0,zones:[]}),/먼저 수정/);
 await assert.rejects(()=>put({base_version:1,zones:[{type:'include',points:[[0,0]]}]}),/꼭짓점/);
 const reloaded=createDemoApi({storage}).request;
 assert.equal((await reloaded('/api/devices/'+device.device_id+'/roi')).version,1,'persists in storage');
 assert.equal((await reloaded('/api/devices')).find(d=>d.device_id===device.device_id).roi.version,1);
 await assert.rejects(()=>api('/api/devices/NOPE/roi'),/장치가 없습니다/);
});

test('server adapter passes ROI GET/PUT through and explains an old server',async()=>{
 const calls=[];
 const response=(status,body)=>({ok:status<300,status,headers:{get:()=>'application/json'},json:async()=>body,text:async()=>JSON.stringify(body)});
 const api=createServerApi({config:{},fetcher:async(url,init)=>{calls.push({url,method:init.method,body:init.body});return url.endsWith('/roi')?response(200,{version:2,zones:[],apply_state:'pending'}):response(404,{});}});
 assert.equal((await api.request('/api/devices/JT-GN-0001/roi')).apply_state,'pending');
 await api.request('/api/devices/JT-GN-0001/roi',{method:'PUT',body:JSON.stringify({base_version:2,zones:[]})});
 assert.equal(calls.at(-1).method,'PUT');assert.match(calls.at(-1).body,/base_version/);
 const old=createServerApi({config:{},fetcher:async()=>response(404,{detail:'Not Found'})});
 await assert.rejects(()=>old.request('/api/devices/JT-GN-0001/roi'),/ROI 기능을 지원하지 않습니다/);
});

test('selfIntersects flags crossing edges and labelPoint stays inside the polygon',async()=>{
 const {selfIntersects,labelPoint}=await import('../assets/roi-editor.js');
 assert.equal(selfIntersects(square),false);
 assert.equal(selfIntersects([[0,0],[1,1],[1,0],[0,1]]),true,'bow-tie');
 // 운영에서 저장된 "바깥 테두리 + 안쪽" 제외 구역은 열쇠구멍 모양의 단순 다각형 (교차 아님)
 const keyhole=[[0,0],[0.99,0],[1,1],[0.01,1],[0.93,0.5],[0.92,0.17],[0.04,0.49],[0,1]];
 assert.equal(selfIntersects(keyhole),false);
 assert.equal(pointInPolygon([0.5,0.1],keyhole),true,"road is excluded");
 assert.equal(pointInPolygon([0.5,0.45],keyhole),false,"sidewalk is the hole");
 const concave=[[0,0],[1,0],[1,1],[0.6,1],[0.6,0.3],[0.4,0.3],[0.4,1],[0,1]];
 assert.equal(selfIntersects(concave),false);
 assert.equal(pointInPolygon(labelPoint(concave),concave),true,'label inside a U-shape');
 assert.equal(pointInPolygon(labelPoint(square),square),true);
});
