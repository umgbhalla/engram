// Cost of the SCAN that page/byte-delta requires (no native dirty-bit in workerd).
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
for(const MB of [1.75, 10, 20]){
  const n=Math.floor(MB*1024*1024);const a=new Uint8Array(n);const b=new Uint8Array(n);
  for(let i=0;i<n;i+=997)b[i]=1; // sparse change
  // 4KB chunk diff via byte-compare
  let t0=performance.now();const CH=4096;let dirty=0;
  for(let c=0;c<n;c+=CH){let d=false;const e=Math.min(c+CH,n);for(let j=c;j<e;j++)if(a[j]!==b[j]){d=true;break}if(d)dirty++}
  let t1=performance.now();
  // crc-style hash per 4KB
  let t2=performance.now();for(let c=0;c<n;c+=CH){let h=2166136261;const e=Math.min(c+CH,n);for(let j=c;j<e;j++){h^=b[j];h=Math.imul(h,16777619)}}
  let t3=performance.now();
  console.log(`${MB}MB: bytecmp-diff ${(t1-t0).toFixed(1)}ms (${dirty} dirty 4KB chunks), FNV-hash-all ${(t3-t2).toFixed(1)}ms`);
}
