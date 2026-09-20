export class LivePlayer {
 constructor(video,message){this.video=video;this.message=message;this.pc=null;this.hls=null;this.session=null;this.aborter=new AbortController();this.closed=false;}
 async start(live){
  this.message.textContent='라이브 영상에 연결하고 있습니다…';
  try{
   if(live.protocol==='hls'){
    if(window.Hls?.isSupported()){
     this.hls=new Hls({enableWorker:false});this.hls.loadSource(live.url);this.hls.attachMedia(this.video);
     this.hls.on(Hls.Events.MANIFEST_PARSED,()=>{this.message.textContent='라이브 · 모자이크 영상';this.video.play().catch(()=>{});});
     this.hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal)this.message.textContent='영상 연결에 실패했습니다. 스트림 주소와 미디어 서버를 확인하세요.';});
    }else if(this.video.canPlayType('application/vnd.apple.mpegurl')){this.video.src=live.url;await this.video.play();this.message.textContent='라이브 · 모자이크 영상';}
    else throw new Error('이 브라우저는 HLS를 지원하지 않습니다.');
    return;
   }
   this.pc=new RTCPeerConnection();this.pc.addTransceiver('video',{direction:'recvonly'});this.pc.addTransceiver('audio',{direction:'recvonly'});
   this.pc.ontrack=e=>{if(this.closed)return;this.video.srcObject=e.streams[0]||new MediaStream([e.track]);this.video.play().catch(()=>{});this.message.textContent='라이브 · 모자이크 영상';};
   this.pc.onconnectionstatechange=()=>{if(this.pc?.connectionState==='failed')this.message.textContent='라이브 연결이 끊겼습니다. 다시 열어 연결하세요.';};
   await this.pc.setLocalDescription(await this.pc.createOffer());
   await new Promise(resolve=>{const timer=setTimeout(resolve,4000);this.pc.onicegatheringstatechange=()=>{if(this.pc?.iceGatheringState==='complete'){clearTimeout(timer);resolve();}};if(this.pc.iceGatheringState==='complete'){clearTimeout(timer);resolve();}});
   if(this.closed)return;
   const response=await fetch(live.url,{method:'POST',headers:{'Content-Type':'application/sdp'},body:this.pc.localDescription.sdp,signal:this.aborter.signal});
   if(!response.ok)throw new Error('미디어 서버 연결 실패 ('+response.status+')');
   const location=response.headers.get('Location');if(location)this.session=new URL(location,live.url).href;
   await this.pc.setRemoteDescription({type:'answer',sdp:await response.text()});
  }catch(e){if(!this.closed)this.message.textContent=e.message||'라이브 연결 실패';}
 }
 close(){this.closed=true;this.aborter.abort();this.hls?.destroy();this.pc?.close();if(this.session)fetch(this.session,{method:'DELETE',keepalive:true}).catch(()=>{});this.video.pause();this.video.srcObject=null;this.video.removeAttribute('src');this.video.load();}
}
