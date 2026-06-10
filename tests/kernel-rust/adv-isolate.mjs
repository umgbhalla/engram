// Isolate each resource bomb on its OWN fresh session to get a clean per-bomb verdict.
import WebSocket from "ws";
const BASE = "engram-rustf.umg-bhalla88.workers.dev";
const RUN = Date.now();
function connect(sid){return new Promise((res,rej)=>{const ws=new WebSocket(`wss://${BASE}/?id=${sid}&apiKey=${process.env.ENGRAM_KERNEL_KEY||""}`);const st={ws,alive:true,code:null};ws.on("open",()=>res(st));ws.on("error",rej);ws.on("close",c=>{st.alive=false;st.code=c});});}
function rpc(st,msg,to=45000){return new Promise(resolve=>{let done=false;const t=setTimeout(()=>{if(!done){done=true;resolve({__timeout:true})}},to);const on=d=>{if(done)return;done=true;clearTimeout(t);st.ws.off("message",on);try{resolve(JSON.parse(d.toString()))}catch{resolve({__parsefail:String(d)})}};st.ws.on("message",on);try{st.ws.send(typeof msg==="string"?msg:JSON.stringify(msg))}catch(e){if(!done){done=true;clearTimeout(t);resolve({__sendfail:String(e)})}}});}
const ev=(st,src,to=45000)=>rpc(st,{t:"eval",src},to);

async function trial(name, src, recoverExpect){
  const st = await connect(`iso-${name}-${RUN}`);
  let r = await rpc(st,{t:"create",config:{rngSeed:1}});
  const created = r.ok;
  const bomb = await ev(st, src, 60000);
  const aliveAfterBomb = st.alive;
  const errName = bomb.error?.name || (bomb.__timeout?"<timeout>":JSON.stringify(bomb).slice(0,80));
  const rec = await ev(st, "globalThis.__rv = " + recoverExpect + "; __rv");
  const recovered = rec.value === recoverExpect;
  console.log(`\n[${name}] created=${created} bombErr=${errName} aliveAfterBomb=${aliveAfterBomb} recovered=${recovered} (val=${JSON.stringify(rec.value)})`);
  if (!recovered) console.log(`   recover-detail: ${JSON.stringify(rec).slice(0,300)}`);
  st.ws.close();
  return { name, created, errName, aliveAfterBomb, recovered, recDetail: rec };
}

(async()=>{
  const out=[];
  out.push(await trial("deeprec", "function f(n){return f(n+1)} f(0)", 9));
  out.push(await trial("alloc60", "new Uint8Array(60*1024*1024)", 101));
  out.push(await trial("growbomb", "let a=[]; for(;;){ a.push(new Array(200000).fill(7)); }", 25));
  out.push(await trial("growf64", "let b=[]; for(;;){ b.push(new Float64Array(100000)); }", 81));
  out.push(await trial("strbomb", "let s=''; for(;;){ s += 'x'.repeat(100000); }", 4));
  out.push(await trial("infloop", "let s=0; while(true){s++;} s", 42));
  console.log("\n===== ISOLATED VERDICT =====");
  for(const o of out) console.log(`${o.recovered?"OK    ":"WEDGED"} ${o.name.padEnd(10)} err=${o.errName} alive=${o.aliveAfterBomb} recovered=${o.recovered}`);
  process.exit(0);
})();
