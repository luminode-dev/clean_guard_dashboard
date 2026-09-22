// 실시간 영상 플레이어 · MediaMTX WebRTC(WHEP) 또는 HLS
// live = {protocol:'webrtc'|'hls', url, headers?}  · headers 에 viewer 계정 Basic 인증을 실을 수 있습니다.
const VIEWER_KEY='clean-guard-live-viewer';
function storedViewer(){try{return sessionStorage.getItem(VIEWER_KEY)||'';}catch{return '';}}
function askViewer(){
 const input=window.prompt('실시간 영상 viewer 계정을 입력하세요 (아이디:비밀번호). 이 탭에만 기억합니다.');
 if(!input||!input.includes(':'))return '';
 const value='Basic '+btoa(input.trim());
 try{sessionStorage.setItem(VIEWER_KEY,value);}catch{}
 return value;
}
export class LivePlayer {
 constructor(video,message){this.video=video;this.message=message;this.pc=null;this.hls=null;this.session=null;this.aborter=new AbortController();this.closed=false;this.headers={};}
 authHeaders(live){
  const headers={...(live.headers||{})};
  if(!headers.Authorization){const saved=storedViewer();if(saved)headers.Authorization=saved;}
  return headers;
 }
 async start(live,retry=true){
  this.message.textContent='라이브 영상에 연결하고 있습니다…';
  this.headers=this.authHeaders(live);
  try{
   if(live.protocol==='hls'){
    if(window.Hls?.isSupported()){
     const headers=this.headers;
     this.hls=new Hls({enableWorker:false,xhrSetup:xhr=>{for(const [k,v] of Object.entries(headers))xhr.setRequestHeader(k,v);}});
     this.hls.loadSource(live.url);this.hls.attachMedia(this.video);
     this.hls.on(Hls.Events.MANIFEST_PARSED,()=>{this.message.textContent='라이브 · 모자이크 영상';this.video.play().catch(()=>{});});
     this.hls.on(Hls.Events.ERROR,(_,data)=>{if(!data.fatal)return;const code=data.response?.code;this.message.textContent=code===401||code===403?'영상 viewer 계정 인증에 실패했습니다. config.js 의 live.user / live.pass 를 확인하세요.':'영상 연결에 실패했습니다. 스트림 주소와 미디어 서버를 확인하세요.';});
    }else if(this.video.canPlayType('application/vnd.apple.mpegurl')){this.video.src=live.url;await this.video.play();this.message.textContent='라이브 · 모자이크 영상';}
    else throw new Error('이 브라우저는 HLS를 지원하지 않습니다.');
    return;
   }
   this.pc=new RTCPeerConnection();this.pc.addTransceiver('video',{direction:'recvonly'});this.pc.addTransceiver('audio',{direction:'recvonly'});
   this.pc.ontrack=e=>{if(this.closed)return;this.video.srcObject=e.streams[0]||new MediaStream([e.track]);this.video.play().catch(()=>{});this.message.textContent='라이브 · 모자이크 영상';};
   this.pc.onconnectionstatechange=()=>{if(this.pc?.connectionState==='failed')this.message.textContent='라이브 연결이 끊겼습니다. UDP 8189 포트포워딩과 webrtcAdditionalHosts 설정을 확인하세요.';};
   await this.pc.setLocalDescription(await this.pc.createOffer());
   await new Promise(resolve=>{const timer=setTimeout(resolve,4000);this.pc.onicegatheringstatechange=()=>{if(this.pc?.iceGatheringState==='complete'){clearTimeout(timer);resolve();}};if(this.pc.iceGatheringState==='complete'){clearTimeout(timer);resolve();}});
   if(this.closed)return;
   const response=await fetch(live.url,{method:'POST',headers:{'Content-Type':'application/sdp',...this.headers},body:this.pc.localDescription.sdp,signal:this.aborter.signal});
   if(response.status===401||response.status===403){
    this.pc.close();this.pc=null;
    if(retry&&!live.headers?.Authorization){try{sessionStorage.removeItem(VIEWER_KEY);}catch{}const auth=askViewer();if(auth&&!this.closed)return this.start({...live,headers:{...(live.headers||{}),Authorization:auth}},false);}
    throw new Error('영상 viewer 계정 인증에 실패했습니다. config.js 의 live.user / live.pass 를 확인하세요.');
   }
   if(!response.ok)throw new Error('미디어 서버 연결 실패 ('+response.status+') · '+live.url);
   const location=response.headers.get('Location');if(location)this.session=new URL(location,live.url).href;
   await this.pc.setRemoteDescription({type:'answer',sdp:await response.text()});
  }catch(e){if(!this.closed)this.message.textContent=e.name==='AbortError'?'라이브 연결을 종료했습니다.':(e.message||'라이브 연결 실패');}
 }
 close(){this.closed=true;this.aborter.abort();this.hls?.destroy();this.pc?.close();if(this.session)fetch(this.session,{method:'DELETE',keepalive:true,headers:this.headers}).catch(()=>{});this.video.pause();this.video.srcObject=null;this.video.removeAttribute('src');this.video.load();}
}
