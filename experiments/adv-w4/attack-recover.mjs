import WebSocket from "ws";
const BASE = process.argv[2];
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const log=(...a)=>console.log(...a);
function connect(id){const ws=new WebSocket(`${BASE}/ws?id=${encodeURIComponent(id)}`);const pending=[];let onMsg=null;let closed=null;
 ws.on("message",d=>{const m=JSON.parse(d.toString());if(onMsg){const cb=onMsg;onMsg=null;cb(m);}else pending.push(m);});
 ws.on("close",(c,r)=>{closed={code:c,reason:r?.toString()};if(onMsg){const cb=onMsg;onMsg=null;cb({__closed:closed});}});
 ws.on("error",()=>{});
 const ready=new Promise((res,rej)=>{ws.on("open",res);ws.on("error",rej);});
 const send=(o,to=20000)=>new Promise(res=>{if(closed)return res({__closed:closed});if(pending.length)return res(pending.shift());onMsg=res;ws.send(JSON.stringify(o));setTimeout(()=>{if(onMsg){onMsg=null;res({__timeout:true});}},to);});
 return {ws,ready,send,get closed(){return closed;},close:()=>ws.close()};}

// After a corrupt-snapshot rejection, can the session recover via (a) retry, (b) reset, (c) reconnect?
async function probe(mode, cells){
  const id=`adv-rec-${mode}-${Date.now()}`;
  let c=connect(id); await c.ready;
  for(let i=0;i<cells;i++){const r=await c.send({t:"eval",src:"globalThis.v=(globalThis.v||0)+1; v"}); if(r.__closed){log(`${mode}: killed building`);return;}}
  await c.send({t:"tamper",mode});
  await c.send({t:"evict"});
  const e1=await c.send({t:"eval",src:"globalThis.v"});
  log(`${mode}: 1st eval after tamper ok=${e1.ok} err=${(e1.error?.name)||String(e1.error).slice(0,40)} closed=${!!e1.__closed}`);
  // (a) retry same eval (kernel still null? does it re-attempt restore each time?)
  const e2=await c.send({t:"eval",src:"40+2"});
  log(`  retry eval: ok=${e2.ok} value=${e2.value} closed=${!!e2.__closed} timeout=${!!e2.__timeout}`);
  // (b) reset
  const rs=await c.send({t:"reset"});
  log(`  reset: ok=${rs.ok} closed=${!!rs.__closed}`);
  const e3=await c.send({t:"eval",src:"globalThis.fresh=1; 7*6"});
  log(`  post-reset eval: ok=${e3.ok} value=${e3.value} closed=${!!e3.__closed}`);
  const recovered = e3.ok!==false && e3.value===42;
  log(`  ==> ${mode} RECOVERABLE via reset: ${recovered}`);
  c.close();
  // (c) reconnect a fresh socket -> does cold restore still hit the (still-corrupt) snapshot or is it healed?
  await sleep(500);
  let c2=connect(id); await c2.ready;
  const e4=await c2.send({t:"eval",src:"40+2"},20000);
  log(`  reconnect eval: ok=${e4.ok} value=${e4.value} closed=${!!e4.__closed} err=${(e4.error?.name)||""}`);
  c2.close();
}
(async()=>{
  for (const [m,n] of [["flipChunk",1],["flipDelta",4],["truncDelta",4],["dropBase",1]]){ await probe(m,n); await sleep(600); }
  process.exit(0);
})();
