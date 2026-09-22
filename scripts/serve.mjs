// 개발용 정적 파일 서버 + API/WebSocket 프록시
//   npm start                                              → 정적 파일만 (서버 응답이 없으면 시연 데이터)
//   npm start -- --api https://cleanguard.duckdns.org     → /api, /ws, /snapshots 를 운영 서버로 프록시
//   npm start -- --api http://127.0.0.1:8010                → 서버 PC 에서 FastAPI 로 직접 프록시
//   환경 변수로도 지정: API_TARGET, PORT, HOST(0.0.0.0 이면 같은 망의 휴대폰에서 접속 가능), PROXY_PATHS, API_INSECURE=1
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {readFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),arg=name=>{const i=args.indexOf('--'+name);if(i>=0)return args[i+1];const kv=args.find(a=>a.startsWith('--'+name+'='));return kv?kv.slice(name.length+3):undefined;};
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const port=Number(arg('port')||process.env.PORT)||4173,host=arg('host')||process.env.HOST||'127.0.0.1';
const targetRaw=arg('api')||process.env.API_TARGET;
let target=null;
if(targetRaw){try{target=new URL(targetRaw);}catch{console.error('API_TARGET 형식이 올바르지 않습니다: '+targetRaw);process.exit(1);}}
const proxied=(arg('paths')||process.env.PROXY_PATHS||'/api,/ws,/snapshots').split(',').map(s=>s.trim()).filter(Boolean);
const insecure=process.env.API_INSECURE==='1';
const isProxied=path=>!!target&&proxied.some(p=>path===p||path.startsWith(p.endsWith('/')?p:p+'/'));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'};
const targetPort=()=>Number(target.port)||(target.protocol==='https:'?443:80);
function proxy(req,res){
 const client=target.protocol==='https:'?https:http;
 const headers={...req.headers,host:target.host};
 const up=client.request({protocol:target.protocol,hostname:target.hostname,port:targetPort(),method:req.method,path:req.url,headers,rejectUnauthorized:!insecure},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
 up.on('error',e=>{if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({detail:'API 프록시 연결 실패 ('+target.origin+'): '+e.message}));});
 req.pipe(up);
}
function proxyUpgrade(req,socket,head){
 const secure=target.protocol==='https:';
 const upstream=(secure?tls:net).connect({host:target.hostname,port:targetPort(),servername:target.hostname,rejectUnauthorized:!insecure},()=>{
  const lines=[`${req.method} ${req.url} HTTP/1.1`];
  for(const [k,v] of Object.entries({...req.headers,host:target.host}))for(const value of [].concat(v))lines.push(`${k}: ${value}`);
  upstream.write(lines.join('\r\n')+'\r\n\r\n');if(head?.length)upstream.write(head);
  upstream.pipe(socket);socket.pipe(upstream);
 });
 upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
}
const server=http.createServer(async(req,res)=>{
 const rawPath=new URL(req.url,'http://localhost').pathname;
 if(isProxied(rawPath))return proxy(req,res);
 try{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  let path=decodeURIComponent(rawPath);
  if(path==='/')path='/index.html';
  const file=resolve(root,'.'+path);
  if(!(path==='/index.html'||path.startsWith('/assets/'))||!file.startsWith(root+sep))throw new Error('Not found');
  const bytes=await readFile(file);
  res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
  res.end(req.method==='HEAD'?undefined:bytes);
 }catch{res.writeHead(404);res.end('Not found');}
});
server.on('upgrade',(req,socket,head)=>{if(isProxied(new URL(req.url,'http://localhost').pathname))proxyUpgrade(req,socket,head);else socket.destroy();});
server.listen(port,host,()=>{
 console.log(`Clean Guard UI: http://${host}:${port}`);
 if(target)console.log(`API 프록시: ${proxied.join(', ')} → ${target.origin}${insecure?' (인증서 검증 끔)':''}`);
 else console.log('API_TARGET 미설정 · 서버 응답이 없으면 브라우저 시연 데이터로 동작합니다. 예) npm start -- --api https://cleanguard.duckdns.org');
});
