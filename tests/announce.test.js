import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPhrase,templateError,voiceLabel} from '../assets/announce.js';
import {createDemoApi} from '../assets/demo-api.js';

const T='[{장소}에 ][{색상} ]{종류}를 무단으로 버리셨습니다. 되가져가 주시기 바랍니다. 이곳은 CCTV 녹화 중입니다.';
const TAIL=' 무단으로 버리셨습니다. 되가져가 주시기 바랍니다. 이곳은 CCTV 녹화 중입니다.';

test('renderPhrase reproduces the phrases the Jetson speaks today',()=>{
 assert.equal(renderPhrase(T,{장소:'루미노드 사무실 앞',색상:'빨간색',종류:'쓰레기봉투'}),'루미노드 사무실 앞에 빨간색 쓰레기봉투를'+TAIL);
 assert.equal(renderPhrase(T,{장소:'',색상:'갈색',종류:'종이 상자'}),'갈색 종이 상자를'+TAIL,'empty place drops the bracket group');
 assert.equal(renderPhrase(T,{장소:'정문',색상:'',종류:'캔'}),'정문에 캔을'+TAIL,'을/를 follows the final consonant');
 assert.equal(renderPhrase(T,{장소:'정문',색상:'파란색',종류:'페트병'}),'정문에 파란색 페트병을'+TAIL);
});

test('particles match the server rules (same cases as app.py)',()=>{
 const cases=[['{종류}은 안 됩니다',{종류:'옷'},'옷은 안 됩니다'],['{종류}이 있습니다',{종류:'쓰레기봉투'},'쓰레기봉투가 있습니다'],['{장소}으로 오세요',{장소:'정문'},'정문으로 오세요'],
  ['{장소}로 오세요',{장소:'1층'},'1층으로 오세요'],['{장소}으로',{장소:'서울'},'서울로'],['{종류}와 함께',{종류:'캔'},'캔과 함께'],['{종류}를',{종류:'PET'},'PET를']];
 for(const [t,v,exp] of cases)assert.equal(renderPhrase(t,v),exp);
});

test('templateError matches server validation',()=>{
 assert.equal(templateError(T),null);
 assert.match(templateError('{주소}에 버리셨습니다'),/주소/);
 assert.match(templateError('[[{장소}]] 테스트'),/겹칠 수 없습니다/);
 assert.match(templateError('[{장소} 테스트'),/짝이 맞지 않습니다/);
 assert.match(templateError('짧'),/5~300자/);
 assert.equal(voiceLabel('M4'),'남성 4 (M4)');assert.equal(voiceLabel('F2'),'여성 2 (F2)');
});

test('demo mode keeps a per-device announcement config with versioning',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const api=createDemoApi({storage}).request;
 const [d1,d2]=await api('/api/devices');
 const first=await api('/api/devices/'+d1.device_id+'/announce');
 assert.equal(first.version,0);assert.equal(first.voice,'M4');assert.ok(first.voices.includes('F5'));
 const saved=await api('/api/devices/'+d1.device_id+'/announce',{method:'PUT',body:JSON.stringify({...first,voice:'F2',speed:1.1,base_version:0})});
 assert.equal(saved.version,1);assert.equal(saved.voice,'F2');assert.equal(saved.apply_state,'applied');
 assert.equal((await api('/api/devices/'+d2.device_id+'/announce')).voice,'M4','other device keeps its own setting');
 await assert.rejects(()=>api('/api/devices/'+d1.device_id+'/announce',{method:'PUT',body:JSON.stringify({...first,base_version:0})}),/먼저 수정/);
 assert.equal((await createDemoApi({storage}).request('/api/devices/'+d1.device_id+'/announce')).voice,'F2','persists');
});
