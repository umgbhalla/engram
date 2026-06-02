// Force a chain-LENGTH rebase (>64 deltas, no spike) with multi-evict, prove chain resets.
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { DOStore } from '../_bench/store.mjs';
import { Session } from '../_bench/session.mjs';
import combined from '../build-combined/strategies/combined.mjs';
import { createHash } from 'node:crypto';
const sha = b => createHash('sha256').update(Buffer.from(b)).digest('hex');

const key='combined/r4-chainlen';
const store=new DOStore({r2Dir:join(tmpdir(),`r4-chainlen-${Date.now()}`)});
combined._st.delete(key);
const sess=new Session(); await sess.create();
sess.eval(`globalThis.acc=[]; var r; globalThis.p=new Promise(x=>{r=x}); globalThis.go=()=>r(9);`);
const ctx={key,generation:0};
let prevImage=null, last=null, maxChain=0, rebases=0, lastBase=combined._state(key).baseGen;
const evicts=new Set([30,80,140]); let coh=[];
for(let i=1;i<=150;i++){
  sess.eval(`acc.push(${i})`);
  const img=sess.dump(); ctx.generation++;
  const {stored}=combined.onCheckpoint(prevImage,img,{__src:`acc.push(${i})`,__rng:i,__usedHeap:sess.usedHeap()},store,ctx);
  last=stored; prevImage=img;
  const st=combined._state(key);
  if(st.chain.length>maxChain)maxChain=st.chain.length;
  if(st.baseGen!==lastBase){rebases++;lastBase=st.baseGen;}
  if(evicts.has(i)){
    const pre=sha(prevImage);
    sess.dispose(); prevImage=null; combined._st.delete(key);
    // rehydrate minimally: re-read manifest -> restore is store-only
    const {image}=combined.onRestore(last,store,ctx);
    // rebuild bookkeeping from manifest so chain continues durably
    const m=JSON.parse(new TextDecoder().decode(store.getRaw(`${key}/manifest`)));
    const s2=combined._state(key);
    const {gzipSync}=await import('node:zlib');
    s2.baseGen=Number(m.baseKey.split('.').pop());
    s2.baseImage=store.getSnapshot(m.baseKey);
    s2.baseGzBytes=gzipSync(Buffer.from(s2.baseImage),{level:6}).byteLength;
    s2.chain=m.chain.map(dk=>({gen:Number(dk.split('.').pop()),key:dk}));
    s2.chainGzBytes=m.chain.reduce((a,dk)=>a+(store.getRaw(dk)?.byteLength||0),0);
    s2.oplogKeys=m.oplogKeys.slice(); s2.seq=m.oplogKeys.reduce((x,o)=>Math.max(x,Number(o.split('.').pop())),0);
    await sess.restore(image); prevImage=image;
    coh.push({evictAt:i, byteIdentical:sha(image)===pre, accLen:sess.eval(`acc.length`), gen:sess.generation, chainAfter:s2.chain.length});
  }
}
console.log(JSON.stringify({maxChain,rebases,coherence:coh,allByteId:coh.every(c=>c.byteIdentical),accOk:coh.every(c=>c.accLen===c.evictAt)},null,2));
sess.dispose();
