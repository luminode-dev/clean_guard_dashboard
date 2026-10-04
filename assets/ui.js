export const $=(s,root=document)=>root.querySelector(s);
export const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const icons={
 dashboard:'<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
 camera:'<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>',
 layers:'<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
 chart:'<path d="M4 3v17h17M8 15v-4m5 4V6m5 9v-7"/>',
 bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
 shield:'<path d="m12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5zM8 11l3 3 5-5"/>',
 refresh:'<path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/>',
 trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
 arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
 alert:'<path d="m12 3 10 18H2zM12 9v5m0 3v1"/>',
 pin:'<path d="M19 10c0 5-7 12-7 12S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>'
};
export const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.layers}</svg>`;
export function hydrateIcons(root=document){root.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));}
export const labels={online:'정상',degraded:'주의',offline:'오프라인',maintenance:'점검 중',new:'미확인',reviewing:'검토 중',confirmed:'확정',actioned:'조치 완료',dismissed:'제외',info:'안내',warning:'주의',critical:'긴급'};
export const badge=state=>`<span class="badge ${esc(state)}"><i class="dot ${esc(state)}"></i>${esc(labels[state]||state)}</span>`;
export const fmtDate=(v,full=false)=>v?new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,...(full?{year:'numeric'}:{})}):'—';
export const pct=v=>v==null?'—':(v*100).toFixed(1)+'%';
export const localDay=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const empty=(message='조회된 자료가 없습니다.')=>`<div class="empty">${esc(message)}</div>`;
export function metric(label,value,unit,foot,ico){return `<article class="metric"><div class="metric-top">${label}<span class="metric-icon">${icon(ico)}</span></div><div class="metric-number">${value}<span>${unit}</span></div><div class="metric-foot">${foot}</div></article>`;}
export function hourChart(values){
 const max=Math.max(4,...values),w=480,h=178,left=28,bottom=150,step=18.2;
 let svg=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="시간대별 사건 수. 최고 ${max}건">`;
 for(let i=0;i<=3;i++){const y=bottom-i*42;svg+=`<line x1="${left}" y1="${y}" x2="472" y2="${y}" stroke="#edf2ef" stroke-dasharray="3 4"/><text x="16" y="${y+3}" text-anchor="end" fill="#a9b5af" font-size="8">${Math.round(max*i/3)}</text>`;}
 values.forEach((n,i)=>{const barH=n/max*126;svg+=`<rect x="${left+i*step+3}" y="${bottom-barH}" width="10" height="${Math.max(barH,1)}" rx="2" fill="${n===Math.max(...values)&&n>0?'#118b70':'#b9dfce'}"><title>${i}시: ${n}건</title></rect>`;if(i%4===0) svg+=`<text x="${left+i*step+7}" y="170" text-anchor="middle" fill="#9eada6" font-size="8">${String(i).padStart(2,'0')}:00</text>`;});
 return svg+'</svg>';
}
export function classBars(classes){const entries=Object.entries(classes).sort((a,b)=>b[1]-a[1]),max=Math.max(1,...entries.map(x=>x[1]));return entries.length?'<div class="bar-list">'+entries.map(([k,n])=>`<div class="bar-row"><div class="bar-label"><span>${esc(k)}</span><strong>${n}건</strong></div><div class="bar-track"><div class="bar-value" style="width:${n/max*100}%"></div></div></div>`).join('')+'</div>':empty();}
// 사건 목록의 영상 칸: 클립이 있으면 바로 재생 버튼
export function clipCell(e){const m=e.media||{};if(m.clip)return `<button class="clip-play" data-clip-event="${esc(e.event_id)}" aria-label="투기 장면 영상 재생">▶ 재생</button>`;if(m.clip_status==='pending')return '<span class="cell-sub">생성 중</span>';if(m.clip_status==='missing'||m.clip_status==='expired')return `<span class="cell-sub" title="${esc(m.clip_note||'')}">${m.clip_status==='expired'?'삭제됨':'영상 없음'}</span>`;return '<span class="cell-sub">—</span>';}
export function eventTable(items,compact=false){return items.length?`<div class="table-wrap"><table><thead><tr><th>발생 시각</th><th>설치 지점</th><th>탐지 종류</th><th>처리 상태</th>${compact?'':'<th>영상</th><th>신뢰도</th><th>방송</th><th>상세</th>'}</tr></thead><tbody>${items.map(e=>`<tr class="click-row" data-event="${esc(e.event_id)}"><td>${esc(fmtDate(e.ts))}<small class="cell-sub">${esc(e.device_id)}</small></td><td><span class="cell-title">${esc(e.site?.name||e.site_id)}</span><small class="cell-sub">${esc(e.site?.region?.dong||'')}</small></td><td><span class="event-class"><span class="waste-icon">${icon('trash')}</span>${esc(e.detection.class)}</span></td><td>${badge(e.review.state)}</td>${compact?'':`<td>${clipCell(e)}</td><td>${(e.detection.conf*100).toFixed(0)}%</td><td>${e.announce?.played?'<span style="color:#409f82">방송 완료</span>':'미방송'}</td><td><button class="icon-btn" data-event="${esc(e.event_id)}" aria-label="${esc(e.site?.name||e.event_id)} 사건 상세">${icon('arrow')}</button></td>`}</tr>`).join('')}</tbody></table></div>`:empty();}
export function alertCards(items,full=false){return items.length?`<div class="alert-list">${items.map(a=>`<article class="alert-card"><span class="alert-symbol ${esc(a.severity)}">${icon(a.kind.startsWith('device')?'camera':a.kind==='event_new'?'trash':'alert')}</span><div class="alert-copy"><h3>${esc(a.summary)}</h3><p>${esc(a.device_id)} · ${esc(fmtDate(a.ts))}${a.resolved?' · 정상 복구됨':''}${a.acked?' · '+esc(a.acked_by)+' 확인':''}</p>${full&&a.event_id?`<button class="panel-link" data-event="${esc(a.event_id)}">사건 보기 →</button>`:''}</div>${full&&!a.acked?`<button class="button" data-ack="${esc(a.alert_id)}">확인</button>`:badge(a.severity)}</article>`).join('')}</div>`:empty('확인할 알림이 없습니다.');}
