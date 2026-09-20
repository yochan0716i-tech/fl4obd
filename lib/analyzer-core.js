import {decode2920,powers} from './did2920.js?v=20260920g';
export const VERSION='v1.1';
export const AT=new Set(['ATZ','ATE0','ATL0','ATS0','ATSP0','ATDPN']);
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const allowed=cmd=>typeof cmd==='string'&&(AT.has(cmd)||/^(01[0-9A-F]{2}|22[0-9A-F]{4})$/.test(cmd));
export function row(did,intervalMs){
 if(!/^[0-9A-F]{4}$/.test(did))throw Error('DIDは4桁の16進数');
 if(!Number.isInteger(intervalMs)||intervalMs<100||intervalMs>3600000)throw Error('周期は100〜3600000 msの整数');
 return {did,cmd:'22'+did,intervalMs,enabled:true,nextDue:0,countOk:0,countErr:0,lastResponse:null};
}
export function pidRow(pid,intervalMs){
 if(pid!=='5B')throw Error('対応する標準PIDは5Bのみです');
 const {did,...base}=row('005B',intervalMs);
 return {...base,pid,cmd:'01'+pid,status:'known_reference'};
}
export function profileRows(profile){
 if(profile.schema_version!==1||profile.safety?.read_only!==true||!Array.isArray(profile.dids))throw Error('read-only profile v1が必要です');
 const seen=new Set();
 const dids=profile.dids.map(d=>{
  const r=row(d.did,d.interval_ms);
  if(d.command!==r.cmd||seen.has(r.cmd))throw Error('command不一致またはDID重複');
  seen.add(r.cmd);return {...r,enabled:d.enabled!==false,status:d.status||'unknown_candidate'};
 });
 const pids=(profile.pids||[]).map(p=>{
  const r=pidRow(p.pid,p.interval_ms);
  if(p.command!==r.cmd||seen.has(r.cmd))throw Error('PID command不一致または重複');
  seen.add(r.cmd);return {...r,enabled:p.enabled!==false};
 });
 return [...dids,...pids];
}
export function nextDid(rows,now){return rows.filter(r=>r.enabled&&r.nextDue<=now).sort((a,b)=>a.nextDue-b.nextDue)[0]||null;}
export function reassemble(raw,cmd){
 const expected=cmd?.startsWith('22')?'62'+cmd.slice(2):cmd?.startsWith('01')?'41'+cmd.slice(2):null;
 if(!expected)return null;
 const tokens=raw.toUpperCase().trim().split(/\s+/),frames=new Map();let length=null,bad=false;
 for(let i=0;i<tokens.length;i++){
  const t=tokens[i];if(/^[0-9A-F]{3,4}$/.test(t)&&/^0:/.test(tokens[i+1]||''))length=parseInt(t,16);
  let m=/^([0-9A-F]{1,2}):([0-9A-F]+)$/.exec(t),n,h;
  if(m){n=parseInt(m[1],16);h=m[2];}
  else if((m=/^(1[0-5])([0-9A-F]{14})$/.exec(t))){n=+m[1];h=m[2];}
  else continue;
  if(h.length%2||frames.has(n))bad=true;frames.set(n,h);
 }
 if(frames.size){
  if(bad||!frames.has(0))return null;const last=Math.max(...frames.keys());let full='';
  for(let i=0;i<=last;i++){const h=frames.get(i),max=i===0?12:14;if(!h||h.length>max||(i<last&&h.length!==max))return null;full+=h;}
  if(length!==null){const extra=full.length/2-length;if(extra<0||extra>6)return null;full=full.slice(0,length*2);}
  return full.startsWith(expected)?full:null;
 }
 for(const l of raw.toUpperCase().split(/[\r\n]+/)){const h=l.replace(/\s/g,'');if(/^[0-9A-F]+$/.test(h)&&h.length%2===0&&h.startsWith(expected))return h;}
 return null;
}
export function classify(raw,cmd){
 const err=/NO DATA|STOPPED|UNABLE TO CONNECT|CAN ERROR|BUS ERROR|ERROR|\?/i.exec(raw);
 if(err)return {ok:false,error:err[0].toUpperCase()};
 if(cmd?.startsWith('AT'))return {ok:true};
 const payload=reassemble(raw,cmd);if(!payload)return {ok:false,error:'unrecognized_or_incomplete_response'};
 if(cmd==='015B'&&payload.length<6)return {ok:false,error:'incomplete_SOC_response'};
 const result={ok:true,payload};
 // Same scaling as index.html decodeService01 case 0x5B; ignore padding.
 if(cmd==='015B')result.decoded={soc:parseInt(payload.slice(4,6),16)*100/255};
 if(cmd==='222920'){const d=decode2920(payload);if(d)result.decoded={...d,...powers(d)};}
 return result;
}
export class Transport{
 constructor(write,emit,{timers=globalThis,startSeq=0}={}){Object.assign(this,{write,emit,timers,seq:startSeq,buffer:'',pending:null,retired:null,closed:false,waiters:[]});}
 context(){const p=this.pending||this.retired;return p?{seq:p.seq,cmd:p.cmd,...(p.did?{did:p.did}:{}),...(p.pid?{pid:p.pid}:{})}:{seq:null,cmd:null};}
 get busy(){return !!(this.pending||this.retired);}
 async request(cmd,timeout=3000){
  if(!allowed(cmd))throw Error('送信禁止: '+cmd);if(this.closed||this.busy)throw Error('transport not idle');
  const p={seq:++this.seq,cmd,did:cmd.startsWith('22')?cmd.slice(2):undefined,pid:cmd.startsWith('01')?cmd.slice(2):undefined};
  const response=new Promise((resolve,reject)=>Object.assign(p,{resolve,reject}));this.pending=p;
  p.timer=this.timers.setTimeout(()=>{if(this.pending!==p)return;this.pending=null;this.retired=p;
   this.emit({type:'rx',...this.context(),ok:false,error:'timeout',raw:this.buffer,partial:true});
   const e=Error('timeout: '+cmd);e.code='timeout';p.reject(e);},timeout);
  this.emit({type:'tx',...this.context()});
  try{const [,result]=await Promise.all([Promise.resolve().then(()=>this.write(cmd+'\r')),response]);return result;}
  catch(e){if(this.pending===p){this.timers.clearTimeout(p.timer);this.emit({type:'rx',...this.context(),ok:false,error:'write_error',message:e.message,raw:this.buffer});this.pending=null;this.retired=p;p.reject(e);}throw e;}
 }
 receive(text){
  if(this.closed){this.emit({type:'rx_chunk',seq:null,cmd:null,raw:text,stale:true});return;}
  this.emit({type:'rx_chunk',...this.context(),raw:text,late:!!this.retired});this.buffer+=text;
  let i;while((i=this.buffer.indexOf('>'))>=0){
   const raw=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);const p=this.pending,late=!!this.retired;
   const result={type:'rx',...this.context(),raw,...classify(raw,(p||this.retired)?.cmd),...(late?{late:true}:{}),...(!p&&!late?{unsolicited:true}:{})};this.emit(result);
   if(p){this.timers.clearTimeout(p.timer);this.pending=null;p.resolve(result);}
   else if(late){this.retired=null;this.resolveIdle();}
  }
 }
 resolveIdle(){for(const f of this.waiters.splice(0))f(!this.closed);}
 waitForIdle(ms){
  if(this.closed)return Promise.resolve(false);if(!this.busy)return Promise.resolve(true);
  return new Promise(resolve=>{const done=value=>{this.timers.clearTimeout(timer);this.waiters=this.waiters.filter(f=>f!==done);resolve(value);};const timer=this.timers.setTimeout(()=>done(false),ms);this.waiters.push(done);});
 }
 close(reason='disconnect'){
  if(this.closed)return;const ctx=this.context();this.closed=true;
  this.emit({type:'transport_closed',...ctx,reason,raw:this.buffer,partial:!!this.buffer});
  if(this.pending){const p=this.pending;this.timers.clearTimeout(p.timer);this.emit({type:'rx',...ctx,ok:false,error:reason,raw:this.buffer,partial:true});this.pending=null;p.reject(Error(reason));}
  this.buffer='';this.retired=null;this.resolveIdle();
 }
}
// index.html's verified command order and delays, with raw logging in Transport.
export async function initialize(t,{pause=sleep,active=()=>true,status=()=>{}}={}){
 const send=(cmd,ms)=>{if(!active())throw Error('cancelled');return t.request(cmd,ms);};
 await send('ATZ',2000);const z=await send('ATZ',2000);if(!z.raw.includes('ELM327'))throw Error('ELM327 identity missing');status({elm:z.raw.trim()});
 for(const [cmd,ms]of [['ATE0',300],['ATL0',300],['ATS0',300],['ATSP0',500]]){const r=await send(cmd,2000);if(!r.raw.includes('OK'))throw Error(cmd+': '+r.raw);await pause(ms);}
 for(let i=0;i<3;i++){const r=await send('011F',20000);if(r.raw.includes('411F')&&!r.raw.includes('STOPPED')){const p=await send('ATDPN',2000);status({protocol:p.raw.trim()});return;}if(i<2)await pause(1000);}
 throw Error('RUNTIME 取得失敗: 411F 応答なし');
}
