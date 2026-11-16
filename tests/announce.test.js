import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPhrase,templateError,voiceLabel,templateToParts,partsToTemplate,textToParts} from '../assets/announce.js';
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

test('chip editor: default template opens as chips and saves back unchanged',()=>{
 const parts=templateToParts(T);
 assert.deepEqual(parts.slice(0,5),[{type:'token',name:'장소'},{type:'text',text:'에 '},{type:'token',name:'색상'},{type:'text',text:' '},{type:'token',name:'종류'}]);
 assert.equal(partsToTemplate(parts),T);
});

test('chip editor: place/color chips drop together with the word attached to them',()=>{
 // 사용자가 칩 + 평범한 글만 입력한 경우 (대괄호 없이)
 const typed=[{type:'text',text:'여기는 '},{type:'token',name:'장소'},{type:'text',text:'입니다. '},{type:'token',name:'색상'},{type:'text',text:' '},{type:'token',name:'종류'},{type:'text',text:'를 버리지 마세요.'}];
 const t=partsToTemplate(typed);
 assert.equal(t,'여기는 [{장소}입니다. ][{색상} ]{종류}를 버리지 마세요.');
 assert.equal(templateError(t),null);
 assert.equal(renderPhrase(t,{장소:'정문',색상:'빨간색',종류:'캔'}),'여기는 정문입니다. 빨간색 캔을 버리지 마세요.');
 assert.equal(renderPhrase(t,{장소:'',색상:'',종류:'종이 상자'}),'여기는 종이 상자를 버리지 마세요.');
 assert.deepEqual(templateToParts(t),typed,'round trip');
});

test('chip editor: typed codes become chips, stray brackets are removed',()=>{
 assert.deepEqual(textToParts('{장소}에 [빨간] {종류}'),[{type:'token',name:'장소'},{type:'text',text:'에 빨간 '},{type:'token',name:'종류'}]);
 assert.equal(partsToTemplate([{type:'token',name:'장소'},{type:'token',name:'종류'},{type:'text',text:'를'}]),'[{장소}]{종류}를');
 assert.equal(partsToTemplate([{type:'text',text:'끝에 '},{type:'token',name:'색상'}]),'끝에 [{색상}]');
});

test('chip editor: templates chips cannot show fall back to code view',()=>{
 assert.equal(templateToParts('[앞 {장소}에 ]{종류}를 버리지 마세요'),null);
 assert.equal(templateToParts('[{장소} {색상} ]{종류}를'),null);
 assert.equal(templateToParts('{장소}에 버리지 마세요'),null,'bare place would change meaning when empty');
 assert.ok(templateToParts('{종류}를 버리지 마세요'));
});
