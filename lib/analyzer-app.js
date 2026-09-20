import {VERSION,Transport,initialize,sleep,row,pidRow,profileRows,nextDid} from './analyzer-core.js';
import {selectExportEvents,toJsonl} from './analyzer-export.js';
const $=id=>document.getElementById(id);
const SVC_UUIDS=['0000fff0-0000-1000-8000-00805f9b34fb','e7810a71-73ae-499d-8c15-faa9aef0c3f2'];
let profile,rows=[],device=null,transport=null,notify=null,listener=null,desired=false,worker=null;
let ready=false,recording=false,stopping=false,inFlight=false,session=null,startTime=0,seq=0,connection=0;
let elm='',protocol='',state='未接続',wake=null,db=null,events=[],writes=Promise.resolve(),persistenceError='';
const totals=new Map();
function message(text){$('message').textContent=text;}
function emit(data){
 const event={type:data.type,ts:new Date().toISOString(),session_id:session,connection,...data};
 events.push(event);
 if(db)writes=writes.then(()=>new Promise((resolve,reject)=>{
  const tx=db.transaction('events','readwrite');tx.objectStore('events').add(event);
  tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('保存中断'));
 })).catch(e=>{persistenceError=e.message;message('端末内保存失敗。JSONLを保存してください: '+e.message);});
 if(data.type==='tx')seq=Math.max(seq,data.seq);
 if(data.type==='rx'&&(data.did||data.cmd==='015B')&&!data.late&&!data.unsolicited){
  const key=data.did||data.cmd;const r=rows.find(r=>r.cmd===data.cmd);const k=data.ok?'countOk':'countErr';
  if(r){r[k]++;r.lastResponse=event.ts;}
  if(recording||stopping){const count=totals.get(key)||{ok:0,error:0};count[data.ok?'ok':'error']++;totals.set(key,count);}
 }
 const item=document.createElement('li');
 item.textContent=event.ts.slice(11,23)+' '+data.type+' '+(data.cmd||data.label||data.reason||data.message||'')+(data.error?' / '+data.error:'');
 $('recent').prepend(item);while($('recent').children.length>60)$('recent').lastChild.remove();
 refresh();
 return event;
}
async function openJournal(){
 try{
  db=await new Promise((resolve,reject)=>{const req=indexedDB.open('fl4obd-analyzer-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('events',{autoIncrement:true});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  events=await new Promise((resolve,reject)=>{const req=db.transaction('events').objectStore('events').getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  seq=events.reduce((n,e)=>Math.max(n,Number.isInteger(e.seq)?e.seq:0),0);
  if(events.length)message('前回までの '+events.length+' イベントを復元しました。保存ボタンでまとめて取得できます。');
 }catch(e){persistenceError=e.message;message('端末内保存が使えません。このタブを閉じる前にJSONLを保存してください。');}
}
function config(){return rows.map(({did,pid,cmd,enabled,intervalMs})=>({...(did?{did}:{}),...(pid?{pid}:{}),cmd,enabled,interval_ms:intervalMs}));}
function refresh(){
 $('state').textContent=state;$('device').textContent=device?.name||'—';$('elm').textContent=elm||'—';$('protocol').textContent=protocol||'—';
 $('recState').textContent=stopping?'停止処理中':recording?'REC':'STOP';
 $('elapsed').textContent=(recording||stopping)?((performance.now()-startTime)/1000).toFixed(1)+' s':'—';
 $('command').textContent=transport?.context().cmd||'—';$('size').textContent=events.length.toLocaleString()+' events'+(persistenceError?' / メモリのみ':'');
 $('connect').disabled=!!worker||desired||!profile;$('disconnect').disabled=!desired&&!worker;
 $('start').disabled=recording||stopping||!profile;$('stop').disabled=!recording;
 for(const button of document.querySelectorAll('[data-mark]'))button.disabled=!recording;
 for(const r of rows){const tr=document.querySelector('[data-did="'+(r.did||r.cmd)+'"]');if(tr){tr.querySelector('.ok').textContent=r.countOk;tr.querySelector('.err').textContent=r.countErr;tr.querySelector('.last').textContent=r.lastResponse?.slice(11,23)||'—';}}
}
function table(){
 $('dids').replaceChildren();
 for(const r of rows){
  const key=r.did||r.cmd;const tr=document.createElement('tr');tr.dataset.did=key;
  const enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=r.enabled;enabled.setAttribute('aria-label',key+' 有効');
  enabled.onchange=()=>{r.enabled=enabled.checked;r.nextDue=performance.now();emit({type:'config',dids:config()});};
  const interval=document.createElement('input');interval.type='number';interval.min=100;interval.max=3600000;interval.step=100;interval.value=r.intervalMs;interval.setAttribute('aria-label',key+' 周期ms');
  interval.oninput=()=>{const value=Number(interval.value);if(Number.isInteger(value)&&value>=100&&value<=3600000&&value!==r.intervalMs){r.intervalMs=value;r.nextDue=performance.now();emit({type:'config',dids:config()});}};
  interval.onchange=()=>{try{const checked=r.pid?pidRow(r.pid,Number(interval.value)):row(r.did,Number(interval.value));r.intervalMs=checked.intervalMs;r.nextDue=performance.now();emit({type:'config',dids:config()});}catch(e){message(e.message);interval.value=r.intervalMs;}};
  const remove=document.createElement('button');remove.textContent='削除';remove.setAttribute('aria-label',key+' 削除');remove.onclick=()=>{rows=rows.filter(x=>x!==r);emit({type:'config',dids:config()});table();};
  for(const value of [enabled,r.pid?'SOC ('+r.cmd+')':r.did,r.cmd,interval,r.status||'unknown_candidate']){const td=document.createElement('td');if(value instanceof Node)td.append(value);else td.textContent=value;tr.append(td);}
  for(const cls of ['ok','err','last']){const td=document.createElement('td');td.className=cls;tr.append(td);}
  const td=document.createElement('td');td.append(remove);tr.append(td);$('dids').append(tr);
 }refresh();
}
async function wakeLock(){
 if(wake||document.visibilityState!=='visible'||!recording)return;
 try{const handle=await navigator.wakeLock?.request('screen');if(!handle)return;wake=handle;handle.addEventListener('release',()=>{if(wake===handle)wake=null;emit({type:'wake_lock',state:'released'});});emit({type:'wake_lock',state:'acquired'});}
 catch(e){emit({type:'wake_lock',error:e.message});}
}
function releaseWake(){const w=wake;wake=null;w?.release().catch(()=>{});}
function startRecording(){
 if(recording||stopping||!profile)return;
 session=crypto.randomUUID();startTime=performance.now();totals.clear();
 for(const r of rows){r.countOk=0;r.countErr=0;r.lastResponse=null;r.nextDue=performance.now();}
 recording=true;
 emit({type:'session_start',app:'fl4obd-analyzer',version:VERSION,device:device?.name||null,profile:profile.profile_id,profile_snapshot:profile,dids:config()});
 wakeLock();refresh();
}
function endRecording(){
 if(!stopping||inFlight)return;
 const counts=Object.fromEntries([...totals].map(([did,n])=>[did,n.ok]));
 const errors=[...totals.values()].reduce((n,c)=>n+c.error,0);
 emit({type:'session_end',duration_ms:Math.round(performance.now()-startTime),counts,errors,details:Object.fromEntries(totals)});
 stopping=false;session=null;releaseWake();refresh();
}
function stopRecording(){if(!recording)return;recording=false;stopping=true;emit({type:'rec_stop_requested'});endRecording();}
async function detach(reason){
 ready=false;
 if(transport){transport.close(reason);seq=Math.max(seq,transport.seq);}
 if(notify&&listener)notify.removeEventListener('characteristicvaluechanged',listener);
 notify=null;listener=null;
 if(device?.gatt.connected)device.gatt.disconnect();
}
// Based on index.html getBleChar: same services/property discovery and writeValue + CR.
async function attach(){
 const server=await device.gatt.connect();
 if(!desired){server.disconnect();throw Error('cancelled');}
 for(const uuid of SVC_UUIDS){
  try{
   const svc=await server.getPrimaryService(uuid),chars=await svc.getCharacteristics();
   let read=null,write=null;
   for(const c of chars){if(c.properties.notify||c.properties.indicate)read=c;if(c.properties.write||c.properties.writeWithoutResponse)write=c;}
   if(!write&&read)write=read;if(!read&&write)read=write;
   if(!read||!write)continue;
   const t=new Transport(data=>write.writeValue(new TextEncoder().encode(data)),emit,{startSeq:seq});
   transport=t;notify=read;listener=evt=>t.receive(new TextDecoder().decode(evt.target.value));
   read.addEventListener('characteristicvaluechanged',listener);
   await read.startNotifications();
   emit({type:'ble_services',service:uuid,notify:read.uuid,write:write.uuid});
   return t;
  }catch(e){
   if(notify&&listener)notify.removeEventListener('characteristicvaluechanged',listener);
   transport?.close('service_error');notify=null;listener=null;
   emit({type:'service_error',service:uuid,message:e.message});
  }
 }
 throw Error('対応サービスが見つかりません (FFF0/E781)');
}
async function delay(ms){const end=performance.now()+ms;while(desired&&performance.now()<end)await sleep(Math.min(100,end-performance.now()));}
async function run(){
 let backoff=1000;
 while(desired){
  try{
   state=connection?'再接続中':'接続中';connection++;emit({type:'connect_attempt',reconnect:connection>1,device:device.name});
   const t=await attach();state='ELM初期化';elm='';protocol='';refresh();
   await initialize(t,{active:()=>desired,status:s=>{if(s.elm)elm=s.elm;if(s.protocol)protocol=s.protocol;refresh();}});
   if(!desired)break;
   ready=true;state='接続済み';backoff=1000;emit({type:'connected',device:device.name,elm,protocol});
   while(desired&&ready&&!t.closed){
    if(!recording){endRecording();await sleep(100);continue;}
    const now=performance.now(),r=nextDid(rows,now);
    if(!r){const due=Math.min(...rows.filter(r=>r.enabled).map(r=>r.nextDue));await sleep(Math.min(100,Math.max(10,due-now)));continue;}
    r.nextDue=now+r.intervalMs;inFlight=true;
    try{await t.request(r.cmd,3000);}
    catch(e){
     if(e.code==='timeout'){
      emit({type:'recovery',reason:'timeout_wait_for_prompt',...t.context()});
      if(!await t.waitForIdle(3000))throw Error('prompt_missing_after_timeout');
      emit({type:'recovery',reason:'late_prompt_received'});
     }else throw e;
    }finally{inFlight=false;endRecording();}
   }
   if(desired)throw Error('link_lost');
  }catch(e){if(desired)emit({type:'reconnect',reason:e.message,delay_ms:backoff});}
  finally{await detach(desired?'recover':'manual_disconnect');}
  if(desired){state='再接続待機';refresh();await delay(backoff);backoff=Math.min(backoff*2,8000);}
 }
 state='未接続';ready=false;endRecording();refresh();
}
async function connect(){
 if(worker||desired)return;
 if(!navigator.bluetooth){message('Web Bluetooth対応のAndroid ChromeとHTTPS/localhostが必要です');return;}
 try{
  state='デバイス選択';$('connect').disabled=true;
  // Existing filters from index.html; exact VEEPEAK also supports devices without service advertising.
  device=await navigator.bluetooth.requestDevice({filters:[{name:'VEEPEAK'},{name:'OBDII'},{name:'ELM327'},{name:'OBD2'},...['OBD','ELM','IOS','Vlink','KONNWEI','iCar','Carista'].map(namePrefix=>({namePrefix})),...SVC_UUIDS.map(uuid=>({services:[uuid]}))],optionalServices:SVC_UUIDS});
  device.addEventListener('gattserverdisconnected',()=>{ready=false;transport?.close('disconnect');emit({type:'disconnect',manual:!desired});});
  desired=true;
  worker=run().catch(e=>{state='エラー';emit({type:'error',message:e.message});}).finally(()=>{worker=null;refresh();});
 }catch(e){state='未接続';emit({type:'connect_error',message:e.message});}
 refresh();
}
async function disconnect(){desired=false;emit({type:'disconnect_requested'});await detach('manual_disconnect');state='切断中';refresh();}
async function save(mode){
 // Select at click time so REC STOP/START while IndexedDB finishes cannot change the target session.
 const snapshot=selectExportEvents(events,{mode,sessionId:session});
 if(!snapshot.length){
  message(mode==='analysis'?'解析用に保存できるRECセッションがありません。':'保存できるイベントがありません。');
  return;
 }
 await writes;
 const blob=new Blob([toJsonl(snapshot)],{type:'application/x-ndjson;charset=utf-8'});
 const a=document.createElement('a'),url=URL.createObjectURL(blob);
 a.href=url;a.download='fl4obd_analyze_'+(mode==='analysis'?'analysis_':'full_')+new Date().toISOString().replace(/[:.]/g,'-')+'.jsonl';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
 message((mode==='analysis'?'解析用JSONL':'完全ログJSONL')+' '+snapshot.length+' イベントのダウンロードを開始しました。端末内ログは保持しています。');
}
$('connect').onclick=connect;$('disconnect').onclick=disconnect;$('start').onclick=startRecording;$('stop').onclick=stopRecording;$('save').onclick=()=>save('analysis');$('saveFull').onclick=()=>save('full');
$('add').onsubmit=e=>{e.preventDefault();try{const r=row($('did').value.trim().toUpperCase(),Number($('interval').value));if(rows.some(x=>x.did===r.did))throw Error('DIDが重複しています');rows.push(r);emit({type:'config',dids:config()});table();}catch(err){message(err.message);}};
for(const button of document.querySelectorAll('[data-mark]')){
 button.onclick=()=>{
  if(!recording)return;
  const label=button.dataset.mark;
  emit({type:'mark',label,note:label==='CUSTOM'?$('note').value:''});
  message('MARK: '+label);
 };
}
document.addEventListener('visibilitychange',()=>{emit({type:'visibility',state:document.visibilityState});if(document.visibilityState==='visible')wakeLock();});
window.addEventListener('beforeunload',e=>{if(recording||stopping){e.preventDefault();e.returnValue='';}});
window.addEventListener('pagehide',()=>emit({type:'pagehide',raw_partial:transport?.buffer||''}));
await openJournal();
try{
 const response=await fetch('./analysis_profile.json',{cache:'no-store'});if(!response.ok)throw Error('profile HTTP '+response.status);
 profile=await response.json();rows=profileRows(profile);$('profile').textContent=profile.profile_id;
 table();if($('message').textContent==='プロファイルを読み込み中…')message('準備完了。CONNECTとREC STARTで収録を開始できます。');emit({type:'app_open',app:'fl4obd-analyzer',version:VERSION,profile:profile.profile_id});
}catch(e){profile=null;message('プロファイルを読み込めません: '+e.message);}
setInterval(()=>{refresh();if(recording&&!wake)wakeLock();},1000);
refresh();
