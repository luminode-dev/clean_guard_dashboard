import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoApi} from '../assets/demo-api.js';
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
const make=storage=>createDemoApi({storage:storage||memory(),now:()=>new Date('2026-09-20T13:00:00Z')});
test('all five screens receive independent sample data',async()=>{
 const api=make().request;assert.equal((await api('/api/devices')).length,8);assert.equal((await api('/api/sites')).length,8);
 assert.equal((await api('/api/events')).total,84);assert.ok((await api('/api/overview')).summary.events>0);
 assert.equal((await api('/api/stats?group_by=site')).rows.length,8);assert.equal((await api('/api/alerts')).length,2);
});
test('review history persists, stale edits fail, terminal states stay closed',async()=>{
 const storage=memory(),api=make(storage).request,e=(await api('/api/events?state=new')).items[0];
 const change=(state,version,action)=>api('/api/events/'+e.event_id+'/review',{method:'POST',body:JSON.stringify({state,version,action,note:'검증'})});
 await assert.rejects(()=>change('confirmed',0));await change('reviewing',0);await assert.rejects(()=>change('confirmed',0));await change('confirmed',1);
 await assert.rejects(()=>change('actioned',2));await change('actioned',2,{type:'collection',result:'수거 완료'});await assert.rejects(()=>change('reviewing',3));
 const reloaded=await make(storage).request('/api/events/'+e.event_id);assert.equal(reloaded.review.state,'actioned');assert.equal(reloaded.review.history.length,3);
});
test('filter, pagination, CSV and reset match the displayed data',async()=>{
 const demo=make(),api=demo.request,first=await api('/api/events?size=2'),second=await api('/api/events?size=2&page=2');assert.notEqual(first.items[0].event_id,second.items[0].event_id);
 const id=first.items[0].event_id;assert.equal((await api('/api/events?q='+id)).total,1);assert.equal((await api('/api/events.csv?q='+id)).split('\r\n').filter(Boolean).length,2);
 const a=(await api('/api/alerts'))[0];await api('/api/alerts/'+a.alert_id+'/ack',{method:'POST'});assert.equal((await api('/api/alerts')).find(x=>x.alert_id===a.alert_id).acked,true);
 demo.reset();assert.equal((await api('/api/alerts')).find(x=>x.alert_id===a.alert_id).acked,false);
});
test('registration discards tokens and adds an offline device',async()=>{
 const storage=memory(),api=make(storage).request;
 const d=await api('/api/devices',{method:'POST',body:JSON.stringify({device_id:'DEMO-9',site_id:'SITE-GN-0001',name:'시험 장치',token:'never-store-this-secret'})});
 assert.equal(d.status,'offline');assert.equal(d.token,undefined);assert.equal(JSON.stringify(await make(storage).request('/api/devices')).includes('never-store-this-secret'),false);
});
test('recovery uses confirmed and actioned only, returns null for no denominator',async()=>{
 const api=make().request;const {summary}=await api('/api/stats');const {items}=await api('/api/events?size=100');
 const confirmed=items.filter(e=>['confirmed','actioned'].includes(e.review.state));assert.equal(summary.retrieved_rate,confirmed.filter(e=>e.outcome.retrieved).length/confirmed.length);
 assert.equal((await api('/api/stats?state=new')).summary.retrieved_rate,null);
});

test('another open adapter preserves saved reviews when acknowledging alerts',async()=>{
 const storage=memory(),a=make(storage).request,b=make(storage).request;
 const e=(await a('/api/events?state=new')).items[0];
 await a('/api/events/'+e.event_id+'/review',{method:'POST',body:JSON.stringify({state:'reviewing',version:0})});
 await b('/api/alerts/DEMO-ALERT-1/ack',{method:'POST'});
 assert.equal((await make(storage).request('/api/events/'+e.event_id)).review.state,'reviewing');
 await assert.rejects(()=>b('/api/events/'+e.event_id+'/review',{method:'POST',body:JSON.stringify({state:'reviewing',version:0})}));
});
