// ROI(감시 구역 / 제외 구역) 다각형 편집기
// - 좌표는 프레임 대비 0~1 정규화 값으로 저장 → 젯슨이 자기 frame_size 를 곱해 픽셀로 사용
// - 영상(<video>), 썸네일(<img>) 또는 빈 16:9 판 위에 <canvas> 오버레이로 그린다
// - 순수 함수(contentRect, toNormalized, toPixel, pointInPolygon, validateZones)는 DOM 없이 테스트 가능

export const ROI_LIMITS={zones:16,minPoints:3,maxPoints:32};
export const ZONE_TYPES={include:'감시 구역',exclude:'제외 구역'};
const HANDLE=6,CLOSE_DIST=12,DEFAULT_FRAME=[1280,720];

// object-fit: contain 으로 표시된 미디어의 실제 화면 영역 (레터박스 여백 제외)
export function contentRect(boxW,boxH,mediaW,mediaH){
 if(!(boxW>0&&boxH>0))return {x:0,y:0,w:0,h:0};
 if(!(mediaW>0&&mediaH>0))return {x:0,y:0,w:boxW,h:boxH};
 const scale=Math.min(boxW/mediaW,boxH/mediaH),w=mediaW*scale,h=mediaH*scale;
 return {x:(boxW-w)/2,y:(boxH-h)/2,w,h};
}
const clamp01=v=>Math.min(1,Math.max(0,v));
const round5=v=>Math.round(v*1e5)/1e5;
// 화면 좌표 → 정규화 좌표. 영역 밖이면 null (clamp=true 면 가장자리로 붙임)
export function toNormalized(px,py,rect,clamp=false){
 if(!(rect.w>0&&rect.h>0))return null;
 const x=(px-rect.x)/rect.w,y=(py-rect.y)/rect.h;
 if(!clamp&&(x<0||x>1||y<0||y>1))return null;
 return [round5(clamp01(x)),round5(clamp01(y))];
}
export const toPixel=([x,y],rect)=>[rect.x+x*rect.w,rect.y+y*rect.h];
export function pointInPolygon([x,y],poly){
 let inside=false;
 for(let i=0,j=poly.length-1;i<poly.length;j=i++){
  const [xi,yi]=poly[i],[xj,yj]=poly[j];
  if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
 }
 return inside;
}
// 젯슨 판정 규칙과 동일: include 가 없으면 화면 전체 감시, exclude 가 우선
const orient=(a,b,c)=>Math.sign((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]));
const segCross=(p1,p2,p3,p4)=>{const d1=orient(p3,p4,p1),d2=orient(p3,p4,p2),d3=orient(p1,p2,p3),d4=orient(p1,p2,p4);return d1*d2<0&&d3*d4<0;};
// 다각형 변끼리 교차하면 true (이웃한 변은 제외)
export function selfIntersects(points){
 const n=points.length;if(n<4)return false;
 for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
  if(j===i+1||(i===0&&j===n-1))continue;
  if(segCross(points[i],points[(i+1)%n],points[j],points[(j+1)%n]))return true;
 }
 return false;
}
// 이름표 위치: 다각형 안쪽에 있는 점 중 하나 (교차·오목 다각형에서도 다른 구역 이름표와 겹치지 않게)
export function labelPoint(points){
 const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
 const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
 const c=[(minX+maxX)/2,(minY+maxY)/2];if(pointInPolygon(c,points))return c;
 for(let gy=1;gy<8;gy++)for(let gx=1;gx<8;gx++){const p=[minX+(maxX-minX)*gx/8,minY+(maxY-minY)*gy/8];if(pointInPolygon(p,points))return p;}
 return points[0];
}
export function isMonitored(pt,zones){
 const inc=zones.filter(z=>z.type==='include'),exc=zones.filter(z=>z.type==='exclude');
 if(exc.some(z=>pointInPolygon(pt,z.points)))return false;
 return !inc.length||inc.some(z=>pointInPolygon(pt,z.points));
}
// 서버(app.py validate_zones)와 같은 규칙. 문제가 있으면 메시지, 없으면 null
export function validateZones(zones){
 if(!Array.isArray(zones))return 'zones 는 배열이어야 합니다.';
 if(zones.length>ROI_LIMITS.zones)return `구역은 최대 ${ROI_LIMITS.zones}개입니다.`;
 for(const [i,z] of zones.entries()){
  if(!z||!ZONE_TYPES[z.type])return `${i+1}번째 구역 종류가 올바르지 않습니다.`;
  if(!Array.isArray(z.points)||z.points.length<ROI_LIMITS.minPoints||z.points.length>ROI_LIMITS.maxPoints)return `${i+1}번째 구역은 꼭짓점 ${ROI_LIMITS.minPoints}~${ROI_LIMITS.maxPoints}개가 필요합니다.`;
  if(!z.points.every(p=>Array.isArray(p)&&p.length===2&&p.every(v=>typeof v==='number'&&v>=0&&v<=1)))return `${i+1}번째 구역 좌표는 0~1 사이여야 합니다.`;
 }
 return null;
}
const nextName=(zones,type)=>`${ZONE_TYPES[type]} ${zones.filter(z=>z.type===type).length+1}`;
const nextId=zones=>{let n=zones.length+1;while(zones.some(z=>z.id==='z'+n))n++;return 'z'+n;};
const copyZones=zones=>(zones||[]).map(z=>({...z,points:z.points.map(p=>[...p])}));

export class RoiEditor{
 constructor(container,media,{zones=[],editable=false,onChange,visible=true}={}){
  this.visible=visible;
  this.container=container;this.media=media;this.zones=copyZones(zones);this.onChange=onChange;
  this.editable=editable;this.mode='select';this.drawType='include';this.draft=[];this.hover=null;
  this.selected=null;this.drag=null;this.dirty=false;
  this.canvas=document.createElement('canvas');this.canvas.className='roi-canvas';this.ctx=this.canvas.getContext('2d');
  container.classList.add('roi-host');container.appendChild(this.canvas);
  this.handlers={down:e=>this.onDown(e),move:e=>this.onMove(e),up:()=>this.onUp(),dbl:e=>{e.preventDefault();this.closeDraft();},key:e=>this.onKey(e),redraw:()=>this.resize()};
  this.canvas.addEventListener('pointerdown',this.handlers.down);this.canvas.addEventListener('pointermove',this.handlers.move);
  window.addEventListener('pointerup',this.handlers.up);this.canvas.addEventListener('dblclick',this.handlers.dbl);window.addEventListener('keydown',this.handlers.key);
  this.observer=window.ResizeObserver?new ResizeObserver(this.handlers.redraw):null;this.observer?.observe(container);
  this.bindMedia(media);this.setEditable(editable);this.resize();
 }
 bindMedia(media){
  if(this.media)['loadedmetadata','resize','load'].forEach(ev=>this.media.removeEventListener?.(ev,this.handlers.redraw));
  this.media=media;
  if(media)['loadedmetadata','resize','load'].forEach(ev=>media.addEventListener?.(ev,this.handlers.redraw));
  this.resize();
 }
 frameSize(){
  const m=this.media;
  if(m?.videoWidth)return [m.videoWidth,m.videoHeight];
  if(m?.naturalWidth)return [m.naturalWidth,m.naturalHeight];
  return DEFAULT_FRAME;
 }
 rect(){
  const host=this.container.getBoundingClientRect(),box=(this.media||this.container).getBoundingClientRect();
  const [fw,fh]=this.frameSize(),inner=contentRect(box.width,box.height,fw,fh);
  return {x:box.left-host.left+inner.x,y:box.top-host.top+inner.y,w:inner.w,h:inner.h};
 }
 resize(){
  const r=this.container.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  this.canvas.width=Math.round(r.width*dpr);this.canvas.height=Math.round(r.height*dpr);
  this.canvas.style.width=r.width+'px';this.canvas.style.height=r.height+'px';
  this.ctx.setTransform(dpr,0,0,dpr,0,0);this.draw();
 }
 setVisible(on){this.visible=on;this.draw();}
 setEditable(on){this.editable=on;this.canvas.classList.toggle('editing',on);if(!on){this.draft=[];this.mode='select';this.selected=null;}this.draw();}
 startDraw(type){this.mode='draw';this.drawType=type;this.draft=[];this.selected=null;this.draw();}
 setZones(zones){this.zones=copyZones(zones);this.dirty=false;this.selected=null;this.draft=[];this.draw();}
 changed(){this.dirty=true;this.draw();this.onChange?.(this);}
 local(e){const r=this.canvas.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];}
 hitVertex(px,py){
  const rect=this.rect();
  for(let zi=this.zones.length-1;zi>=0;zi--)for(const [pi,p] of this.zones[zi].points.entries()){const [x,y]=toPixel(p,rect);if(Math.hypot(x-px,y-py)<=HANDLE+3)return {zi,pi};}
  return null;
 }
 hitZone(px,py){const n=toNormalized(px,py,this.rect());if(!n)return null;for(let i=this.zones.length-1;i>=0;i--)if(pointInPolygon(n,this.zones[i].points))return i;return null;}
 onDown(e){
  if(!this.editable)return;e.preventDefault();const [px,py]=this.local(e);
  if(this.mode==='draw'){
   if(this.draft.length>=ROI_LIMITS.minPoints){const [fx,fy]=toPixel(this.draft[0],this.rect());if(Math.hypot(fx-px,fy-py)<=CLOSE_DIST){this.closeDraft();return;}}
   const n=toNormalized(px,py,this.rect());if(!n)return;
   if(this.draft.length>=ROI_LIMITS.maxPoints)return;
   this.draft.push(n);this.draw();return;
  }
  const v=this.hitVertex(px,py);
  if(v){this.selected=v.zi;this.drag=v;this.canvas.setPointerCapture?.(e.pointerId);this.draw();this.onChange?.(this);return;}
  this.selected=this.hitZone(px,py);this.draw();this.onChange?.(this);
 }
 onMove(e){
  const [px,py]=this.local(e);
  if(this.drag){const n=toNormalized(px,py,this.rect(),true);if(n){this.zones[this.drag.zi].points[this.drag.pi]=n;this.dirty=true;this.draw();}return;}
  if(this.mode==='draw'){this.hover=toNormalized(px,py,this.rect(),true);this.draw();}
  else if(this.editable)this.canvas.style.cursor=this.hitVertex(px,py)?'move':this.hitZone(px,py)!=null?'pointer':'default';
 }
 onUp(){if(this.drag){this.drag=null;this.changed();}}
 onKey(e){
  if(!this.editable||/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||''))return;
  if(e.key==='Escape'&&this.mode==='draw'){this.cancelDraft();}
  else if(e.key==='Enter'&&this.mode==='draw'){this.closeDraft();}
  else if(e.key==='Backspace'&&this.mode==='draw'&&this.draft.length){e.preventDefault();this.draft.pop();this.draw();}
  else if((e.key==='Delete'||e.key==='Backspace')&&this.selected!=null){e.preventDefault();this.removeSelected();}
 }
 closeDraft(){
  if(this.mode!=='draw')return;
  if(this.draft.length<ROI_LIMITS.minPoints){this.onChange?.(this,`꼭짓점을 ${ROI_LIMITS.minPoints}개 이상 찍어 주세요.`);return;}
  if(this.zones.length>=ROI_LIMITS.zones){this.onChange?.(this,`구역은 최대 ${ROI_LIMITS.zones}개입니다.`);return;}
  this.zones.push({id:nextId(this.zones),name:nextName(this.zones,this.drawType),type:this.drawType,points:this.draft});
  this.selected=this.zones.length-1;this.draft=[];this.mode='select';this.hover=null;this.changed();
 }
 cancelDraft(){this.draft=[];this.mode='select';this.hover=null;this.draw();this.onChange?.(this);}
 removeSelected(){if(this.selected==null)return;this.zones.splice(this.selected,1);this.selected=null;this.changed();}
 clearAll(){if(!this.zones.length)return;this.zones=[];this.selected=null;this.changed();}
 updateSelected(patch){if(this.selected==null)return;Object.assign(this.zones[this.selected],patch);this.changed();}
 hatch(color){
  const p=document.createElement('canvas');p.width=p.height=10;const c=p.getContext('2d');
  c.strokeStyle=color;c.lineWidth=2;c.beginPath();c.moveTo(0,10);c.lineTo(10,0);c.stroke();
  return this.ctx.createPattern(p,'repeat');
 }
 draw(){
  const ctx=this.ctx,rect=this.rect(),w=this.canvas.width,h=this.canvas.height;
  ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,w,h);ctx.restore();
  if(!(rect.w>0))return;
  if(this.editable){ctx.strokeStyle='rgba(255,255,255,.55)';ctx.setLineDash([4,4]);ctx.lineWidth=1;ctx.strokeRect(rect.x+.5,rect.y+.5,rect.w-1,rect.h-1);ctx.setLineDash([]);}
  const placed=[];
  if(!this.visible&&!this.editable)return;
  for(const [i,z] of this.zones.entries()){
   const pts=z.points.map(p=>toPixel(p,rect)),inc=z.type==='include',sel=i===this.selected;
   ctx.beginPath();pts.forEach(([x,y],k)=>k?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();
   // 젯슨 판정(ray casting = even-odd)과 같은 규칙으로 칠한다: 선이 교차한 안쪽은 구멍
   ctx.fillStyle=inc?'rgba(22,161,129,.22)':'rgba(220,116,107,.18)';ctx.fill('evenodd');
   if(!inc){ctx.save();ctx.fillStyle=this.hatch('rgba(220,116,107,.55)');ctx.fill('evenodd');ctx.restore();}
   ctx.setLineDash(this.dirty?[6,4]:[]);ctx.lineWidth=sel?3:2;ctx.strokeStyle=inc?'#16a181':'#dc746b';ctx.stroke();ctx.setLineDash([]);
   let [lx,ly]=toPixel(labelPoint(z.points),rect);
   while(placed.some(([px,py])=>Math.abs(px-lx)<90&&Math.abs(py-ly)<20))ly+=22;
   placed.push([lx,ly]);
   ctx.font='600 12px "Malgun Gothic",system-ui,sans-serif';const label=z.name||ZONE_TYPES[z.type],tw=ctx.measureText(label).width;
   ctx.fillStyle='rgba(16,41,44,.75)';ctx.fillRect(lx-tw/2-5,ly-9,tw+10,18);ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,lx,ly);
   if(this.editable&&(sel||this.mode==='select'))for(const [x,y] of pts){ctx.beginPath();ctx.arc(x,y,sel?HANDLE:HANDLE-2,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.lineWidth=2;ctx.strokeStyle=inc?'#16a181':'#dc746b';ctx.stroke();}
  }
  if(this.mode==='draw'&&this.draft.length){
   const pts=this.draft.map(p=>toPixel(p,rect)),color=this.drawType==='include'?'#16a181':'#dc746b';
   ctx.beginPath();pts.forEach(([x,y],k)=>k?ctx.lineTo(x,y):ctx.moveTo(x,y));if(this.hover){const [hx,hy]=toPixel(this.hover,rect);ctx.lineTo(hx,hy);}
   ctx.setLineDash([5,4]);ctx.lineWidth=2;ctx.strokeStyle=color;ctx.stroke();ctx.setLineDash([]);
   pts.forEach(([x,y],k)=>{ctx.beginPath();ctx.arc(x,y,k===0&&pts.length>=ROI_LIMITS.minPoints?HANDLE+2:HANDLE-1,0,Math.PI*2);ctx.fillStyle=k===0?color:'#fff';ctx.fill();ctx.strokeStyle=color;ctx.stroke();});
  }
 }
 // 서버 PUT 본문
 payload(baseVersion){return {base_version:baseVersion,frame_ref:this.frameSize().map(Math.round),zones:copyZones(this.zones)};}
 destroy(){
  this.observer?.disconnect();this.bindMedia(null);
  this.canvas.removeEventListener('pointerdown',this.handlers.down);this.canvas.removeEventListener('pointermove',this.handlers.move);
  window.removeEventListener('pointerup',this.handlers.up);window.removeEventListener('keydown',this.handlers.key);
  this.canvas.remove();this.container.classList.remove('roi-host');
 }
}
