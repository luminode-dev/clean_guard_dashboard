// wss://cleanguard.duckdns.org/ws/events 실시간 사건 수신 (자동 재접속)
export function connectEvents({url,onEvent,onStatus,WebSocketImpl=globalThis.WebSocket}={}){
 let ws=null,closed=false,delay=1000,timer=null;
 function open(){
  if(closed||!WebSocketImpl)return;
  try{ws=new WebSocketImpl(url);}catch(e){onStatus?.('error',e);schedule();return;}
  ws.onopen=()=>{delay=1000;onStatus?.('open');};
  ws.onmessage=e=>{let data=e.data;if(typeof data==='string'){try{data=JSON.parse(data);}catch{}}onEvent?.(data);};
  ws.onerror=()=>{onStatus?.('error');};
  ws.onclose=()=>{onStatus?.('closed');schedule();};
 }
 function schedule(){if(closed)return;clearTimeout(timer);timer=setTimeout(open,delay);delay=Math.min(delay*2,30000);}
 open();
 return {close(){closed=true;clearTimeout(timer);try{ws?.close();}catch{}},get readyState(){return ws?.readyState;}};
}
