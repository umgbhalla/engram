//! engram Rust kernel ENGINE (rquickjs on wasm32-wasip1).
//!
//! ALL kernel logic lives here in Rust — eval, value-preview, guards, determinism,
//! host-boundary. The host (a thin JS WASI shim) only provides: WASI imports, the
//! literal `memory.buffer` blit (snapshot substrate), and the implementation of the
//! one host effect (fetch) that the engine cannot do from inside wasip1.
//!
//! ABI (C exports the shim calls):
//!   scratch_ptr() / result_ptr() / result_len()    — IO buffers (no host marshalling)
//!   create(clock_seed, rng_seed)                    — seed + build runtime
//!   reattach()                                      — re-validate blitted runtime
//!   eval_begin(src_ptr, src_len, budget, grow_cap)  — start eval; returns status (see below)
//!   eval_resume(...)                                — feed a host-effect result, continue
//!   pending_host_call_ptr()/len()                   — read the host-call request JSON
//!   used_heap() / buffer_bytes()                    — size-admission introspection
//!   clock_calls() / rng_calls()                     — entropy counters (persist in manifest)
//!   set_counters(clock, rng)                        — restore entropy counters
//!   kv_export_ptr()/len() / kv_import(ptr,len)      — inert stubs (host.kv removed)
//!
//! eval_begin / eval_resume return an i32 status:
//!   0 = DONE  (result JSON is in RESULT)
//!   1 = HOST_CALL pending (request JSON in HOSTCALL; shim must call eval_resume)

use rquickjs::{Context, Ctx, Function, Runtime, Value};
use std::cell::{Cell, RefCell};

thread_local! {
    static CTX: RefCell<Option<(Runtime, Context)>> = RefCell::new(None);
    static CLOCK: Cell<u64> = Cell::new(0);
    static RNG: Cell<u64> = Cell::new(0);
    static CLOCK_CALLS: Cell<u64> = Cell::new(0);
    static RNG_CALLS: Cell<u64> = Cell::new(0);
    // interrupt-budget guard
    static BUDGET: Cell<i64> = Cell::new(0);
    static TRIPPED: Cell<bool> = Cell::new(false);
    static WIRED: Cell<bool> = Cell::new(false);
    // BUFFER-GROWTH TRIPWIRE: pages at eval-begin + per-cell grow cap (in pages).
    static START_PAGES: Cell<u32> = Cell::new(0);
    static GROW_CAP_PAGES: Cell<u32> = Cell::new(0);
    static GROW_TRIPPED: Cell<bool> = Cell::new(false);
    // host-call rendezvous: when a host effect (fetch) is invoked from JS, the
    // request is parked here and control returns to the shim; the resolved value is
    // injected on resume.
    static HOSTCALL_REQ: RefCell<Option<String>> = RefCell::new(None);
    static HOSTCALL_RES: RefCell<Option<String>> = RefCell::new(None);
}

// ---- IO buffers -----------------------------------------------------------
static mut RESULT: [u8; 1 << 20] = [0; 1 << 20]; // 1MB result (value previews + logs)
static mut RESULT_LEN: usize = 0;
static mut HOSTCALL: [u8; 1 << 16] = [0; 1 << 16];
static mut HOSTCALL_LEN: usize = 0;
static mut SCRATCH: [u8; 1 << 20] = [0; 1 << 20]; // 1MB cell source / resume payload
static mut KV_OUT: [u8; 1 << 18] = [0; 1 << 18];
static mut KV_OUT_LEN: usize = 0;
static mut BOOT_ERR: [u8; 4096] = [0; 4096];
static mut BOOT_ERR_LEN: usize = 0;

#[no_mangle]
pub extern "C" fn boot_err_ptr() -> *const u8 {
    core::ptr::addr_of!(BOOT_ERR) as *const u8
}
#[no_mangle]
pub extern "C" fn boot_err_len() -> usize {
    unsafe { BOOT_ERR_LEN }
}

fn set_result(s: &str) {
    let b = s.as_bytes();
    let n = b.len().min(1 << 20);
    unsafe {
        let p = core::ptr::addr_of_mut!(RESULT) as *mut u8;
        core::ptr::copy_nonoverlapping(b.as_ptr(), p, n);
        RESULT_LEN = n;
    }
}
fn set_hostcall(s: &str) {
    let b = s.as_bytes();
    let n = b.len().min(1 << 16);
    unsafe {
        let p = core::ptr::addr_of_mut!(HOSTCALL) as *mut u8;
        core::ptr::copy_nonoverlapping(b.as_ptr(), p, n);
        HOSTCALL_LEN = n;
    }
}

#[no_mangle]
pub extern "C" fn scratch_ptr() -> *const u8 {
    core::ptr::addr_of!(SCRATCH) as *const u8
}
#[no_mangle]
pub extern "C" fn scratch_cap() -> usize {
    1 << 20
}
#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    core::ptr::addr_of!(RESULT) as *const u8
}
#[no_mangle]
pub extern "C" fn result_len() -> usize {
    unsafe { RESULT_LEN }
}
#[no_mangle]
pub extern "C" fn pending_host_call_ptr() -> *const u8 {
    core::ptr::addr_of!(HOSTCALL) as *const u8
}
#[no_mangle]
pub extern "C" fn pending_host_call_len() -> usize {
    unsafe { HOSTCALL_LEN }
}

// ---- determinism ----------------------------------------------------------
fn lcg(state: u64) -> u64 {
    state
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407)
}

fn cur_pages() -> u32 {
    core::arch::wasm32::memory_size(0) as u32
}

// In-VM JS bootstrap (the irreducible floor): seeded Date/Math traps + the
// util.inspect-style preview formatter + the `host` Proxy that marshals host
// effects out to Rust via __hostCall.
const BOOTSTRAP: &str = r#"
try { Object.defineProperty(Date, 'now', { value: globalThis.__now, writable: true, configurable: true }); } catch(e){ try { Date.now = globalThis.__now; } catch(e2){} }
try { Object.defineProperty(Math, 'random', { value: globalThis.__rand, writable: true, configurable: true }); } catch(e){ try { Math.random = globalThis.__rand; } catch(e2){} }
// seeded performance.now (monotone, ms) reuses the clock tick
try { if (typeof performance === 'undefined') { globalThis.performance = {}; } performance.now = function(){ return globalThis.__now(); }; } catch(e){}

// seeded crypto shim: nanoid/uuid call crypto.getRandomValues. Route through the seeded
// __rand so seeded sessions stay byte-reproducible across restore. randomUUID is v4-shaped.
try {
  if (typeof globalThis.crypto === 'undefined') { globalThis.crypto = {}; }
  globalThis.crypto.getRandomValues = function(arr){
    for (var i=0;i<arr.length;i++){ arr[i] = (globalThis.__rand()*256) & 0xff; }
    return arr;
  };
  globalThis.crypto.randomUUID = function(){
    var b = new Uint8Array(16); globalThis.crypto.getRandomValues(b);
    b[6]=(b[6]&0x0f)|0x40; b[8]=(b[8]&0x3f)|0x80;
    var h=[]; for(var i=0;i<16;i++){ h.push((b[i]+0x100).toString(16).slice(1)); }
    return h[0]+h[1]+h[2]+h[3]+'-'+h[4]+h[5]+'-'+h[6]+h[7]+'-'+h[8]+h[9]+'-'+h[10]+h[11]+h[12]+h[13]+h[14]+h[15];
  };
} catch(e){}

// ===== TIER-0 WEB EXTENSIONS (pure-JS bootstrap polyfills; snapshot-persisted) =====
// rquickjs ships no TextEncoder/Decoder/URL/structuredClone/Headers/crypto.subtle. The JS
// kernel static-links 5 quickjs-wasi C .so for these; static-link into rquickjs is non-trivial,
// so we install pure-JS polyfills evaled here at create. They live in the heap and survive
// hibernation/restore (no re-inject). UTF-8 codecs are spec-correct; subtle.digest is SHA-256.
try {
// ---- TextEncoder / TextDecoder (UTF-8) ----
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = function TextEncoder(){ this.encoding='utf-8'; };
  globalThis.TextEncoder.prototype.encode = function(str){
    str = str === undefined ? '' : String(str);
    var out = [];
    for (var i=0;i<str.length;i++){
      var c = str.charCodeAt(i);
      if (c < 0x80){ out.push(c); }
      else if (c < 0x800){ out.push(0xc0|(c>>6), 0x80|(c&0x3f)); }
      else if (c >= 0xd800 && c <= 0xdbff){
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c&0x3ff)<<10) + (c2&0x3ff);
        out.push(0xf0|(cp>>18), 0x80|((cp>>12)&0x3f), 0x80|((cp>>6)&0x3f), 0x80|(cp&0x3f));
      } else { out.push(0xe0|(c>>12), 0x80|((c>>6)&0x3f), 0x80|(c&0x3f)); }
    }
    return new Uint8Array(out);
  };
  globalThis.TextEncoder.prototype.encodeInto = function(str, u8){
    var enc = this.encode(str); var n = Math.min(enc.length, u8.length);
    for (var i=0;i<n;i++) u8[i]=enc[i];
    return { read: str.length, written: n };
  };
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = function TextDecoder(label){ this.encoding=(label||'utf-8'); };
  globalThis.TextDecoder.prototype.decode = function(buf){
    if (buf === undefined) return '';
    var b = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf.buffer || buf);
    var out=''; var i=0;
    while (i<b.length){
      var c=b[i++];
      if (c<0x80){ out+=String.fromCharCode(c); }
      else if (c<0xe0){ out+=String.fromCharCode(((c&0x1f)<<6)|(b[i++]&0x3f)); }
      else if (c<0xf0){ out+=String.fromCharCode(((c&0x0f)<<12)|((b[i++]&0x3f)<<6)|(b[i++]&0x3f)); }
      else { var cp=((c&0x07)<<18)|((b[i++]&0x3f)<<12)|((b[i++]&0x3f)<<6)|(b[i++]&0x3f); cp-=0x10000;
             out+=String.fromCharCode(0xd800+(cp>>10), 0xdc00+(cp&0x3ff)); }
    }
    return out;
  };
}

// ---- URLSearchParams + URL ----
if (typeof globalThis.URLSearchParams === 'undefined') {
  var __enc=function(s){ return encodeURIComponent(String(s)).replace(/%20/g,'+'); };
  var __dec=function(s){ return decodeURIComponent(String(s).replace(/\+/g,' ')); };
  globalThis.URLSearchParams = function URLSearchParams(init){
    this._l = [];
    if (init && typeof init === 'string'){
      var q = init[0]==='?' ? init.slice(1) : init;
      if (q) q.split('&').forEach(function(p){ var i=p.indexOf('='); var k=i<0?p:p.slice(0,i); var v=i<0?'':p.slice(i+1); this._l.push([__dec(k),__dec(v)]); }, this);
    } else if (init && typeof init === 'object'){
      if (typeof init.forEach==='function' && !Array.isArray(init)){ /* another USP */ var self=this; if (init._l){ init._l.forEach(function(p){ self._l.push([p[0],p[1]]); }); } }
      else if (Array.isArray(init)){ init.forEach(function(p){ this._l.push([String(p[0]),String(p[1])]); }, this); }
      else { Object.keys(init).forEach(function(k){ this._l.push([k,String(init[k])]); }, this); }
    }
  };
  var USP = globalThis.URLSearchParams.prototype;
  USP.append=function(k,v){ this._l.push([String(k),String(v)]); };
  USP.set=function(k,v){ k=String(k); var done=false; this._l=this._l.filter(function(p){ if(p[0]===k){ if(!done){p[1]=String(v);done=true;return true;} return false;} return true; }); if(!done) this._l.push([k,String(v)]); };
  USP.get=function(k){ k=String(k); for(var i=0;i<this._l.length;i++) if(this._l[i][0]===k) return this._l[i][1]; return null; };
  USP.getAll=function(k){ k=String(k); return this._l.filter(function(p){return p[0]===k;}).map(function(p){return p[1];}); };
  USP.has=function(k){ return this.get(String(k))!==null; };
  USP.delete=function(k){ k=String(k); this._l=this._l.filter(function(p){return p[0]!==k;}); };
  USP.forEach=function(cb,t){ this._l.forEach(function(p){ cb.call(t,p[1],p[0],this); },this); };
  USP.keys=function(){ return this._l.map(function(p){return p[0];})[Symbol.iterator](); };
  USP.values=function(){ return this._l.map(function(p){return p[1];})[Symbol.iterator](); };
  USP.entries=function(){ return this._l.map(function(p){return [p[0],p[1]];})[Symbol.iterator](); };
  USP[Symbol.iterator]=USP.entries;
  USP.sort=function(){ this._l.sort(function(a,b){return a[0]<b[0]?-1:a[0]>b[0]?1:0;}); };
  USP.toString=function(){ return this._l.map(function(p){return __enc(p[0])+'='+__enc(p[1]);}).join('&'); };
  Object.defineProperty(USP,'size',{ get:function(){return this._l.length;} });
}
if (typeof globalThis.URL === 'undefined') {
  // RFC-3986-ish parser (covers http/https/ws/file + query/hash). Not 100% WHATWG.
  globalThis.URL = function URL(url, base){
    url = String(url);
    var re = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?(\/\/(([^:@\/?#]*)(?::([^@\/?#]*))?@)?([^:\/?#]*)(?::(\d+))?)?([^?#]*)(\?[^#]*)?(#.*)?$/;
    if (base !== undefined && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)){
      var b = new globalThis.URL(base);
      if (url[0]==='/'){ url = b.protocol+'//'+b.host+url; }
      else if (url[0]==='?'){ url = b.protocol+'//'+b.host+b.pathname+url; }
      else if (url[0]==='#'){ url = b.protocol+'//'+b.host+b.pathname+b.search+url; }
      else { var pp=b.pathname.replace(/[^\/]*$/,''); url=b.protocol+'//'+b.host+pp+url; }
    }
    var m = re.exec(url) || [];
    this.protocol = m[1] || '';
    this.username = m[4] || '';
    this.password = m[5] || '';
    this.hostname = m[6] || '';
    this.port = m[7] || '';
    this.pathname = m[8] || '';
    this.search = m[9] || '';
    this.hash = m[10] || '';
    this.host = this.hostname + (this.port ? ':'+this.port : '');
    this.origin = this.protocol + '//' + this.host;
    this.searchParams = new globalThis.URLSearchParams(this.search);
  };
  globalThis.URL.prototype.toString = function(){
    var auth = this.username ? (this.username + (this.password?':'+this.password:'') + '@') : '';
    var s = this.searchParams && this.searchParams._l.length ? '?'+this.searchParams.toString() : this.search;
    return this.protocol + (this.host||this.hostname?'//':'') + auth + this.host + this.pathname + s + this.hash;
  };
  globalThis.URL.prototype.toJSON = function(){ return this.toString(); };
  globalThis.URL.canParse = function(u, b){ try { new globalThis.URL(u,b); return true; } catch(e){ return false; } };
}

// ---- structuredClone (deep clone; Map/Set/Date/RegExp/TypedArray/ArrayBuffer/plain) ----
if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = function structuredClone(v){
    var seen = new Map();
    function clone(x){
      if (x === null || typeof x !== 'object') {
        if (typeof x === 'function') throw new Error('DataCloneError: function not cloneable');
        return x;
      }
      if (seen.has(x)) return seen.get(x);
      var out;
      if (x instanceof Date){ return new Date(x.getTime()); }
      if (x instanceof RegExp){ return new RegExp(x.source, x.flags); }
      if (x instanceof ArrayBuffer){ return x.slice(0); }
      if (ArrayBuffer.isView(x)){ return new x.constructor(x); }
      if (x instanceof Map){ out=new Map(); seen.set(x,out); x.forEach(function(val,k){ out.set(clone(k),clone(val)); }); return out; }
      if (x instanceof Set){ out=new Set(); seen.set(x,out); x.forEach(function(val){ out.add(clone(val)); }); return out; }
      if (Array.isArray(x)){ out=[]; seen.set(x,out); for(var i=0;i<x.length;i++) out[i]=clone(x[i]); return out; }
      out={}; seen.set(x,out); for(var k in x){ if(Object.prototype.hasOwnProperty.call(x,k)) out[k]=clone(x[k]); } return out;
    }
    return clone(v);
  };
}

// ---- Headers (fetch headers shim) ----
if (typeof globalThis.Headers === 'undefined') {
  globalThis.Headers = function Headers(init){
    this._m = {};
    if (init){
      var self=this;
      if (init instanceof globalThis.Headers){ Object.keys(init._m).forEach(function(k){ self._m[k]=init._m[k]; }); }
      else if (Array.isArray(init)){ init.forEach(function(p){ self.append(p[0],p[1]); }); }
      else { Object.keys(init).forEach(function(k){ self.append(k,init[k]); }); }
    }
  };
  var HP = globalThis.Headers.prototype;
  HP.append=function(k,v){ k=String(k).toLowerCase(); this._m[k]=this._m[k]!==undefined?this._m[k]+', '+v:String(v); };
  HP.set=function(k,v){ this._m[String(k).toLowerCase()]=String(v); };
  HP.get=function(k){ k=String(k).toLowerCase(); return this._m[k]!==undefined?this._m[k]:null; };
  HP.has=function(k){ return this._m[String(k).toLowerCase()]!==undefined; };
  HP.delete=function(k){ delete this._m[String(k).toLowerCase()]; };
  HP.forEach=function(cb,t){ var self=this; Object.keys(this._m).sort().forEach(function(k){ cb.call(t,self._m[k],k,self); }); };
  HP.keys=function(){ return Object.keys(this._m).sort()[Symbol.iterator](); };
  HP.values=function(){ var self=this; return Object.keys(this._m).sort().map(function(k){return self._m[k];})[Symbol.iterator](); };
  HP.entries=function(){ var self=this; return Object.keys(this._m).sort().map(function(k){return [k,self._m[k]];})[Symbol.iterator](); };
  HP[Symbol.iterator]=HP.entries;
}

// ---- crypto.subtle.digest (SHA-256, pure JS; sync-result wrapped in a resolved Promise) ----
try {
  if (typeof globalThis.crypto === 'undefined') globalThis.crypto = {};
  if (typeof globalThis.crypto.subtle === 'undefined'){
    var __sha256 = function(bytes){
      function rotr(x,n){ return (x>>>n)|(x<<(32-n)); }
      var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
      var H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
      var l=bytes.length; var bl=l*8;
      var withOne=l+1; var k=(56 - (withOne%64) + 64)%64; var total=withOne+k+8;
      var m=new Uint8Array(total); m.set(bytes); m[l]=0x80;
      var hi=Math.floor(bl/0x100000000), lo=bl>>>0;
      m[total-8]=(hi>>>24)&0xff; m[total-7]=(hi>>>16)&0xff; m[total-6]=(hi>>>8)&0xff; m[total-5]=hi&0xff;
      m[total-4]=(lo>>>24)&0xff; m[total-3]=(lo>>>16)&0xff; m[total-2]=(lo>>>8)&0xff; m[total-1]=lo&0xff;
      var w=new Array(64);
      for (var i=0;i<total;i+=64){
        for (var t=0;t<16;t++){ w[t]=(m[i+t*4]<<24)|(m[i+t*4+1]<<16)|(m[i+t*4+2]<<8)|(m[i+t*4+3]); }
        for (var t=16;t<64;t++){ var s0=rotr(w[t-15],7)^rotr(w[t-15],18)^(w[t-15]>>>3); var s1=rotr(w[t-2],17)^rotr(w[t-2],19)^(w[t-2]>>>10); w[t]=(w[t-16]+s0+w[t-7]+s1)|0; }
        var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
        for (var t=0;t<64;t++){
          var S1=rotr(e,6)^rotr(e,11)^rotr(e,25); var ch=(e&f)^(~e&g); var t1=(h+S1+ch+K[t]+w[t])|0;
          var S0=rotr(a,2)^rotr(a,13)^rotr(a,22); var maj=(a&b)^(a&c)^(b&c); var t2=(S0+maj)|0;
          h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
        }
        H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;
      }
      var out=new Uint8Array(32);
      for (var i=0;i<8;i++){ out[i*4]=(H[i]>>>24)&0xff; out[i*4+1]=(H[i]>>>16)&0xff; out[i*4+2]=(H[i]>>>8)&0xff; out[i*4+3]=H[i]&0xff; }
      return out;
    };
    globalThis.crypto.subtle = {
      digest: function(algo, data){
        var name = (typeof algo === 'string') ? algo : (algo && algo.name);
        return new Promise(function(res, rej){
          if (String(name).toUpperCase().replace('-','') !== 'SHA256'){ rej(new Error('NotSupportedError: only SHA-256 digest is supported in this VM')); return; }
          var b = (data instanceof Uint8Array) ? data : new Uint8Array(data.buffer || data);
          res(__sha256(b).buffer);
        });
      }
    };
  }
} catch(e){}
} catch(e){}
// ===== END TIER-0 WEB EXTENSIONS =====

// console capture -> __logs (drained per cell by Rust via __drainLogs)
globalThis.__logs = [];
const __fmt = (a) => (typeof a === 'string' ? a : globalThis.__preview(a, 2));
globalThis.console = {
  log:   (...a)=>{ globalThis.__logs.push({level:'log',   msg:a.map(__fmt).join(' ')}); },
  error: (...a)=>{ globalThis.__logs.push({level:'error', msg:a.map(__fmt).join(' ')}); },
  warn:  (...a)=>{ globalThis.__logs.push({level:'warn',  msg:a.map(__fmt).join(' ')}); },
  info:  (...a)=>{ globalThis.__logs.push({level:'info',  msg:a.map(__fmt).join(' ')}); },
  debug: (...a)=>{ globalThis.__logs.push({level:'debug', msg:a.map(__fmt).join(' ')}); },
};
globalThis.__drainLogs = function(){ const l = globalThis.__logs; globalThis.__logs = []; return JSON.stringify(l); };

// host Proxy: every host.<name>(...args) becomes a host-effect call dispatched to
// Rust (__hostCall), which parks the request and returns a Promise resolved by the
// shim on resume. fetch is the only wired host effect.
globalThis.host = new Proxy({}, {
  get(_t, name){
    if (typeof name !== 'string') return undefined;
    return function(...args){
      // park the request in Rust, then hand back a promise the shim settles on resume.
      globalThis.__hostCall(name, JSON.stringify(args));
      return new Promise((res,rej)=>{
        globalThis.__settleHost = (ok, val) => { ok ? res(val) : rej(new Error(val)); };
      });
    };
  }
});

// ===== NODE-PARITY SHIMS (snapshot-persisted, zero entropy) =====
// Best-effort parity with the bits of the Node/REPL surface that are pure in-VM. These add NO
// host capability (no fs/process/net identity) and NO non-determinism — they are convenience
// globals many libraries probe for. All survive hibernation (they live in the heap).
globalThis.global = globalThis;
if (typeof globalThis.process === 'undefined') {
  globalThis.process = {
    env: {}, argv: [], argv0: 'engram', execPath: '/engram', pid: 1, platform: 'engram',
    arch: 'wasm', version: 'v0.0.0-engram', versions: { quickjs: '1', engram: '1' },
    cwd: function(){ return '/'; },
    nextTick: function(f){ var a = Array.prototype.slice.call(arguments, 1); queueMicrotask(function(){ f.apply(null, a); }); },
    // no exit/stdin/kill/binding — the sandbox has no process identity.
  };
}
// fetch() as a thin Response-like wrapper over the mediated, allowlisted host.fetch bridge.
if (typeof globalThis.fetch === 'undefined') {
  globalThis.fetch = async function(url, init){
    var r = await globalThis.host.fetch(typeof url === 'string' ? url : String(url), init);
    return {
      ok: !!r.ok, status: r.status|0, url: typeof url === 'string' ? url : String(url),
      headers: (typeof Headers !== 'undefined') ? new Headers(r.headers || {}) : (r.headers || {}),
      text: async function(){ return r.body; },
      json: async function(){ return JSON.parse(r.body); },
      arrayBuffer: async function(){ return new TextEncoder().encode(r.body).buffer; },
    };
  };
}
// console.dir/group/table over the existing capture + __preview.
globalThis.console.dir      = function(x, o){ globalThis.console.log(globalThis.__preview(x, (o && o.depth) || 4)); };
globalThis.console.group    = function(){ globalThis.console.log.apply(null, arguments); };
globalThis.console.groupEnd = function(){};
globalThis.console.table    = function(rows){ globalThis.console.log(globalThis.__preview(rows, 3)); };
globalThis.console.assert   = function(c){ if (!c) globalThis.console.error.apply(null, ['Assertion failed:'].concat(Array.prototype.slice.call(arguments, 1))); };

// use(name) — load an npm package at RUNTIME by fetching a pre-bundled CDN build (the "bundler"
// is jsDelivr/esm.sh) and evaluating it into the heap. Handles CJS (module.exports) and UMD
// (attaches a global). Result is cached in globalThis.__mods and snapshot-persists, so a cold
// wake keeps the module without re-fetching. ASYNC (the VM has no synchronous host IO), so use
// `const _ = await use('lodash')`. Determinism: source eval adds no entropy; pin a version with
// `use('lodash@4.17.21')`. Requires the package host on the fetch allowlist (e.g. cdn.jsdelivr.net).
// NOTE: NOT `require` (sync) and does NOT resolve nested ESM imports — it works for the large set
// of libraries that ship a self-contained CJS/UMD bundle.
globalThis.__mods = globalThis.__mods || {};
globalThis.use = async function(name, opts){
  opts = opts || {};
  if (globalThis.__mods[name] !== undefined) return globalThis.__mods[name];
  var url = opts.url || ('https://cdn.jsdelivr.net/npm/' + name);
  var r = await globalThis.host.fetch(url);
  if (!r || !r.ok) throw new Error('use("' + name + '"): fetch failed (' + (r && r.status) + ') from ' + url);
  var before = new Set(Object.getOwnPropertyNames(globalThis));
  var module = { exports: {} };
  // CJS frame so module.exports is captured; a UMD bundle with no module system attaches a global
  // instead, which we detect by diffing globalThis.
  (0, eval)('(function(module, exports){\n' + r.body + '\n})')(module, module.exports);
  var val;
  if (module.exports && (typeof module.exports === 'function' || Object.keys(module.exports).length)) {
    val = module.exports;
  } else {
    for (var k of Object.getOwnPropertyNames(globalThis)) { if (!before.has(k)) { val = globalThis[k]; break; } }
  }
  if (opts.global) val = globalThis[opts.global];
  globalThis.__mods[name] = val;
  return val;
};
// ===== END NODE-PARITY SHIMS =====

// util.inspect-style preview. Renders Map/Set/Date/RegExp/Symbol/Promise/Error/
// typed arrays/Array/Object correctly — NOT JSON.stringify(x)=>"{}" (the FAFO bug).
globalThis.__preview = function(v, depth){
  depth = (depth === undefined) ? 2 : depth;
  const seen = new WeakSet();
  function q(s){ return '"' + String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n') + '"'; }
  function go(v, d){
    const t = typeof v;
    if (v === null) return 'null';
    if (t === 'undefined') return 'undefined';
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'bigint') return String(v)+'n';
    if (t === 'string') return q(v);
    if (t === 'symbol') return v.toString();
    if (t === 'function') return (v.name ? '[Function: '+v.name+']' : '[Function (anonymous)]');
    if (typeof v === 'object'){
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
      try {
        if (v instanceof Date) return v.toISOString();
        if (v instanceof RegExp) return v.toString();
        if (v instanceof Error) return (v.name||'Error')+': '+(v.message||'');
        if (typeof Promise !== 'undefined' && v instanceof Promise) return 'Promise { <pending> }';
        if (typeof Map !== 'undefined' && v instanceof Map){
          if (d < 0) return 'Map('+v.size+')';
          const parts=[]; let i=0; for (const [k,val] of v){ if(i++>=100){parts.push('...');break;} parts.push(go(k,d-1)+' => '+go(val,d-1)); }
          return 'Map('+v.size+') {'+(parts.length?' '+parts.join(', ')+' ':'')+'}';
        }
        if (typeof Set !== 'undefined' && v instanceof Set){
          if (d < 0) return 'Set('+v.size+')';
          const parts=[]; let i=0; for (const val of v){ if(i++>=100){parts.push('...');break;} parts.push(go(val,d-1)); }
          return 'Set('+v.size+') {'+(parts.length?' '+parts.join(', ')+' ':'')+'}';
        }
        if (ArrayBuffer.isView(v) && !(v instanceof DataView)){
          const a=Array.prototype.slice.call(v,0,100).map(String);
          return v[Symbol.toStringTag]+'('+v.length+') ['+a.join(', ')+(v.length>100?', ...':'')+']';
        }
        if (Array.isArray(v)){
          if (d < 0) return '[Array]';
          const parts=v.slice(0,100).map(x=>go(x,d-1)); if(v.length>100)parts.push('...'+(v.length-100)+' more');
          return '['+parts.join(', ')+']';
        }
        if (d < 0) return '[Object]';
        const ctor = (v.constructor && v.constructor.name && v.constructor.name!=='Object') ? v.constructor.name+' ' : '';
        const keys=Object.keys(v).slice(0,100);
        const parts=keys.map(k=>k+': '+go(v[k],d-1)); if(Object.keys(v).length>100)parts.push('...');
        return ctor+'{'+(parts.length?' '+parts.join(', ')+' ':'')+'}';
      } catch(e){ return '[unserializable]'; }
    }
    return String(v);
  }
  try { return go(v, depth); } catch(e){ return '[preview-error]'; }
};

// classify a value into a coarse valueType tag (for the eval-result frame).
globalThis.__valueType = function(v){
  if (v === null) return 'null';
  const t = typeof v;
  if (t !== 'object' && t !== 'function') return t;
  if (t === 'function') return 'function';
  if (v instanceof Error) return 'error';
  if (v instanceof Date) return 'date';
  if (v instanceof RegExp) return 'regexp';
  if (typeof Map!=='undefined' && v instanceof Map) return 'map';
  if (typeof Set!=='undefined' && v instanceof Set) return 'set';
  if (typeof Promise!=='undefined' && v instanceof Promise) return 'promise';
  if (Array.isArray(v)) return 'array';
  return 'object';
};
"#;

fn inject_host_fns(ctx: &Ctx) {
    let g = ctx.globals();
    let now = Function::new(ctx.clone(), || -> f64 {
        CLOCK.with(|c| {
            let t = c.get();
            c.set(t + 1);
            CLOCK_CALLS.with(|n| n.set(n.get() + 1));
            // seeded epoch base 1.7e12 + 1ms tick (parity with JS kernel determinism)
            1_700_000_000_000.0 + t as f64
        })
    })
    .unwrap();
    g.set("__now", now).unwrap();

    let rand = Function::new(ctx.clone(), || -> f64 {
        RNG.with(|r| {
            let n = lcg(r.get());
            r.set(n);
            RNG_CALLS.with(|c| c.set(c.get() + 1));
            ((n >> 11) as f64) / ((1u64 << 53) as f64)
        })
    })
    .unwrap();
    g.set("__rand", rand).unwrap();

    // __hostCall(name, argsJson): park the request for the shim. Returns nothing; the
    // host Proxy (in BOOTSTRAP) builds the Promise the shim settles on resume.
    let hostcall = Function::new(ctx.clone(), |name: String, args_json: String| {
        HOSTCALL_REQ.with(|h| {
            *h.borrow_mut() = Some(format!(
                "{{\"name\":{},\"args\":{}}}",
                json_str(&name),
                args_json
            ))
        });
    })
    .unwrap();
    g.set("__hostCall", hostcall).unwrap();
}

fn build_runtime() -> (Runtime, Context) {
    let rt = Runtime::new().unwrap();
    let ctx = Context::full(&rt).unwrap();
    rt.set_memory_limit(64 * 1024 * 1024);
    rt.set_max_stack_size(512 * 1024);
    rt.set_interrupt_handler(Some(Box::new(|| {
        // GUARD 1: instruction budget
        let over_budget = BUDGET.with(|b| {
            let left = b.get() - 1;
            b.set(left);
            left <= 0
        });
        if over_budget {
            TRIPPED.with(|t| t.set(true));
            return true;
        }
        // GUARD 3: BUFFER-GROWTH TRIPWIRE. If the linear memory has grown more than the
        // per-cell cap since eval-begin, abort. This catches the fast-array bomb that beats
        // rquickjs set_memory_limit (native alloc growth with few bytecode interrupts still
        // hits *some* interrupts; the buffer byteLength is the source of truth).
        let cap = GROW_CAP_PAGES.with(|c| c.get());
        if cap > 0 {
            let start = START_PAGES.with(|s| s.get());
            if cur_pages().saturating_sub(start) > cap {
                GROW_TRIPPED.with(|g| g.set(true));
                return true;
            }
        }
        false
    })));
    ctx.with(|ctx| inject_host_fns(&ctx));
    (rt, ctx)
}

fn ensure_ctx() {
    CTX.with(|c| {
        if c.borrow().is_none() {
            *c.borrow_mut() = Some(build_runtime());
        }
    });
}

#[no_mangle]
pub extern "C" fn create(clock_seed: u64, rng_seed: u64) -> i32 {
    CLOCK.with(|c| c.set(clock_seed));
    RNG.with(|r| r.set(if rng_seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { rng_seed }));
    ensure_ctx();
    1
}

#[no_mangle]
pub extern "C" fn reattach() -> i32 {
    CTX.with(|c| if c.borrow().is_some() { 1 } else { 0 })
}

#[no_mangle]
pub extern "C" fn clock_calls() -> i64 {
    CLOCK_CALLS.with(|c| c.get() as i64)
}
#[no_mangle]
pub extern "C" fn rng_calls() -> i64 {
    RNG_CALLS.with(|c| c.get() as i64)
}
#[no_mangle]
pub extern "C" fn set_counters(clock: i64, rng: i64) {
    CLOCK_CALLS.with(|c| c.set(clock as u64));
    RNG_CALLS.with(|c| c.set(rng as u64));
}

#[no_mangle]
pub extern "C" fn used_heap() -> i64 {
    CTX.with(|c| match c.borrow().as_ref() {
        Some((rt, _)) => rt.memory_usage().memory_used_size as i64,
        None => -1,
    })
}
#[no_mangle]
pub extern "C" fn buffer_bytes() -> i64 {
    (cur_pages() as i64) * 65536
}

// W5 (docs/W5-COMPACTION-PLAN.md): run GC, then SCRUB freed dlmalloc slack by allocating
// zero-filled buffers across the freed arena and dropping them, so the monotonic linear
// buffer (which cannot shrink in place) gzips down toward ~nothing on the freed pages.
// `budget_mb` is computed host-side from (bufferBytes - usedHeap) slack, capped so the
// bounded, non-growing scrub itself cannot OOM. Returns the post-scrub used-heap bytes.
#[no_mangle]
pub extern "C" fn scrub_arena(budget_mb: u32) -> i64 {
    ensure_ctx();
    // First GC so freed objects are actually reclaimable as slack.
    CTX.with(|c| {
        if let Some((rt, _)) = c.borrow().as_ref() {
            rt.run_gc();
        }
    });
    if budget_mb >= 1 {
        // Allocate `budget_mb` 1MB zero buffers, drop refs, GC. Disarm the interrupt guard
        // during the scrub (it is host-driven, not a user cell).
        let saved_budget = BUDGET.with(|b| b.get());
        let saved_cap = GROW_CAP_PAGES.with(|c| c.get());
        BUDGET.with(|b| b.set(i64::MAX));
        GROW_CAP_PAGES.with(|c| c.set(0));
        let src = format!(
            "{{let __s=[];try{{for(let __i=0;__i<{};__i++){{__s.push(new Uint8Array(1048576));}}}}catch(__e){{}}__s.length=0;}}0",
            budget_mb
        );
        CTX.with(|c| {
            if let Some((rt, ctx)) = c.borrow().as_ref() {
                ctx.with(|ctx| {
                    let _: rquickjs::Result<Value> = ctx.eval(src.as_str());
                });
                rt.run_gc();
            }
        });
        BUDGET.with(|b| b.set(saved_budget));
        GROW_CAP_PAGES.with(|c| c.set(saved_cap));
    }
    used_heap()
}

// host.kv (RLM-demo) removed. These exports remain as inert stubs so the JS shim's
// snapshot-meta plumbing keeps a stable ABI without an RLM key/value surface.
#[no_mangle]
pub extern "C" fn kv_export_ptr() -> *const u8 {
    unsafe {
        let p = core::ptr::addr_of_mut!(KV_OUT) as *mut u8;
        KV_OUT[0] = b'{';
        KV_OUT[1] = b'}';
        KV_OUT_LEN = 2;
        let _ = p;
        core::ptr::addr_of!(KV_OUT) as *const u8
    }
}
#[no_mangle]
pub extern "C" fn kv_export_len() -> usize {
    unsafe { KV_OUT_LEN }
}
#[no_mangle]
pub extern "C" fn kv_import(_ptr: *const u8, _len: usize) {
    // no-op: host.kv removed.
}

const STATUS_DONE: i32 = 0;
const STATUS_HOST_CALL: i32 = 1;

// Apply the bootstrap once, lazily.
fn ensure_wired() {
    if !WIRED.with(|w| w.get()) {
        CTX.with(|c| {
            if let Some((_, ctx)) = c.borrow().as_ref() {
                ctx.with(|ctx| {
                    let r: rquickjs::Result<Value> = ctx.eval(BOOTSTRAP);
                    if r.is_err() {
                        let msg = ctx.catch().as_exception().and_then(|e| e.message()).unwrap_or_else(|| "no-exc".into());
                        let b = msg.as_bytes();
                        let n = b.len().min(4096);
                        unsafe {
                            let p = core::ptr::addr_of_mut!(BOOT_ERR) as *mut u8;
                            core::ptr::copy_nonoverlapping(b.as_ptr(), p, n);
                            BOOT_ERR_LEN = n;
                        }
                    }
                });
            }
        });
        WIRED.with(|w| w.set(true));
    }
}

// Drive microtasks until the cell settles or a host call parks.
// Returns true if a host call got parked (status HOST_CALL).
fn pump_jobs(rt: &Runtime) -> bool {
    let mut guard = 0;
    loop {
        // A host effect may have parked synchronously (before any job ran) or during a job.
        if HOSTCALL_REQ.with(|h| h.borrow().is_some()) {
            return true;
        }
        if !rt.is_job_pending() || guard >= 2_000_000 {
            return false;
        }
        let _ = rt.execute_pending_job();
        guard += 1;
    }
}

// Finalize: build the result JSON from the settled cell globals. All value/preview/
// type/error extraction is done in-VM (one JSON blob) to handle Map/Set/Date/Error
// correctly and avoid host-side marshalling.
fn finalize_cell(ctx: &Ctx) {
    let tripped = TRIPPED.with(|t| t.get());
    // POST-CELL buffer-growth check: a SINGLE huge native alloc (e.g. new Uint8Array(40MB))
    // grows the linear buffer past the per-cell cap WITHOUT looping, so no interrupt fires
    // mid-cell and the interrupt tripwire misses it. Catch it here by comparing the final
    // page count to start+cap. (The buffer is monotonic so it stays grown, but we report a
    // typed recoverable MemoryLimitError, socket alive, next eval works — and the dump-ceiling
    // guard additionally clean-rejects the oversized image at checkpoint.)
    let post_grow = {
        let cap = GROW_CAP_PAGES.with(|c| c.get());
        let start = START_PAGES.with(|s| s.get());
        cap > 0 && cur_pages().saturating_sub(start) > cap
    };
    let grow_tripped = GROW_TRIPPED.with(|g| g.get()) || post_grow;

    if tripped || grow_tripped {
        let logs = drain_logs(ctx);
        let (name, msg) = if grow_tripped {
            ("MemoryLimitError", "cell grew linear memory past the per-cell cap")
        } else {
            ("TimeoutError", "cell exceeded the instruction budget")
        };
        set_result(&format!(
            "{{\"ok\":false,\"valueType\":\"error\",\"logs\":{},\"error\":{{\"name\":{},\"message\":{},\"stack\":\"\"}}}}",
            logs, json_str(name), json_str(msg)
        ));
        return;
    }

    // Build the whole result frame inside the VM, returning a JSON string.
    let frame_js = r#"
      (function(){
        var ok = globalThis.__cellOk;
        var logs = globalThis.__drainLogs();
        if (ok) {
          var v = globalThis.__cellResult;
          var preview = globalThis.__preview(v, 2);
          var vtype = globalThis.__valueType(v);
          var value;
          try { value = (v===undefined) ? null : JSON.parse(JSON.stringify(v)); }
          catch(e){ value = null; }
          return JSON.stringify({ok:true, value:value, valuePreview:preview, valueType:vtype, logs:JSON.parse(logs)});
        } else {
          var e = globalThis.__cellError;
          var name='Error', message=String(e), stack='';
          if (e && typeof e === 'object'){ name = e.name||'Error'; message = e.message!==undefined?String(e.message):String(e); stack = e.stack||''; }
          return JSON.stringify({ok:false, valueType:'error', logs:JSON.parse(logs), error:{name:name, message:message, stack:stack}});
        }
      })()
    "#;
    let res = ctx.eval::<Value, _>(frame_js);
    let frame = match res {
        Ok(v) => v
            .as_string()
            .and_then(|s| s.to_string().ok())
            .unwrap_or_else(|| {
                format!("{{\"FRAME_NOT_STRING\":true,\"isPromise\":{}}}", v.is_promise())
            }),
        Err(_) => {
            let m = ctx
                .catch()
                .as_exception()
                .and_then(|e| e.message())
                .unwrap_or_else(|| "no-exc".into());
            format!("{{\"FRAME_ERR\":{}}}", json_str(&m))
        }
    };
    set_result(&frame);
}

fn drain_logs(ctx: &Ctx) -> String {
    ctx.eval::<Value, _>("globalThis.__drainLogs()")
        .ok()
        .and_then(|v| v.as_string().and_then(|s| s.to_string().ok()))
        .unwrap_or_else(|| "[]".into())
}

// Re-arm the per-cell guard counters at (re)entry into JS execution.
fn arm_guards(budget: i64, grow_cap_pages: u32) {
    BUDGET.with(|b| b.set(budget));
    TRIPPED.with(|t| t.set(false));
    GROW_TRIPPED.with(|g| g.set(false));
    START_PAGES.with(|s| s.set(cur_pages()));
    GROW_CAP_PAGES.with(|c| c.set(grow_cap_pages));
}

#[no_mangle]
pub extern "C" fn eval_begin(src_ptr: *const u8, src_len: usize, budget: i64, grow_cap_pages: u32) -> i32 {
    ensure_ctx();
    arm_guards(budget, grow_cap_pages);
    ensure_wired();
    HOSTCALL_REQ.with(|h| *h.borrow_mut() = None);
    HOSTCALL_RES.with(|h| *h.borrow_mut() = None);

    let src = unsafe { std::slice::from_raw_parts(src_ptr, src_len) };
    let src = match std::str::from_utf8(src) {
        Ok(s) => s.to_string(),
        Err(_) => {
            set_result(r#"{"ok":false,"valueType":"error","logs":[],"error":{"name":"Error","message":"invalid-utf8","stack":""}}"#);
            return STATUS_DONE;
        }
    };
    // Wrap the cell so its completion value is captured into __cellResult and any
    // throw into __cellError, regardless of sync/async. We eval the wrapped form,
    // then drive the resulting promise to settlement (pumping host calls along the
    // way). This makes `await host.fetch()` cells work with one value-capture path.
    install_cell(&src);
    run(false)
}

#[no_mangle]
pub extern "C" fn eval_resume(res_ptr: *const u8, res_len: usize) -> i32 {
    let s = unsafe { std::slice::from_raw_parts(res_ptr, res_len) };
    let payload = std::str::from_utf8(s).unwrap_or("{}").to_string();
    HOSTCALL_RES.with(|h| *h.borrow_mut() = Some(payload));
    // re-arm budget for the continuation but keep counting buffer growth from start.
    BUDGET.with(|b| b.set(b.get().max(100_000)));
    run(true)
}

// Wrap the cell source so its completion settles into __cellDone with a captured
// value/error. An async function lets `await host.fetch()` work uniformly: a sync
// cell's last-expression value is returned; a thrown error rejects.
fn install_cell(src: &str) {
    CTX.with(|c| {
        if let Some((_, ctx)) = c.borrow().as_ref() {
            ctx.with(|ctx| {
                // The cell body is appended as the function body; we transform it so the
                // LAST expression's value is the return value (REPL semantics). We do the
                // simplest robust thing: eval the source via indirect eval inside an async
                // fn, capturing its completion value (works for expression cells); for
                // statement cells the completion value is undefined, which is correct.
                g_set(&ctx, "__cellSrc", src);
                // REPL semantics with async support: try to compile the source as the
                // RETURN of an async function (expression cell, supports top-level await);
                // if that fails to compile (statement/declaration cell), fall back to using
                // it as the async function BODY (declarations land in the cell's scope; but
                // we want them GLOBAL, so the body form runs via indirect global eval which
                // does NOT allow await — covered by the expression form for await cells).
                // `__mkCell` returns the async fn or null on compile failure.
                let driver = r#"
                  globalThis.__cellDone = false;
                  globalThis.__cellOk = true;
                  globalThis.__cellResult = undefined;
                  globalThis.__cellError = null;
                  (function(){
                    var AsyncFn = (async function(){}).constructor;
                    var fn = null, mode = 'global';
                    // (1) Expression form: `return (src)` — supports await, returns the value.
                    try { fn = new AsyncFn("return (\n" + globalThis.__cellSrc + "\n);"); mode = 'expr'; }
                    catch(e) { fn = null; }
                    // (2) Multi-statement cell that USES await: compile as an async function BODY
                    // (top-level await works inside it). Declarations are function-scoped, so the
                    // REPL persistence contract is `globalThis.x = ...` (matches the host surface).
                    if (!fn && /\bawait\b/.test(globalThis.__cellSrc)) {
                      try { fn = new AsyncFn(globalThis.__cellSrc); mode = 'asyncbody'; }
                      catch(e) { fn = null; }
                    }
                    (async function(){
                      try {
                        var r;
                        if (fn) {
                          r = await fn.call(globalThis);
                        } else {
                          // (3) Statement/declaration cell (no await): eval in GLOBAL scope so
                          // `let x`, `function f(){}`, `globalThis.x=` persist.
                          r = await (0, eval)(globalThis.__cellSrc);
                        }
                        globalThis.__cellResult = r;
                        // REPL last-value: `_` holds the previous cell's completion value (persists).
                        try { if (r !== undefined) globalThis._ = r; } catch(_e) {}
                        globalThis.__cellOk = true;
                      } catch(e) {
                        globalThis.__cellError = e;
                        globalThis.__cellOk = false;
                      } finally {
                        globalThis.__cellDone = true;
                      }
                    })();
                  })();
                "#;
                let _: rquickjs::Result<Value> = ctx.eval(driver);
            });
        }
    });
}

fn g_set(ctx: &Ctx, key: &str, val: &str) {
    let g = ctx.globals();
    if let Ok(s) = rquickjs::String::from_str(ctx.clone(), val) {
        let _ = g.set(key, s);
    }
}

// Core driver shared by begin/resume. Pumps microtasks; if a host call parks, returns
// STATUS_HOST_CALL; when the cell promise settles (__cellDone), finalizes and returns DONE.
fn run(resume: bool) -> i32 {
    CTX.with(|c| {
        let b = c.borrow();
        let (rt, ctx) = b.as_ref().unwrap();

        if resume {
            // settle the parked host promise with the shim's result.
            let payload = HOSTCALL_RES.with(|h| h.borrow().clone().unwrap_or_else(|| "{}".into()));
            HOSTCALL_REQ.with(|h| *h.borrow_mut() = None);
            let code = format!(
                r#"(function(){{var p={}; if(globalThis.__settleHost){{var f=globalThis.__settleHost; globalThis.__settleHost=null; f(p.ok, p.ok?p.value:(p.error||'host error'));}}}})()"#,
                payload
            );
            ctx.with(|ctx| {
                let _: rquickjs::Result<Value> = ctx.eval(code.as_str());
            });
        }

        // drain microtasks; a parked host call interrupts the pump.
        let parked = pump_jobs(rt);
        if parked {
            return emit_hostcall();
        }

        // If a guard TRIPPED mid-cell, the async cell-driver's continuation (and any chained
        // reactions) may be left pending in the job queue. If they persist into the snapshot,
        // resuming them on cold-restore re-trips/loops (the bomb-then-restore hang). DISARM the
        // guards and bounded-drain the queue so the snapshot is clean. (Budget is huge during the
        // drain, so a freed/aborted continuation runs to completion and is discarded.)
        let tripped = TRIPPED.with(|t| t.get()) || GROW_TRIPPED.with(|g| g.get());
        if tripped {
            BUDGET.with(|b| b.set(i64::MAX));
            GROW_CAP_PAGES.with(|g| g.set(0));
            let mut guard = 0;
            while rt.is_job_pending() && guard < 200_000 {
                let _ = rt.execute_pending_job();
                guard += 1;
            }
        }

        // The cell promise should now be settled (no pending host call, jobs drained).
        // If for some reason it is not done and not parked, finalize as undefined.
        ctx.with(|ctx| finalize_cell(&ctx));
        STATUS_DONE
    })
}

fn emit_hostcall() -> i32 {
    let req = HOSTCALL_REQ.with(|h| h.borrow().clone().unwrap_or_else(|| "{}".into()));
    // All host effects (fetch) go to the shim; the RLM kv/ctx/subLM/final surface was removed.
    set_hostcall(&req);
    STATUS_HOST_CALL
}

// ---- tiny helpers ----------------------------------------------------------
fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

// ---- ultra-minimal JSON value reader for host-call requests ----------------
// (avoids pulling serde_json into the wasip1 engine to keep size down)
mod serde_lite {
    pub struct Value {
        raw: String,
    }
    pub struct Arr {
        items: Vec<Item>,
    }
    pub struct Item {
        raw: String,
    }
    impl Item {
        pub fn as_str(&self) -> Option<&str> {
            let t = self.raw.trim();
            if t.starts_with('"') && t.ends_with('"') && t.len() >= 2 {
                Some(&t[1..t.len() - 1])
            } else {
                None
            }
        }
        pub fn raw(&self) -> String {
            self.raw.clone()
        }
    }
    impl Arr {
        pub fn get(&self, i: usize) -> Option<&Item> {
            self.items.get(i)
        }
    }
    impl Value {
        pub fn get_str(&self, key: &str) -> Option<&str> {
            let pat = format!("\"{}\":", key);
            let idx = self.raw.find(&pat)? + pat.len();
            let rest = self.raw[idx..].trim_start();
            if !rest.starts_with('"') {
                return None;
            }
            let rest = &rest[1..];
            let end = rest.find('"')?;
            Some(&rest[..end])
        }
        pub fn get_arr(&self, key: &str) -> Option<Arr> {
            let pat = format!("\"{}\":", key);
            let idx = self.raw.find(&pat)? + pat.len();
            let rest = self.raw[idx..].trim_start();
            if !rest.starts_with('[') {
                return None;
            }
            // split top-level array items (string-aware, depth-aware)
            let bytes = rest.as_bytes();
            let mut depth = 0i32;
            let mut in_str = false;
            let mut esc = false;
            let mut start = 1usize;
            let mut items = Vec::new();
            let mut i = 1usize;
            while i < bytes.len() {
                let c = bytes[i] as char;
                if in_str {
                    if esc {
                        esc = false;
                    } else if c == '\\' {
                        esc = true;
                    } else if c == '"' {
                        in_str = false;
                    }
                } else {
                    match c {
                        '"' => in_str = true,
                        '[' | '{' => depth += 1,
                        ']' | '}' => {
                            if c == ']' && depth == 0 {
                                let item = rest[start..i].trim();
                                if !item.is_empty() {
                                    items.push(Item { raw: item.to_string() });
                                }
                                return Some(Arr { items });
                            }
                            depth -= 1;
                        }
                        ',' if depth == 0 => {
                            let item = rest[start..i].trim();
                            if !item.is_empty() {
                                items.push(Item { raw: item.to_string() });
                            }
                            start = i + 1;
                        }
                        _ => {}
                    }
                }
                i += 1;
            }
            Some(Arr { items })
        }
    }
    pub fn parse(s: &str) -> Option<Value> {
        Some(Value { raw: s.to_string() })
    }
}
