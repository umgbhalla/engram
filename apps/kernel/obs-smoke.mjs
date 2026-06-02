import WebSocket from "ws";
const BASE = "wss://montydyn-v05.umg-bhalla88.workers.dev";
const ID = "obs-" + Date.now();
const URL = `${BASE}/ws?id=${ID}`;
function connect(){return new Promise((res,rej)=>{const ws=new WebSocket(URL);ws.once("open",()=>res(ws));ws.once("error",rej);});}
function rpc(ws,msg,t=20000){return new Promise((res,rej)=>{const to=setTimeout(()=>rej(new Error("TIMEOUT "+JSON.stringify(msg))),t);ws.once("message",d=>{clearTimeout(to);res(JSON.parse(d.toString()));});ws.send(JSON.stringify(msg));});}
let ws = await connect();
const log=(l,r)=>console.log(l, JSON.stringify(r).slice(0,180));
log("create", await rpc(ws,{t:"create",config:{clock:"seeded",rngSeed:7,tools:["echo","add"],fetch:["example.com"]}}));
log("ping", await rpc(ws,{t:"ping"}));
log("gen", await rpc(ws,{t:"gen"}));
log("eval1", await rpc(ws,{t:"eval",src:"globalThis.x=41; x+1"}));
log("eval2-log", await rpc(ws,{t:"eval",src:"console.log('hi'); ({a:1})"}));
log("error", await rpc(ws,{t:"eval",src:"throw new Error('boom')"}));
log("timeout", await rpc(ws,{t:"eval",src:"while(true){}"}));
log("fetch", await rpc(ws,{t:"eval",src:"(await host.fetch('https://example.com')).status"}));
log("fetch-blocked", await rpc(ws,{t:"eval",src:"(await host.fetch('https://evil.com')).status"}));
log("evict", await rpc(ws,{t:"evict"}));
log("cold-restore-eval", await rpc(ws,{t:"eval",src:"x"}));
log("reset", await rpc(ws,{t:"reset"}));
ws.close();
process.exit(0);
