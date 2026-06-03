// Deep-recursion wedge: does an evict+cold-reconnect recover the session?
// And compare against the JS kernel (engram-kernel) on the identical input.
import WebSocket from "ws";
const RUN = Date.now();
function connect(base,sid){return new Promise((res,rej)=>{const ws=new WebSocket(`wss://${base}/?id=${sid}`);const st={ws,alive:true,code:null};ws.on("open",()=>res(st));ws.on("error",rej);ws.on("close",c=>{st.alive=false;st.code=c});});}
function rpc(st,msg,to=45000){return new Promise(resolve=>{let done=false;const t=setTimeout(()=>{if(!done){done=true;resolve({__timeout:true})}},to);const on=d=>{if(done)return;done=true;clearTimeout(t);st.ws.off("message",on);try{resolve(JSON.parse(d.toString()))}catch{resolve({__parsefail:String(d)})}};st.ws.on("message",on);try{st.ws.send(typeof msg==="string"?msg:JSON.stringify(msg))}catch(e){if(!done){done=true;clearTimeout(t);resolve({__sendfail:String(e)})}}});}
const ev=(st,src,to=45000)=>rpc(st,{t:"eval",src},to);
const SRC = "function f(n){return f(n+1)} f(0)";

async function test(base, label){
  console.log(`\n##### ${label} (${base}) #####`);
  const sid = `deeprec-${label}-${RUN}`;
  let st = await connect(base, sid);
  let r = await rpc(st,{t:"create",config:{rngSeed:1}});
  console.log(`create ok=${r.ok}`);
  r = await ev(st, SRC, 60000);
  console.log(`bomb -> ok=${r.ok} err=${r.error?.name} aliveAfterBomb=${st.alive} code=${st.code}`);
  console.log(`bomb detail: ${JSON.stringify(r).slice(0,160)}`);
  // try in-place recover
  r = await ev(st, "1+1");
  console.log(`in-place recover -> val=${JSON.stringify(r.value)} ok=${r.ok} err=${r.error?.name} detail=${JSON.stringify(r).slice(0,120)}`);
  const inPlaceRecovered = r.value === 2;
  // try reset
  r = await rpc(st, {t:"reset"});
  console.log(`reset -> ${JSON.stringify(r).slice(0,120)}`);
  r = await ev(st, "2+2");
  console.log(`after reset -> val=${JSON.stringify(r.value)}`);
  const resetRecovered = r.value === 4;
  // evict + cold reconnect
  await rpc(st,{t:"evict"});
  st.ws.close();
  await new Promise(s=>setTimeout(s,2500));
  st = await connect(base, sid);
  r = await rpc(st,{t:"ping"});
  console.log(`cold ping -> ${JSON.stringify(r).slice(0,140)}`);
  r = await ev(st, "5+5");
  console.log(`cold eval -> val=${JSON.stringify(r.value)} detail=${JSON.stringify(r).slice(0,140)}`);
  const coldRecovered = r.value === 10;
  st.ws.close();
  console.log(`RESULT ${label}: inPlace=${inPlaceRecovered} reset=${resetRecovered} cold=${coldRecovered} socketKilled=${!st.alive&&st.code===1006}`);
  return { label, inPlaceRecovered, resetRecovered, coldRecovered };
}

(async()=>{
  const rustf = await test("engram-rustf.umg-bhalla88.workers.dev","RUST");
  let js=null;
  try { js = await test("engram-kernel.umg-bhalla88.workers.dev","JS"); }
  catch(e){ console.log("JS kernel test skipped/err:", e.message); }
  console.log("\n===== DEEPREC COMPARATIVE =====");
  console.log("RUST:", JSON.stringify(rustf));
  if(js) console.log("JS  :", JSON.stringify(js));
  process.exit(0);
})();
