// 방송 설정 패널: 장치별 목소리·속도·문구 틀을 정하고, 젯슨 목소리로 미리 들어 본 뒤 적용한다.
// 문구 틀 규칙은 서버(app.py render_phrase)·젯슨과 같다.
//   {장소} {색상} {종류}  자리표시자
//   [ … ]                 안의 자리표시자 값이 하나라도 비면 구간째 빠짐
//   을/를 은/는 이/가 과/와 으로/로   자리표시자 바로 뒤 조사는 받침에 맞게 자동 수정
export const ANNOUNCE_TOKENS=['장소','색상','종류'];
const PARTICLES=[['으로','로'],['을','를'],['은','는'],['이','가'],['과','와']];
const TOKEN_RE=new RegExp('^\\{('+ANNOUNCE_TOKENS.join('|')+')\\}');
const jong=ch=>{const c=(ch||'').charCodeAt(0)-0xAC00;return c>=0&&c<11172?c%28:null;};
function fixParticle(value,rest){
 if(!value)return ['',0];
 const j=jong(value.at(-1));
 for(const [withJ,without] of PARTICLES)for(const written of [withJ,without])if(rest.startsWith(written)){
  if(j===null)return [written,written.length];
  if(withJ==='으로')return [(j===0||j===8)?'로':'으로',written.length];
  return [j?withJ:without,written.length];
 }
 return ['',0];
}
function renderInner(template,values){
 let out='',i=0;
 while(i<template.length){
  const ch=template[i];
  if(ch==='['){const end=template.indexOf(']',i),inner=template.slice(i+1,end);
   const names=[...inner.matchAll(new RegExp('\\{('+ANNOUNCE_TOKENS.join('|')+')\\}','g'))].map(m=>m[1]);
   if(names.every(n=>String(values[n]??'').trim()))out+=renderInner(inner,values);
   i=end+1;continue;}
  const m=template.slice(i).match(TOKEN_RE);
  if(m){const v=String(values[m[1]]??'').trim();i+=m[0].length;const [p,used]=fixParticle(v,template.slice(i));out+=v+p;i+=used;continue;}
  out+=ch;i++;
 }
 return out;
}
export function renderPhrase(template,values){return renderInner(template,values).replace(/\s{2,}/g,' ').trim();}
export function templateError(t){
 t=String(t||'').trim();
 if(t.length<5||t.length>300)return '방송 문구는 5~300자여야 합니다.';
 const bad=[...t.matchAll(/\{([^{}]*)\}/g)].map(m=>m[1]).filter(x=>!ANNOUNCE_TOKENS.includes(x));
 if(bad.length)return '쓸 수 없는 자리표시자입니다: '+bad.map(b=>'{'+b+'}').join(', ');
 let d=0;for(const ch of t){d+=ch==='['?1:ch===']'?-1:0;if(d<0||d>1)return '대괄호 [ ] 는 짝이 맞아야 하고 겹칠 수 없습니다.';}
 return d?'대괄호 [ ] 의 짝이 맞지 않습니다.':null;
}
export const voiceLabel=v=>/^M\d+$/.test(v)?`남성 ${v.slice(1)} (${v})`:/^F\d+$/.test(v)?`여성 ${v.slice(1)} (${v})`:v;
const STATES={none:['maintenance','기본 설정 사용'],pending:['new','젯슨 전달 대기'],applied:['online','젯슨 적용됨'],failed:['offline','적용 실패']};

export function mountAnnouncePanel({box,deviceId,api,toast,esc,fmtDate,demo}){
 let doc=null,form=null,editing=false,job=null,pollTimer=null,audioUrl=null;
 const badge=()=>{const st=doc?.apply_state||'none',[c,l]=STATES[st]||STATES.none;return `<span class="badge ${c}"><i class="dot ${c}"></i>${l}${doc?.version?' · v'+doc.version:''}</span>`;};
 const sampleValues=()=>{const f=form||doc;const cls=f._sampleClass??Object.keys(f.classes||{})[0]??'';return {장소:f._samplePlace??doc.site_name??'',색상:f._sampleColor??(f.colors||[])[0]??'',종류:(f.classes||{})[cls]??cls};};
 async function load(){try{doc=await api('/api/devices/'+encodeURIComponent(deviceId)+'/announce');render();}catch(e){box.innerHTML=`<h3>방송 설정</h3><p class="cell-sub">${esc(e.message)}</p>`;}}
 function view(){
  box.innerHTML=`<div class="roi-head"><h3>방송 설정</h3><span id="ann-badge">${badge()}</span></div>
   ${doc.apply_state==='failed'&&doc.apply_error?`<p class="error">${esc(doc.apply_error)}</p>`:''}
   <p class="site-line">목소리 <b>${esc(voiceLabel(doc.voice))}</b> · 속도 ${Number(doc.speed).toFixed(2)}배${doc.enabled?'':' · <b style="color:#c16a61">방송 끔</b>'}</p>
   <p class="ann-sentence">“${esc(renderPhrase(doc.template,sampleValues()))}”</p>
   <p class="cell-sub">${doc.updated_by?esc(doc.updated_by)+' '+esc(fmtDate(doc.updated_at))+' 저장':'아직 저장한 설정이 없어 기본 문구를 씁니다.'}</p>
   <div class="roi-tools"><button class="button" id="ann-edit">방송 편집</button></div>`;
  box.querySelector('#ann-edit').onclick=()=>{editing=true;form=JSON.parse(JSON.stringify({enabled:doc.enabled,voice:doc.voice,speed:doc.speed,template:doc.template,classes:doc.classes,colors:doc.colors}));render();};
 }
 function edit(){
  const f=form,voices=[...new Set([...(doc.voices||[]),f.voice])];
  const clsKeys=Object.keys(f.classes);
  box.innerHTML=`<div class="roi-head"><h3>방송 편집</h3><span id="ann-badge">${badge()}</span></div>
   <div class="site-form">
    <label>목소리<select id="ann-voice">${voices.map(v=>`<option value="${esc(v)}" ${v===f.voice?'selected':''}>${esc(voiceLabel(v))}</option>`).join('')}</select></label>
    <label>속도 <b id="ann-speed-v">${Number(f.speed).toFixed(2)}배</b><input id="ann-speed" type="range" min="0.7" max="1.5" step="0.05" value="${f.speed}"></label>
    <label class="full">방송 문구<textarea id="ann-template" maxlength="300" rows="3">${esc(f.template)}</textarea></label>
    <div class="full ann-tokens">끼워 넣기 <button type="button" class="button" data-ins="[{장소}에 ]">[장소]</button><button type="button" class="button" data-ins="[{색상} ]">[색상]</button><button type="button" class="button" data-ins="{종류}를">종류</button>
     <small class="cell-sub">대괄호 안은 값이 없으면 빠집니다. 을/를·은/는·이/가는 자동으로 맞춥니다.</small></div>
    <p id="ann-error" class="error full"></p>
    <div class="full ann-sample"><b>예시</b> 색상 <select id="ann-s-color">${f.colors.map(c=>`<option ${c===(f._sampleColor??f.colors[0])?'selected':''}>${esc(c)}</option>`).join('')}<option value="" ${f._sampleColor===''?'selected':''}>(색상 모름)</option></select>
     종류 <select id="ann-s-class">${clsKeys.map(k=>`<option value="${esc(k)}" ${k===(f._sampleClass??clsKeys[0])?'selected':''}>${esc(k)}</option>`).join('')}</select>
     <label class="ann-inline"><input type="checkbox" id="ann-s-place" ${f._samplePlace===''?'':'checked'}> 장소 넣기</label></div>
    <p class="ann-sentence full" id="ann-preview-text"></p>
    <details class="full"><summary>종류별 읽는 말 (${clsKeys.length}) · 색상 목록 (${f.colors.length})</summary>
     <div class="ann-vocab" id="ann-classes">${clsKeys.map(k=>`<label>${esc(k)}<input data-cls="${esc(k)}" value="${esc(f.classes[k])}" maxlength="20"></label>`).join('')}</div>
     <label class="full">색상 (쉼표로 구분)<input id="ann-colors" value="${esc(f.colors.join(', '))}"></label>
    </details>
    <label class="ann-inline full"><input type="checkbox" id="ann-enabled" ${f.enabled?'checked':''}> 무단투기 탐지 시 방송하기</label>
   </div>
   <div class="audio-box" id="ann-audio"></div>
   <div class="roi-actions"><button class="button" id="ann-preview">▶ 미리듣기</button><button class="primary" id="ann-save">저장 후 젯슨에 적용</button><button class="button" id="ann-cancel">편집 취소</button><button class="button" id="ann-default" title="기본 문구와 목소리로 되돌림">기본값</button></div>
   <p class="footnote roi-help">미리듣기는 이 젯슨이 실제 목소리로 합성해 보내 줍니다(몇 초 소요). 적용하면 젯슨이 고정 문구를 미리 렌더링해 두고, 사건 때는 색상·종류만 합성해 이어 붙입니다.</p>`;
  const $=s=>box.querySelector(s),ta=$('#ann-template');
  const refresh=()=>{f.template=ta.value;const err=templateError(f.template);$('#ann-error').textContent=err||'';$('#ann-preview-text').textContent=err?'':'“'+renderPhrase(f.template,sampleValues())+'”';};
  ta.addEventListener('input',refresh);
  $('#ann-voice').onchange=e=>{f.voice=e.target.value;};
  $('#ann-speed').oninput=e=>{f.speed=Number(e.target.value);$('#ann-speed-v').textContent=f.speed.toFixed(2)+'배';};
  $('#ann-s-color').onchange=e=>{f._sampleColor=e.target.value;refresh();};
  $('#ann-s-class').onchange=e=>{f._sampleClass=e.target.value;refresh();};
  $('#ann-s-place').onchange=e=>{f._samplePlace=e.target.checked?undefined:'';refresh();};
  $('#ann-enabled').onchange=e=>{f.enabled=e.target.checked;};
  box.querySelectorAll('[data-cls]').forEach(i=>i.oninput=()=>{f.classes[i.dataset.cls]=i.value;refresh();});
  $('#ann-colors').onchange=e=>{f.colors=e.target.value.split(',').map(s=>s.trim()).filter(Boolean);render();};
  box.querySelectorAll('[data-ins]').forEach(b=>b.onclick=()=>{const s=ta.selectionStart??ta.value.length,e=ta.selectionEnd??s;ta.value=ta.value.slice(0,s)+b.dataset.ins+ta.value.slice(e);ta.focus();ta.selectionStart=ta.selectionEnd=s+b.dataset.ins.length;refresh();});
  $('#ann-cancel').onclick=()=>{stopPoll();editing=false;form=null;render();};
  $('#ann-default').onclick=()=>{if(!window.confirm('기본 문구·목소리로 되돌릴까요? (저장해야 적용됩니다)'))return;form={...form,enabled:true,voice:'M4',speed:1,template:'[{장소}에 ][{색상} ]{종류}를 무단으로 버리셨습니다. 되가져가 주시기 바랍니다. 이곳은 CCTV 녹화 중입니다.'};render();};
  $('#ann-preview').onclick=preview;
  $('#ann-save').onclick=save;
  refresh();
  if(audioUrl)showAudio(audioUrl,job);
 }
 const payload=()=>({enabled:form.enabled,voice:form.voice,speed:form.speed,template:form.template.trim(),classes:Object.fromEntries(Object.entries(form.classes).map(([k,v])=>[k,String(v).trim()||k])),colors:form.colors});
 async function preview(){
  const err=templateError(form.template);if(err){toast(err);return;}
  const v=sampleValues(),text=renderPhrase(form.template,v),box2=box.querySelector('#ann-audio');
  if(demo){speakInBrowser(text);box2.innerHTML='<small class="cell-sub">시연 모드: 브라우저 기본 음성으로 읽었습니다. 실제 방송은 젯슨 목소리입니다.</small>';return;}
  const btn=box.querySelector('#ann-preview');btn.disabled=true;btn.textContent='젯슨에서 합성 중…';box2.innerHTML='<small class="cell-sub">젯슨에 미리듣기 요청을 보냈습니다…</small>';
  try{
   job=await api('/api/devices/'+encodeURIComponent(deviceId)+'/announce/preview',{method:'POST',body:JSON.stringify({...payload(),sample:{장소:v.장소,색상:v.색상,종류:form._sampleClass??Object.keys(form.classes)[0]}})});
   poll(job.job_id);
  }catch(e){toast(e.message);btn.disabled=false;btn.textContent='▶ 미리듣기';box2.innerHTML='';}
 }
 function poll(id){
  stopPoll();const started=Date.now();
  pollTimer=setInterval(async()=>{
   try{const j=await api('/api/devices/'+encodeURIComponent(deviceId)+'/announce/preview/'+encodeURIComponent(id));
    if(j.status==='queued'||j.status==='sent'){const b=box.querySelector('#ann-audio');if(b)b.innerHTML=`<small class="cell-sub">${j.status==='sent'?'젯슨이 합성하고 있습니다…':'젯슨 응답을 기다리는 중…'} ${Math.round((Date.now()-started)/1000)}초</small>`;return;}
    onPreview(j);
   }catch(e){stopPoll();toast(e.message);}
  },1000);
 }
 function stopPoll(){clearInterval(pollTimer);pollTimer=null;}
 function onPreview(j){
  if(!job||j.job_id!==job.job_id)return;stopPoll();job=j;
  const btn=box.querySelector('#ann-preview');if(btn){btn.disabled=false;btn.textContent='▶ 미리듣기';}
  if(j.status==='done'&&j.audio){audioUrl=j.audio;showAudio(j.audio,j,true);}
  else{const b=box.querySelector('#ann-audio');if(b)b.innerHTML=`<p class="error">${esc(j.error||'미리듣기에 실패했습니다.')}</p>`;}
 }
 function showAudio(url,j,autoplay){
  const b=box.querySelector('#ann-audio');if(!b)return;
  b.innerHTML=`<audio controls ${autoplay?'autoplay':''} src="${esc(url)}"></audio><small class="cell-sub">젯슨 목소리 ${esc(voiceLabel(j?.voice||''))} · ${j?.audio_s?j.audio_s.toFixed(1)+'초 · ':''}“${esc(j?.text||'')}”</small>`;
 }
 function speakInBrowser(text){try{const u=new SpeechSynthesisUtterance(text);u.lang='ko-KR';u.rate=form.speed;speechSynthesis.cancel();speechSynthesis.speak(u);}catch{toast('이 브라우저는 음성 읽기를 지원하지 않습니다.');}}
 async function save(){
  const err=templateError(form.template);if(err){toast(err);return;}
  const btn=box.querySelector('#ann-save');btn.disabled=true;
  try{doc=await api('/api/devices/'+encodeURIComponent(deviceId)+'/announce',{method:'PUT',body:JSON.stringify({...payload(),base_version:doc.version||0})});
   stopPoll();editing=false;form=null;render();toast(demo?'방송 설정을 저장했습니다 (시연 모드).':'방송 설정을 저장했습니다. 다음 하트비트(최대 30초)에 젯슨이 받아 렌더링합니다.');}
  catch(e){toast(e.message);btn.disabled=false;}
 }
 function render(){if(!doc)return;editing?edit():view();}
 load();
 return {
  updateConfig(cfg){if(!doc)return;Object.assign(doc,{apply_state:cfg.apply_state,applied_version:cfg.applied_version,apply_error:cfg.apply_error});const b=box.querySelector('#ann-badge');if(b)b.innerHTML=badge();if(cfg.apply_state==='applied')toast('젯슨에 방송 설정이 적용되었습니다 · v'+cfg.version);if(cfg.apply_state==='failed')toast('젯슨 방송 설정 적용 실패 · '+(cfg.apply_error||''));},
  onPreview,
  destroy(){stopPoll();}
 };
}
