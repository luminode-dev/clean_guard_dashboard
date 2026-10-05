// 설치 위치 패널: 지점명·주소·GPS 좌표를 지정하면 서버에 저장되고, 다음 하트비트에 젯슨 config/site.json 으로 전달된다.
// 위치를 정하는 방법: 주소 검색 / 위도·경도 직접 입력 / 지도 클릭·마커 드래그 / 젯슨이 보고한 GPS
export const SITE_STATES={none:['maintenance','위치 미설정'],pending:['new','젯슨 전달 대기'],applied:['online','젯슨 적용됨'],failed:['offline','적용 실패']};
const DEFAULT_VIEW=[36.4,127.9],DEFAULT_ZOOM=7;
// Leaflet 기본 핀은 이미지 파일(marker-icon.png)이 필요해 깨지므로 CSS 로 그린 핀을 쓴다. 핀 끝(아래 꼭짓점)이 좌표 위치
const pinIcon=editing=>window.L.divIcon({className:'site-pin-wrap',html:'<span class="site-pin'+(editing?' editing':'')+'"><i></i></span>',iconSize:[28,36],iconAnchor:[14,35]});

export function parseCoord(v){const n=Number(String(v??'').trim());return Number.isFinite(n)&&String(v??'').trim()!==''?n:null;}
// "37.5, 127.03" 처럼 한 칸에 붙여 넣은 좌표도 받는다 (지도 앱에서 복사한 형식)
export function parseLatLng(text){
 const m=String(text||'').match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);if(!m)return null;
 const lat=Number(m[1]),lng=Number(m[2]);
 return Math.abs(lat)<=90&&Math.abs(lng)<=180?{lat,lng}:null;
}
export function validLocation(lat,lng){return lat!=null&&lng!=null&&Math.abs(lat)<=90&&Math.abs(lng)<=180&&!(lat===0&&lng===0);}

export function mountSitePanel({box,device,api,toast,esc,fmtDate,badge,demo,onSaved}){
 const site=device.site||{site_id:device.site_id};
 let state={editing:false,form:null,results:[],map:null,marker:null,cfg:device.site_config||{version:site.version||0,apply_state:site.version?'pending':'none'}};
 const badgeHtml=()=>{const st=state.cfg?.apply_state||'none',[cls,label]=SITE_STATES[st]||SITE_STATES.none;return `<span class="badge ${cls}"><i class="dot ${cls}"></i>${label}${state.cfg?.version?' · v'+state.cfg.version:''}</span>`;};
 const loc=()=>state.form?{lat:parseCoord(state.form.lat),lng:parseCoord(state.form.lng)}:site.location;
 function view(){
  const l=site.location;
  box.innerHTML=`<div class="roi-head"><h3>설치 위치</h3><span id="site-badge">${badgeHtml()}</span></div>
   ${state.cfg?.apply_state==='failed'&&state.cfg.apply_error?`<p class="error">${esc(state.cfg.apply_error)}</p>`:''}
   <p class="site-line"><b>${esc(site.name||site.site_id||'지점 미지정')}</b></p>
   <p class="site-line">${esc(site.address||'주소 미입력')}</p>
   <p class="site-line cell-sub">${l?`위도 ${l.lat.toFixed(6)} · 경도 ${l.lng.toFixed(6)}${site.location_source?' · '+({address:'주소 검색',gps:'GPS 좌표',manual:'직접 입력',map:'지도 지정',device:'젯슨 GPS'}[site.location_source]||''):''}`:'좌표가 없어 지도에 표시되지 않습니다.'}${site.updated_by?' · '+esc(site.updated_by)+' '+esc(fmtDate(site.updated_at)):''}</p>
   ${l?'<div id="site-map-mini" class="site-map"></div>':''}
   <div class="roi-tools"><button class="button" id="site-edit">위치 편집</button></div>
   <p class="footnote roi-help">${esc(device.hw?.model||'기기 정보 미등록')} · ${esc(device.device_id)} · 지점 ${esc(site.site_id||'-')}</p>`;
  box.querySelector('#site-edit').onclick=()=>{state.editing=true;state.form={name:site.name||'',address:site.address||'',lat:site.location?.lat??'',lng:site.location?.lng??'',region:{...(site.region||{})},source:site.location_source||'manual'};render();};
  if(l)drawMap(false);
 }
 function edit(){
  const f=state.form,gps=device.gps&&validLocation(parseCoord(device.gps.lat),parseCoord(device.gps.lng))?device.gps:null;
  box.innerHTML=`<div class="roi-head"><h3>설치 위치 편집</h3><span id="site-badge">${badgeHtml()}</span></div>
   <div class="site-form">
    <label class="full">지점명<input id="site-name" maxlength="60" value="${esc(f.name)}" placeholder="예: 역삼1동 수거함 앞"></label>
    <label class="full">주소<span class="site-row"><input id="site-address" maxlength="200" value="${esc(f.address)}" placeholder="도로명 또는 지번 주소"><button class="button" id="site-geocode" type="button">주소로 찾기</button></span></label>
    <div id="site-results" class="site-results full"></div>
    <label>위도<input id="site-lat" inputmode="decimal" value="${esc(f.lat)}" placeholder="37.500019"></label>
    <label>경도<input id="site-lng" inputmode="decimal" value="${esc(f.lng)}" placeholder="127.036548"></label>
    <p class="footnote full roi-help">지도 앱에서 복사한 "37.5000, 127.0365" 형식을 위도 칸에 붙여 넣어도 됩니다. 아래 지도를 클릭하거나 핀을 끌어 위치를 정할 수도 있습니다.</p>
    <div class="site-tools full">${gps?`<button class="button" id="site-gps" type="button">젯슨 GPS 위치 사용 (${Number(gps.lat).toFixed(5)}, ${Number(gps.lng).toFixed(5)})</button>`:''}<button class="button" id="site-reverse" type="button">좌표로 주소 채우기</button></div>
    <div id="site-map-edit" class="site-map full"></div>
   </div>
   <p id="site-error" class="error" role="alert"></p>
   <div class="roi-actions"><button class="primary" id="site-save">저장 후 젯슨에 전송</button><button class="button" id="site-cancel">편집 취소</button></div>`;
  const $=s=>box.querySelector(s);
  const sync=()=>{f.name=$('#site-name').value;f.address=$('#site-address').value;
   const pasted=parseLatLng($('#site-lat').value);if(pasted&&/[, ]/.test($('#site-lat').value.trim())){$('#site-lat').value=pasted.lat;$('#site-lng').value=pasted.lng;f.source='gps';}
   f.lat=$('#site-lat').value;f.lng=$('#site-lng').value;};
  ['#site-name','#site-address'].forEach(s=>$(s).addEventListener('input',sync));
  ['#site-lat','#site-lng'].forEach(s=>$(s).addEventListener('change',()=>{sync();f.source='gps';placeMarker(true);}));
  $('#site-address').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('#site-geocode').click();}});
  $('#site-geocode').onclick=async()=>{
   sync();if(f.address.trim().length<2){toast('주소를 입력하세요.');return;}
   if(demo){toast('시연 모드에서는 주소 검색을 할 수 없습니다. 좌표를 직접 입력하세요.');return;}
   const btn=$('#site-geocode');btn.disabled=true;btn.textContent='찾는 중…';
   try{state.results=await api('/api/geocode?q='+encodeURIComponent(f.address.trim()));showResults();}
   catch(err){toast(err.message);}finally{btn.disabled=false;btn.textContent='주소로 찾기';}
  };
  $('#site-reverse').onclick=async()=>{
   sync();const lat=parseCoord(f.lat),lng=parseCoord(f.lng);if(!validLocation(lat,lng)){toast('먼저 좌표를 정하세요.');return;}
   if(demo){toast('시연 모드에서는 주소 찾기를 할 수 없습니다.');return;}
   try{const r=await api(`/api/geocode/reverse?lat=${lat}&lng=${lng}`);if(r.label){f.address=shortAddress(r.label);f.region={...f.region,...r.region};$('#site-address').value=f.address;}else toast('이 좌표의 주소를 찾지 못했습니다.');}catch(err){toast(err.message);}
  };
  $('#site-gps')?.addEventListener('click',()=>{$('#site-lat').value=Number(gps.lat);$('#site-lng').value=Number(gps.lng);sync();f.source='device';placeMarker(true);});
  $('#site-cancel').onclick=()=>{state.editing=false;state.form=null;state.results=[];render();};
  $('#site-save').onclick=async e=>{
   sync();const lat=parseCoord(f.lat),lng=parseCoord(f.lng);
   if(!f.name.trim()){$('#site-error').textContent='지점명을 입력하세요.';return;}
   if((f.lat!==''||f.lng!=='')&&!validLocation(lat,lng)){$('#site-error').textContent='위도는 -90~90, 경도는 -180~180 사이 숫자여야 합니다.';return;}
   e.target.disabled=true;
   try{
    const saved=await api('/api/sites/'+encodeURIComponent(site.site_id),{method:'PUT',body:JSON.stringify({base_version:site.version||0,name:f.name.trim(),address:f.address.trim(),location:validLocation(lat,lng)?{lat,lng}:null,location_source:f.source,region:f.region})});
    Object.assign(site,saved);device.site=site;state.cfg=saved.devices?.[device.device_id]||{version:saved.version,applied_version:saved.version,apply_state:demo?'applied':'pending'};
    state.editing=false;state.form=null;state.results=[];render();
    toast(demo?'설치 위치를 저장했습니다 (시연 모드).':'설치 위치를 저장했습니다. 다음 하트비트(최대 30초)에 젯슨으로 전달됩니다.');onSaved?.(site);
   }catch(err){$('#site-error').textContent=err.message;e.target.disabled=false;}
  };
  drawMap(true);
 }
 function shortAddress(label){return label.split(',').map(s=>s.trim()).filter(s=>s&&s!=='대한민국'&&!/^\d{5}$/.test(s)).reverse().join(' ');}
 function showResults(){
  const el=box.querySelector('#site-results');
  if(!state.results.length){el.innerHTML='<p class="cell-sub">검색 결과가 없습니다. 도로명 주소(예: 서울 강남구 테헤란로 152)로 다시 찾거나 지도에서 직접 지정하세요.</p>';return;}
  el.innerHTML=state.results.map((r,i)=>`<button class="site-result" type="button" data-i="${i}">${esc(r.label)}<small>${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}</small></button>`).join('');
  el.querySelectorAll('[data-i]').forEach(b=>b.onclick=()=>{const r=state.results[Number(b.dataset.i)];const f=state.form;
   f.lat=r.lat;f.lng=r.lng;f.region={...f.region,...r.region};f.source='address';
   box.querySelector('#site-lat').value=r.lat;box.querySelector('#site-lng').value=r.lng;
   el.innerHTML=`<p class="cell-sub">선택: ${esc(r.label)}</p>`;placeMarker(true);});
 }
 function drawMap(editable){
  state.map?.remove();state.map=null;state.marker=null;
  const el=box.querySelector(editable?'#site-map-edit':'#site-map-mini');if(!el)return;
  if(!window.L){el.innerHTML='<p class="cell-sub">지도 모듈을 불러오지 못했습니다.</p>';return;}
  const l=loc(),has=l&&validLocation(l.lat,l.lng);
  state.map=L.map(el,{scrollWheelZoom:editable,zoomControl:true,attributionControl:true}).setView(has?[l.lat,l.lng]:DEFAULT_VIEW,has?17:DEFAULT_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(state.map);
  if(has)placeMarker(false);
  if(editable)state.map.on('click',e=>{const f=state.form;f.lat=+e.latlng.lat.toFixed(7);f.lng=+e.latlng.lng.toFixed(7);f.source='map';box.querySelector('#site-lat').value=f.lat;box.querySelector('#site-lng').value=f.lng;placeMarker(false);});
  setTimeout(()=>state.map?.invalidateSize(),60);
 }
 function placeMarker(pan){
  if(!state.map)return;const l=loc();if(!l||!validLocation(l.lat,l.lng))return;
  if(state.marker)state.marker.setLatLng([l.lat,l.lng]);
  else{state.marker=L.marker([l.lat,l.lng],{draggable:state.editing,icon:pinIcon(state.editing),keyboard:false}).addTo(state.map);
   if(state.editing)state.marker.on('dragend',()=>{const p=state.marker.getLatLng(),f=state.form;f.lat=+p.lat.toFixed(7);f.lng=+p.lng.toFixed(7);f.source='map';box.querySelector('#site-lat').value=f.lat;box.querySelector('#site-lng').value=f.lng;});}
  if(pan)state.map.setView([l.lat,l.lng],Math.max(state.map.getZoom(),17));
 }
 function render(){state.editing?edit():view();}
 render();
 return {
  updateConfig(cfg){state.cfg=cfg;const b=box.querySelector('#site-badge');if(b)b.innerHTML=badgeHtml();},
  destroy(){state.map?.remove();state.map=null;}
 };
}
