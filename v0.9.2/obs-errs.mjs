import WebSocket from "ws";
const BASE="wss://montydyn-v05.umg-bhalla88.workers.dev";
const ID="obserr-"+Date.now();
function connect(){return new Promise((res,rej)=>{const ws=new WebSocket(`${BASE}/ws?id=${ID}`);ws.once("open",()=>res(ws));ws.once("error",rej);});}
function rpc(ws,m,t=20000){return new Promise((res,rej)=>{const to=setTimeout(()=>rej(new Error("TO")),t);ws.once("message",d=>{clearTimeout(to);res(JSON.parse(d.toString()));});ws.send(JSON.stringify(m));});}
let ws=await connect();
await rpc(ws,{t:"create",config:{cellBudgetTicks:1200}});
await rpc(ws,{t:"ping"});
const e=await rpc(ws,{t:"eval",src:"throw new TypeError('x')"});
console.log("error ok=",e.ok,"name=",e.error&&e.error.name);
const tm=await rpc(ws,{t:"eval",src:"while(true){}"});
console.log("timeout ok=",tm.ok,"name=",tm.error&&tm.error.name);
ws.close();process.exit(0);
