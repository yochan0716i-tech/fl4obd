import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {selectExportEvents,toJsonl} from '../lib/analyzer-export.js';
const start=id=>({type:'session_start',session_id:id,ts:'2026-09-20T01:00:00Z'});
const end=id=>({type:'session_end',session_id:id,counts:{2920:1},errors:0});
const rx={type:'rx',session_id:'B',seq:9,cmd:'222920',did:'2920',ok:true,raw:'06F\r0:622920...\rA:00\r>',payload:'6229200001',decoded:{rpm:1234,pbat:-4.5,mode:40}};
const journal=[
 {type:'app_open',session_id:null},start('A'),{type:'rx_chunk',session_id:'A',raw:'old>'},end('A'),
 {type:'connect_attempt',session_id:null},start('B'),{type:'config',session_id:'B',dids:[{did:'2920',interval_ms:200}]},
 {type:'tx',session_id:'B',seq:9,cmd:'222920'}, {type:'rx_chunk',session_id:'B',seq:9,raw:rx.raw},rx,
 {type:'rx',session_id:'B',raw:'SEARCHING...',ok:false,error:'timeout',partial:true},
 {type:'rx',session_id:'B',raw:'NO DATA',ok:false,error:'NO DATA',late:true},
 {type:'mark',session_id:'B',label:'REGEN',note:'日本語\nメモ'},
 {type:'reconnect',session_id:'B'}, {type:'disconnect',session_id:'B'},
 {type:'transport_closed',session_id:'B',raw:'partial',partial:true},
 {type:'future_event_type',session_id:'B',details:{preserve:true}},end('B'),
 {type:'disconnect',session_id:null}
];
test('analysis uses active REC even if another start exists later',()=>{
 const selected=selectExportEvents(journal,{sessionId:'A'});
 assert.deepEqual(selected,[journal[1],journal[3]]);
});
test('idle / reloaded journal chooses latest session and preserves every type except rx_chunk',()=>{
 const selected=selectExportEvents(journal);
 assert.deepEqual(selected,journal.filter(e=>e.session_id==='B'&&e.type!=='rx_chunk'));
 for(const type of ['session_start','config','tx','rx','mark','reconnect','disconnect','transport_closed','future_event_type','session_end'])
  assert(selected.some(e=>e.type===type),type);
 assert(selected.includes(rx));assert.deepEqual(selected.find(e=>e.seq===9&&e.type==='rx'),rx);
});
test('active session need not have session_end; timeout and partial records are retained',()=>{
 const selected=selectExportEvents(journal.slice(0,-2),{sessionId:'B'});
 assert(selected.some(e=>e.error==='timeout'));assert(selected.some(e=>e.late));assert(!selected.some(e=>e.type==='session_end'));
});
test('latest means append order, not timestamps; no REC never leaks diagnostics',()=>{
 assert.deepEqual(selectExportEvents([start('old'),{...start('new'),ts:'1990-01-01T00:00:00Z'}]),[{...start('new'),ts:'1990-01-01T00:00:00Z'}]);
 for(const events of [[],[{type:'rx_chunk',session_id:null,raw:'orphan'}],[{type:'rx',session_id:'orphan',raw:'orphan'}]])
  assert.deepEqual(selectExportEvents(events),[]);
 assert.deepEqual(selectExportEvents(journal,{sessionId:'missing'}),[]);
});
test('full export retains all sessions, diagnostics and chunks without changing order',()=>{
 const selected=selectExportEvents(journal,{mode:'full',sessionId:'B'});
 assert.deepEqual(selected,journal);assert.notEqual(selected,journal);
});
test('JSONL roundtrip preserves complete response, Unicode, CR/LF and nested decoded fields',()=>{
 const before=structuredClone(journal);
 for(const mode of ['analysis','full']){
  const selected=selectExportEvents(journal,{mode}),text=toJsonl(selected);
  assert(text.endsWith('\n'));assert.deepEqual(text.trimEnd().split('\n').map(JSON.parse),selected);
  assert.deepEqual(selected.find(e=>e===rx),rx);
 }
 assert.deepEqual(journal,before);assert.equal(toJsonl([]),'');
 assert.throws(()=>selectExportEvents(journal,{mode:'bad'}));
});
const app=await readFile(new URL('../lib/analyzer-app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../analyze.html',import.meta.url),'utf8');
function harness(events,session,writes=Promise.resolve()){
 const downloads=[],blobs=[],messages=[],buttons={save:{},saveFull:{}};
 const save=app.match(/async function save\(mode\)\{[\s\S]*?\r?\n\}/)?.[0];assert(save);
 const wiring=app.match(/\$\('save'\)\.onclick=.*?\$\('saveFull'\)\.onclick=.*?;/)?.[0];assert(wiring);
 const env={selectExportEvents,toJsonl,events,session,writes,Blob,
  message:m=>messages.push(m),$:id=>buttons[id],
  document:{createElement(){const a={click(){downloads.push({name:a.download,url:a.href});}};return a;}},
  URL:{createObjectURL(blob){blobs.push(blob);return 'blob:test';},revokeObjectURL(){}},setTimeout(){}};
 vm.runInNewContext(save+'\n'+wiring,env);
 return {buttons,downloads,blobs,messages,env};
}
test('real UI save handlers create distinct filenames and correct JSONL blobs',async()=>{
 assert(html.includes('id="save">解析用JSONL'));assert(html.includes('id="saveFull">完全ログJSONL'));
 const h=harness(journal,null);
 await h.buttons.save.onclick();await h.buttons.saveFull.onclick();
 assert.match(h.downloads[0].name,/^fl4obd_analyze_analysis_.*\.jsonl$/);
 assert.match(h.downloads[1].name,/^fl4obd_analyze_full_.*\.jsonl$/);
 const parse=async blob=>(await blob.text()).trimEnd().split('\n').map(JSON.parse);
 assert.deepEqual(await parse(h.blobs[0]),selectExportEvents(journal));
 assert.deepEqual(await parse(h.blobs[1]),journal);
});
test('no REC produces guidance instead of an empty analysis download; full remains usable',async()=>{
 const h=harness([{type:'connect_attempt',session_id:null}],null);
 await h.buttons.save.onclick();assert.equal(h.downloads.length,0);assert.match(h.messages[0],/RECセッション/);
 await h.buttons.saveFull.onclick();assert.equal(h.downloads.length,1);
});
test('save snapshot stays on clicked session if STOP/START happens while storage completes',async()=>{
 let release;const writes=new Promise(r=>release=r),events=[start('A'),{type:'rx',session_id:'A',raw:'OK'}];
 const h=harness(events,'A',writes);const pending=h.buttons.save.onclick();
 events.push(end('A'),start('B'),{type:'rx',session_id:'B',raw:'new'});h.env.session='B';release();await pending;
 assert.deepEqual((await h.blobs[0].text()).trim().split('\n').map(JSON.parse),events.slice(0,2));
});
