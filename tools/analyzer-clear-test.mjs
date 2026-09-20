import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const app=await readFile(new URL('../lib/analyzer-app.js',import.meta.url),'utf8');
const clear=app.slice(app.indexOf('async function clearLogs(){'),app.indexOf('async function save(mode){'));
function harness({recording=false,stopping=false,approve=true,fail=false,available=true}={}){
 const disk=[{type:'old'}],memory=[...disk],items=[{removed:false,remove(){this.removed=true;}}];
 let confirmed=0,clears=0,release;
 const pending=new Promise(r=>release=r);
 const ctx=vm.createContext({recording,stopping,clearing:false,events:memory,writes:pending,persistenceError:'old',seq:42,profile:{id:1},rows:[{did:'2920',enabled:true}],transport:{seq:42},
  $:()=>({children:items}),confirm:()=>{confirmed++;return approve;},refresh:()=>{},message:s=>ctx.messageText=s,
  db:available?{transaction(store,mode){assert.equal(store,'events');assert.equal(mode,'readwrite');const tx={objectStore(name){assert.equal(name,'events');return {clear(){clears++;queueMicrotask(()=>{if(fail){tx.error=Error('disk failure');tx.onabort();}else{disk.length=0;tx.oncomplete();}});}};}};return tx;}}:null});
 vm.runInContext(clear,ctx);
 return {ctx,disk,items,release,counts:()=>({confirmed,clears})};
}
test('all Analyzer local module edges use the same fixed cache version',async()=>{
 const html=await readFile(new URL('../analyze.html',import.meta.url),'utf8');
 const entry=html.match(/<script type="module" src="([^"]+)"/)[1];
 const visited=new Set();let edges=0;
 async function walk(spec,parent){assert.match(spec,/\?v=20260920g$/);edges++;const url=new URL(spec,parent);url.search='';if(visited.has(url.href))return;visited.add(url.href);const src=await readFile(url,'utf8');for(const m of src.matchAll(/^import[^\r\n]*from\s+['"]([^'"]+)['"]/gm))if(m[1].startsWith('.'))await walk(m[1],url);}
 await walk(entry,new URL('../analyze.html',import.meta.url));assert.equal(edges,4);
 assert.ok(app.includes("fetch('./analysis_profile.json',{cache:'no-store'})"));
 assert.match(html,/id="clearLogs" disabled>端末内ログCLEAR/);
 assert.ok(app.includes("$('clearLogs').onclick=clearLogs"));
});
test('CLEAR refused during REC, stopping, or another CLEAR; cancel preserves everything',async()=>{
 for(const options of [{recording:true},{stopping:true},{approve:false},{}]){
  const h=harness(options);if(Object.keys(options).length===0)h.ctx.clearing=true;
  await h.ctx.clearLogs();assert.equal(h.ctx.events.length,1);assert.equal(h.counts().clears,0);
  assert.equal(h.counts().confirmed,options.approve===false?1:0);
 }
});
test('CLEAR waits for queued writes, clears disk/memory/list and preserves settings and seq',async()=>{
 const h=harness();const profile=h.ctx.profile,rows=h.ctx.rows,transport=h.ctx.transport;
 const done=h.ctx.clearLogs();assert.equal(h.ctx.clearing,true);assert.equal(h.counts().clears,0);
 h.release();await done;assert.equal(h.disk.length,0);assert.equal(h.ctx.events.length,0);assert.equal(h.items[0].removed,true);
 assert.equal(h.ctx.profile,profile);assert.equal(h.ctx.rows,rows);assert.equal(h.ctx.transport,transport);assert.equal(h.ctx.seq,42);
 assert.equal(h.ctx.messageText,'端末内ログを削除しました');assert.equal(h.ctx.clearing,false);
});
test('events arriving during CLEAR survive in memory, list and subsequent storage writes',async()=>{
 const h=harness();const done=h.ctx.clearLogs();const event={type:'disconnect'};h.ctx.events.push(event);
 const item={removed:false,remove(){this.removed=true;}};h.items.push(item);
 h.ctx.writes=h.ctx.writes.then(()=>h.disk.push(event));h.release();await done;await h.ctx.writes;
 assert.equal(h.ctx.events.length,1);assert.equal(h.ctx.events[0],event);assert.deepEqual(h.disk,[event]);assert.equal(item.removed,false);
});
test('failed or unavailable IndexedDB retains memory/list and leaves write queue usable',async()=>{
 for(const options of [{fail:true},{available:false}]){
  const h=harness(options);const done=h.ctx.clearLogs();h.release();await done;await h.ctx.writes;
  assert.equal(h.ctx.events.length,1);assert.equal(h.items[0].removed,false);assert.equal(h.ctx.clearing,false);assert.match(h.ctx.messageText,/削除できませんでした/);
 }
});
test('actual refresh disables CLEAR during REC/stopping/deletion and REC START during deletion',()=>{
 const code=app.slice(app.indexOf('function refresh(){'),app.indexOf('function table(){'));
 const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);};
 const ctx=vm.createContext({$,state:'',device:null,elm:'',protocol:'',recording:false,stopping:false,clearing:false,startTime:0,performance:{now:()=>0},transport:null,events:[],persistenceError:'',worker:null,desired:false,profile:{},rows:[],document:{querySelectorAll:()=>[]}});
 vm.runInContext(code,ctx);for(const flag of ['recording','stopping','clearing']){ctx[flag]=true;ctx.refresh();assert.equal($('clearLogs').disabled,true);ctx[flag]=false;}
 ctx.clearing=true;ctx.refresh();assert.equal($('start').disabled,true);ctx.clearing=false;ctx.refresh();assert.equal($('clearLogs').disabled,false);
 const start=app.slice(app.indexOf('function startRecording(){'),app.indexOf('function endRecording(){'));vm.runInContext(start,ctx);ctx.clearing=true;ctx.startRecording();assert.equal(ctx.recording,false);
});
