import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {Transport,classify,profileRows,pidRow,nextDid,allowed} from '../lib/analyzer-core.js';
import {selectExportEvents,toJsonl} from '../lib/analyzer-export.js';
const profile=JSON.parse(await readFile(new URL('../analysis_profile.json',import.meta.url)));
const app=await readFile(new URL('../lib/analyzer-app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../analyze.html',import.meta.url),'utf8');
test('SOC profile preserves three DIDs and adds only read-only 015B at 1000ms',()=>{
 const rows=profileRows(profile);
 assert.deepEqual(rows.map(r=>[r.cmd,r.intervalMs]),[['222920',200],['222902',1000],['222922',1000],['015B',1000]]);
 assert.equal(rows[3].did,undefined);assert.equal(rows[3].pid,'5B');
 assert(allowed(rows[3].cmd));assert.throws(()=>pidRow('04',1000));
 assert.throws(()=>profileRows({...profile,pids:[{pid:'5B',command:'04',interval_ms:1000}]}));
 assert.throws(()=>profileRows({...profile,pids:[...profile.pids,...profile.pids]}));
 const mixed=profileRows({...profile,dids:[...profile.dids,{did:'015B',command:'22015B',interval_ms:1000}]});
 assert(mixed.some(r=>r.cmd==='22015B'));assert(mixed.some(r=>r.cmd==='015B'));
});
test('SOC matches Monitor A*100/255, ignoring padding, including endpoints',()=>{
 for(const [raw,a]of [['415B00',0],['415B80',128],['415BFF',255],['41 5B 9E 55 55 55',158],['015B\r415B80555555\r',128]]){
  const r=classify(raw,'015B');assert.equal(r.ok,true);assert.equal(r.decoded.soc,a*100/255);
 }
 for(const raw of ['415B','415BGG','415B8','NO DATA','STOPPED'])assert.equal(classify(raw,'015B').ok,false);
 assert(!classify('6229021234','222902').decoded);
});
test('SOC fragmented notification retains raw/payload/decoded and pid metadata in both exports',async()=>{
 const events=[];const t=new Transport(()=>{},e=>events.push({...e,session_id:'soc'}));
 const p=t.request('015B',100);t.receive('415');t.receive('B80555555\r>');const r=await p;
 assert.equal(r.pid,'5B');assert.equal(r.cmd,'015B');assert.equal(r.did,undefined);
 assert.equal(r.raw,'415B80555555\r');assert.equal(r.payload,'415B80555555');
 assert.equal(r.decoded.soc,128*100/255);
 events.unshift({type:'session_start',session_id:'soc'});
 for(const mode of ['analysis','full']){
  const saved=toJsonl(selectExportEvents(events,{mode})).trim().split('\n').map(JSON.parse);
  assert.deepEqual(saved.find(e=>e.type==='rx'),{...r,session_id:'soc'});
 }
 t.close();
});
test('mixed scheduler serializes SOC and all DIDs without starvation',async()=>{
 const rows=profileRows(profile),counts={};let now=0,active=0,peak=0,t;
 t=new Transport(async wire=>{
  active++;peak=Math.max(peak,active);const cmd=wire.trim();counts[cmd]=(counts[cmd]||0)+1;
  await Promise.resolve();active--;t.receive(cmd==='015B'?'415B80>':('62'+cmd.slice(2)+'1234>'));
 },()=>{});
 while(now<2200){
  const r=nextDid(rows,now);
  if(!r){now=Math.min(...rows.filter(r=>r.enabled).map(r=>r.nextDue));continue;}
  r.nextDue=now+r.intervalMs;await t.request(r.cmd,100);now+=10;
 }
 assert.equal(peak,1);for(const cmd of ['222920','222902','222922','015B'])assert(counts[cmd]>=2,cmd);
 assert(counts['222920']>counts['015B']);rows[3].enabled=false;
 assert.notEqual(nextDid(rows,100000)?.cmd,'015B');t.close();
});
test('SOC NO DATA and timeout preserve failure records and allow subsequent DID after prompt',async()=>{
 const events=[];const t=new Transport(()=>{},e=>events.push(e));
 let p=t.request('015B',100);t.receive('NO DATA>');assert.equal((await p).ok,false);
 p=t.request('015B',10);await assert.rejects(p,/timeout/);
 assert.equal(events.find(e=>e.error==='timeout').pid,'5B');await assert.rejects(t.request('222902'),/idle/);
 t.receive('415B80>');p=t.request('222902',100);t.receive('6229021234>');assert.equal((await p).ok,true);t.close();
});
const labels=['BRAKE','ACCEL','BRAKE+ACCEL','LIGHT','HIGH_BEAM','A/C','CUSTOM'];
function markerHarness(){
 const buttons=labels.map(label=>({dataset:{mark:label},disabled:true})),events=[];
 const code=app.match(/for\(const button of document.querySelectorAll\('\[data-mark\]'\)\)\{\r?\n button.onclick=[\s\S]*?\r?\n\}/)?.[0];assert(code);
 const ctx={recording:true,document:{querySelectorAll:()=>buttons},$:()=>({value:'CUSTOMだけのメモ'}),emit:e=>events.push({...e,ts:new Date().toISOString(),session_id:'test'}),message(){}};
 vm.runInNewContext(code,ctx);return {buttons,events,ctx};
}
test('seven large direct buttons emit exactly one mark immediately; only CUSTOM uses memo',()=>{
 assert.deepEqual([...html.matchAll(/data-mark="([^"]+)"/g)].map(m=>m[1]),labels);
 assert(!html.includes('id="marker"'));assert(!html.includes('id="mark"'));assert(html.includes('min-height:72px'));
 const h=markerHarness();
 for(const b of h.buttons){const n=h.events.length;b.onclick();assert.equal(h.events.length,n+1);assert.equal(h.events.at(-1).label,b.dataset.mark);assert.equal(h.events.at(-1).note,b.dataset.mark==='CUSTOM'?'CUSTOMだけのメモ':'');assert.equal(h.events.at(-1).type,'mark');}
 h.ctx.recording=false;for(const b of h.buttons)b.onclick();assert.equal(h.events.length,7);
});
test('SOC counters use 015B key while DID counters keep previous keys; late SOC not counted twice',()=>{
 const rows=profileRows(profile),events=[],totals=new Map(),children=[];
 const recent={children,prepend:e=>children.unshift(e),get lastChild(){return {remove:()=>children.pop()};}};
 const code=app.match(/function emit\(data\)\{[\s\S]*?\r?\n\}/)[0];
 const ctx={events,totals,rows,db:null,writes:Promise.resolve(),session:'s',connection:1,recording:true,stopping:false,seq:0,
 document:{createElement:()=>({})},$:()=>recent,refresh(){},message(){}};
 vm.runInNewContext(code,ctx);
 ctx.emit({type:'rx',cmd:'015B',pid:'5B',raw:'415B80',ok:true});
 ctx.emit({type:'rx',cmd:'015B',pid:'5B',raw:'',ok:false,error:'timeout'});
 ctx.emit({type:'rx',cmd:'015B',pid:'5B',raw:'415B80',ok:true,late:true});
 ctx.emit({type:'rx',cmd:'222920',did:'2920',raw:'622920',ok:true});
 ctx.emit({type:'rx',cmd:'011F',pid:'1F',raw:'411F0010',ok:true});
 assert.equal(rows[3].countOk,1);assert.equal(rows[3].countErr,1);
 assert.equal(totals.get('015B').ok,1);assert.equal(totals.get('015B').error,1);
 assert.equal(totals.get('2920').ok,1);assert(!totals.has('011F'));
});
