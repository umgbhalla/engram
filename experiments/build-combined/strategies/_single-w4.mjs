// Reference: PURE W4 byte-delta (no W5 rebase, no E6). One full base ever, then an
// unbounded delta chain. Lowest possible bytes-written but UNBOUNDED restore replay cost.
import { gz, gunzip } from '../../_bench/store.mjs';
const PAGE = 4096;
function enc(prev, cur){ const tp=Math.ceil(cur.length/PAGE); const d=[];
  for(let p=0;p<tp;p++){const s=p*PAGE,e=Math.min(s+PAGE,cur.length);let dy=false;
    for(let j=s;j<e;j++){const pv=prev&&j<prev.length?prev[j]:0;if(cur[j]!==pv){dy=true;break;}}
    if(!dy&&prev&&s>=prev.length)dy=true; if(dy)d.push(p);}
  const h=[]; vw(h,cur.length); vw(h,d.length); for(const p of d)vw(h,p);
  const hb=Uint8Array.from(h); const body=new Uint8Array(d.length*PAGE);
  for(let i=0;i<d.length;i++){const p=d[i],s=p*PAGE,e=Math.min(s+PAGE,cur.length);body.set(cur.subarray(s,e),i*PAGE);}
  const o=new Uint8Array(hb.length+body.length);o.set(hb,0);o.set(body,hb.length);return gz(o);}
function app(base,dg){const raw=gunzip(dg);let off=0;const r=()=>{const[v,n]=vr(raw,off);off=n;return v;};
  const cl=r(),nd=r();const pg=[];for(let i=0;i<nd;i++)pg.push(r());const bs=off;
  const out=new Uint8Array(cl);out.set(base.subarray(0,Math.min(base.length,cl)),0);
  for(let i=0;i<nd;i++){const p=pg[i],s=p*PAGE,e=Math.min(s+PAGE,cl);out.set(raw.subarray(bs+i*PAGE,bs+i*PAGE+(e-s)),s);}return out;}
function vw(a,v){v=v>>>0;while(v>=0x80){a.push((v&0x7f)|0x80);v>>>=7;}a.push(v);}
function vr(b,o){let v=0,s=0,x;do{x=b[o++];v|=(x&0x7f)<<s;s+=7;}while(x&0x80);return[v>>>0,o];}
const st=new Map();
export default { name:'single-w4',
  onCheckpoint(prev,cur,hs,store,ctx){ let s=st.get(ctx.key); let bytes=0;
    if(!s){ s={chain:[]}; st.set(ctx.key,s); const r=store.putSnapshot(`${ctx.key}/base`,cur); bytes+=r.bytes; }
    else { const blob=enc(prev||s.baseImg,cur); const k=`${ctx.key}/d.${ctx.generation}`; bytes+=store.putRaw(k,blob).bytes; s.chain.push(k); }
    s.baseImg=s.baseImg||cur;
    store.putRaw(`${ctx.key}/man`, new TextEncoder().encode(JSON.stringify({base:`${ctx.key}/base`,chain:s.chain})));
    return { stored:{man:`${ctx.key}/man`}, bytes }; },
  onRestore(stored,store){ const m=JSON.parse(new TextDecoder().decode(store.getRaw(stored.man)));
    let img=store.getSnapshot(m.base); for(const k of m.chain) img=app(img,store.getRaw(k)); return { image:img, hostState:{} }; } };
