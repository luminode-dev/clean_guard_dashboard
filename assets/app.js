import {$,esc,icon,hydrateIcons,badge,labels,fmtDate,pct,localDay,empty,metric,hourChart,classBars,eventTable,alertCards} from './ui.js';
import {LivePlayer} from './live.js';
import {createDemoApi} from './demo-api.js';
import {createServerApi} from './server-api.js';
import {connectEvents} from './realtime.js';
import {RoiEditor,validateZones,ZONE_TYPES,selfIntersects} from './roi-editor.js';
const config=window.CLEAN_GUARD_CONFIG||{};
const demo=createDemoApi({storage:window.localStorage});
const serverApi=createServerApi({config,storage:window.localStorage});
let api=demo.request,serverMode=false,realtime=null,realtimeState='off';

let roiOverlay=null;
let roiEditor=null,roiDoc=null,roiDeviceId=null,deviceDialogId=null,eventDialogId=null;
let page='overview',context={},sites=[],devices=[],leafletMap=null,livePlayer=null,thumbnailTimer=null,refreshTimer=null,loadSerial=0;
let eventFilters={},eventPage=1,deviceFilters={q:'',status:''},alertFilter='active';
const descriptions={overview:['CITY OPERATIONS','통합 관제','도시의 현황을 한눈에 살피고, 필요한 대응을 시작하세요.'],devices:['DEVICE MONITORING','장치 · 영상','설치 지점별 장치 상태와 모자이크 영상을 확인하세요.'],events:['EVENT MANAGEMENT','사건 관리','탐지된 사건을 검토하고, 현장 조치까지 기록하세요.'],stats:['INSIGHTS & IMPACT','통계 분석','무단투기 발생 추이와 방송 후 회수 현황을 살펴보세요.'],alerts:['NOTIFICATION CENTER','알림 센터','장치 장애와 새 사건을 확인하고 대응하세요.']};
const content=$('#page-content'),dialog=$('#detail-dialog');

const send=(url,data)=>api(url,{method:'POST',...(data?{body:JSON.stringify(data)}:{})});
function toast(message){const el=$('#toast');el.textContent=message;el.hidden=false;setTimeout(()=>el.hidden=true,3600);}
function fail(error){const el=$('#global-error');el.textContent=error.message;el.hidden=false;$('#connection').innerHTML='<i class="off"></i>'+(serverMode?'서버 응답 오류':'시연 데이터 오류');}
function connectionLabel(){if(!serverMode)return '로컬 시연 모드';return '서버 연결 · '+serverApi.host(window.location)+(realtimeState==='open'?' · 실시간 수신 중':config.wsPath?' · 실시간 재접속 중':'');}
function showConnection(){$('#connection').innerHTML='<i></i>'+connectionLabel();}
const query=p=>new URLSearchParams(Object.entries(p).filter(([,v])=>v!==''&&v!=null)).toString();
function options(items,value='',all='전체 지점'){return `<option value="">${all}</option>`+items.map(s=>`<option value="${esc(s.site_id)}" ${value===s.site_id?'selected':''}>${esc(s.name)}</option>`).join('');}
function stateOptions(value,device=false){return `<option value="">전체 상태</option>`+(device?['online','degraded','offline','maintenance']:['new','reviewing','confirmed','actioned','dismissed']).map(s=>`<option value="${s}" ${value===s?'selected':''}>${labels[s]}</option>`).join('');}
function panel(title,body,link='',count=''){return `<section class="panel"><div class="panel-head"><div class="panel-title"><h2>${title}</h2>${count!==''?`<span class="count">${count}</span>`:''}</div>${link}</div>${body}</section>`;}
function link(text,page){return `<a class="panel-link" href="#${page}">${text} ↗</a>`;}
function chartPanel(summary){const max=Math.max(...summary.by_hour),peak=summary.by_hour.indexOf(max);return panel('시간대별 탐지 현황',`<p class="chart-caption">오늘 00:00–23:59 · 한국 표준시</p><div class="chart-body">${hourChart(summary.by_hour)}</div><div class="chart-note">${icon('chart')} ${max?`<strong>${peak}시</strong>에 가장 많은 사건이 발생했습니다.`:'오늘 접수된 사건이 없습니다.'}</div>`,'<span class="badge online">오늘</span>');}
async function load(){
 const serial=++loadSerial;$('#global-error').hidden=true;
 try{
  [sites,devices]=await Promise.all([api('/api/sites'),api('/api/devices')]);
  if(serial!==loadSerial)return;
  const overview=await api('/api/overview');if(serial!==loadSerial)return;
  $('#pending-nav').textContent=overview.all_pending;$('#alert-nav').textContent=overview.unacked_alerts;
  leafletMap?.remove();leafletMap=null;
  if(page==='overview')await renderOverview(overview,serial);
  if(page==='events')await renderEvents(serial);
  if(page==='devices')renderDevices();
  if(page==='stats')await renderStats(serial);
  if(page==='alerts')await renderAlerts(serial);
  if(serial!==loadSerial)return;
  hydrateIcons();showConnection();$('#last-updated').textContent='마지막 조회 '+new Date().toLocaleTimeString('ko-KR',{hour12:false});
 }catch(e){if(serial===loadSerial)fail(e);}
}
async function renderOverview(o,serial){
 const [recent,alerts]=await Promise.all([api('/api/events?size=5'),api('/api/alerts')]);if(serial!==loadSerial)return;
 const c=o.device_counts,s=o.summary,total=devices.length;
 content.innerHTML=`<div class="metrics">${metric('운영 장치',c.online||0,`/ ${total}대`,`<b>정상 운영</b> · 주의 ${c.degraded||0} · 오프라인 ${c.offline||0}`,'camera')}${metric('오늘 탐지 사건',s.events,'건','오늘 00:00부터 접수된 탐지 사건','layers')}${metric('확인 대기 사건',o.all_pending,'건','미확인 + 검토 중 · 전체 기간','alert')}${metric('오늘 확정 사건 회수율',pct(s.retrieved_rate),'',`확정 ${s.confirmed}건 중 <b>${s.retrieved}건 회수</b>`,'shield')}</div><div class="dashboard-grid">${panel('설치 지점 현황',`<div class="map-wrap"><div id="site-map" class="map" aria-label="설치 장치 위치 지도"></div><div id="map-fallback" class="map-fallback" hidden>지도 배경을 불러올 수 없습니다. 아래 장치 목록을 이용하세요.</div><div class="map-legend">${['online','degraded','offline','maintenance'].map(s=>`<span class="legend-item"><i class="dot ${s}"></i>${labels[s]}</span>`).join('')}</div></div><div class="map-summary"><span>전체 <b>${total}개 장치</b></span><span>점검 중 <b>${c.maintenance||0}대</b></span><span>지점 선택 시 상세 보기</span></div>`,link('전체 장치','devices'),sites.length)}${chartPanel(s)}</div><div class="dashboard-grid lower">${panel('최근 탐지 사건',eventTable(recent.items,true),link('전체 사건','events'))}${panel('확인할 알림',alertCards(alerts.filter(a=>!a.acked&&!a.resolved).slice(0,3))+`<div class="alert-footer">미확인 알림 ${o.unacked_alerts}건 · 상태별 확인 후 대응하세요.</div>`,link('알림 센터','alerts'))}</div>`;
 drawMap();
}
function drawMap(){
 if(!window.L){$('#site-map').innerHTML=empty('지도 모듈을 불러오지 못했습니다. 장치 목록을 이용하세요.');return;}
 leafletMap=L.map('site-map',{scrollWheelZoom:false,zoomControl:true}).setView([37.504,127.05],13);
 const layer=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(leafletMap);
 layer.on('tileerror',()=>{const notice=$('#map-fallback');if(notice)notice.hidden=false;});
 const points=[];
 for(const [index,d] of devices.entries()){
  if(!d.site?.location)continue;const pos=[d.site.location.lat,d.site.location.lng];points.push(pos);
  const marker=L.marker(pos,{icon:L.divIcon({className:'',html:`<span class="map-pin ${esc(d.status)}">${index+1}</span>`,iconSize:[30,30],iconAnchor:[15,15]}),title:d.name,keyboard:true}).addTo(leafletMap);
  marker.bindTooltip(esc(d.site.name)+' · '+labels[d.status]);marker.on('click',()=>openDevice(d.device_id));
 }
 if(points.length)leafletMap.fitBounds(points,{padding:[35,35],maxZoom:14});
}
function eventFilterForm(){return `<form id="event-filters" class="filters"><label class="search">사건 검색<input name="q" placeholder="지점, 장치 또는 사건 ID 검색" value="${esc(eventFilters.q||'')}"></label><label>시작일<input name="from" type="date" value="${esc(eventFilters.from||'')}"></label><label>종료일<input name="to" type="date" value="${esc(eventFilters.to||'')}"></label><label>설치 지점<select name="site_id">${options(sites,eventFilters.site_id)}</select></label><label>처리 상태<select name="state">${stateOptions(eventFilters.state)}</select></label><label>탐지 종류<select name="class"><option value="">전체 종류</option>${['쓰레기봉투','대형가구','가전제품','페트','캔','병','스티로폼','종이박스','의류','플라스틱'].map(v=>`<option ${v===eventFilters.class?'selected':''}>${v}</option>`).join('')}</select></label><div class="filter-end"><button class="primary" type="submit">조회</button><button class="button" type="button" id="reset-events">초기화</button></div></form>`;}
async function renderEvents(serial){
 const data=await api('/api/events?'+query({...eventFilters,page:eventPage,size:12}));if(serial!==loadSerial)return;
 content.innerHTML=eventFilterForm()+panel('탐지 사건 목록',eventTable(data.items)+`<div class="pagination"><span>전체 ${data.total}건 · ${eventPage} / ${Math.max(1,Math.ceil(data.total/12))} 페이지</span><button class="button" id="prev-page" ${eventPage===1?'disabled':''}>이전</button><button class="button" id="next-page" ${eventPage*12>=data.total?'disabled':''}>다음</button></div>`,`<a class="button" href="./api/events.csv?${esc(query(eventFilters))}">${icon('download')} CSV 내보내기</a>`,data.total);
 $('#event-filters').onsubmit=e=>{e.preventDefault();eventFilters=Object.fromEntries(new FormData(e.target));eventPage=1;load();};
 $('#reset-events').onclick=()=>{eventFilters={};eventPage=1;load();};$('#prev-page').onclick=()=>{eventPage--;load();};$('#next-page').onclick=()=>{eventPage++;load();};
}
function renderDevices(){
 const filtered=devices.filter(d=>(!deviceFilters.status||d.status===deviceFilters.status)&&((d.name+' '+d.device_id+' '+d.site?.address).toLowerCase().includes(deviceFilters.q.toLowerCase())));
 content.innerHTML=`<form class="filters" id="device-filters"><label class="search">장치 검색<input name="q" placeholder="장치명, 지점 또는 주소 검색" value="${esc(deviceFilters.q)}"></label><label>상태<select name="status">${stateOptions(deviceFilters.status,true)}</select></label><button class="primary" type="submit">조회</button><div class="filter-end"><button type="button" id="register-site" class="button">+ 지점 등록</button><button type="button" id="register-device" class="button">+ 장치 등록</button></div></form><div class="device-grid">${filtered.map(d=>{
  const h=d.heartbeat;return `<article class="device-card"><div class="device-preview" id="preview-${esc(d.device_id)}">${badge(d.status)}${icon('camera')}<small>${d.video?.publishing?'영상 송출 중 · 상세에서 라이브 보기':'영상 미연결 · 썸네일 대기'}</small></div><div class="device-info"><h3>${esc(d.site?.name||d.name)}</h3><p>${esc(d.device_id)} · ${esc(d.site?.address||'')}</p>${d.roi?.version?`<p class="roi-chip ${esc(d.roi.apply_state)}">ROI v${d.roi.version} · ${d.roi.apply_state==='applied'?'적용됨':d.roi.apply_state==='failed'?'적용 실패':'전달 대기'}</p>`:''}<div class="device-readings"><div>추론 속도<b>${h?h.pipeline.fps.toFixed(1):'—'} <small>FPS</small></b></div><div>GPU 온도<b>${h?.system?.temp_c?.gpu??'—'} <small>°C</small></b></div><div>방송 워커<b>${h?.tts?.worker==='ready'?'정상':'—'}</b></div></div><button class="button" data-device="${esc(d.device_id)}">장치 상세 · 영상 보기 ${icon('arrow')}</button></div></article>`;
 }).join('')}</div>${filtered.length?'':empty('검색 조건에 맞는 장치가 없습니다.')}`;
 $('#device-filters').onsubmit=e=>{e.preventDefault();deviceFilters=Object.fromEntries(new FormData(e.target));renderDevices();};
 $('#register-site').onclick=()=>registration('site');$('#register-device').onclick=()=>registration('device');
 refreshThumbnails();
}
async function refreshThumbnails(){
 if(page!=='devices')return;
 await Promise.all(devices.map(async d=>{try{const s=await api('/api/devices/'+encodeURIComponent(d.device_id)+'/stream');const preview=$('#preview-'+CSS.escape(d.device_id));if(preview&&s.thumbnail?.url){preview.innerHTML=badge(d.status)+`<img src="${esc(s.thumbnail.url)}?v=${encodeURIComponent(s.ts)}" alt="${esc(d.name)} 모자이크 썸네일">`;$('img',preview).onerror=()=>preview.innerHTML=badge(d.status)+icon('camera')+'<small>썸네일을 불러올 수 없습니다.</small>';}}catch{/* Keep the prior thumbnail; the global data refresh reports connectivity. */}}));
}
let statsFilters={from:(()=>{const d=new Date();d.setDate(d.getDate()-6);return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(d);})(),to:localDay(),group_by:'site'};
async function renderStats(serial){
 const data=await api('/api/stats?'+query(statsFilters));if(serial!==loadSerial)return;const s=data.summary;
 content.innerHTML=`<form class="filters" id="stats-filters"><label>시작일<input type="date" name="from" required value="${esc(statsFilters.from)}"></label><label>종료일<input type="date" name="to" required value="${esc(statsFilters.to)}"></label><label>집계 기준<select name="group_by">${Object.entries({site:'지점별',region:'행정동별',day:'일자별',hour:'시간대별',class:'종류별'}).map(([v,l])=>`<option value="${v}" ${statsFilters.group_by===v?'selected':''}>${l}</option>`).join('')}</select></label><button type="submit" class="primary">분석</button><div class="filter-end"><a class="button" href="./api/events.csv?${esc(query(statsFilters))}">${icon('download')} 사건 데이터 내보내기</a></div></form><div class="metrics">${metric('전체 탐지 사건',s.events,'건','선택 기간 내 탐지 사건','layers')}${metric('확정 사건',s.confirmed,'건','무단투기 확정 + 조치 완료','check')}${metric('회수율',pct(s.retrieved_rate),'',`확정 ${s.confirmed}건 중 ${s.retrieved}건 회수`,'shield')}${metric('야간 탐지 비중',pct(s.night_share),'','적외선 · 저조도 탐지','camera')}</div><div class="stats-grid">${panel('시간대별 발생 분포',`<div class="chart-body">${hourChart(s.by_hour)}</div><p class="footnote">선택 기간 합계 · Asia/Seoul</p>`)}${panel('폐기물 종류별 현황',classBars(s.by_class))}</div>${panel('방송 여부별 회수 현황',`<div class="cohorts">${data.announce_cohorts.map(c=>`<div class="cohort"><p>${c.played?'방송한 사건':'방송하지 않은 사건'}</p><strong>${pct(c.retrieved_rate)}</strong><small>확정 ${c.confirmed}건 · 회수 ${c.retrieved}건</small></div>`).join('')}</div><p class="footnote">확정 사건만 포함합니다. 방송 여부별 단순 비교이며 방송의 인과 효과를 의미하지 않습니다.</p>`)}<div style="margin-top:20px">${panel('집계 상세',data.rows.length?`<div class="table-wrap"><table><thead><tr><th>분류</th><th>탐지</th><th>확정</th><th>조치 완료</th><th>제외</th><th>회수</th><th>회수율</th><th>야간 비중</th></tr></thead><tbody>${data.rows.map(r=>`<tr><td class="cell-title">${esc(r.label)}</td><td>${r.events}</td><td>${r.confirmed}</td><td>${r.actioned}</td><td>${r.dismissed}</td><td>${r.retrieved}</td><td>${pct(r.retrieved_rate)}</td><td>${pct(r.night_share)}</td></tr>`).join('')}</tbody></table></div>`:empty())}</div>`;
 $('#stats-filters').onsubmit=e=>{e.preventDefault();statsFilters=Object.fromEntries(new FormData(e.target));load();};
}
async function renderAlerts(serial){
 const data=await api('/api/alerts');if(serial!==loadSerial)return;
 const rows=alertFilter==='all'?data:alertFilter==='acked'?data.filter(a=>a.acked):data.filter(a=>!a.acked&&!a.resolved);
 content.innerHTML=panel('알림 목록',alertCards(rows,true),`<div class="view-tabs">${Object.entries({active:'미확인',acked:'확인 완료',all:'전체'}).map(([k,v])=>`<button data-alert-filter="${k}" class="${alertFilter===k?'active':''}">${v}</button>`).join('')}</div>`,rows.length);
 content.querySelectorAll('[data-alert-filter]').forEach(b=>b.onclick=()=>{alertFilter=b.dataset.alertFilter;load();});
}
function showDialog(title,eyebrow,html){stopLive();$('#dialog-title').textContent=title;$('#dialog-eyebrow').textContent=eyebrow;$('#dialog-body').innerHTML=html;if(!dialog.open)dialog.showModal();}
function stopLive(){roiOverlay=null;roiEditor?.destroy();roiEditor=null;roiDoc=null;roiDeviceId=null;livePlayer?.close();livePlayer=null;clearInterval(thumbnailTimer);thumbnailTimer=null;}
function closeDialog(){stopLive();dialog.close();}
// 투기 장면 클립: 서버가 SRT 순환 버퍼에서 사건 시각 앞뒤 5초를 잘라 붙인다 (보관 개수 초과 시 오래된 영상부터 삭제)
function clipBlock(e){
 const m=e.media||{};
 if(m.clip)return `<div class="clip-box"><h3>투기 장면 영상</h3><video controls preload="metadata" playsinline src="${esc(m.clip)}"></video><small class="cell-sub">${m.clip_range?esc(fmtDate(m.clip_range[0]))+' ~ '+esc(fmtDate(m.clip_range[1]))+' · ':''}${m.clip_source==='device'?'젯슨 업로드':'서버 영상에서 자동 추출'}${m.clip_note?' · '+esc(m.clip_note):''}</small></div>`;
 if(m.clip_status==='pending')return '<div class="clip-box pending"><h3>투기 장면 영상</h3><p>영상 클립을 만드는 중입니다 · 사건 발생 후 약 10초 뒤 자동으로 표시됩니다.</p></div>';
 if(m.clip_status==='missing'||m.clip_status==='expired')return `<div class="clip-box missing"><h3>투기 장면 영상</h3><p>${esc(m.clip_note||'영상 클립이 없습니다.')}</p></div>`;
 return '';
}
async function openEvent(id){
 eventDialogId=id;
 try{
 const e=await api('/api/events/'+encodeURIComponent(id));const review=e.review,d=e.detection,allowed={new:['reviewing','dismissed'],reviewing:['confirmed','dismissed'],confirmed:['actioned']}[review.state]||[];
 const snapshot=e.media?.snapshot;
 showDialog(e.site?.name||e.site_id,'EVENT DETAIL',`<div class="detail-grid"><div><div class="evidence">${snapshot?`<img src="${esc(snapshot)}" alt="모자이크 처리된 사건 증거">`:icon('camera')+'<p>증거 이미지가 아직 수신되지 않았습니다.</p>'}</div><p class="evidence-caption">${context.demo?'시연 사건 · ':''}모자이크 자료 기본 표시 · 원본 해상도 ${esc(d.frame_size?.join(' × ')||'미수신')}</p>${clipBlock(e)}<dl class="detail-facts"><dt>사건 ID</dt><dd>${esc(e.event_id)}</dd><dt>발생 시각</dt><dd>${esc(fmtDate(e.ts,true))}</dd><dt>서버 수신</dt><dd>${esc(fmtDate(e.received_at,true))}</dd><dt>장치</dt><dd>${esc(e.device_id)}</dd><dt>탐지 정보</dt><dd>${esc(d.class)} · ${d.night?esc(d.night):esc(d.color||'색상 없음')} · ${(d.conf*100).toFixed(0)}%</dd><dt>방송</dt><dd>${e.announce?.played?'방송 완료':'방송 미실시'+(e.announce?.suppressed_reason?' · '+esc(e.announce.suppressed_reason):'')}</dd><dt>회수 여부</dt><dd>${e.outcome?.retrieved?'회수 보고됨'+(e.outcome.retrieved_at?' · '+esc(fmtDate(e.outcome.retrieved_at)):''):'회수 보고 없음'}</dd>${e.suspect?`<dt>투기자 귀속</dt><dd>${e.suspect.owner_matched?'소지품 일치 (강한 귀속)':'추정'} · 객체 #${esc(e.suspect.obj_id??'-')}${e.suspect.owner_pid!=null?' · 인물 #'+esc(e.suspect.owner_pid):''}</dd>`:''}${e.review?.assignee?`<dt>담당자</dt><dd>${esc(e.review.assignee)}</dd>`:''}</dl>${context.investigator?'<button class="button" id="raw-button">원본 자료 열람 · 이력 기록</button>':''}<div class="detail-section"><h3>방송 문구</h3><p>${esc(e.announce?.phrase||'방송 문구가 기록되지 않았습니다.')}</p></div></div><div><div style="display:flex;justify-content:space-between;margin-bottom:18px"><h3>사건 처리</h3>${badge(review.state)}</div>${allowed.length?`<form id="review-form" class="review-form"><label>처리 상태<select name="state">${allowed.map(s=>`<option value="${s}">${labels[s]}</option>`).join('')}</select></label><label id="reason-field" hidden>제외 사유<select name="reason"><option value="false_positive">오탐</option><option value="authorized">허용된 배출</option><option value="duplicate">중복 사건</option></select></label><div id="action-fields" ${allowed[0]==='actioned'?'':'hidden'}><label>조치 유형<select name="action_type"><option value="field_visit">현장 방문</option><option value="collection">수거</option><option value="fine">과태료</option><option value="other">기타</option></select></label><label>조치 결과<input name="action_result" maxlength="500" placeholder="예: 현장 수거 완료"></label><label style="display:flex;align-items:center;gap:6px"><input name="fine_issued" type="checkbox" style="width:auto">과태료 부과 기록</label></div><label>처리 메모<textarea name="note" maxlength="2000" placeholder="확인 내용 또는 현장 조치 내용을 입력하세요."></textarea></label><p id="review-error" class="error" role="alert"></p><button type="submit" class="primary">처리 내용 저장</button></form>`:`<div class="detail-section"><p>종결된 사건입니다.</p>${review.action?`<p>조치 결과: ${esc(review.action.result)}</p>`:''}${review.reason?`<p>제외 사유: ${esc({false_positive:'오탐',authorized:'허용된 배출',duplicate:'중복 사건'}[review.reason]||review.reason)}</p>`:''}</div>`}<div class="detail-section"><h3>처리 이력 <span class="muted">${review.history.length}</span></h3><div class="history">${review.history.length?review.history.slice().reverse().map(h=>`<div class="history-item">${esc(labels[h.from])} → <strong>${esc(labels[h.to])}</strong><small>${esc(h.by)} · ${esc(fmtDate(h.at))}</small>${h.note?`<p>${esc(h.note)}</p>`:''}</div>`).join(''):'<p class="muted">아직 처리 이력이 없습니다.</p>'}</div></div></div></div>`);
 if(snapshot){const img=$('.evidence img');img.onerror=()=>img.parentElement.innerHTML=icon('camera')+'<p>보존 기간이 만료되었거나 자료를 불러올 수 없습니다.</p>';}
 if(allowed.length){const form=$('#review-form');form.elements.state.onchange=()=>{$('#reason-field').hidden=form.elements.state.value!=='dismissed';$('#action-fields').hidden=form.elements.state.value!=='actioned';};form.onsubmit=async ev=>{ev.preventDefault();const button=$('button[type="submit"]',form);button.disabled=true;const f=Object.fromEntries(new FormData(form));try{await send('/api/events/'+id+'/review',{state:f.state,reason:f.reason,note:f.note,version:e.version,action:{type:f.action_type,result:f.action_result,fine_issued:f.fine_issued==='on'}});toast('사건 처리 내용이 저장되었습니다.');await openEvent(id);await load();}catch(error){$('#review-error').textContent=error.message;}finally{button.disabled=false;}};}
 if(context.investigator)$('#raw-button').onclick=async()=>{try{const result=await api('/api/events/'+id+'/raw');window.open(result.url,'_blank','noopener');}catch(error){toast(error.message);}};
 }catch(e){toast(e.message);}
}
async function openDevice(id){
 eventDialogId=null;
 try{
 const d=devices.find(d=>d.device_id===id);if(!d)return;
 const [s,uptime,roi]=await Promise.all([api('/api/devices/'+id+'/stream'),api('/api/devices/'+id+'/uptime'),api('/api/devices/'+encodeURIComponent(id)+'/roi').catch(()=>null)]);const h=d.heartbeat;
 showDialog(d.site?.name||d.name,'DEVICE MONITORING',`<div class="detail-grid"><div><div class="evidence" id="device-evidence">${s.thumbnail?.url?`<img id="detail-thumb" src="${esc(s.thumbnail.url)}" alt="모자이크 썸네일">`:icon('camera')+'<p>영상 미연결 · 썸네일 대기</p>'}</div><p class="evidence-caption" id="live-message">${s.live&&s.video&&!s.video.publishing?'젯슨이 지금 영상을 보내지 않습니다 · 송출이 시작되면 연결할 수 있습니다.':s.live?'라이브 연결 가능 · '+esc(s.live.stream||'')+' ('+esc((s.live.protocol||'webrtc').toUpperCase())+') · 장치 상세에서만 연결합니다.':'미디어 서버 주소가 등록되지 않았습니다. config.js 의 live.base 와 장치 stream 을 확인하세요.'}</p>${s.live?'<button class="primary" id="start-live">라이브 영상 연결</button>':''}<div class="detail-section roi-section" id="roi-section"></div><div class="detail-section"><h3>설치 정보</h3><p>${esc(d.site?.address)}</p><p>${esc(d.hw?.model||'기기 정보 미등록')} · ${esc(d.device_id)}</p></div></div><div><div style="margin-bottom:20px"><span id="device-status">${badge(d.status)}</span> ${context.demo&&d.demo?'<span class="demo-label">모의 하트비트</span>':''}</div><dl class="detail-facts"><dt>장치 시각</dt><dd>${fmtDate(d.last_heartbeat_at,true)}</dd><dt>서버 수신</dt><dd id="device-seen">${seenText(d)}</dd><dt>영상 송출</dt><dd id="device-video">${videoText(s.video??d.video)}</dd><dt>FPS</dt><dd>${h?.pipeline?.fps??'—'}</dd><dt>CPU / GPU</dt><dd>${h?.system?.cpu_pct??'—'}% / ${h?.system?.gpu_pct??'—'}%</dd><dt>GPU 온도</dt><dd>${h?.system?.temp_c?.gpu??'—'}°C</dd><dt>디스크 여유</dt><dd>${h?.system?.disk_free_mb??'—'} MB</dd><dt>방송 워커</dt><dd>${esc(h?.tts?.worker||'미수신')}</dd><dt>합성 지연</dt><dd>${h?.tts?.last_synth_ms??'—'} ms</dd><dt>관측 구간 정상률</dt><dd>${uptime.device_uptime_pct==null?'—':uptime.device_uptime_pct.toFixed(1)+'%'}<small class="cell-sub">오늘 ${Math.round(uptime.observed_seconds/60)}분 관측 · 미관측 구간 제외</small></dd><dt>이상 항목</dt><dd>${esc(h?.issues?.join(', ')||'없음')}</dd></dl><button id="maintenance-button" class="button">${d.maintenance?'점검 종료':'점검 모드로 전환'}</button><p class="footnote" style="padding:12px 0">점검 중에는 장치 장애 알림을 억제합니다.</p></div></div>`);
 $('#maintenance-button').onclick=async()=>{try{await send('/api/devices/'+id+'/maintenance',{enabled:!d.maintenance});toast('점검 상태가 변경되었습니다.');await load();await openDevice(id);}catch(e){toast(e.message);}};

 roiDoc=roi;roiDeviceId=id;deviceDialogId=id;renderRoiSection();attachRoi();
 if(s.live)$('#start-live').onclick=()=>{livePlayer?.close();$('#device-evidence').innerHTML='<video id="live-video" controls autoplay muted playsinline></video>';livePlayer=new LivePlayer($('#live-video'),$('#live-message'),{onState:st=>{const b=$('#start-live');if(!b)return;b.disabled=st==='playing'||st==='connecting';if(st==='ended'||st==='stalled')b.textContent='라이브 다시 연결';}});livePlayer.start(s.live);$('#start-live').disabled=true;clearInterval(thumbnailTimer);attachRoi();};
 const img=$('#detail-thumb');if(img)img.onerror=()=>{img.parentElement.innerHTML=icon('camera')+'<p>썸네일을 불러올 수 없습니다.</p>';};
 thumbnailTimer=setInterval(async()=>{try{const next=await api('/api/devices/'+id+'/stream');const image=$('#detail-thumb');if(image&&next.thumbnail?.url)image.src=next.thumbnail.url+'?v='+encodeURIComponent(next.ts);}catch{}},5000);
 }catch(e){toast(e.message);}
}
// ---------- ROI 편집 (감시 구역 / 제외 구역 → 서버 → 젯슨 config/roi.json)
const roiStates={none:['maintenance','ROI 미설정 · 화면 전체 감시'],pending:['new','젯슨 전달 대기'],applied:['online','젯슨 적용됨'],failed:['offline','적용 실패']};
function roiBadge(doc){const st=doc?.apply_state||'none',[cls,label]=roiStates[st]||roiStates.none;return `<span class="badge ${cls}"><i class="dot ${cls}"></i>${label}${doc?.version?' · v'+doc.version:''}</span>`;}
function roiMedia(){return $('#live-video')||$('#detail-thumb')||$('#roi-blank');}
function roiOverlayOn(){if(roiOverlay!=null)return roiOverlay;const onVideo=!!($('#live-video')||$('#detail-thumb'));return !(onVideo&&roiDoc?.apply_state==='applied');}
function attachRoi(){
 const host=$('#device-evidence');if(!host||roiDoc==null)return;
 const editing=!!roiEditor?.editable,zones=roiEditor?roiEditor.zones:(roiDoc.zones||[]),dirty=roiEditor?.dirty,selected=roiEditor?.selected??null;
 roiEditor?.destroy();
 if(editing&&!$('#live-video')&&!$('#detail-thumb')&&!$('#roi-blank'))host.innerHTML='<div id="roi-blank" class="roi-blank"><span>영상 미연결 · 16:9 기준 화면에 그립니다</span></div>';
 roiEditor=new RoiEditor(host,roiMedia(),{zones,editable:editing,visible:roiOverlayOn(),onChange:(ed,msg)=>{renderRoiToolbar();if(msg)toast(msg);}});
 roiEditor.dirty=!!dirty;roiEditor.selected=selected;roiEditor.draw();
}
function roiCounts(zones){return `감시 ${zones.filter(z=>z.type==='include').length}개 · 제외 ${zones.filter(z=>z.type==='exclude').length}개`;}
function renderRoiSection(){
 const box=$('#roi-section');if(!box)return;
 if(roiDoc==null){box.innerHTML='<h3>감시 구역 (ROI)</h3><p>서버가 ROI 기능을 지원하지 않습니다. 서버 app.py 를 업데이트하세요.</p>';return;}
 const editing=!!roiEditor?.editable,zones=roiDoc.zones||[];
 const summary=zones.length?roiCounts(zones)+(roiDoc.updated_by?' · '+esc(roiDoc.updated_by)+' '+esc(fmtDate(roiDoc.updated_at)):''):'구역이 없으면 화면 전체를 감시합니다.';
 box.innerHTML=`<div class="roi-head"><h3>감시 구역 (ROI)</h3><span id="roi-badge">${roiBadge(roiDoc)}</span></div>${roiDoc.apply_state==='failed'&&roiDoc.apply_error?`<p class="error">${esc(roiDoc.apply_error)}</p>`:''}<p class="roi-summary">${summary}</p>${!editing&&zones.some(z=>selfIntersects(z.points))?'<p class="roi-warn">선이 서로 교차하는 구역이 있습니다. 젯슨은 교차된 안쪽을 구멍(구역 아님)으로 판정합니다. ROI 편집에서 다시 그려 주세요.</p>':''}<div id="roi-toolbar"></div>${editing?'':`<div class="roi-tools"><button class="button" id="roi-edit">ROI 편집</button>${zones.length?`<button class="button" id="roi-overlay">${roiOverlayOn()?'구역 겹쳐 보기 끄기':'구역 겹쳐 보기'}</button>`:''}</div>${zones.length&&!roiOverlayOn()?'<p class="footnote roi-help">영상의 초록·빨간 선은 젯슨이 직접 그린, 지금 적용 중인 구역입니다.</p>':''}`}`;
 $('#roi-edit')?.addEventListener('click',()=>{attachRoi();roiEditor.setEditable(true);attachRoi();renderRoiSection();});
 $('#roi-overlay')?.addEventListener('click',()=>{roiOverlay=!roiOverlayOn();roiEditor?.setVisible(roiOverlay);renderRoiSection();});
 renderRoiToolbar();
}
function renderRoiToolbar(){
 const bar=$('#roi-toolbar');if(!bar)return;
 if(!roiEditor?.editable){bar.innerHTML='';return;}
 const ed=roiEditor,sel=ed.selected!=null?ed.zones[ed.selected]:null,drawing=ed.mode==='draw';
 const tools=drawing
  ?`<span class="roi-hint">${ZONE_TYPES[ed.drawType]} 그리는 중 · 클릭으로 꼭짓점, 첫 점 클릭·더블클릭·Enter 로 완료, Esc 취소</span><button class="button" id="roi-close">완료</button><button class="button" id="roi-cancel-draw">취소</button>`
  :`<button class="button roi-include" id="roi-add-include">+ 감시 구역</button><button class="button roi-exclude" id="roi-add-exclude">+ 제외 구역</button><button class="button" id="roi-clear" ${ed.zones.length?'':'disabled'}>전체 삭제</button>`;
 const selected=sel&&!drawing?`<div class="roi-selected"><label>이름<input id="roi-name" maxlength="40" value="${esc(sel.name)}"></label><label>종류<select id="roi-type"><option value="include" ${sel.type==='include'?'selected':''}>감시 구역</option><option value="exclude" ${sel.type==='exclude'?'selected':''}>제외 구역</option></select></label><button class="button" id="roi-delete">구역 삭제</button></div>`:'';
 bar.innerHTML=`<div class="roi-tools">${tools}</div>${selected}${ed.zones.some(z=>selfIntersects(z.points))?'<p class="roi-warn">선이 서로 교차하는 구역이 있습니다. 교차된 안쪽은 구멍으로 판정됩니다. 감시 구역 밖은 원래 무시되므로, 바깥 전체를 제외 구역으로 두를 필요는 없습니다.</p>':''}<p class="footnote roi-help">${ed.zones.length?roiCounts(ed.zones)+' · ':''}구역을 클릭해 선택, 꼭짓점을 끌어 수정합니다. 제외 구역이 감시 구역보다 우선합니다.${$('#live-video')||$('#detail-thumb')?' 영상에 보이는 얇은 실선은 젯슨이 현재 적용 중인 구역(v'+(roiDoc?.applied_version||0)+')이며, 저장 후 젯슨이 적용하면(최대 30초) 새 구역으로 바뀝니다.':''}</p><div class="roi-actions"><button class="primary" id="roi-save" ${ed.dirty&&!drawing?'':'disabled'}>저장 후 젯슨에 전송</button><button class="button" id="roi-cancel">편집 취소</button></div>`;
 $('#roi-add-include')?.addEventListener('click',()=>{ed.startDraw('include');renderRoiToolbar();});
 $('#roi-add-exclude')?.addEventListener('click',()=>{ed.startDraw('exclude');renderRoiToolbar();});
 $('#roi-close')?.addEventListener('click',()=>ed.closeDraft());
 $('#roi-cancel-draw')?.addEventListener('click',()=>ed.cancelDraft());
 $('#roi-clear')?.addEventListener('click',()=>{if(window.confirm('모든 구역을 삭제할까요? 저장하면 화면 전체 감시로 바뀝니다.'))ed.clearAll();});
 $('#roi-delete')?.addEventListener('click',()=>ed.removeSelected());
 $('#roi-name')?.addEventListener('change',e=>ed.updateSelected({name:e.target.value.trim()||ZONE_TYPES[sel.type]}));
 $('#roi-type')?.addEventListener('change',e=>ed.updateSelected({type:e.target.value}));
 $('#roi-cancel').addEventListener('click',()=>{
  if(ed.dirty&&!window.confirm('저장하지 않은 변경을 버릴까요?'))return;
  ed.setZones(roiDoc.zones||[]);ed.setEditable(false);
  if($('#roi-blank'))$('#device-evidence').innerHTML=icon('camera')+'<p>영상 미연결 · 썸네일 대기</p>';
  attachRoi();renderRoiSection();
 });
 $('#roi-save').addEventListener('click',async e=>{
  const err=validateZones(ed.zones);if(err){toast(err);return;}
  e.target.disabled=true;
  try{
   roiDoc=await api('/api/devices/'+encodeURIComponent(roiDeviceId)+'/roi',{method:'PUT',body:JSON.stringify(ed.payload(roiDoc.version||0))});
   ed.setZones(roiDoc.zones||[]);ed.setEditable(false);roiOverlay=null;
   if($('#roi-blank'))$('#device-evidence').innerHTML=icon('camera')+'<p>영상 미연결 · 썸네일 대기</p>';
   attachRoi();renderRoiSection();
   toast(serverMode?'ROI 를 저장했습니다. 다음 하트비트(최대 30초)에 젯슨으로 전달됩니다.':'ROI 를 저장했습니다 (시연 모드).');
  }catch(error){
   toast(error.message);e.target.disabled=false;
   if(/먼저 수정/.test(error.message)){try{roiDoc=await api('/api/devices/'+encodeURIComponent(roiDeviceId)+'/roi');const b=$('#roi-badge');if(b)b.innerHTML=roiBadge(roiDoc);}catch{}}
  }
 });
}
async function refreshRoiState(deviceId){
 if(!dialog.open||roiDeviceId!==deviceId)return;
 try{
  const doc=await api('/api/devices/'+encodeURIComponent(deviceId)+'/roi'),was=roiDoc?.apply_state;roiDoc=doc;
  if(roiEditor?.editable){const b=$('#roi-badge');if(b)b.innerHTML=roiBadge(doc);}else{roiEditor?.setZones(doc.zones||[]);roiEditor?.setVisible(roiOverlayOn());renderRoiSection();}
  if(doc.apply_state==='applied'&&was!=='applied')toast('젯슨에 ROI 가 적용되었습니다 · v'+doc.applied_version);
  if(doc.apply_state==='failed'&&was!=='failed')toast('젯슨 ROI 적용 실패 · '+(doc.apply_error||''));
 }catch{}
}
// ---------- 장치 상태 표시 (하트비트 기준, 서버 판정 그대로)
function seenText(d){if(!d.last_received_at)return '수신 기록 없음';const s=d.last_seen_s??Math.round((Date.now()-new Date(d.last_received_at))/1000);const ago=s<60?s+'초 전':s<3600?Math.floor(s/60)+'분 전':Math.floor(s/3600)+'시간 전';return esc(fmtDate(d.last_received_at,true))+' <small class="cell-sub">'+ago+(s>90?' · 90초 넘게 하트비트 없음':'')+'</small>';}
function videoText(v){if(v==null)return '확인 불가';return v.publishing?'<span style="color:#2b907a">송출 중</span>'+(v.since?' <small class="cell-sub">'+esc(fmtDate(v.since))+'부터</small>':''):'<span style="color:#c16a61">송출 없음</span>';}
function applyDeviceStatus(st){
 const d=devices.find(x=>x.device_id===st.device_id);if(d){d.status=st.status;if(st.video!==undefined)d.video=st.video;if(st.last_received_at)d.last_received_at=st.last_received_at;if(st.last_seen_s!==undefined)d.last_seen_s=st.last_seen_s;}
 if(!dialog.open||deviceDialogId!==st.device_id)return;
 const badgeBox=$('#device-status');if(badgeBox)badgeBox.innerHTML=badge(st.status);
 if(d){const seen=$('#device-seen');if(seen)seen.innerHTML=seenText(d);}
 const video=$('#device-video');if(video&&st.video!==undefined)video.innerHTML=videoText(st.video);
 if(st.video&&!st.video.publishing&&livePlayer&&livePlayer.state==='playing')livePlayer.setState('ended','젯슨 영상 송출이 종료되었습니다.');
}
async function refreshOpenDevice(){
 if(!deviceDialogId)return;
 try{const list=await api('/api/devices');const d=list.find(x=>x.device_id===deviceDialogId);if(d){const i=devices.findIndex(x=>x.device_id===d.device_id);if(i>=0)devices[i]=d;applyDeviceStatus({device_id:d.device_id,status:d.status,video:d.video,last_received_at:d.last_received_at,last_seen_s:d.last_seen_s});}}catch{}
}
function registration(kind){
 eventDialogId=null;deviceDialogId=null;
 const site=kind==='site';
 showDialog(site?'설치 지점 등록':'장치 등록','REGISTER',`<form id="registration-form" class="registration">${site?'<label>지점 ID<input name="site_id" required pattern="[A-Za-z0-9_-]+" placeholder="SITE-GN-0009"></label><label>지점명<input name="name" required></label><label class="full">주소<input name="address" required></label><label>위도<input name="lat" type="number" step="any" min="-90" max="90" required></label><label>경도<input name="lng" type="number" step="any" min="-180" max="180" required></label><label>행정동<input name="dong" required></label><label>행정동 코드<input name="code" required></label><label>시도<input name="sido" value="서울특별시" required></label><label>시군구<input name="sigungu" value="강남구" required></label>':`<label>장치 ID<input name="device_id" required pattern="[A-Za-z0-9_-]+" placeholder="JT-GN-0009"></label><label>장치명<input name="name" required></label><label class="full">설치 지점<select name="site_id" required>${options(sites,'','지점 선택')}</select></label><label class="full">시연용 장치 토큰 (실제 비밀값 입력 금지)<input name="token" type="password" minlength="16" maxlength="100" required autocomplete="new-password"></label><p class="footnote full">화면 동작 확인용 등록입니다. 장치 연결이나 인증은 수행하지 않으며 입력한 토큰도 저장하지 않습니다.</p>`}<p id="registration-error" class="error full" role="alert"></p><button type="submit" class="primary full">등록하기</button></form>`);
 $('#registration-form').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target)),button=$('button[type="submit"]',e.target);button.disabled=true;try{const body=site?{site_id:f.site_id,name:f.name,address:f.address,location:{lat:Number(f.lat),lng:Number(f.lng)},region:{sido:f.sido,sigungu:f.sigungu,dong:f.dong,code:f.code}}:f;await send(site?'/api/sites':'/api/devices',body);closeDialog();toast('등록되었습니다.');await load();}catch(error){$('#registration-error').textContent=error.message;}finally{button.disabled=false;}};
}
function navigate(){const target=location.hash.slice(1)||'overview';page=Object.hasOwn(descriptions,target)?target:'overview';const [eyebrow,title,description]=descriptions[page];$('#page-eyebrow').textContent=eyebrow;$('#page-title').textContent=title;$('#breadcrumb-title').textContent=title;$('#page-description').textContent=description;document.title='Clean Guard · '+title;document.querySelectorAll('nav [data-page]').forEach(a=>a.classList.toggle('active',a.dataset.page===page));content.innerHTML='<div class="loading">관제 데이터를 불러오고 있습니다…</div>';load();}
document.addEventListener('click',async e=>{
 const csv=e.target.closest('a[href*="api/events.csv?"]');
 if(csv){e.preventDefault();try{const data=await api('/api/events.csv'+new URL(csv.href).search);const url=URL.createObjectURL(new Blob([data],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=serverMode?'clean-guard-events.csv':'clean-guard-demo-events.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){toast(error.message);}return;}

 const event=e.target.closest('[data-event]');if(event){openEvent(event.dataset.event);return;}
 const device=e.target.closest('[data-device]');if(device){openDevice(device.dataset.device);return;}
 const ack=e.target.closest('[data-ack]');if(ack){ack.disabled=true;try{await send('/api/alerts/'+ack.dataset.ack+'/ack');toast('알림을 확인했습니다.');await load();}catch(error){toast(error.message);}finally{ack.disabled=false;}}
});
$('#close-dialog').onclick=closeDialog;dialog.addEventListener('close',()=>{deviceDialogId=null;eventDialogId=null;stopLive();});dialog.addEventListener('cancel',stopLive);$('#refresh').onclick=load;$('#top-alerts').onclick=()=>location.hash='alerts';window.addEventListener('hashchange',navigate);window.addEventListener('pagehide',stopLive);
$('#today').textContent=new Date().toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',weekday:'short'});hydrateIcons();
async function chooseMode(){
 const mode=config.mode||'auto';
 if(mode==='demo')return false;
 if(mode==='server')return true;
 const probe=await serverApi.probe();
 if(!probe.ok)console.info('Clean Guard: 서버 응답이 없어 시연 데이터로 실행합니다. '+(probe.reason||''));
 return probe.ok;
}
// jetson_data.md 기준 WebSocket 메시지 분류: 사건(§4.1) · 회수 후속(§4.2 event_update) · 하트비트(§3) · 알림(§6) · 트랙(§5.3)
function classifyMessage(data){
 if(!data||typeof data!=='object')return null;
 const body=data.type&&data.data&&typeof data.data==='object'?data.data:data;
 if(data.type==='device_config')return {kind:'config',body};
 if(data.type==='device_status')return {kind:'status',body};
 if(body.update||data.type==='event_update')return {kind:'update',body};
 if(body.alert_id||data.type==='alert')return {kind:'alert',body};
 if(body.pipeline||body.uptime_s!=null||data.type==='heartbeat')return {kind:'heartbeat',body};
 if(Array.isArray(body.persons)||Array.isArray(body.objects))return {kind:'track',body};
 if(body.event_id||body.detection||body.class||body.label||data.type==='event')return {kind:'event',body};
 return null;
}
function startRealtime(){
 const url=serverApi.wsUrl(window.location);if(!url)return;
 let timer=null;
 const reload=(delay=800)=>{clearTimeout(timer);timer=setTimeout(()=>{if(!dialog.open)load();},delay);};
 const reloadNow=()=>{clearTimeout(timer);if(!dialog.open)load();};
 realtime=connectEvents({url,onStatus:state=>{realtimeState=state;showConnection();},onEvent:data=>{
  const message=classifyMessage(data);if(!message)return;
  const {kind,body}=message;
  if(kind==='track')return;
  serverApi.invalidate();
  if(kind==='event'){const cls=body.detection?.class||body.class||body.label;toast(cls?'새 사건 수신 · '+cls:'새 사건이 수신되었습니다.');reload();}
  else if(kind==='update'){if(body.update==='retrieved')toast('회수 보고 · '+(body.event_id||''));if(body.update==='media'&&dialog.open&&eventDialogId===body.event_id&&!document.querySelector('.clip-box video')){if(body.clip_status==='ready')toast('투기 장면 영상이 준비되었습니다.');openEvent(body.event_id);}reload();}
  else if(kind==='alert'){toast((body.summary||body.title||'새 알림')+'');reload();}
  else if(kind==='heartbeat'){reload(5000);}
  else if(kind==='config'){refreshRoiState(body.device_id);reload(5000);}
  else if(kind==='status'){applyDeviceStatus(body);if(body.previous!==body.status&&(body.status==='offline'||body.previous==='offline'))toast((devices.find(d=>d.device_id===body.device_id)?.name||body.device_id)+(body.status==='offline'?' · 연결 끊김 (하트비트 90초 없음)':' · 연결 복구'));reloadNow();}
 }});
 window.addEventListener('pagehide',()=>realtime?.close());
}
try{
 serverMode=await chooseMode();
 api=serverMode?serverApi.request:demo.request;
 document.body.classList.toggle('server-mode',serverMode);
 $('#reset-demo').hidden=serverMode;$('#user-role').textContent=serverMode?'운영 서버 연결':'프런트엔드 시연';
 context=await api('/api/context');$('#user-name').textContent=context.user||'관제 운영자';$('#demo-label').hidden=!context.demo;navigate();
 if(serverMode)startRealtime();
 refreshTimer=setInterval(()=>{if(document.hidden)return;if(dialog.open){refreshOpenDevice();return;}if(page==='overview'||page==='devices')load();},15000);setInterval(()=>{if(!document.hidden&&!dialog.open)refreshThumbnails();},5000);
}catch(e){fail(e);}

$('#reset-demo').onclick=()=>{if(window.confirm('이 브라우저의 시연 변경 내용을 초기화할까요?')){demo.reset();closeDialog();load();toast('시연 데이터를 초기화했습니다.');}};
$('.skip-link').onclick=e=>{e.preventDefault();$('#main').focus();};
