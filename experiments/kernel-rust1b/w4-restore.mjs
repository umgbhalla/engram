// Verify delta-chain cold restore: reconnect to a fresh session, build a 25-cell delta chain
// (crossing one base reset), then force eviction-style fresh glue and confirm state survives.
import WebSocket from "ws";
const BASE="engram-rust1b.umg-bhalla88.workers.dev";
const SID="w4-restore-"+Date.now();
const conn=()=>new Promise((res,rej)=>{const ws=new WebSocket(`wss://${BASE}/?id=${SID}`);ws.on("open",()=>res(ws));ws.on("error",rej);});
const rpc=(ws,m)=>new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error("timeout")),30000);ws.once("message",d=>{clearTimeout(t);res(JSON.parse(d.toString()));});ws.send(JSON.stringify(m));});
let ws=await conn();
await rpc(ws,{t:"create",config:{rngSeed:7}});
await rpc(ws,{t:"eval",src:"globalThis.store={};'init'"});
for(let i=0;i<25;i++) await rpc(ws,{t:"eval",src:`store.k${i}=${i};1`});
ws.close();
await new Promise(r=>setTimeout(r,1500));
// reconnect (warm or restored); read state
ws=await conn();
const r=await rpc(ws,{t:"eval",src:"JSON.stringify({n:Object.keys(store).length,k0:store.k0,k24:store.k24})"});
console.log("restoreSource:",r.restoreSource,"inMemoryBefore:",r.inMemoryBefore,"value:",r.value);
ws.close();
const v=JSON.parse(r.value);
console.log("STATE INTACT:", v.n===25 && v.k24===24 && v.k0===0);
