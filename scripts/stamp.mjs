// 배포 전에 실행: index.html 과 assets/*.js 의 상대 경로 import 에 ?v=<스탬프> 를 붙여
// 브라우저가 열려 있던 탭에서도 옛 스크립트를 쓰지 않게 한다.
//   node scripts/stamp.mjs            → 현재 시각 스탬프
//   node scripts/stamp.mjs 20261005a  → 지정한 스탬프
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const stamp=process.argv[2]||new Date().toISOString().replace(/[-:T]/g,'').slice(0,12);
const tag=s=>s.replace(/(\.(?:js|css))(\?v=[\w-]+)?(['"])/g,`$1?v=${stamp}$3`);
// assets 안의 상대 import:  from './x.js'  /  import('./x.js')
for(const f of readdirSync(join(root,'assets')).filter(f=>f.endsWith('.js'))){
 const p=join(root,'assets',f);const s=readFileSync(p,'utf8');
 const out=s.replace(/(from\s+|import\()(['"])(\.\/[\w-]+\.js)(\?v=[\w-]+)?\2/g,(m,kw,q,path)=>`${kw}${q}${path}?v=${stamp}${q}`);
 if(out!==s)writeFileSync(p,out);
}
// index.html 의 ./assets/*.js, *.css (vendor 제외)
const ip=join(root,'index.html');let html=readFileSync(ip,'utf8');
html=html.replace(/(\.\/assets\/(?!vendor\/)[\w-]+\.(?:js|css))(\?v=[\w-]+)?(")/g,`$1?v=${stamp}$3`);
writeFileSync(ip,html);
console.log('asset stamp',stamp);
