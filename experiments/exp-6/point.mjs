// Single-point probe: reset, grow to N MB (in <=16MB grow messages to stay under
// per-message CPU), then attempt ONE snapcheck. Reports exactly which op dies.
import WebSocket from "ws";
const BASE = process.argv[2];
const N = Number(process.argv[3]);
const MODE = process.argv[4] || "buffered";
function connect(id){const ws=new WebSocket(`${BASE}/ws?id=${encodeURIComponent(id)}`);let onMsg=null;const pending=[];let closed=null;
ws.on("message",d=>{const m=JSON.parse(d.toString());if(onMsg){const c=onMsg;onMsg=null;c(m);}else pending.push(m);});
ws.on("close",code=>{closed=`closed ${code}`;if(onMsg){const c=onMsg;onMsg=null;c({__closed:true,error:closed});}});
const ready=new Promise((res,rej)=>{ws.on("open",res);ws.on("error",rej);});
const send=o=>new Promise(res=>{if(pending.length)return res(pending.shift());if(closed)return res({__closed:true,error:closed});onMsg=res;ws.send(JSON.stringify(o));});
return{ready,send,close:()=>ws.close()};}
(async()=>{
const c=connect(`point-${N}-${Date.now()}`);await c.ready;await c.send({t:"reset"});
let done=0;const CHUNK=16;
while(done<N){const step=Math.min(CHUNK,N-done);const g=await c.send({t:"grow",mb:step});
 if(g.__closed){console.log(JSON.stringify({N,phase:"grow",died:true,atApprox:done,error:g.error}));process.exit(0);}
 if(!g.ok){console.log(JSON.stringify({N,phase:"grow",kernelFail:g.evalErr,atApprox:done}));process.exit(0);}
 done+=step;}
const s=await c.send({t:"snapcheck",mode:MODE});
if(s.__closed){console.log(JSON.stringify({N,phase:"snapcheck",mode:MODE,died:true,error:s.error}));process.exit(0);}
console.log(JSON.stringify({N,mode:MODE,snapOk:s.ok,liveLinearMB:s.liveLinearMB,serializedMB:Math.round(s.serializedBytes/1048576*100)/100,gzMB:Math.round(s.gzBytes/1048576*100)/100,peakTransientMB:s.peakTransientMB,ms:s.ms,error:s.error}));
c.close();process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
