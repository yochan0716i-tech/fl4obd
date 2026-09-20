import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Transport,initialize,reassemble,classify,row,profileRows,nextDid,allowed} from '../lib/analyzer-core.js';
const sourceRoot=new URL('../',import.meta.url);
const profile=JSON.parse(await readFile(new URL('../analysis_profile.json',import.meta.url)));
const log=await readFile(new URL('testdata/dummy_drive.txt',sourceRoot),'utf8');
const replies=log.split(/\r?\n/).filter(l=>l.includes('0:622920')).map(l=>l.slice(l.indexOf('←')+1).trim().replace(/\b(1[0-5])([0-9A-F]{14})\b/g,(_,n,data)=>(+n).toString(16).toUpperCase()+':'+data));
test('profile and read-only command whitelist',()=>{
 assert.deepEqual(profileRows(profile).map(r=>[r.cmd,r.intervalMs]),[['222920',200],['222902',1000],['222922',1000]]);
 for(const cmd of ['ATSH18DAF107','ATFCSM1','1101','2E292000','3101','04','222920\r04','22GGGG','ATSP7'])assert.equal(allowed(cmd),false,cmd);
 for(const cmd of ['ATZ','ATSP0','011F','222920'])assert.equal(allowed(cmd),true,cmd);
 assert.throws(()=>row('2902\r04',1000));assert.throws(()=>row('2902',0));
});
test('fixture log: Veepeak and legacy formats, known decoder',()=>{
 let good=0,bad=0;
 for(const raw of replies){
  const p=reassemble(raw,'222920');
  if(!p){bad++;continue;}
  good++;assert.equal(p.length,222);const r=classify(raw,'222920');assert(r.decoded);assert(Number.isFinite(r.decoded.rpm));
  const legacy=raw.replace(/\b([A-F]):([0-9A-F]{14})\b/gi,(_,n,data)=>parseInt(n,16)+data);
  assert.equal(reassemble(legacy,'222920'),p);
 }
 assert.equal(good,388);assert.equal(bad,0);assert.equal(reassemble(replies[0].replace(/ E:[0-9A-F]+/,''),'222920'),null);
});
test('unknown DID has no speculative decoded fields and supports different length',()=>{
 const r=classify('008\r0:622902010203\r1:0405\r','222902');
 assert.equal(r.payload,'6229020102030405');assert(!('decoded'in r));
 assert.equal(reassemble('008 0:622902010203 2:0405','222902'),null);
 assert.equal(classify('NO DATA','222922').ok,false);
 assert.equal(classify('SEARCHING...\rSTOPPED','011F').error,'STOPPED');
});
test('scheduler chooses oldest due, disabled never selected',()=>{
 const a=row('2920',200),b=row('2902',1000);a.nextDue=100;b.nextDue=50;
 assert.equal(nextDid([a,b],90),b);b.enabled=false;assert.equal(nextDid([a,b],90),null);
});
test('single request, fragmented response, raw notification retention',async()=>{
 const events=[],sent=[];const t=new Transport(s=>sent.push(s),e=>events.push(e));
 const p=t.request('222902',100);await Promise.resolve();
 await assert.rejects(t.request('222922'),/idle/);
 t.receive('008\r0:622902');t.receive('010203\r1:0405\r>');const r=await p;
 assert.equal(r.payload,'6229020102030405');assert.deepEqual(sent,['222902\r']);
 assert.equal(events.filter(e=>e.type==='rx_chunk').map(e=>e.raw).join(''),'008\r0:622902010203\r1:0405\r>');
 assert(events.every(e=>e.seq===1));t.close();
});
test('NO DATA does not block the next DID',async()=>{
 const events=[];let t;t=new Transport(s=>queueMicrotask(()=>t.receive(s.startsWith('222902')?'NO DATA\r>':'6229220102\r>')),e=>events.push(e));
 assert.equal((await t.request('222902')).ok,false);assert.equal((await t.request('222922')).payload,'6229220102');t.close();
});
test('timeout quarantine associates late response to old seq and then permits next',async()=>{
 const events=[];const t=new Transport(()=>{},e=>events.push(e));
 const p=t.request('222902',10);t.receive('SEARCHING...');
 await assert.rejects(p,/timeout/);await assert.rejects(t.request('222922'),/idle/);
 const drained=t.waitForIdle(100);t.receive('\rNO DATA\r>');assert.equal(await drained,true);
 const p2=t.request('222922',100);t.receive('6229220102>');await p2;
 const late=events.find(e=>e.type==='rx'&&e.late);assert.equal(late.seq,1);assert.equal(late.did,'2902');
 assert.equal(events.find(e=>e.error==='timeout').raw,'SEARCHING...');t.close();
});
test('no prompt -> recovery required; disconnect flushes partial raw and rejects request',async()=>{
 const events=[];const t=new Transport(()=>{},e=>events.push(e));const p=t.request('222902',10);t.receive('partial');
 await assert.rejects(p,/timeout/);assert.equal(await t.waitForIdle(5),false);t.close('disconnect');
 assert.equal(events.find(e=>e.type==='transport_closed').raw,'partial');
 const other=new Transport(()=>{},e=>events.push(e));const pending=other.request('222922',100);other.receive('6229');other.close();await assert.rejects(pending,/disconnect/);
 assert(events.some(e=>e.error==='disconnect'&&e.raw==='6229'));
});
test('write failure closes waiter and is logged',async()=>{
 const events=[];const t=new Transport(()=>Promise.reject(Error('write failed')),e=>events.push(e));
 await assert.rejects(t.request('222902',100),/write failed/);assert(events.some(e=>e.error==='write_error'));t.close();
});
test('index-equivalent initialization order and delays; STOPPED retry',async()=>{
 const commands=[],delays=[];let first=true;
 await initialize({async request(cmd,timeout){commands.push([cmd,timeout]);if(cmd==='ATZ')return {raw:'ELM327 v2.2'};if(cmd==='011F'&&first){first=false;return {raw:'SEARCHING... STOPPED'};}return {raw:cmd==='011F'?'411F0010':cmd==='ATDPN'?'A7':'OK'};}},{pause:async ms=>delays.push(ms)});
 assert.deepEqual(commands.map(x=>x[0]),['ATZ','ATZ','ATE0','ATL0','ATS0','ATSP0','011F','011F','ATDPN']);
 assert.equal(commands[6][1],20000);assert.deepEqual(delays,[300,300,300,500,1000]);
});
test('initialization timeout never sends another OBD request on that link',async()=>{
 const commands=[];await assert.rejects(initialize({async request(cmd){commands.push(cmd);if(cmd==='011F')throw Error('timeout');return {raw:cmd==='ATZ'?'ELM327 v2.2':'OK'};}},{pause:async()=>{}}),/timeout/);
 assert.equal(commands.at(-1),'011F');assert.equal(commands.filter(c=>c==='011F').length,1);
});
