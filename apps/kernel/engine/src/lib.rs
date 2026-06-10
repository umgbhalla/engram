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
// SCRATCH carries eval source IN and host-call results (fetch bodies, fs writes crossing the
// boundary) IN on resume. It is a DYNAMIC, releasable buffer (was a fixed 32MB `static mut` BSS
// array). The fixed array forced EVERY kernel instance's initial wasm linear memory to ~32MB, so
// N co-resident KernelDOs in a CONJOINED isolate (ThinkDO + one in-Worker kernel per subLM depth)
// paid N×32MB and OOM'd the 128MB DO budget at depth >= 4. A Vec at a 1MB FLOOR lets idle/parked
// kernels stay ~1MB; only the ACTIVE kernel doing a big payload grows (scratch_reserve, up to a
// 32MB CEIL), then drops back to the floor (scratch_release) after the cell. NOTE: wasm linear
// memory never shrinks, so a kernel that actually DID a big payload keeps that peak memory.size for
// its life — but a parent parked on host.subLM only ever held small orchestration source, so it
// stays ~1MB, which is exactly what collapses the conjoined N×32MB multiplier.
const SCRATCH_FLOOR: usize = 1 << 20; // 1MB idle floor (the buffer never drops below this)
const SCRATCH_CEIL: usize = 32 << 20; // 32MB hard ceiling (matches host FETCH_MAX_BODY_BYTES)
static mut RESULT: [u8; 1 << 20] = [0; 1 << 20]; // 1MB result (value previews + logs)
static mut RESULT_LEN: usize = 0;
static mut HOSTCALL: [u8; 1 << 16] = [0; 1 << 16];
static mut HOSTCALL_LEN: usize = 0;
thread_local! {
    // Dynamic scratch buffer: 1MB floor, grows to SCRATCH_CEIL on demand (scratch_reserve),
    // releases to the floor after a cell (scratch_release). Replaces the old fixed 32MB array.
    static SCRATCH: RefCell<Vec<u8>> = RefCell::new(vec![0u8; SCRATCH_FLOOR]);
}
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
    SCRATCH.with(|s| s.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn scratch_cap() -> usize {
    SCRATCH.with(|s| s.borrow().len())
}
// Grow scratch to hold >= `len` bytes (64KB-rounded, clamped to SCRATCH_CEIL) and return its
// (possibly relocated) data pointer. The glue calls this BEFORE writing a payload, then RE-READS
// scratch_ptr()/scratch_cap() — it never caches a pointer across a reserve. If `len` exceeds
// SCRATCH_CEIL the buffer grows only to the ceiling, so the glue's `len > scratch_cap()` check then
// rejects the payload (ProtocolSizeError) instead of overrunning linear memory.
#[no_mangle]
pub extern "C" fn scratch_reserve(len: usize) -> *const u8 {
    SCRATCH.with(|s| {
        let mut v = s.borrow_mut();
        let want = ((len + 0xFFFF) & !0xFFFF).clamp(SCRATCH_FLOOR, SCRATCH_CEIL);
        if want > v.len() {
            v.resize(want, 0);
        }
        v.as_ptr()
    })
}
// Release scratch back to the 1MB floor after a cell completes (frees the big payload to the
// allocator for reuse). wasm linear memory does not shrink, so this does not lower memory.size, but
// it lets the next big payload reuse freed space instead of growing further, and keeps a kernel
// that only runs small cells from ever holding a big buffer.
//
// W5/Tier-2: ZERO the released region BEFORE truncating. The freed bytes (a stale fetch/eval body,
// often incompressible) otherwise persist in monotonic linear memory at their high-water-mark and
// permanently inflate every later snapshot's gzip — a one-time large host.fetch would bloat the
// stored image for the session's life. Zeroing lets the snapshot's gzip reclaim the freed pages
// (raw memory.size stays put; the STORED/compressed image shrinks). Pure dead-byte scrub: the glue
// re-reads scratch_ptr()/scratch_cap() per use and never reads scratch across cells, so no
// VM-visible state, determinism, or restore semantics can change.
#[no_mangle]
pub extern "C" fn scratch_release() {
    SCRATCH.with(|s| {
        let mut v = s.borrow_mut();
        if v.len() > SCRATCH_FLOOR {
            for b in &mut v[SCRATCH_FLOOR..] {
                *b = 0;
            }
            v.truncate(SCRATCH_FLOOR);
            v.shrink_to_fit();
        }
    })
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

// ---- hash primitives (SHA-256 / SHA-1 / MD5, pure JS) on globalThis.__hashes ----
// Hoisted to a stable global so BOTH crypto.subtle.digest AND require('crypto').createHash reuse
// ONE implementation. Each takes a Uint8Array, returns a Uint8Array digest. Snapshot-persisted.
try {
  if (typeof globalThis.__hashes === 'undefined') {
    function __rotr(x,n){ return (x>>>n)|(x<<(32-n)); }
    function __rotl(x,n){ return (x<<n)|(x>>>(32-n)); }
    var __sha256 = function(bytes){
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
        for (var t=16;t<64;t++){ var s0=__rotr(w[t-15],7)^__rotr(w[t-15],18)^(w[t-15]>>>3); var s1=__rotr(w[t-2],17)^__rotr(w[t-2],19)^(w[t-2]>>>10); w[t]=(w[t-16]+s0+w[t-7]+s1)|0; }
        var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
        for (var t=0;t<64;t++){
          var S1=__rotr(e,6)^__rotr(e,11)^__rotr(e,25); var ch=(e&f)^(~e&g); var t1=(h+S1+ch+K[t]+w[t])|0;
          var S0=__rotr(a,2)^__rotr(a,13)^__rotr(a,22); var maj=(a&b)^(a&c)^(b&c); var t2=(S0+maj)|0;
          h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
        }
        H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;
      }
      var out=new Uint8Array(32);
      for (var i=0;i<8;i++){ out[i*4]=(H[i]>>>24)&0xff; out[i*4+1]=(H[i]>>>16)&0xff; out[i*4+2]=(H[i]>>>8)&0xff; out[i*4+3]=H[i]&0xff; }
      return out;
    };
    // SHA-1 (160-bit). Big-endian, same MD-padding as SHA-256.
    var __sha1 = function(bytes){
      var H=[0x67452301,0xEFCDAB89,0x98BADCFE,0x10325476,0xC3D2E1F0];
      var l=bytes.length, bl=l*8, withOne=l+1, k=(56-(withOne%64)+64)%64, total=withOne+k+8;
      var m=new Uint8Array(total); m.set(bytes); m[l]=0x80;
      var hi=Math.floor(bl/0x100000000), lo=bl>>>0;
      m[total-8]=(hi>>>24)&0xff; m[total-7]=(hi>>>16)&0xff; m[total-6]=(hi>>>8)&0xff; m[total-5]=hi&0xff;
      m[total-4]=(lo>>>24)&0xff; m[total-3]=(lo>>>16)&0xff; m[total-2]=(lo>>>8)&0xff; m[total-1]=lo&0xff;
      var w=new Array(80);
      for (var i=0;i<total;i+=64){
        for (var t=0;t<16;t++){ w[t]=(m[i+t*4]<<24)|(m[i+t*4+1]<<16)|(m[i+t*4+2]<<8)|(m[i+t*4+3]); }
        for (var t=16;t<80;t++){ w[t]=__rotl(w[t-3]^w[t-8]^w[t-14]^w[t-16],1); }
        var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4];
        for (var t=0;t<80;t++){
          var f,kk;
          if (t<20){ f=(b&c)|((~b)&d); kk=0x5A827999; }
          else if (t<40){ f=b^c^d; kk=0x6ED9EBA1; }
          else if (t<60){ f=(b&c)|(b&d)|(c&d); kk=0x8F1BBCDC; }
          else { f=b^c^d; kk=0xCA62C1D6; }
          var tmp=(__rotl(a,5)+f+e+kk+w[t])|0; e=d; d=c; c=__rotl(b,30); b=a; a=tmp;
        }
        H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;
      }
      var out=new Uint8Array(20);
      for (var i=0;i<5;i++){ out[i*4]=(H[i]>>>24)&0xff; out[i*4+1]=(H[i]>>>16)&0xff; out[i*4+2]=(H[i]>>>8)&0xff; out[i*4+3]=H[i]&0xff; }
      return out;
    };
    // MD5 (128-bit). LITTLE-endian length + word load (RFC 1321).
    var __md5 = function(bytes){
      var S=[7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
      var K=[];
      for (var ki=0;ki<64;ki++){ K[ki]=(Math.floor(Math.abs(Math.sin(ki+1))*0x100000000))|0; }
      var a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476;
      var l=bytes.length, withOne=l+1, k=(56-(withOne%64)+64)%64, total=withOne+k+8;
      var m=new Uint8Array(total); m.set(bytes); m[l]=0x80;
      var bl=l*8, hi=Math.floor(bl/0x100000000), lo=bl>>>0;
      m[total-8]=lo&0xff; m[total-7]=(lo>>>8)&0xff; m[total-6]=(lo>>>16)&0xff; m[total-5]=(lo>>>24)&0xff;
      m[total-4]=hi&0xff; m[total-3]=(hi>>>8)&0xff; m[total-2]=(hi>>>16)&0xff; m[total-1]=(hi>>>24)&0xff;
      for (var i=0;i<total;i+=64){
        var M=new Array(16);
        for (var j=0;j<16;j++){ M[j]=m[i+j*4]|(m[i+j*4+1]<<8)|(m[i+j*4+2]<<16)|(m[i+j*4+3]<<24); }
        var A=a0,B=b0,C=c0,D=d0;
        for (var t=0;t<64;t++){
          var F,gg;
          if (t<16){ F=(B&C)|((~B)&D); gg=t; }
          else if (t<32){ F=(D&B)|((~D)&C); gg=(5*t+1)%16; }
          else if (t<48){ F=B^C^D; gg=(3*t+5)%16; }
          else { F=C^(B|(~D)); gg=(7*t)%16; }
          F=(F+A+K[t]+M[gg])|0; A=D; D=C; C=B; B=(B+__rotl(F,S[t]))|0;
        }
        a0=(a0+A)|0; b0=(b0+B)|0; c0=(c0+C)|0; d0=(d0+D)|0;
      }
      var out=new Uint8Array(16); var words=[a0,b0,c0,d0];
      for (var i=0;i<4;i++){ out[i*4]=words[i]&0xff; out[i*4+1]=(words[i]>>>8)&0xff; out[i*4+2]=(words[i]>>>16)&0xff; out[i*4+3]=(words[i]>>>24)&0xff; }
      return out;
    };
    globalThis.__hashes = {
      sha256: __sha256, 'sha-256': __sha256,
      sha1: __sha1, 'sha-1': __sha1,
      md5: __md5,
      blockSize: { sha256: 64, 'sha-256': 64, sha1: 64, 'sha-1': 64, md5: 64 },
    };
  }
  if (typeof globalThis.crypto === 'undefined') globalThis.crypto = {};
  if (typeof globalThis.crypto.subtle === 'undefined'){
    globalThis.crypto.subtle = {
      digest: function(algo, data){
        var name = (typeof algo === 'string') ? algo : (algo && algo.name);
        return new Promise(function(res, rej){
          var key = String(name).toLowerCase();
          var fn = globalThis.__hashes[key] || (key.replace('-','') === 'sha256' ? globalThis.__hashes.sha256 : (key.replace('-','') === 'sha1' ? globalThis.__hashes.sha1 : null));
          if (!fn){ rej(new Error('NotSupportedError: unsupported digest ' + name + ' (supported: SHA-256, SHA-1)')); return; }
          var b = (data instanceof Uint8Array) ? data : new Uint8Array(data.buffer || data);
          res(fn(b).buffer);
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
// Capture the host bridge into a BOOTSTRAP-local const, then remove the global so guest cells
// cannot shadow/replace globalThis.__hostCall to intercept host effects. The const lives in the
// heap installed by BOOTSTRAP (WIRED-guarded, once per fresh runtime) so it survives snapshot/
// restore like every other BOOTSTRAP value. __settleHost stays a global (Rust reads it on resume).
const __HOSTCALL = globalThis.__hostCall;
try { delete globalThis.__hostCall; } catch(e) { try { globalThis.__hostCall = undefined; } catch(e2){} }
globalThis.host = new Proxy({}, {
  get(_t, name){
    if (typeof name !== 'string') return undefined;
    return function(...args){
      // park the request in Rust, then hand back a promise the shim settles on resume.
      __HOSTCALL(name, JSON.stringify(args));
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
// process — a Node-shaped object so libraries that gate on process.platform / versions.node /
// process.env / nextTick / hrtime work. WAVE 4 completion: this presents as Node v20 on
// linux/x64 (the common feature-detect target) instead of the engram/wasm placeholder, populates
// env from globalThis.__processEnv (the glue MAY seed it from config/ctx; defaults to {}), and adds
// hrtime/uptime, a CATCHABLE exit (throws ProcessExit — it does NOT kill the kernel), chdir,
// nextTick, on/once (no-op-ish for 'exit'/'uncaughtException'), and stdout/stderr.write -> console.
// CAVEATS (determinism): hrtime/uptime are derived from the SEEDED clock (Date.now), NOT a real
// monotonic clock; argv/pid/platform are fixed; there is no real process to signal or kill.
// Snapshot-safe (pure heap). RE-SEED on resume: a cold-restored snapshot keeps this object, but the
// glue may re-eval the env line; process.env stays a plain mutable object across hibernate.
(function(){
  var p = globalThis.process;
  if (!p || typeof p !== 'object') { p = {}; globalThis.process = p; }
  // env: plain object; seed from the glue-provided __processEnv (config/ctx) when present.
  if (!p.env || typeof p.env !== 'object') {
    p.env = (globalThis.__processEnv && typeof globalThis.__processEnv === 'object') ? globalThis.__processEnv : {};
  }
  p.argv = ['node', 'repl'];
  p.argv0 = 'node';
  p.execPath = '/usr/local/bin/node';
  p.execArgv = [];
  p.pid = 1; p.ppid = 0;
  p.platform = 'linux';
  p.arch = 'x64';
  p.version = 'v20.11.1';
  p.versions = { node: '20.11.1', v8: '11.3.244.8-node.17', uv: '1.46.0', zlib: '1.2.13.1-motley', quickjs: '1', engram: '1', modules: '115', openssl: '3.0.12+quic' };
  p.release = { name: 'node', sourceUrl: '', headersUrl: '', lts: 'Iron' };
  p.title = 'node';
  p.allowedNodeEnvironmentFlags = (typeof Set !== 'undefined') ? new Set() : { has: function(){ return false; } };
  p.config = { target_defaults: {}, variables: {} };
  p.features = { inspector: false, debug: false, uv: true, ipv6: true, tls: false, cached_builtins: true };
  p.cwd = function(){ return globalThis.__cwd || '/'; };
  p.chdir = function(d){ globalThis.__cwd = (typeof d === 'string' && d) ? d : '/'; };
  p.umask = function(){ return 0; };
  p.getuid = function(){ return 0; }; p.getgid = function(){ return 0; };
  p.geteuid = function(){ return 0; }; p.getegid = function(){ return 0; };
  p.memoryUsage = function(){ return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }; };
  p.memoryUsage.rss = function(){ return 0; };
  p.cpuUsage = function(){ return { user: 0, system: 0 }; };
  p.resourceUsage = function(){ return {}; };
  p.nextTick = function(f){ var a = Array.prototype.slice.call(arguments, 1); queueMicrotask(function(){ if (typeof f === 'function') f.apply(null, a); }); };
  // hrtime: [seconds, nanoseconds] from the SEEDED clock (ms granularity → ns is zero-padded).
  // hrtime(prev) returns the delta. hrtime.bigint() returns nanoseconds as a BigInt.
  function __nowMs(){ try { return Date.now(); } catch(e){ return 0; } }
  p.hrtime = function(prev){ var ms = __nowMs(); var s = Math.floor(ms / 1000); var ns = (ms % 1000) * 1e6; if (prev && prev.length === 2){ var ds = s - prev[0], dn = ns - prev[1]; if (dn < 0){ ds -= 1; dn += 1e9; } return [ds, dn]; } return [s, ns]; };
  p.hrtime.bigint = function(){ try { return BigInt(__nowMs()) * 1000000n; } catch(e){ return 0n; } };
  // uptime: seconds since the FIRST hrtime/uptime observation (seeded clock).
  globalThis.__procT0 = (globalThis.__procT0 === undefined) ? __nowMs() : globalThis.__procT0;
  p.uptime = function(){ return (__nowMs() - globalThis.__procT0) / 1000; };
  // exit(code): throws a CATCHABLE ProcessExit (does NOT terminate the kernel — there is no real
  // process). The cell sees an Error with .code; outer harness logic that relied on a hard exit
  // instead gets a recoverable throw. exitCode is recorded for libraries that read it.
  function ProcessExit(code){ var e = new Error('process.exit(' + (code|0) + ') called'); e.name = 'ProcessExit'; e.code = code|0; e.processExit = true; return e; }
  p.exit = function(code){ if (code !== undefined) p.exitCode = code|0; throw ProcessExit(code === undefined ? (p.exitCode|0) : code); };
  p.exitCode = 0;
  p.abort = function(){ throw ProcessExit(134); };
  p.kill = function(){ return true; }; // no real process to signal; report success.
  // EventEmitter-ish on/once/off for 'exit'/'uncaughtException'/'warning'/'beforeExit' etc.
  // These are stored but, by the determinism/snapshot model, NOT auto-fired by the runtime (there
  // is no real process lifecycle). A cell may emit() them manually. Listeners are kept on the heap.
  p._ev = p._ev || {};
  p.on = function(ev, fn){ (p._ev[ev] = p._ev[ev] || []).push(fn); return p; };
  p.addListener = p.on;
  p.once = function(ev, fn){ var g = function(){ p.off(ev, g); return fn.apply(this, arguments); }; g.listener = fn; return p.on(ev, g); };
  p.off = function(ev, fn){ if (p._ev[ev]) p._ev[ev] = p._ev[ev].filter(function(g){ return g !== fn && g.listener !== fn; }); return p; };
  p.removeListener = p.off;
  p.removeAllListeners = function(ev){ if (ev === undefined) p._ev = {}; else delete p._ev[ev]; return p; };
  p.listeners = function(ev){ return (p._ev[ev] || []).slice(); };
  p.listenerCount = function(ev){ return (p._ev[ev] || []).length; };
  p.emit = function(ev){ var a = Array.prototype.slice.call(arguments, 1); var ls = p._ev[ev]; if (!ls || !ls.length) return false; ls.slice().forEach(function(f){ try { f.apply(p, a); } catch(e){} }); return true; };
  p.prependListener = p.on; p.eventNames = function(){ return Object.keys(p._ev); };
  p.setMaxListeners = function(){ return p; }; p.getMaxListeners = function(){ return 10; };
  p.emitWarning = function(w){ try { console.warn('Warning: ' + (w && w.message ? w.message : w)); } catch(e){} };
  // stdout/stderr: write-only sinks routed to console (the only output channel). isTTY=false.
  function mkStream(level){ return { write: function(chunk){ try { var s = (chunk instanceof Uint8Array) ? new TextDecoder().decode(chunk) : String(chunk); s = s.replace(/\n$/, ''); if (s.length) console[level](s); } catch(e){} return true; }, end: function(){}, on: function(){ return this; }, once: function(){ return this; }, isTTY: false, fd: level === 'error' ? 2 : 1, columns: 80, rows: 24, cork: function(){}, uncork: function(){}, setDefaultEncoding: function(){ return this; } }; }
  p.stdout = mkStream('log');
  p.stderr = mkStream('error');
  p.stdin = { read: function(){ return null; }, on: function(){ return this; }, once: function(){ return this; }, resume: function(){ return this; }, pause: function(){ return this; }, setEncoding: function(){ return this; }, pipe: function(d){ return d; }, isTTY: false, fd: 0 };
  p.binding = function(){ throw new Error("process.binding is not supported in this sandbox"); };
  p.hasUncaughtExceptionCaptureCallback = function(){ return false; };
})();
// Timers — IMMEDIATE semantics. setTimeout/setImmediate fire on the microtask queue and IGNORE
// the delay, so they complete WITHIN the cell's settle drain — deterministic and hibernation-safe
// (no timer ever spans a snapshot). setInterval is a NO-OP (a real repeating timer can't survive
// the determinism/snapshot model; an immediate self-loop would hang). This unblocks the large set
// of bundles that reference setTimeout for deferral. CAVEAT: `setTimeout(fn, 1000)` runs ~now, not
// after 1s — there are no wall-clock timers in the sandbox.
if (typeof globalThis.setTimeout === 'undefined') {
  var __tid = 1; var __tcancel = {};
  globalThis.setTimeout = function(f){ var a = Array.prototype.slice.call(arguments, 2); var id = __tid++; queueMicrotask(function(){ if (__tcancel[id]) { delete __tcancel[id]; return; } if (typeof f === 'function') f.apply(null, a); }); return id; };
  globalThis.clearTimeout = function(id){ __tcancel[id] = true; };
  globalThis.setImmediate = function(f){ var a = Array.prototype.slice.call(arguments, 1); var id = __tid++; queueMicrotask(function(){ if (typeof f === 'function') f.apply(null, a); }); return id; };
  globalThis.clearImmediate = function(){};
  globalThis.setInterval = function(){ return __tid++; };   // no-op: no repeating timers
  globalThis.clearInterval = function(){};
}
// base64<->bytes helpers shared by fetch, Response/Request/Blob bodies, and FormData.
(function(){
  function __b64ToBytes(b64){ var bin = atob(b64 || ''); var out = new Uint8Array(bin.length); for (var i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i); return out; }
  function __bytesToB64(u8){ var s = '', CH = 0x8000; for (var i=0;i<u8.length;i+=CH){ s += String.fromCharCode.apply(null, u8.subarray(i, i+CH)); } return btoa(s); }
  globalThis.__fetchB64 = { enc: __bytesToB64, dec: __b64ToBytes };
})();

// ===== WAVE 4 — REAL WHATWG fetch types (Blob/FormData/AbortController/AbortSignal/Request/
//        Response) + fetch() resolving to a real Response over the binary-safe host.fetch. =====
// The fetch idiom `const r = await fetch(u); if (r.ok) return r.json()` now works against a true
// Response instance (instanceof Response, .clone(), .blob(), Headers, AbortController). Bytes still
// cross the JSON host boundary as base64 (`bodyB64`) exactly as before, so git packfiles / PDFs are
// byte-exact. BACKWARD-COMPAT: the prior plain-object shape (ok/status/statusText/url/headers +
// .arrayBuffer()/.bytes()/.text()/.json()) is a strict subset of the Response surface, so existing
// code doing `await (await fetch(u)).arrayBuffer()` / `.json()` is unchanged. Pure in-VM,
// snapshot-persisted, deterministic (no host entropy; abort uses the same microtask model).
(function(){
  var ENC = new TextEncoder(), DEC = new TextDecoder(), B64 = globalThis.__fetchB64;

  // ---- Blob ----
  function Blob(parts, opts){
    opts = opts || {};
    var chunks = [];
    if (parts && typeof parts[Symbol.iterator] === 'function'){
      for (var part of parts){
        if (part instanceof Blob) chunks.push(part._bytes());
        else if (part instanceof Uint8Array) chunks.push(part.slice());
        else if (part instanceof ArrayBuffer) chunks.push(new Uint8Array(part.slice(0)));
        else if (part && part.buffer instanceof ArrayBuffer) chunks.push(new Uint8Array(part.buffer.slice(part.byteOffset||0, (part.byteOffset||0)+part.byteLength)));
        else chunks.push(ENC.encode(String(part)));
      }
    }
    var total = 0, i; for (i=0;i<chunks.length;i++) total += chunks[i].length;
    var all = new Uint8Array(total), off = 0; for (i=0;i<chunks.length;i++){ all.set(chunks[i], off); off += chunks[i].length; }
    this._buf = all;
    this.size = all.length;
    this.type = opts.type ? String(opts.type).toLowerCase() : '';
  }
  Blob.prototype._bytes = function(){ return this._buf; };
  Blob.prototype.arrayBuffer = function(){ var b = this._buf; return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  Blob.prototype.bytes = function(){ return Promise.resolve(this._buf.slice()); };
  Blob.prototype.text = function(){ var self = this; return Promise.resolve(DEC.decode(self._buf)); };
  Blob.prototype.slice = function(start, end, type){ var len = this.size; var s = start === undefined ? 0 : (start < 0 ? Math.max(len + start, 0) : Math.min(start, len)); var e = end === undefined ? len : (end < 0 ? Math.max(len + end, 0) : Math.min(end, len)); var sub = this._buf.subarray(s, Math.max(s, e)); var b = new Blob([], { type: type || '' }); b._buf = sub.slice(); b.size = b._buf.length; return b; };
  Blob.prototype.stream = function(){ var self = this; if (globalThis.__builtins && globalThis.__builtins.stream){ var rd = new globalThis.__builtins.stream.Readable({ read: function(){} }); queueMicrotask(function(){ rd.push(self._buf.slice()); rd.push(null); }); return rd; } throw new Error('Blob.stream requires the stream module'); };
  globalThis.Blob = globalThis.Blob || Blob;
  function File(parts, name, opts){ Blob.call(this, parts, opts); this.name = String(name); this.lastModified = (opts && opts.lastModified) || 0; }
  File.prototype = Object.create(Blob.prototype); File.prototype.constructor = File;
  globalThis.File = globalThis.File || File;

  // ---- FormData ----
  function FormData(){ this._l = []; }
  function toEntryVal(v, filename){ if (v instanceof Blob) { if (filename !== undefined && !(v instanceof File)){ var f = new File([v._bytes()], filename, { type: v.type }); return f; } return v; } return String(v); }
  FormData.prototype.append = function(name, value, filename){ this._l.push([String(name), toEntryVal(value, filename)]); };
  FormData.prototype.set = function(name, value, filename){ name = String(name); var done = false; this._l = this._l.filter(function(p){ if (p[0] === name){ if (!done){ p[1] = toEntryVal(value, filename); done = true; return true; } return false; } return true; }); if (!done) this._l.push([name, toEntryVal(value, filename)]); };
  FormData.prototype.get = function(name){ name = String(name); for (var i=0;i<this._l.length;i++) if (this._l[i][0] === name) return this._l[i][1]; return null; };
  FormData.prototype.getAll = function(name){ name = String(name); return this._l.filter(function(p){ return p[0] === name; }).map(function(p){ return p[1]; }); };
  FormData.prototype.has = function(name){ name = String(name); return this._l.some(function(p){ return p[0] === name; }); };
  FormData.prototype.delete = function(name){ name = String(name); this._l = this._l.filter(function(p){ return p[0] !== name; }); };
  FormData.prototype.forEach = function(cb, t){ this._l.forEach(function(p){ cb.call(t, p[1], p[0], this); }, this); };
  FormData.prototype.keys = function(){ return this._l.map(function(p){ return p[0]; })[Symbol.iterator](); };
  FormData.prototype.values = function(){ return this._l.map(function(p){ return p[1]; })[Symbol.iterator](); };
  FormData.prototype.entries = function(){ return this._l.map(function(p){ return [p[0], p[1]]; })[Symbol.iterator](); };
  FormData.prototype[Symbol.iterator] = FormData.prototype.entries;
  globalThis.FormData = globalThis.FormData || FormData;

  // ---- AbortSignal / AbortController ----
  // Determinism: timeout() fires on the microtask queue (immediate, like setTimeout in this VM) —
  // there is no wall clock, so AbortSignal.timeout(ms) aborts ~now, not after ms. aborted/reason
  // and the 'abort' event work so fetch({signal}) rejects with the reason.
  function AbortSignal(){ this.aborted = false; this.reason = undefined; this._cbs = []; this.onabort = null; }
  AbortSignal.prototype.addEventListener = function(type, cb){ if (type === 'abort' && typeof cb === 'function') this._cbs.push(cb); };
  AbortSignal.prototype.removeEventListener = function(type, cb){ if (type === 'abort') this._cbs = this._cbs.filter(function(f){ return f !== cb; }); };
  AbortSignal.prototype.dispatchEvent = function(ev){ var self = this; this._cbs.slice().forEach(function(f){ try { f.call(self, ev); } catch(e){} }); if (typeof this.onabort === 'function'){ try { this.onabort.call(this, ev); } catch(e){} } return true; };
  AbortSignal.prototype.throwIfAborted = function(){ if (this.aborted) throw this.reason; };
  function __abort(sig, reason){ if (sig.aborted) return; sig.aborted = true; sig.reason = (reason !== undefined) ? reason : (function(){ var e = new Error('The operation was aborted.'); e.name = 'AbortError'; return e; })(); sig.dispatchEvent({ type: 'abort', target: sig }); }
  AbortSignal.abort = function(reason){ var s = new AbortSignal(); s.aborted = true; s.reason = (reason !== undefined) ? reason : (function(){ var e = new Error('The operation was aborted.'); e.name = 'AbortError'; return e; })(); return s; };
  AbortSignal.timeout = function(){ var s = new AbortSignal(); queueMicrotask(function(){ var e = new Error('The operation timed out.'); e.name = 'TimeoutError'; __abort(s, e); }); return s; };
  AbortSignal.any = function(signals){ var out = new AbortSignal(); var arr = Array.from(signals || []); for (var i=0;i<arr.length;i++){ var s = arr[i]; if (s && s.aborted){ out.aborted = true; out.reason = s.reason; return out; } } arr.forEach(function(s){ if (s && typeof s.addEventListener === 'function') s.addEventListener('abort', function(){ __abort(out, s.reason); }); }); return out; };
  globalThis.AbortSignal = globalThis.AbortSignal || AbortSignal;
  function AbortController(){ this.signal = new (globalThis.AbortSignal || AbortSignal)(); }
  AbortController.prototype.abort = function(reason){ __abort(this.signal, reason); };
  globalThis.AbortController = globalThis.AbortController || AbortController;
  globalThis.__abortSignal = __abort; // internal: used by fetch to honour an aborting signal.

  // ---- Body mixin (shared by Request + Response): bytes/arrayBuffer/text/json/blob/formData ----
  function bodyToBytes(body){
    if (body == null) return new Uint8Array(0);
    if (typeof body === 'string') return ENC.encode(body);
    if (body instanceof Uint8Array) return body.slice();
    if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
    if (body && body.buffer instanceof ArrayBuffer && typeof body.byteLength === 'number') return new Uint8Array(body.buffer.slice(body.byteOffset||0, (body.byteOffset||0)+body.byteLength));
    if (globalThis.Blob && body instanceof globalThis.Blob) return body._bytes().slice();
    if (globalThis.URLSearchParams && body instanceof globalThis.URLSearchParams) return ENC.encode(body.toString());
    if (globalThis.FormData && body instanceof globalThis.FormData){
      // multipart-ish flattening to urlencoded for the common JSON-API case (no real boundary).
      var usp = new globalThis.URLSearchParams(); body.forEach(function(v, k){ usp.append(k, (v instanceof Blob) ? '[blob]' : v); }); return ENC.encode(usp.toString());
    }
    return ENC.encode(String(body));
  }
  // contentType inferred from a body when the caller did not set one (WHATWG default).
  function inferContentType(body){
    if (typeof body === 'string') return 'text/plain;charset=UTF-8';
    if (globalThis.URLSearchParams && body instanceof globalThis.URLSearchParams) return 'application/x-www-form-urlencoded;charset=UTF-8';
    if (globalThis.Blob && body instanceof globalThis.Blob && body.type) return body.type;
    if (globalThis.FormData && body instanceof globalThis.FormData) return 'application/x-www-form-urlencoded;charset=UTF-8';
    return null;
  }
  function installBody(proto){
    proto.arrayBuffer = function(){ if (this.bodyUsed) return Promise.reject(new TypeError('Body has already been consumed.')); this.bodyUsed = true; var b = this._buf; return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
    proto.bytes = function(){ if (this.bodyUsed) return Promise.reject(new TypeError('Body has already been consumed.')); this.bodyUsed = true; return Promise.resolve(this._buf.slice()); };
    proto.text = function(){ if (this.bodyUsed) return Promise.reject(new TypeError('Body has already been consumed.')); this.bodyUsed = true; var self = this; return Promise.resolve(self._fullText ? self._fullText() : DEC.decode(self._buf)); };
    proto.json = function(){ return this.text().then(function(t){ return JSON.parse(t); }); };
    proto.blob = function(){ if (this.bodyUsed) return Promise.reject(new TypeError('Body has already been consumed.')); this.bodyUsed = true; var ct = (this.headers && this.headers.get && this.headers.get('content-type')) || ''; return Promise.resolve(new globalThis.Blob([this._buf.slice()], { type: ct })); };
    proto.formData = function(){ return this.text().then(function(t){ var fd = new globalThis.FormData(); var usp = new globalThis.URLSearchParams(t); usp.forEach(function(v, k){ fd.append(k, v); }); return fd; }); };
  }

  // ---- Request ----
  function Request(input, init){
    init = init || {};
    if (input instanceof Request){ this.url = input.url; this.method = init.method ? String(init.method).toUpperCase() : input.method; this._buf = (init.body != null) ? bodyToBytes(init.body) : input._buf.slice(); this.headers = new globalThis.Headers(init.headers || input.headers); this.signal = init.signal || input.signal || null; }
    else { this.url = String(input); this.method = init.method ? String(init.method).toUpperCase() : 'GET'; this._buf = bodyToBytes(init.body); this.headers = new globalThis.Headers(init.headers || {}); this.signal = init.signal || null; }
    this.bodyUsed = false;
    this.redirect = init.redirect || 'follow';
    this.credentials = init.credentials || 'same-origin';
    this.mode = init.mode || 'cors';
    this.cache = init.cache || 'default';
    this.referrer = init.referrer || 'about:client';
    this.integrity = init.integrity || '';
    if ((init.body != null || (input instanceof Request && input._buf.length)) && !this.headers.has('content-type')){ var ct = inferContentType(init.body != null ? init.body : null); if (ct) this.headers.set('content-type', ct); }
  }
  installBody(Request.prototype);
  Request.prototype.clone = function(){ var r = new Request(this.url, { method: this.method, headers: this.headers, signal: this.signal }); r._buf = this._buf.slice(); r.bodyUsed = false; return r; };
  globalThis.Request = globalThis.Request || Request;

  // ---- Response ----
  function Response(body, init){
    init = init || {};
    this.status = (init.status === undefined) ? 200 : (init.status|0);
    this.statusText = init.statusText !== undefined ? String(init.statusText) : '';
    this.headers = new globalThis.Headers(init.headers || {});
    this.ok = this.status >= 200 && this.status < 300;
    this.url = init.url || '';
    this.redirected = !!init.redirected;
    this.type = init.type || 'default';
    this.bodyUsed = false;
    // null body for 204/205/304 (per spec) — but accept any body otherwise.
    this._buf = (body == null) ? new Uint8Array(0) : bodyToBytes(body);
    if (body != null && !this.headers.has('content-type')){ var ct = inferContentType(body); if (ct) this.headers.set('content-type', ct); }
    // _fullText hook lets fetch() supply the host's utf8 preview when the body is complete.
    this._fullText = null;
  }
  installBody(Response.prototype);
  Object.defineProperty(Response.prototype, 'body', { get: function(){ var self = this; if (globalThis.__builtins && globalThis.__builtins.stream){ var rd = new globalThis.__builtins.stream.Readable({ read: function(){} }); queueMicrotask(function(){ rd.push(self._buf.slice()); rd.push(null); }); return rd; } return null; }, configurable: true });
  Response.prototype.clone = function(){ var r = new Response(this._buf.slice(), { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url, redirected: this.redirected, type: this.type }); r.bodyUsed = false; r._fullText = this._fullText; return r; };
  Response.json = function(data, init){ init = init || {}; var h = new globalThis.Headers(init.headers || {}); if (!h.has('content-type')) h.set('content-type', 'application/json'); var r = new Response(JSON.stringify(data), { status: init.status, statusText: init.statusText, headers: h }); return r; };
  Response.error = function(){ var r = new Response(null, { status: 0 }); r.type = 'error'; r.ok = false; return r; };
  Response.redirect = function(url, status){ status = status || 302; var r = new Response(null, { status: status }); r.headers.set('location', String(url)); return r; };
  globalThis.Response = globalThis.Response || Response;

  // ---- fetch(): resolve to a real Response over the binary-safe host.fetch bytes ----
  if (typeof globalThis.fetch === 'undefined' || !globalThis.__realFetch) {
    globalThis.fetch = function(input, init){
      // Accept a Request as the first arg (input.url + its method/headers/body/signal).
      var req = (input instanceof globalThis.Request) ? input : new globalThis.Request(input, init || {});
      var u = req.url;
      var signal = req.signal;
      // If already aborted, reject immediately with the reason.
      if (signal && signal.aborted) return Promise.reject(signal.reason || (function(){ var e = new Error('The operation was aborted.'); e.name = 'AbortError'; return e; })());
      // Build the host init: method, headers (plain object), and a binary-safe body (bodyB64).
      var hdrObj = {}; req.headers.forEach(function(v, k){ hdrObj[k] = v; });
      var sendInit = { method: req.method, headers: hdrObj };
      if (req._buf && req._buf.length){ sendInit.bodyB64 = B64.enc(req._buf); }
      else if (init && init.body != null && typeof init.body === 'string'){ sendInit.body = init.body; }
      var hostPromise = globalThis.host.fetch(u, sendInit).then(function(r){
        var _bytes = null;
        function bytes(){ if (_bytes) return _bytes; _bytes = (typeof r.bodyB64 === 'string') ? B64.dec(r.bodyB64) : ENC.encode(r.body || ''); return _bytes; }
        // r.body is a CAPPED utf8 PREVIEW (host truncates big bodies). Use it ONLY when it is the
        // WHOLE body (!r.bodyTruncated); else decode exact bytes from bodyB64 (so .text()/.json()
        // are never truncated). This preserves the prior fullText() semantics on the new Response.
        var resp = new globalThis.Response(bytes(), {
          status: r.status|0,
          statusText: r.statusText || '',
          headers: r.headers || {},
          url: r.url || u,
          redirected: !!r.redirected,
        });
        resp._fullText = function(){ return (typeof r.body === 'string' && !r.bodyTruncated) ? r.body : DEC.decode(bytes()); };
        return resp;
      });
      // Wire the signal: reject the fetch promise on abort (the host call resolves independently;
      // the abort just wins the race for the caller). Deterministic — abort fires on a microtask.
      if (signal){
        return new Promise(function(resolve, reject){
          var settled = false;
          signal.addEventListener('abort', function(){ if (!settled){ settled = true; reject(signal.reason || (function(){ var e = new Error('The operation was aborted.'); e.name = 'AbortError'; return e; })()); } });
          hostPromise.then(function(v){ if (!settled){ settled = true; resolve(v); } }, function(e){ if (!settled){ settled = true; reject(e); } });
        });
      }
      return hostPromise;
    };
    globalThis.__realFetch = true;
  }
})();
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

// Minimal Buffer over Uint8Array — many CJS bundles reference it at module scope. Subset:
// from / alloc / isBuffer / concat / toString(enc). NOT the full Node Buffer.
//
// CRITICAL for binary libs (isomorphic-git smart-HTTP parse): `Buffer.from(bytes).toString('utf8')`
// MUST utf8-decode, not Array-join the byte numbers. Since this Buffer is a real Uint8Array (the
// Node "Buffer is a Uint8Array subclass" model), we give Uint8Array.prototype an ENCODING-AWARE
// toString: with NO arg it keeps the default (engram value-preview/JSON unaffected); with an
// encoding ('utf8'/'utf-8'/'hex'/'base64'/'latin1'/'ascii') it decodes properly. Pure in-VM, no
// entropy.
if (typeof globalThis.Buffer === 'undefined') {
  var __U8P = Uint8Array.prototype;
  var __u8ToStringOrig = __U8P.toString;
  __U8P.toString = function(enc){
    if (enc === undefined || enc === null) return __u8ToStringOrig.apply(this, arguments);
    var e = String(enc).toLowerCase();
    if (e === 'utf8' || e === 'utf-8') return new TextDecoder().decode(this);
    if (e === 'hex'){ var h = ''; for (var i=0;i<this.length;i++) h += (this[i] + 0x100).toString(16).slice(1); return h; }
    if (e === 'base64'){ var s=''; for (var j=0;j<this.length;j++) s += String.fromCharCode(this[j]); return btoa(s); }
    if (e === 'latin1' || e === 'binary' || e === 'ascii'){ var t=''; for (var k=0;k<this.length;k++) t += String.fromCharCode(this[k] & (e==='ascii'?0x7f:0xff)); return t; }
    return new TextDecoder().decode(this);
  };
  // Buffer numeric read/write helpers (isomorphic-git's packfile parser uses readUInt32BE etc.).
  // Defined on Uint8Array.prototype so Buffer.from(bytes) (a Uint8Array) carries them. Big/little
  // endian via DataView over the same backing buffer (honour byteOffset).
  function __dv(u8){ return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  if (typeof __U8P.readUInt32BE !== 'function') {
    __U8P.readUInt32BE = function(o){ return __dv(this).getUint32(o|0, false); };
    __U8P.readUInt32LE = function(o){ return __dv(this).getUint32(o|0, true); };
    __U8P.readInt32BE  = function(o){ return __dv(this).getInt32(o|0, false); };
    __U8P.readUInt16BE = function(o){ return __dv(this).getUint16(o|0, false); };
    __U8P.readUInt16LE = function(o){ return __dv(this).getUint16(o|0, true); };
    __U8P.readUInt8    = function(o){ return this[o|0]; };
    __U8P.readInt32LE  = function(o){ return __dv(this).getInt32(o|0, true); };
    __U8P.writeUInt32BE = function(val, o){ __dv(this).setUint32(o|0, val>>>0, false); return (o|0)+4; };
    __U8P.writeUInt32LE = function(val, o){ __dv(this).setUint32(o|0, val>>>0, true); return (o|0)+4; };
    __U8P.writeInt32BE = function(val, o){ __dv(this).setInt32(o|0, val|0, false); return (o|0)+4; };
    __U8P.writeInt32LE = function(val, o){ __dv(this).setInt32(o|0, val|0, true); return (o|0)+4; };
    __U8P.writeUInt16BE = function(val, o){ __dv(this).setUint16(o|0, val&0xffff, false); return (o|0)+2; };
    __U8P.writeUInt16LE = function(val, o){ __dv(this).setUint16(o|0, val&0xffff, true); return (o|0)+2; };
    __U8P.writeUInt8    = function(val, o){ this[o|0] = val & 0xff; return (o|0)+1; };
    // ----- READ/WRITE MATRIX completion (binary-codec libs: protobuf/msgpack/image/audio) -----
    // 8/16/24/32-bit signed, float/double BE+LE, 64-bit BigInt/BigUInt, and the variable-length
    // readUIntBE/LE(off,len)/readIntBE/LE(off,len) family. All over a DataView honouring byteOffset.
    __U8P.readInt8     = function(o){ return __dv(this).getInt8(o|0); };
    __U8P.readInt16BE  = function(o){ return __dv(this).getInt16(o|0, false); };
    __U8P.readInt16LE  = function(o){ return __dv(this).getInt16(o|0, true); };
    __U8P.readFloatBE  = function(o){ return __dv(this).getFloat32(o|0, false); };
    __U8P.readFloatLE  = function(o){ return __dv(this).getFloat32(o|0, true); };
    __U8P.readDoubleBE = function(o){ return __dv(this).getFloat64(o|0, false); };
    __U8P.readDoubleLE = function(o){ return __dv(this).getFloat64(o|0, true); };
    __U8P.readBigInt64BE  = function(o){ return __dv(this).getBigInt64(o|0, false); };
    __U8P.readBigInt64LE  = function(o){ return __dv(this).getBigInt64(o|0, true); };
    __U8P.readBigUInt64BE = function(o){ return __dv(this).getBigUint64(o|0, false); };
    __U8P.readBigUInt64LE = function(o){ return __dv(this).getBigUint64(o|0, true); };
    // variable-length unsigned/signed (1..6 bytes); values <= 2^48 stay exact in a JS number.
    __U8P.readUIntBE = function(o, len){ o=o|0; len=len|0; var v=0; for (var i=0;i<len;i++) v = v*256 + this[o+i]; return v; };
    __U8P.readUIntLE = function(o, len){ o=o|0; len=len|0; var v=0, m=1; for (var i=0;i<len;i++){ v += this[o+i]*m; m*=256; } return v; };
    __U8P.readIntBE  = function(o, len){ var v = this.readUIntBE(o, len); var max = Math.pow(2, 8*len); return v >= max/2 ? v - max : v; };
    __U8P.readIntLE  = function(o, len){ var v = this.readUIntLE(o, len); var max = Math.pow(2, 8*len); return v >= max/2 ? v - max : v; };
    __U8P.writeInt8     = function(val, o){ __dv(this).setInt8(o|0, val|0); return (o|0)+1; };
    __U8P.writeInt16BE  = function(val, o){ __dv(this).setInt16(o|0, val|0, false); return (o|0)+2; };
    __U8P.writeInt16LE  = function(val, o){ __dv(this).setInt16(o|0, val|0, true); return (o|0)+2; };
    __U8P.writeFloatBE  = function(val, o){ __dv(this).setFloat32(o|0, +val, false); return (o|0)+4; };
    __U8P.writeFloatLE  = function(val, o){ __dv(this).setFloat32(o|0, +val, true); return (o|0)+4; };
    __U8P.writeDoubleBE = function(val, o){ __dv(this).setFloat64(o|0, +val, false); return (o|0)+8; };
    __U8P.writeDoubleLE = function(val, o){ __dv(this).setFloat64(o|0, +val, true); return (o|0)+8; };
    __U8P.writeBigInt64BE  = function(val, o){ __dv(this).setBigInt64(o|0, BigInt(val), false); return (o|0)+8; };
    __U8P.writeBigInt64LE  = function(val, o){ __dv(this).setBigInt64(o|0, BigInt(val), true); return (o|0)+8; };
    __U8P.writeBigUInt64BE = function(val, o){ __dv(this).setBigUint64(o|0, BigInt(val), false); return (o|0)+8; };
    __U8P.writeBigUInt64LE = function(val, o){ __dv(this).setBigUint64(o|0, BigInt(val), true); return (o|0)+8; };
    __U8P.writeUIntBE = function(val, o, len){ o=o|0; len=len|0; for (var i=len-1;i>=0;i--){ this[o+i]=val&0xff; val=Math.floor(val/256); } return o+len; };
    __U8P.writeUIntLE = function(val, o, len){ o=o|0; len=len|0; for (var i=0;i<len;i++){ this[o+i]=val&0xff; val=Math.floor(val/256); } return o+len; };
    __U8P.writeIntBE  = function(val, o, len){ if (val<0) val += Math.pow(2,8*len); return this.writeUIntBE(val, o, len); };
    __U8P.writeIntLE  = function(val, o, len){ if (val<0) val += Math.pow(2,8*len); return this.writeUIntLE(val, o, len); };
    // byte-swap in place (audio/network codecs flip endianness): 16/32/64-bit groups.
    __U8P.swap16 = function(){ for (var i=0;i<this.length;i+=2){ var t=this[i]; this[i]=this[i+1]; this[i+1]=t; } return this; };
    __U8P.swap32 = function(){ for (var i=0;i<this.length;i+=4){ var a=this[i],b=this[i+1]; this[i]=this[i+3]; this[i+3]=a; this[i+1]=this[i+2]; this[i+2]=b; } return this; };
    __U8P.swap64 = function(){ for (var i=0;i<this.length;i+=8){ for (var j=0;j<4;j++){ var t=this[i+j]; this[i+j]=this[i+7-j]; this[i+7-j]=t; } } return this; };
    // toJSON: Node Buffer serializes as { type:'Buffer', data:[...] } (libs round-trip via JSON).
    __U8P.toJSON = function(){ return { type: 'Buffer', data: Array.prototype.slice.call(this) }; };
    // indexOf/includes with a Buffer|string|byte needle + optional encoding (string-search libs).
    __U8P.includes = function(val, byteOffset, enc){ return this.indexOf(val, byteOffset, enc) !== -1; };
    var __U8indexOf = __U8P.indexOf;
    __U8P.indexOf = function(val, byteOffset, enc){
      if (typeof val === 'number') return __U8indexOf.call(this, val & 0xff, byteOffset|0);
      var needle = (typeof val === 'string') ? globalThis.Buffer.from(val, enc) : val;
      if (!needle || !needle.length) return (byteOffset|0);
      var start = byteOffset|0; if (start < 0) start = Math.max(0, this.length + start);
      for (var i=start;i<=this.length-needle.length;i++){ var m=true; for (var j=0;j<needle.length;j++){ if (this[i+j]!==needle[j]){ m=false; break; } } if (m) return i; }
      return -1;
    };
    // Buffer.copy(target, targetStart, sourceStart, sourceEnd)
    __U8P.copy = function(target, ts, ss, se){ ts = ts|0; ss = ss|0; se = (se === undefined) ? this.length : (se|0); var sub = this.subarray(ss, se); target.set(sub, ts); return sub.length; };
    __U8P.equals = function(other){ if (!other || this.length !== other.length) return false; for (var i=0;i<this.length;i++) if (this[i] !== other[i]) return false; return true; };
    // Buffer.write(string, [offset], [length], [encoding]) — write a string into the buffer at
    // offset; returns bytes written. Supports utf8 (default) + hex (isomorphic-git writes a hex
    // sha into a 20-byte buffer). NOTE: native Uint8Array has no `write`; this is the Buffer add-on.
    __U8P.write = function(str, offset, length, encoding){
      str = String(str);
      if (typeof offset === 'string'){ encoding = offset; offset = 0; length = undefined; }
      else if (typeof length === 'string'){ encoding = length; length = undefined; }
      offset = offset|0;
      var e = encoding ? String(encoding).toLowerCase() : 'utf8', src;
      if (e === 'hex'){ var hl = str.length >> 1; src = new Uint8Array(hl); for (var i=0;i<hl;i++) src[i] = parseInt(str.substr(i*2,2),16); }
      else if (e === 'base64'){ src = Uint8Array.from(atob(str), function(c){return c.charCodeAt(0);}); }
      else if (e === 'latin1' || e === 'binary' || e === 'ascii'){ src = new Uint8Array(str.length); for (var j=0;j<str.length;j++) src[j] = str.charCodeAt(j) & 0xff; }
      else src = new TextEncoder().encode(str);
      var max = (length === undefined) ? (this.length - offset) : Math.min(length|0, this.length - offset);
      var n = Math.min(src.length, max);
      this.set(src.subarray(0, n), offset);
      return n;
    };
  }
  // __B is ALSO callable as the legacy `Buffer(arg)` constructor (number -> alloc, else -> from):
  // safe-buffer's feature-detect (Buffer.from && .alloc && .allocUnsafe && .allocUnsafeSlow) must
  // pass, else it falls back to `Buffer(size)` legacy calls. We provide all four + legacy-callable.
  var __B = function(arg, a, b){ return (typeof arg === 'number') ? __B.alloc(arg) : __B.from(arg, a, b); };
  __B.from = function(v, enc, len){
    if (typeof v === 'string') {
      var e = enc ? String(enc).toLowerCase() : 'utf8';
      if (e === 'base64' || e === 'base64url'){ var s = (e === 'base64url') ? v.replace(/-/g,'+').replace(/_/g,'/') : v; return Uint8Array.from(atob(s), function(c){return c.charCodeAt(0);}); }
      if (e === 'hex'){ var out = new Uint8Array(v.length >> 1); for (var i=0;i<out.length;i++) out[i] = parseInt(v.substr(i*2,2),16); return out; }
      if (e === 'latin1' || e === 'binary' || e === 'ascii'){ var a = new Uint8Array(v.length); for (var j=0;j<v.length;j++) a[j] = v.charCodeAt(j) & 0xff; return a; }
      if (e === 'ucs2' || e === 'utf16le'){ var u = new Uint8Array(v.length*2); var dv = new DataView(u.buffer); for (var k=0;k<v.length;k++) dv.setUint16(k*2, v.charCodeAt(k), true); return u; }
      return new TextEncoder().encode(v);
    }
    if (v instanceof Uint8Array) return new Uint8Array(v); // copy, stays a Uint8Array
    if (v instanceof ArrayBuffer) return (enc === undefined) ? new Uint8Array(v) : new Uint8Array(v, enc|0, len === undefined ? undefined : len|0);
    if (v && v.type === 'Buffer' && Array.isArray(v.data)) return Uint8Array.from(v.data); // from a toJSON() round-trip
    return Uint8Array.from(v);
  };
  // Buffer.fill instance method (alloc + many libs zero/pattern-fill): number | string(+enc) | Buffer.
  if (typeof __U8P.fill !== 'function' || __U8P.fill === Uint8Array.prototype.fill) {
    var __u8FillOrig = __U8P.fill;
    __U8P.fill = function(val, start, end, enc){
      if (typeof val === 'number') return __u8FillOrig.call(this, val & 0xff, start|0, end === undefined ? this.length : end|0);
      if (typeof start === 'string'){ enc = start; start = 0; end = this.length; }
      else if (typeof end === 'string'){ enc = end; end = this.length; }
      start = start|0; end = (end === undefined) ? this.length : end|0;
      var src = (typeof val === 'string') ? globalThis.Buffer.from(val, enc) : val;
      if (!src || !src.length) return this;
      for (var i=start, j=0; i<end; i++, j++){ this[i] = src[j % src.length]; }
      return this;
    };
  }
  __B.alloc = function(n, fill, enc){ var a = new Uint8Array(n); if (fill !== undefined && fill !== 0) a.fill(fill, 0, n, enc); return a; };
  __B.allocUnsafe = function(n){ return new Uint8Array(n); };
  __B.allocUnsafeSlow = function(n){ return new Uint8Array(n); };
  __B.isBuffer = function(x){ return x instanceof Uint8Array; };
  __B.isEncoding = function(e){ return ['utf8','utf-8','hex','base64','base64url','latin1','binary','ascii','ucs2','utf16le'].indexOf(String(e).toLowerCase()) !== -1; };
  // Buffer.byteLength(string, encoding) — UTF-8 byte length (NOT .length char count); routers/HTTP
  // Content-Length and many parsers call this. hex/base64/latin1 have closed-form lengths.
  __B.byteLength = function(v, enc){
    if (v instanceof Uint8Array || v instanceof ArrayBuffer) return v.byteLength;
    var s = String(v), e = enc ? String(enc).toLowerCase() : 'utf8';
    if (e === 'hex') return s.length >> 1;
    if (e === 'base64' || e === 'base64url'){ var p = (s.match(/=*$/)||[''])[0].length; return Math.floor(s.replace(/=/g,'').length * 3 / 4); }
    if (e === 'latin1' || e === 'binary' || e === 'ascii') return s.length;
    return new TextEncoder().encode(s).length;
  };
  // Buffer.compare(a,b) -> -1|0|1 (sort + dedupe of binary keys).
  __B.compare = function(a, b){ var n = Math.min(a.length, b.length); for (var i=0;i<n;i++){ if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; } return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1); };
  __U8P.compare = function(other){ return globalThis.Buffer.compare(this, other); };
  // Buffer.concat(list, totalLength?) — pre-sized when totalLength given (saves a second pass).
  __B.concat = function(list, total){ var len, i; if (typeof total === 'number'){ len = total; } else { len = 0; for (i=0;i<list.length;i++) len += list[i].length; } var out = new Uint8Array(len), off = 0; for (i=0;i<list.length && off<len;i++){ var src = list[i]; if (off + src.length > len) src = src.subarray(0, len - off); out.set(src, off); off += src.length; } return out; };
  globalThis.Buffer = __B;
}

// Built-in module shims for require(). Deterministic: crypto routes through the already-seeded
// crypto.getRandomValues; nothing here adds entropy; no host round-trip; every shim is pure-JS in
// the snapshot-persisted heap (survives hibernate). These cover the common Node builtins that
// self-contained CJS bundles transitively pull in (stream is the keystone — readable-stream,
// through2, node-fetch, csv-parse, tar, got all require it).

// ===== events (full EventEmitter) =====
// on/once/emit/off/removeListener/removeAllListeners/listenerCount/listeners/rawListeners/
// prependListener/prependOnceListener/eventNames/setMaxListeners + static EventEmitter.once/listenerCount.
var __events = (function(){
  function EventEmitter(){ if (!this._e) this._e = Object.create(null); this._max = 10; }
  var EP = EventEmitter.prototype;
  function list(self,k){ return self._e[k] || (self._e[k] = []); }
  EP.on = function(k,f){ if (this._e === undefined) this._e = Object.create(null); this.emit && this._e['newListener'] && this.emit('newListener', k, f); list(this,k).push(f); return this; };
  EP.addListener = EP.on;
  EP.prependListener = function(k,f){ if (this._e === undefined) this._e = Object.create(null); list(this,k).unshift(f); return this; };
  EP.once = function(k,f){ var s=this; function g(){ s.removeListener(k,g); return f.apply(this, arguments); } g.listener = f; return this.on(k,g); };
  EP.prependOnceListener = function(k,f){ var s=this; function g(){ s.removeListener(k,g); return f.apply(this, arguments); } g.listener = f; return this.prependListener(k,g); };
  EP.removeListener = function(k,f){ if (!this._e || !this._e[k]) return this; this._e[k] = this._e[k].filter(function(g){ return g !== f && g.listener !== f; }); if (!this._e[k].length) delete this._e[k]; return this; };
  EP.off = EP.removeListener;
  EP.removeAllListeners = function(k){ if (k === undefined) { this._e = Object.create(null); } else { delete this._e[k]; } return this; };
  EP.emit = function(k){ var a = Array.prototype.slice.call(arguments,1); var ls = this._e && this._e[k]; if (!ls || !ls.length){ if (k === 'error') throw (a[0] instanceof Error ? a[0] : new Error('Unhandled error.' + (a[0]!==undefined?' ('+a[0]+')':''))); return false; } ls.slice().forEach(function(f){ f.apply(this, a); }, this); return true; };
  EP.listeners = function(k){ return (this._e && this._e[k] ? this._e[k].slice() : []).map(function(g){ return g.listener || g; }); };
  EP.rawListeners = function(k){ return this._e && this._e[k] ? this._e[k].slice() : []; };
  EP.listenerCount = function(k){ return this._e && this._e[k] ? this._e[k].length : 0; };
  EP.eventNames = function(){ return this._e ? Object.keys(this._e) : []; };
  EP.setMaxListeners = function(n){ this._max = n; return this; };
  EP.getMaxListeners = function(){ return this._max === undefined ? 10 : this._max; };
  // static once(emitter, name) -> Promise (resolves with the emitted args array). Determinism-safe:
  // resolves on a microtask via the emitter's own emit.
  EventEmitter.once = function(emitter, name){ return new Promise(function(res, rej){ function ok(){ emitter.removeListener('error', err); res(Array.prototype.slice.call(arguments)); } function err(e){ emitter.removeListener(name, ok); rej(e); } emitter.once(name, ok); if (name !== 'error') emitter.once('error', err); }); };
  EventEmitter.listenerCount = function(emitter, name){ return emitter.listenerCount(name); };
  EventEmitter.defaultMaxListeners = 10;
  EventEmitter.EventEmitter = EventEmitter;
  return EventEmitter;
})();

// ===== util (format/inspect/types/isDeepStrictEqual/promisify/callbackify/inherits/deprecate) =====
var __util = (function(){
  function inspect(x, opts){ var depth = (opts && typeof opts === 'object' && opts.depth !== undefined) ? (opts.depth === null ? 6 : opts.depth) : (typeof opts === 'number' ? opts : 2); return globalThis.__preview(x, depth); }
  // printf-style format: %s %d %i %f %j %o %O %c %%; extra args appended space-separated; %j -> JSON.
  function formatWithOptions(opts, f){
    var args = Array.prototype.slice.call(arguments, 2);
    if (typeof f !== 'string'){ var all = [f].concat(args); return all.map(function(a){ return typeof a === 'string' ? a : inspect(a, opts); }).join(' '); }
    var i = 0, str = String(f).replace(/%[sdifjoOc%]/g, function(m){
      if (m === '%%') return '%';
      if (i >= args.length) return m;
      var a = args[i++];
      switch (m){
        case '%s': return typeof a === 'bigint' ? a+'n' : (typeof a === 'object' && a !== null ? inspect(a, opts) : String(a));
        case '%d': case '%i': return typeof a === 'bigint' ? a+'n' : String(parseInt(a, 10));
        case '%f': return String(parseFloat(a));
        case '%j': try { return JSON.stringify(a); } catch(e){ return '[Circular]'; }
        case '%o': case '%O': return inspect(a, opts);
        case '%c': return '';
      }
      return m;
    });
    for (; i < args.length; i++){ var a = args[i]; str += ' ' + (typeof a === 'string' ? a : inspect(a, opts)); }
    return str;
  }
  function format(){ return formatWithOptions.apply(null, [undefined].concat(Array.prototype.slice.call(arguments))); }
  var types = {
    isTypedArray: function(x){ return ArrayBuffer.isView(x) && !(x instanceof DataView); },
    isUint8Array: function(x){ return x instanceof Uint8Array; },
    isDate: function(x){ return x instanceof Date; },
    isRegExp: function(x){ return x instanceof RegExp; },
    isMap: function(x){ return typeof Map !== 'undefined' && x instanceof Map; },
    isSet: function(x){ return typeof Set !== 'undefined' && x instanceof Set; },
    isWeakMap: function(x){ return typeof WeakMap !== 'undefined' && x instanceof WeakMap; },
    isWeakSet: function(x){ return typeof WeakSet !== 'undefined' && x instanceof WeakSet; },
    isPromise: function(x){ return typeof Promise !== 'undefined' && x instanceof Promise; },
    isAsyncFunction: function(x){ return typeof x === 'function' && x.constructor && x.constructor.name === 'AsyncFunction'; },
    isArrayBuffer: function(x){ return x instanceof ArrayBuffer; },
    isDataView: function(x){ return x instanceof DataView; },
    isProxy: function(){ return false; },
    isNativeError: function(x){ return x instanceof Error; },
    isBoxedPrimitive: function(x){ return x instanceof Number || x instanceof String || x instanceof Boolean; },
  };
  // isDeepStrictEqual — shared structural compare (also used by assert.deepStrictEqual).
  function isDeepStrictEqual(a, b){ return globalThis.__deepEqual(a, b, true); }
  function promisify(f){ if (f && f.__promisify_custom) return f.__promisify_custom; var fn = function(){ var a = Array.prototype.slice.call(arguments), s = this; return new Promise(function(res,rej){ a.push(function(e,v){ if (e) rej(e); else res(v); }); f.apply(s,a); }); }; return fn; }
  promisify.custom = Symbol.for('nodejs.util.promisify.custom');
  function callbackify(f){ return function(){ var a = Array.prototype.slice.call(arguments), cb = a.pop(), s = this; Promise.resolve(f.apply(s, a)).then(function(v){ cb(null, v); }, function(e){ cb(e == null ? new Error('Promise was rejected with falsy value') : e); }); }; }
  function inherits(c,p){ c.super_ = p; Object.setPrototypeOf(c.prototype, p.prototype); }
  function deprecate(fn, msg){ var warned = false; return function(){ if (!warned){ warned = true; try { console.warn('DeprecationWarning: ' + msg); } catch(e){} } return fn.apply(this, arguments); }; }
  return {
    format: format, formatWithOptions: formatWithOptions, inspect: inspect, types: types,
    isDeepStrictEqual: isDeepStrictEqual, promisify: promisify, callbackify: callbackify,
    inherits: inherits, deprecate: deprecate, debuglog: function(){ return function(){}; },
    TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
    isArray: Array.isArray, isBuffer: function(x){ return x instanceof Uint8Array; },
    isDeepEqual: isDeepStrictEqual,
  };
})();

// ===== shared structural deep-equal (Map/Set/Date/RegExp/typed-array/NaN/key-order-insensitive) =====
// Used by assert.deepStrictEqual + assert.deepEqual + util.isDeepStrictEqual. NOT JSON.stringify
// (which loses Map/Set/undefined/NaN/Symbol-key/cyclic + is key-order sensitive).
globalThis.__deepEqual = function(a, b, strict){
  var seen = new Map();
  function eq(a, b){
    if (a === b) return true;
    // NaN
    if (a !== a && b !== b) return true;
    if (typeof a !== typeof b){ if (strict) return false; }
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object'){
      return strict ? a === b : a == b;
    }
    // cycle guard
    if (seen.get(a) === b) return true;
    seen.set(a, b);
    if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
    if (a instanceof RegExp) return b instanceof RegExp && a.source === b.source && a.flags === b.flags;
    if (ArrayBuffer.isView(a) && !(a instanceof DataView)){
      if (!ArrayBuffer.isView(b) || a.length !== b.length) return false;
      for (var i=0;i<a.length;i++) if (a[i] !== b[i]) return false; return true;
    }
    if (a instanceof ArrayBuffer){ if (!(b instanceof ArrayBuffer) || a.byteLength !== b.byteLength) return false; var ua=new Uint8Array(a), ub=new Uint8Array(b); for (var j=0;j<ua.length;j++) if (ua[j]!==ub[j]) return false; return true; }
    if (typeof Map !== 'undefined' && a instanceof Map){ if (!(b instanceof Map) || a.size !== b.size) return false; var ok=true; a.forEach(function(v,k){ if (!b.has(k) || !eq(v, b.get(k))) ok=false; }); return ok; }
    if (typeof Set !== 'undefined' && a instanceof Set){ if (!(b instanceof Set) || a.size !== b.size) return false; var ok2=true; a.forEach(function(v){ if (!b.has(v)) ok2=false; }); return ok2; }
    if (Array.isArray(a) || Array.isArray(b)){ if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false; for (var x=0;x<a.length;x++) if (!eq(a[x], b[x])) return false; return true; }
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var y=0;y<ka.length;y++){ var k = ka[y]; if (!Object.prototype.hasOwnProperty.call(b, k)) return false; if (!eq(a[k], b[k])) return false; }
    return true;
  }
  return eq(a, b);
};

// ===== assert (structural; AssertionError; throws/rejects/doesNotThrow) =====
var __assert = (function(){
  function AssertionError(opts){ opts = opts || {}; var msg = opts.message || ((inspectShort(opts.actual)) + ' ' + (opts.operator||'') + ' ' + (inspectShort(opts.expected))); var e = new Error(msg); e.name = 'AssertionError'; e.code = 'ERR_ASSERTION'; e.actual = opts.actual; e.expected = opts.expected; e.operator = opts.operator; e.generatedMessage = !opts.message; return e; }
  function inspectShort(x){ try { return globalThis.__preview(x, 2); } catch(e){ return String(x); } }
  function fail(actual, expected, message, operator){ throw AssertionError({ actual: actual, expected: expected, message: typeof message === 'string' ? message : undefined, operator: operator }); }
  function assert(value, message){ if (!value) fail(value, true, message, '=='); }
  assert.ok = assert;
  assert.fail = function(message){ throw AssertionError({ message: typeof message === 'string' ? message : 'Failed', operator: 'fail' }); };
  assert.equal = function(a,b,m){ if (a != b) fail(a,b,m,'=='); };
  assert.notEqual = function(a,b,m){ if (a == b) fail(a,b,m,'!='); };
  assert.strictEqual = function(a,b,m){ if (!Object.is(a,b)) fail(a,b,m,'strictEqual'); };
  assert.notStrictEqual = function(a,b,m){ if (Object.is(a,b)) fail(a,b,m,'notStrictEqual'); };
  assert.deepEqual = function(a,b,m){ if (!globalThis.__deepEqual(a,b,false)) fail(a,b,m,'deepEqual'); };
  assert.notDeepEqual = function(a,b,m){ if (globalThis.__deepEqual(a,b,false)) fail(a,b,m,'notDeepEqual'); };
  assert.deepStrictEqual = function(a,b,m){ if (!globalThis.__deepEqual(a,b,true)) fail(a,b,m,'deepStrictEqual'); };
  assert.notDeepStrictEqual = function(a,b,m){ if (globalThis.__deepEqual(a,b,true)) fail(a,b,m,'notDeepStrictEqual'); };
  function matchErr(err, expected){
    if (expected === undefined) return true;
    if (typeof expected === 'function'){ if (expected === Error || (expected.prototype instanceof Error) || (Error.prototype.isPrototypeOf(expected.prototype))) return err instanceof expected; return !!expected(err); }
    if (expected instanceof RegExp) return expected.test(String(err && err.message !== undefined ? err.message : err));
    if (typeof expected === 'object'){ for (var k in expected){ if (err[k] !== expected[k] && !globalThis.__deepEqual(err[k], expected[k], true)) return false; } return true; }
    return true;
  }
  assert.throws = function(fn, expected, message){ var threw=false, caught; try { fn(); } catch(e){ threw=true; caught=e; } if (!threw) fail(undefined, expected, message || 'Missing expected exception', 'throws'); if (!matchErr(caught, expected)) throw caught; };
  assert.doesNotThrow = function(fn, expected, message){ try { fn(); } catch(e){ if (matchErr(e, expected)) fail(e, expected, message || 'Got unwanted exception', 'doesNotThrow'); throw e; } };
  assert.rejects = function(p, expected, message){ var pr = (typeof p === 'function') ? Promise.resolve().then(p) : Promise.resolve(p); return pr.then(function(){ fail(undefined, expected, message || 'Missing expected rejection', 'rejects'); }, function(e){ if (!matchErr(e, expected)) throw e; }); };
  assert.doesNotReject = function(p, expected, message){ var pr = (typeof p === 'function') ? Promise.resolve().then(p) : Promise.resolve(p); return pr.then(function(){}, function(e){ if (matchErr(e, expected)) fail(e, expected, message || 'Got unwanted rejection', 'doesNotReject'); throw e; }); };
  assert.match = function(s, re, m){ if (!re.test(s)) fail(s, re, m, 'match'); };
  assert.doesNotMatch = function(s, re, m){ if (re.test(s)) fail(s, re, m, 'doesNotMatch'); };
  assert.ifError = function(e){ if (e !== null && e !== undefined) throw (e instanceof Error ? e : AssertionError({ message: 'ifError got unwanted exception: ' + inspectShort(e), actual: e, operator: 'ifError' })); };
  assert.AssertionError = AssertionError;
  assert.strict = assert; // assert.strict.* maps to the strict variants (deepEqual===deepStrictEqual under strict)
  return assert;
})();

// ===== path (full posix; resolve/relative/isAbsolute/parse/format/normalize + path.posix) =====
var __path = (function(){
  function assertPath(p){ if (typeof p !== 'string') throw new TypeError('Path must be a string. Received ' + JSON.stringify(p)); }
  function normalizeArray(parts, allowAbove){ var up = 0, res = []; for (var i=parts.length-1;i>=0;i--){ var last = parts[i]; if (!last || last === '.') continue; if (last === '..'){ up++; } else if (up){ up--; } else { res.unshift(last); } } if (allowAbove){ for (; up--; up) res.unshift('..'); } return res; }
  function normalize(p){ assertPath(p); if (p.length === 0) return '.'; var isAbs = p.charCodeAt(0) === 47; var trailing = p.charCodeAt(p.length-1) === 47; p = normalizeArray(p.split('/'), !isAbs).join('/'); if (!p && !isAbs) p = '.'; if (p && trailing) p += '/'; return (isAbs ? '/' : '') + p; }
  function isAbsolute(p){ assertPath(p); return p.length > 0 && p.charCodeAt(0) === 47; }
  function join(){ if (arguments.length === 0) return '.'; var joined; for (var i=0;i<arguments.length;i++){ var arg = arguments[i]; assertPath(arg); if (arg.length > 0){ if (joined === undefined) joined = arg; else joined += '/' + arg; } } if (joined === undefined) return '.'; return normalize(joined); }
  function resolve(){ var resolvedPath = '', resolvedAbsolute = false; for (var i=arguments.length-1;i>=-1 && !resolvedAbsolute;i--){ var path = (i >= 0) ? arguments[i] : '/'; assertPath(path); if (path.length === 0) continue; resolvedPath = path + '/' + resolvedPath; resolvedAbsolute = path.charCodeAt(0) === 47; } resolvedPath = normalizeArray(resolvedPath.split('/'), !resolvedAbsolute).join('/'); if (resolvedAbsolute) return '/' + resolvedPath; return resolvedPath.length > 0 ? resolvedPath : '.'; }
  function relative(from, to){ assertPath(from); assertPath(to); if (from === to) return ''; from = resolve(from); to = resolve(to); if (from === to) return ''; var fromParts = from.split('/').filter(Boolean), toParts = to.split('/').filter(Boolean); var length = Math.min(fromParts.length, toParts.length), samePartsLength = length; for (var i=0;i<length;i++){ if (fromParts[i] !== toParts[i]){ samePartsLength = i; break; } } var outputParts = []; for (var j=samePartsLength;j<fromParts.length;j++) outputParts.push('..'); outputParts = outputParts.concat(toParts.slice(samePartsLength)); return outputParts.join('/'); }
  function dirname(p){ assertPath(p); if (p.length === 0) return '.'; var hadRoot = p.charCodeAt(0) === 47, end = -1, matchedSlash = true; for (var i=p.length-1;i>=1;i--){ if (p.charCodeAt(i) === 47){ if (!matchedSlash){ end = i; break; } } else { matchedSlash = false; } } if (end === -1) return hadRoot ? '/' : '.'; if (hadRoot && end === 1) return '//'; return p.slice(0, end); }
  function basename(p, ext){ assertPath(p); var start = 0, end = -1, matchedSlash = true, i; for (i=p.length-1;i>=0;i--){ if (p.charCodeAt(i) === 47){ if (!matchedSlash){ start = i+1; break; } } else if (end === -1){ matchedSlash = false; end = i+1; } } if (end === -1) return ''; var base = p.slice(start, end); if (ext && base.slice(-ext.length) === ext && base !== ext) base = base.slice(0, -ext.length); return base; }
  function extname(p){ assertPath(p); var startDot = -1, startPart = 0, end = -1, matchedSlash = true, preDotState = 0; for (var i=p.length-1;i>=0;i--){ var code = p.charCodeAt(i); if (code === 47){ if (!matchedSlash){ startPart = i+1; break; } continue; } if (end === -1){ matchedSlash = false; end = i+1; } if (code === 46){ if (startDot === -1) startDot = i; else if (preDotState !== 1) preDotState = 1; } else if (startDot !== -1){ preDotState = -1; } } if (startDot === -1 || end === -1 || preDotState === 0 || (preDotState === 1 && startDot === end-1 && startDot === startPart+1)) return ''; return p.slice(startDot, end); }
  function format(obj){ var dir = obj.dir || obj.root; var base = obj.base || ((obj.name || '') + (obj.ext || '')); if (!dir) return base; return dir === obj.root ? dir + base : dir + '/' + base; }
  function parse(p){ assertPath(p); var ret = { root: '', dir: '', base: '', ext: '', name: '' }; if (p.length === 0) return ret; var isAbs = p.charCodeAt(0) === 47; if (isAbs) ret.root = '/'; ret.base = basename(p); ret.ext = extname(p); ret.name = ret.base.slice(0, ret.base.length - ret.ext.length); var d = dirname(p); ret.dir = (d === '.' && !isAbs) ? '' : d; if (isAbs && ret.dir === '') ret.dir = '/'; return ret; }
  var posix = { sep: '/', delimiter: ':', normalize: normalize, isAbsolute: isAbsolute, join: join, resolve: resolve, relative: relative, dirname: dirname, basename: basename, extname: extname, format: format, parse: parse };
  posix.posix = posix; posix.win32 = posix;
  return posix;
})();

// ===== querystring (parse/stringify/escape/unescape/encode/decode) =====
var __querystring = (function(){
  function escape(s){ return encodeURIComponent(String(s)); }
  function unescape(s){ try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch(e){ return String(s); } }
  function stringify(obj, sep, eq){ sep = sep || '&'; eq = eq || '='; if (obj === null || typeof obj !== 'object') return ''; var keys = Object.keys(obj), out = []; for (var i=0;i<keys.length;i++){ var k = escape(keys[i]), v = obj[keys[i]]; if (Array.isArray(v)){ for (var j=0;j<v.length;j++) out.push(k + eq + escape(v[j])); } else { out.push(k + eq + escape(v === undefined || v === null ? '' : v)); } } return out.join(sep); }
  function parse(qs, sep, eq){ sep = sep || '&'; eq = eq || '='; var obj = {}; if (typeof qs !== 'string' || qs.length === 0) return obj; var parts = qs.split(sep); for (var i=0;i<parts.length;i++){ if (!parts[i]) continue; var idx = parts[i].indexOf(eq), k, v; if (idx < 0){ k = unescape(parts[i]); v = ''; } else { k = unescape(parts[i].slice(0, idx)); v = unescape(parts[i].slice(idx + eq.length)); } if (Object.prototype.hasOwnProperty.call(obj, k)){ if (Array.isArray(obj[k])) obj[k].push(v); else obj[k] = [obj[k], v]; } else obj[k] = v; } return obj; }
  return { parse: parse, stringify: stringify, escape: escape, unescape: unescape, encode: stringify, decode: parse };
})();

// ===== string_decoder (StringDecoder; UTF-8 multibyte-boundary buffering — needed by readable-stream) =====
var __string_decoder = (function(){
  function StringDecoder(encoding){ this.encoding = (encoding || 'utf8').toLowerCase(); this._dec = new TextDecoder('utf-8'); this._pending = new Uint8Array(0); }
  function toBytes(buf){ if (buf instanceof Uint8Array) return buf; if (buf instanceof ArrayBuffer) return new Uint8Array(buf); if (typeof buf === 'string') return new TextEncoder().encode(buf); return new Uint8Array(buf); }
  // find how many trailing bytes are an INCOMPLETE utf8 sequence (so we hold them for the next chunk).
  function incompleteTail(bytes){ var i = bytes.length - 1; if (i < 0) return 0; var needed = 0, seen = 0; while (i >= 0 && seen < 4){ var b = bytes[i]; seen++; if (b < 0x80) return 0; if ((b & 0xc0) === 0x80){ i--; continue; } if ((b & 0xe0) === 0xc0) needed = 2; else if ((b & 0xf0) === 0xe0) needed = 3; else if ((b & 0xf8) === 0xf0) needed = 4; else return 0; return seen < needed ? seen : 0; } return 0; }
  StringDecoder.prototype.write = function(buf){ var bytes = toBytes(buf); if (this.encoding === 'hex' || this.encoding === 'base64' || this.encoding === 'latin1' || this.encoding === 'binary' || this.encoding === 'ascii'){ return globalThis.Buffer.from(bytes).toString(this.encoding); } var joined = new Uint8Array(this._pending.length + bytes.length); joined.set(this._pending); joined.set(bytes, this._pending.length); var tail = incompleteTail(joined); var emit = tail ? joined.subarray(0, joined.length - tail) : joined; this._pending = tail ? joined.subarray(joined.length - tail).slice() : new Uint8Array(0); return this._dec.decode(emit); };
  StringDecoder.prototype.end = function(buf){ var out = buf !== undefined ? this.write(buf) : ''; if (this._pending.length){ out += this._dec.decode(this._pending); this._pending = new Uint8Array(0); } return out; };
  return { StringDecoder: StringDecoder };
})();

// ===== stream (THE keystone) — Readable/Writable/Duplex/Transform/PassThrough + pipeline/finished =====
// Pure-JS over arrays + microtask promises (determinism-safe: backpressure modelled on resolved
// promises/microtasks only, never wall-clock). objectMode + flowing/paused, .pipe(), the
// 'data'/'end'/'error'/'finish'/'close'/'drain' events, .write/.end/.read/.push. The single module
// the largest fraction of npm transitively requires (readable-stream, through2, node-fetch, csv-parse,
// tar, got) and the prerequisite for fs.createReadStream/createWriteStream later.
var __stream = (function(EventEmitter){
  function inheritsE(C){ Object.setPrototypeOf(C.prototype, EventEmitter.prototype); }
  function isU8(x){ return x instanceof Uint8Array; }

  function Readable(opts){ EventEmitter.call(this); opts = opts || {}; this._readableState = { buffer: [], flowing: null, ended: false, endEmitted: false, reading: false, objectMode: !!opts.objectMode, length: 0, errored: null, destroyed: false }; if (typeof opts.read === 'function') this._read = opts.read; }
  inheritsE(Readable);
  Readable.prototype._read = function(){};
  Readable.prototype.push = function(chunk){ var st = this._readableState; if (chunk === null){ st.ended = true; emitReadable(this); return false; } if (typeof chunk === 'string' && !st.objectMode) chunk = new TextEncoder().encode(chunk); st.buffer.push(chunk); st.length += (chunk && chunk.length) || 1; if (st.flowing) emitReadable(this); return true; };
  Readable.prototype.unshift = function(chunk){ var st = this._readableState; if (chunk === null) return; if (typeof chunk === 'string' && !st.objectMode) chunk = new TextEncoder().encode(chunk); st.buffer.unshift(chunk); st.length += (chunk && chunk.length) || 1; };
  Readable.prototype.read = function(){ var st = this._readableState; if (st.buffer.length){ st.length -= (st.buffer[0] && st.buffer[0].length) || 1; return st.buffer.shift(); } if (!st.reading && !st.ended){ st.reading = true; try { this._read(); } finally { st.reading = false; } if (st.buffer.length) return this.read(); } return null; };
  function emitReadable(self){ var st = self._readableState; queueMicrotask(function(){ flow(self); }); }
  function flow(self){ var st = self._readableState; if (st.destroyed) return; while (st.flowing && st.buffer.length){ var chunk = st.buffer.shift(); st.length -= (chunk && chunk.length) || 1; self.emit('data', chunk); } if (!st.reading && !st.ended && st.flowing){ st.reading = true; try { self._read(); } finally { st.reading = false; } if (st.buffer.length){ queueMicrotask(function(){ flow(self); }); return; } } if (st.ended && !st.buffer.length && !st.endEmitted){ st.endEmitted = true; self.emit('end'); self.emit('close'); } }
  Readable.prototype.resume = function(){ var st = this._readableState; st.flowing = true; emitReadable(this); return this; };
  Readable.prototype.pause = function(){ this._readableState.flowing = false; return this; };
  Readable.prototype.isPaused = function(){ return this._readableState.flowing === false; };
  Readable.prototype.on = Readable.prototype.addListener = function(ev, fn){ EventEmitter.prototype.on.call(this, ev, fn); if (ev === 'data'){ this._readableState.flowing = true; emitReadable(this); } return this; };
  Readable.prototype.pipe = function(dest, opts){ var self = this; opts = opts || {}; self.on('data', function(chunk){ var ok = dest.write(chunk); if (ok === false && typeof self.pause === 'function'){ self.pause(); dest.once('drain', function(){ self.resume(); }); } }); if (opts.end !== false){ self.on('end', function(){ dest.end(); }); } self.on('error', function(e){ dest.emit('error', e); }); dest.emit('pipe', self); self.resume(); return dest; };
  Readable.prototype.unpipe = function(){ return this; };
  Readable.prototype.destroy = function(err){ var st = this._readableState; if (st.destroyed) return this; st.destroyed = true; var self = this; queueMicrotask(function(){ if (err) self.emit('error', err); self.emit('close'); }); return this; };
  Readable.prototype.setEncoding = function(enc){ this._readableState.encoding = enc; return this; };
  // async-iterator: for await (const chunk of readable) — settles on microtasks.
  Readable.prototype[Symbol.asyncIterator] = function(){ var self = this, st = self._readableState; var done = false, error = null, waiting = null; self.on('end', function(){ done = true; if (waiting){ waiting.resolve({ done: true, value: undefined }); waiting = null; } }); self.on('error', function(e){ error = e; if (waiting){ waiting.reject(e); waiting = null; } }); self.on('data', function(chunk){ if (waiting){ waiting.resolve({ done: false, value: chunk }); waiting = null; } else { st.buffer.push(chunk); } }); self.resume(); return { next: function(){ if (error) return Promise.reject(error); if (st.buffer.length){ var c = st.buffer.shift(); return Promise.resolve({ done: false, value: c }); } if (done) return Promise.resolve({ done: true, value: undefined }); return new Promise(function(resolve, reject){ waiting = { resolve: resolve, reject: reject }; }); }, return: function(){ done = true; return Promise.resolve({ done: true, value: undefined }); }, [Symbol.asyncIterator]: function(){ return this; } }; };
  Readable.from = function(iterable, opts){ var r = new Readable(Object.assign({ objectMode: true }, opts)); r._read = function(){}; Promise.resolve().then(async function(){ try { if (iterable && typeof iterable[Symbol.asyncIterator] === 'function'){ for await (var c of iterable) r.push(c); } else { var arr = Array.from(iterable); for (var i=0;i<arr.length;i++) r.push(arr[i]); } r.push(null); } catch(e){ r.destroy(e); } }); return r; };

  function Writable(opts){ EventEmitter.call(this); opts = opts || {}; this._writableState = { ended: false, finished: false, objectMode: !!opts.objectMode, needDrain: false, writing: false, buffered: [], destroyed: false, corked: 0 }; if (typeof opts.write === 'function') this._write = opts.write; if (typeof opts.final === 'function') this._final = opts.final; }
  inheritsE(Writable);
  Writable.prototype._write = function(chunk, enc, cb){ cb(); };
  Writable.prototype.write = function(chunk, enc, cb){ var st = this._writableState, self = this; if (typeof enc === 'function'){ cb = enc; enc = undefined; } if (st.ended){ var e = new Error('write after end'); if (cb) cb(e); else self.emit('error', e); return false; } if (typeof chunk === 'string' && !st.objectMode) chunk = new TextEncoder().encode(chunk); st.writing = true; var done = function(err){ st.writing = false; if (err){ if (cb) cb(err); self.emit('error', err); return; } if (cb) cb(); if (st.needDrain){ st.needDrain = false; self.emit('drain'); } }; try { this._write(chunk, enc, done); } catch(e){ done(e); } return true; };
  Writable.prototype.cork = function(){ this._writableState.corked++; };
  Writable.prototype.uncork = function(){ if (this._writableState.corked) this._writableState.corked--; };
  Writable.prototype.setDefaultEncoding = function(){ return this; };
  Writable.prototype.end = function(chunk, enc, cb){ var st = this._writableState, self = this; if (typeof chunk === 'function'){ cb = chunk; chunk = undefined; } else if (typeof enc === 'function'){ cb = enc; enc = undefined; } if (chunk !== undefined && chunk !== null) this.write(chunk, enc); st.ended = true; var finish = function(){ if (st.finished) return; st.finished = true; if (cb) cb(); self.emit('finish'); self.emit('close'); }; if (typeof this._final === 'function'){ this._final(function(){ finish(); }); } else { queueMicrotask(finish); } return this; };
  Writable.prototype.destroy = function(err){ var st = this._writableState; if (st.destroyed) return this; st.destroyed = true; var self = this; queueMicrotask(function(){ if (err) self.emit('error', err); self.emit('close'); }); return this; };

  // Duplex: a Readable that is also Writable (compose both states + both method sets).
  function Duplex(opts){ Readable.call(this, opts); Writable.call(this, opts); }
  Object.setPrototypeOf(Duplex.prototype, Readable.prototype);
  ['_write','write','cork','uncork','setDefaultEncoding','_final'].forEach(function(m){ if (Writable.prototype[m]) Duplex.prototype[m] = Writable.prototype[m]; });
  Duplex.prototype.end = Writable.prototype.end;
  Duplex.prototype._writableState = undefined;

  // Transform: writes go through _transform(chunk, enc, cb) and are pushed to the readable side.
  function Transform(opts){ Duplex.call(this, opts); var self = this; if (opts && typeof opts.transform === 'function') this._transform = opts.transform; if (opts && typeof opts.flush === 'function') this._flush = opts.flush; }
  Object.setPrototypeOf(Transform.prototype, Duplex.prototype);
  Transform.prototype._transform = function(chunk, enc, cb){ cb(null, chunk); };
  Transform.prototype._write = function(chunk, enc, cb){ var self = this; this._transform(chunk, enc, function(err, data){ if (err){ cb(err); return; } if (data !== undefined && data !== null) self.push(data); cb(); }); };
  Transform.prototype.end = function(chunk, enc, cb){ var self = this; var origEnd = function(){ if (typeof self._flush === 'function'){ self._flush(function(err, data){ if (data !== undefined && data !== null) self.push(data); self.push(null); }); } else { self.push(null); } }; if (typeof chunk === 'function'){ cb = chunk; chunk = undefined; } else if (typeof enc === 'function'){ cb = enc; enc = undefined; } if (chunk !== undefined && chunk !== null){ this.write(chunk, enc); } this._writableState.ended = true; queueMicrotask(function(){ origEnd(); if (cb) cb(); self.emit('finish'); }); return this; };

  function PassThrough(opts){ Transform.call(this, opts); }
  Object.setPrototypeOf(PassThrough.prototype, Transform.prototype);
  PassThrough.prototype._transform = function(chunk, enc, cb){ cb(null, chunk); };

  // finished(stream, cb) -> resolves/calls back when stream ends/finishes/errors/closes.
  function finished(stream, optsOrCb, maybeCb){ var cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb; var promise; if (!cb){ promise = new Promise(function(res, rej){ cb = function(err){ err ? rej(err) : res(); }; }); } var called = false; function done(err){ if (called) return; called = true; cb(err); } stream.on('error', done); stream.on('end', function(){ done(); }); stream.on('finish', function(){ done(); }); stream.on('close', function(){ done(); }); return promise; }

  // pipeline(...streams, cb?) -> wire src.pipe(next)...; resolve/callback on terminal finish/error.
  function pipeline(){ var streams = Array.prototype.slice.call(arguments); var cb = (typeof streams[streams.length-1] === 'function') ? streams.pop() : null; var promise; if (!cb){ promise = new Promise(function(res, rej){ cb = function(err, val){ err ? rej(err) : res(val); }; }); } var destroyed = false; function fail(err){ if (destroyed) return; destroyed = true; streams.forEach(function(s){ if (s && typeof s.destroy === 'function') s.destroy(); }); cb(err); } for (var i=0;i<streams.length;i++){ (function(s){ if (s && typeof s.on === 'function') s.on('error', fail); })(streams[i]); } for (var j=0;j<streams.length-1;j++){ streams[j].pipe(streams[j+1]); } var last = streams[streams.length-1]; finished(last, function(err){ if (err) fail(err); else if (!destroyed){ destroyed = true; cb(null); } }); return promise; }

  var Stream = Readable; // require('stream') default export is also the legacy Stream base
  var api = { Readable: Readable, Writable: Writable, Duplex: Duplex, Transform: Transform, PassThrough: PassThrough, Stream: Stream, pipeline: pipeline, finished: finished, promises: { pipeline: pipeline, finished: finished } };
  api.Stream = function Stream(){ Readable.call(this); };
  Object.setPrototypeOf(api.Stream.prototype, EventEmitter.prototype);
  Object.assign(api.Stream, api);
  return api;
})(__events);

// ===== crypto (node:crypto) — randomBytes/randomFillSync/getRandomValues/randomUUID/randomInt +
//        createHash(sha256|sha1|md5) + createHmac + scryptSync. Reuses globalThis.__hashes. =====
// SHADOW-SAFETY (ADR crypto-shadow): the SEEDED entropy primitive is captured ONCE here as
// `__seededRandom` straight off globalThis.crypto.getRandomValues at bootstrap. Every method below
// uses that captured ref — NEVER `globalThis.crypto.getRandomValues` at call time. So even if a
// later cell reassigns globalThis.crypto (e.g. `globalThis.crypto = require('crypto')`), the shim's
// getRandomValues can never resolve to ITSELF → no infinite recursion / stack overflow. (The REPL
// transform additionally keeps `const crypto = require('crypto')` cell-local so it doesn't clobber
// globalThis.crypto at all; this capture is belt-and-suspenders for a manual global reassign.)
var __crypto = (function(){
  var __seededRandom = (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function')
    ? globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    : function(a){ for (var i=0;i<a.length;i++) a[i] = (globalThis.__rand() * 256) & 0xff; return a; };
  var __seededUUID = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
    ? globalThis.crypto.randomUUID.bind(globalThis.crypto) : null;
  function toBytes(v, enc){ return globalThis.Buffer.from(typeof v === 'string' ? globalThis.Buffer.from(v, enc || 'utf8') : v); }
  function randomBytes(n, cb){ var a = new Uint8Array(n|0); __seededRandom(a); var b = globalThis.Buffer.from(a); if (typeof cb === 'function'){ queueMicrotask(function(){ cb(null, b); }); return; } return b; }
  function randomFillSync(buf, off, size){ off = off|0; size = (size === undefined) ? buf.length - off : size|0; var tmp = new Uint8Array(size); __seededRandom(tmp); for (var i=0;i<size;i++) buf[off+i] = tmp[i]; return buf; }
  function randomFill(buf, off, size, cb){ if (typeof off === 'function'){ cb = off; off = 0; size = buf.length; } else if (typeof size === 'function'){ cb = size; size = buf.length - off; } randomFillSync(buf, off, size); queueMicrotask(function(){ cb(null, buf); }); }
  function getRandomValues(a){ return __seededRandom(a); }
  function randomUUID(){ if (__seededUUID) return __seededUUID(); var b = randomBytes(16); b[6]=(b[6]&0x0f)|0x40; b[8]=(b[8]&0x3f)|0x80; var h=[]; for (var i=0;i<16;i++) h.push((b[i]+0x100).toString(16).slice(1)); return h[0]+h[1]+h[2]+h[3]+'-'+h[4]+h[5]+'-'+h[6]+h[7]+'-'+h[8]+h[9]+'-'+h[10]+h[11]+h[12]+h[13]+h[14]+h[15]; }
  // randomInt([min,] max[, cb]) — uniform integer in [min,max). Rejection-sampled off the seeded RNG.
  function randomInt(min, max, cb){ if (typeof max === 'function' || max === undefined){ cb = max; max = min; min = 0; } min = Math.floor(min); max = Math.floor(max); if (!(max > min)) throw new RangeError('max must be greater than min'); var range = max - min; var bytesNeeded = Math.ceil(Math.log2(range) / 8) || 1; var maxValid = Math.floor(0x100000000 / range) * range; var val; do { var bb = randomBytes(4); val = ((bb[0]<<24)>>>0) + (bb[1]<<16) + (bb[2]<<8) + bb[3]; } while (val >= maxValid && range <= 0x100000000); var out = min + (val % range); if (typeof cb === 'function'){ queueMicrotask(function(){ cb(null, out); }); return; } return out; }
  // Hash: createHash(algo).update(data).digest([enc]). Buffers chunks, hashes once on digest().
  function normAlgo(a){ return String(a).toLowerCase().replace(/^rsa-/, ''); }
  function Hash(algo){ this._algo = normAlgo(algo); this._fn = globalThis.__hashes[this._algo]; if (!this._fn) throw new Error("Digest method not supported: " + algo); this._chunks = []; }
  Hash.prototype.update = function(data, enc){ this._chunks.push(toBytes(data, enc)); return this; };
  Hash.prototype.digest = function(enc){ var total = 0, i; for (i=0;i<this._chunks.length;i++) total += this._chunks[i].length; var all = new Uint8Array(total), off = 0; for (i=0;i<this._chunks.length;i++){ all.set(this._chunks[i], off); off += this._chunks[i].length; } var out = globalThis.Buffer.from(this._fn(all)); return enc ? out.toString(enc) : out; };
  function createHash(algo){ return new Hash(algo); }
  // HMAC (RFC 2104) over any supported hash. createHmac(algo, key).update(data).digest([enc]).
  function Hmac(algo, key){ this._algo = normAlgo(algo); this._fn = globalThis.__hashes[this._algo]; if (!this._fn) throw new Error("Digest method not supported: " + algo); var blockSize = (globalThis.__hashes.blockSize && globalThis.__hashes.blockSize[this._algo]) || 64; var k = toBytes(key); if (k.length > blockSize) k = globalThis.Buffer.from(this._fn(k)); if (k.length < blockSize){ var kk = new Uint8Array(blockSize); kk.set(k); k = globalThis.Buffer.from(kk); } this._ipad = new Uint8Array(blockSize); this._opad = new Uint8Array(blockSize); for (var i=0;i<blockSize;i++){ this._ipad[i] = k[i] ^ 0x36; this._opad[i] = k[i] ^ 0x5c; } this._chunks = []; }
  Hmac.prototype.update = function(data, enc){ this._chunks.push(toBytes(data, enc)); return this; };
  Hmac.prototype.digest = function(enc){ var total = this._ipad.length, i; for (i=0;i<this._chunks.length;i++) total += this._chunks[i].length; var inner = new Uint8Array(total); inner.set(this._ipad); var off = this._ipad.length; for (i=0;i<this._chunks.length;i++){ inner.set(this._chunks[i], off); off += this._chunks[i].length; } var innerHash = this._fn(inner); var outer = new Uint8Array(this._opad.length + innerHash.length); outer.set(this._opad); outer.set(innerHash, this._opad.length); var out = globalThis.Buffer.from(this._fn(outer)); return enc ? out.toString(enc) : out; };
  function createHmac(algo, key){ return new Hmac(algo, key); }
  // scryptSync — pure-JS RFC 7914 (PBKDF2-SHA256 + Salsa20/8 ROMix). Deterministic, no entropy.
  // Provided per spec (optional); small N only — it is O(N) memory/CPU in-VM. Throws above a cap.
  function pbkdf2Sha256(pw, salt, iterations, keylen){
    var hLen = 32, blocks = Math.ceil(keylen / hLen), out = new Uint8Array(blocks * hLen);
    for (var b=1;b<=blocks;b++){
      var ib = new Uint8Array(salt.length + 4); ib.set(salt); ib[salt.length]=(b>>>24)&0xff; ib[salt.length+1]=(b>>>16)&0xff; ib[salt.length+2]=(b>>>8)&0xff; ib[salt.length+3]=b&0xff;
      var u = hmacRaw(pw, ib), t = u.slice();
      for (var it=1;it<iterations;it++){ u = hmacRaw(pw, u); for (var k=0;k<hLen;k++) t[k] ^= u[k]; }
      out.set(t, (b-1)*hLen);
    }
    return out.subarray(0, keylen);
  }
  function hmacRaw(key, msg){ var h = new Hmac('sha256', key); h.update(msg); var total = h._ipad.length + msg.length; var inner = new Uint8Array(total); inner.set(h._ipad); inner.set(msg, h._ipad.length); var ih = globalThis.__hashes.sha256(inner); var outer = new Uint8Array(h._opad.length + ih.length); outer.set(h._opad); outer.set(ih, h._opad.length); return globalThis.__hashes.sha256(outer); }
  function scryptSync(password, salt, keylen, opts){
    opts = opts || {}; var N = opts.N || opts.cost || 16384, r = opts.r || opts.blockSize || 8, p = opts.p || opts.parallelization || 1;
    if (N * r * 128 > (16 << 20)) throw new Error('scryptSync: parameters exceed the in-VM memory cap (N*r*128 <= 16MB)');
    var pw = toBytes(password), sl = toBytes(salt);
    var B = pbkdf2Sha256(pw, sl, 1, p * 128 * r);
    function R(a,b){ return (a<<b)|(a>>>(32-b)); }
    function salsa(B32){ var x = B32.slice(); for (var i=8;i>0;i-=2){ x[4]^=R(x[0]+x[12],7); x[8]^=R(x[4]+x[0],9); x[12]^=R(x[8]+x[4],13); x[0]^=R(x[12]+x[8],18); x[9]^=R(x[5]+x[1],7); x[13]^=R(x[9]+x[5],9); x[1]^=R(x[13]+x[9],13); x[5]^=R(x[1]+x[13],18); x[14]^=R(x[10]+x[6],7); x[2]^=R(x[14]+x[10],9); x[6]^=R(x[2]+x[14],13); x[10]^=R(x[6]+x[2],18); x[3]^=R(x[15]+x[11],7); x[7]^=R(x[3]+x[15],9); x[11]^=R(x[7]+x[3],13); x[15]^=R(x[11]+x[7],18); x[1]^=R(x[0]+x[3],7); x[2]^=R(x[1]+x[0],9); x[3]^=R(x[2]+x[1],13); x[0]^=R(x[3]+x[2],18); x[6]^=R(x[5]+x[4],7); x[7]^=R(x[6]+x[5],9); x[4]^=R(x[7]+x[6],13); x[5]^=R(x[4]+x[7],18); x[11]^=R(x[10]+x[9],7); x[8]^=R(x[11]+x[10],9); x[9]^=R(x[8]+x[11],13); x[10]^=R(x[9]+x[8],18); x[12]^=R(x[15]+x[14],7); x[13]^=R(x[12]+x[15],9); x[14]^=R(x[13]+x[12],13); x[15]^=R(x[14]+x[13],18); } for (var i=0;i<16;i++) B32[i]=(B32[i]+x[i])|0; }
    function blockmix(BB){ var X = BB.subarray((2*r-1)*16, (2*r-1)*16+16).slice(); var Y = new Int32Array(BB.length); for (var i=0;i<2*r;i++){ for (var j=0;j<16;j++) X[j]^=BB[i*16+j]; salsa(X); var dst = (i%2===0 ? (i/2) : (r + (i-1)/2)) * 16; for (var j=0;j<16;j++) Y[dst+j]=X[j]; } BB.set(Y); }
    function toI32(u8){ var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); var out = new Int32Array(u8.length/4); for (var i=0;i<out.length;i++) out[i]=dv.getInt32(i*4, true); return out; }
    function fromI32(i32){ var out = new Uint8Array(i32.length*4); var dv = new DataView(out.buffer); for (var i=0;i<i32.length;i++) dv.setInt32(i*4, i32[i], true); return out; }
    for (var i=0;i<p;i++){
      var Bi = toI32(B.subarray(i*128*r, (i+1)*128*r));
      var V = []; for (var n=0;n<N;n++){ V.push(Bi.slice()); blockmix(Bi); }
      for (var n=0;n<N;n++){ var jj = (Bi[(2*r-1)*16] >>> 0) % N; for (var k=0;k<Bi.length;k++) Bi[k]^=V[jj][k]; blockmix(Bi); }
      B.set(fromI32(Bi), i*128*r);
    }
    var dk = pbkdf2Sha256(pw, B, 1, keylen);
    return globalThis.Buffer.from(dk);
  }
  return {
    randomBytes: randomBytes, randomFillSync: randomFillSync, randomFill: randomFill,
    getRandomValues: getRandomValues, randomUUID: randomUUID, randomInt: randomInt,
    createHash: createHash, createHmac: createHmac, Hash: Hash, Hmac: Hmac,
    scryptSync: scryptSync, pbkdf2Sync: function(pw, salt, it, kl, digest){ if (digest && normAlgo(digest).replace('-','') !== 'sha256') throw new Error('pbkdf2Sync: only sha256 supported in-VM'); return globalThis.Buffer.from(pbkdf2Sha256(toBytes(pw), toBytes(salt), it, kl)); },
    constants: {}, webcrypto: globalThis.crypto,
    getHashes: function(){ return ['sha256','sha1','md5']; },
    timingSafeEqual: function(a, b){ if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length'); var diff = 0; for (var i=0;i<a.length;i++) diff |= a[i] ^ b[i]; return diff === 0; },
  };
})();

// ===== zlib (node:zlib) — PURE-JS DEFLATE/INFLATE + gzip/zlib framing. =====
// rquickjs has no CompressionStream (that is workerd-host-only, used by the snapshot glue), and
// gzipSync/gunzipSync MUST be synchronous, so this is a self-contained pure-JS codec (snapshot-safe,
// deterministic, no host round-trip). INFLATE handles all three DEFLATE block types (stored / fixed
// / DYNAMIC Huffman) so it reads real `content-encoding: gzip` and tar.gz streams from servers.
// DEFLATE emits standards-compliant FIXED-Huffman + LZ77 blocks (valid for Node/zlib gunzip too).
// gzip = 10-byte header + DEFLATE + CRC32 + ISIZE; zlib(deflate) = 2-byte header + DEFLATE + Adler32.
// brotli* is NOT provided (a pure-JS brotli needs the ~120KB static dictionary) — those throw a
// clear NotSupported. Async variants (gzip/gunzip/…) are the sync codec wrapped in a microtask.
var __zlib = (function(){
  var ENC = new TextEncoder();
  function toU8(x){ if (x instanceof Uint8Array) return x; if (x instanceof ArrayBuffer) return new Uint8Array(x); if (typeof x === 'string') return ENC.encode(x); if (x && x.buffer) return new Uint8Array(x.buffer, x.byteOffset||0, x.byteLength); return new Uint8Array(x); }
  function crc32(u8){ var c, crc = 0xFFFFFFFF; for (var i=0;i<u8.length;i++){ c = (crc ^ u8[i]) & 0xFF; for (var k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }
  function adler32(u8){ var a = 1, b = 0; for (var i=0;i<u8.length;i++){ a = (a + u8[i]) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; }

  // ---- INFLATE (RFC 1951) — bit reader + the three block types ----
  function inflateRaw(data){
    var bytes = toU8(data), pos = 0, bitBuf = 0, bitCnt = 0;
    var out = [], outLen = 0;
    function ensure(n){ while (bitCnt < n){ bitBuf |= (pos < bytes.length ? bytes[pos++] : 0) << bitCnt; bitCnt += 8; } }
    function bits(n){ if (n === 0) return 0; ensure(n); var v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v; }
    function alignByte(){ bitBuf = 0; bitCnt = 0; }
    function pushByte(b){ out.push(b); outLen++; }
    // build a canonical-Huffman fast decode table from code lengths.
    function buildTree(lengths){ var maxBits = 0, i; for (i=0;i<lengths.length;i++) if (lengths[i] > maxBits) maxBits = lengths[i]; var blCount = new Array(maxBits+1).fill(0); for (i=0;i<lengths.length;i++) blCount[lengths[i]]++; blCount[0] = 0; var nextCode = new Array(maxBits+1).fill(0), code = 0; for (var b=1;b<=maxBits;b++){ code = (code + blCount[b-1]) << 1; nextCode[b] = code; } var codes = {}; for (i=0;i<lengths.length;i++){ var len = lengths[i]; if (len){ codes[len + ':' + (nextCode[len]++)] = i; } } return { codes: codes, maxBits: maxBits }; }
    function decodeSym(tree){ var code = 0; for (var len=1; len<=tree.maxBits; len++){ code = (code << 1) | bits(1); var sym = tree.codes[len + ':' + code]; if (sym !== undefined) return sym; } throw new Error('zlib: invalid Huffman code'); }
    var LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    var LEXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    var DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    var DEXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
    var fixedLit = null, fixedDist = null;
    function fixedTrees(){ if (fixedLit) return; var ll = []; for (var i=0;i<=143;i++) ll.push(8); for (;i<=255;i++) ll.push(9); for (;i<=279;i++) ll.push(7); for (;i<=287;i++) ll.push(8); fixedLit = buildTree(ll); var dl = []; for (i=0;i<30;i++) dl.push(5); fixedDist = buildTree(dl); }
    var bfinal = 0;
    do {
      bfinal = bits(1); var btype = bits(2);
      if (btype === 0){ alignByte(); var len = bytes[pos] | (bytes[pos+1] << 8); pos += 4; for (var i=0;i<len;i++) pushByte(bytes[pos++]); }
      else {
        var litTree, distTree;
        if (btype === 1){ fixedTrees(); litTree = fixedLit; distTree = fixedDist; }
        else if (btype === 2){
          var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
          var order = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
          var clLens = new Array(19).fill(0); for (var i=0;i<hclen;i++) clLens[order[i]] = bits(3);
          var clTree = buildTree(clLens);
          var lens = []; while (lens.length < hlit + hdist){ var s = decodeSym(clTree); if (s < 16) lens.push(s); else if (s === 16){ var r = bits(2) + 3, prev = lens[lens.length-1]; while (r--) lens.push(prev); } else if (s === 17){ var r = bits(3) + 3; while (r--) lens.push(0); } else { var r = bits(7) + 11; while (r--) lens.push(0); } }
          litTree = buildTree(lens.slice(0, hlit)); distTree = buildTree(lens.slice(hlit));
        } else throw new Error('zlib: invalid block type ' + btype);
        while (true){ var sym = decodeSym(litTree); if (sym === 256) break; if (sym < 256){ pushByte(sym); } else { var li = sym - 257; var length = LBASE[li] + bits(LEXT[li]); var dsym = decodeSym(distTree); var dist = DBASE[dsym] + bits(DEXT[dsym]); var start = outLen - dist; for (var k=0;k<length;k++) pushByte(out[start + k]); } }
      }
    } while (!bfinal);
    return Uint8Array.from(out);
  }

  // ---- DEFLATE (RFC 1951, fixed-Huffman + a greedy hash-chain LZ77 matcher) ----
  function deflateRaw(data){
    var src = toU8(data);
    var bitBuf = 0, bitCnt = 0, ob = [];
    function putBits(val, n){ bitBuf |= (val << bitCnt); bitCnt += n; while (bitCnt >= 8){ ob.push(bitBuf & 0xFF); bitBuf >>>= 8; bitCnt -= 8; } }
    function putBitsRev(code, n){ var r = 0; for (var i=0;i<n;i++){ r = (r << 1) | ((code >>> i) & 1); } putBits(r, n); } // Huffman codes are MSB-first
    // fixed literal/length code: 0-143 ->8b(0x30..),144-255 ->9b(0x190..),256-279 ->7b(0..),280-287 ->8b(0xC0..)
    function litCode(sym){ if (sym <= 143) return { c: 0x30 + sym, n: 8 }; if (sym <= 255) return { c: 0x190 + (sym - 144), n: 9 }; if (sym <= 279) return { c: (sym - 256), n: 7 }; return { c: 0xC0 + (sym - 280), n: 8 }; }
    function emitLit(b){ var lc = litCode(b); putBitsRev(lc.c, lc.n); }
    var LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    var LEXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    var DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    var DEXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
    function lenSym(len){ for (var i=28;i>=0;i--){ if (len >= LBASE[i]) return i; } return 0; }
    function distSym(d){ for (var i=29;i>=0;i--){ if (d >= DBASE[i]) return i; } return 0; }
    putBits(1, 1); putBits(1, 2); // BFINAL=1, BTYPE=01 (fixed Huffman)
    var head = {}; // hash of 3-byte sequences -> last position
    function hash(i){ return ((src[i] << 16) ^ (src[i+1] << 8) ^ src[i+2]) & 0x7FFF; }
    var i = 0, n = src.length;
    while (i < n){
      var matchLen = 0, matchDist = 0;
      if (i + 3 <= n){
        var h = hash(i), cand = head[h];
        if (cand !== undefined && (i - cand) <= 32768){
          var len = 0, maxLen = Math.min(258, n - i);
          while (len < maxLen && src[cand + len] === src[i + len]) len++;
          if (len >= 3){ matchLen = len; matchDist = i - cand; }
        }
        head[h] = i;
      }
      if (matchLen >= 3){
        var ls = lenSym(matchLen); var lc = litCode(256 + 1 + ls); putBitsRev(lc.c, lc.n); putBits(matchLen - LBASE[ls], LEXT[ls]);
        var ds = distSym(matchDist); putBitsRev(ds, 5); putBits(matchDist - DBASE[ds], DEXT[ds]);
        // insert hash entries for the matched run so later matches can reference inside it.
        for (var j=1;j<matchLen && i+j+3 <= n;j++){ head[hash(i+j)] = i+j; }
        i += matchLen;
      } else { emitLit(src[i]); i++; }
    }
    emitLit(256); // end-of-block
    if (bitCnt > 0){ ob.push(bitBuf & 0xFF); bitBuf = 0; bitCnt = 0; }
    return Uint8Array.from(ob);
  }

  function gzipSync(data, opts){ var src = toU8(data); var body = deflateRaw(src); var crc = crc32(src), isize = src.length >>> 0; var out = new Uint8Array(10 + body.length + 8); out.set([0x1f,0x8b,8,0,0,0,0,0,0,0xff], 0); out.set(body, 10); var o = 10 + body.length; out[o]=crc&0xff; out[o+1]=(crc>>>8)&0xff; out[o+2]=(crc>>>16)&0xff; out[o+3]=(crc>>>24)&0xff; out[o+4]=isize&0xff; out[o+5]=(isize>>>8)&0xff; out[o+6]=(isize>>>16)&0xff; out[o+7]=(isize>>>24)&0xff; return globalThis.Buffer.from(out); }
  function gunzipSync(data){ var b = toU8(data); if (b.length < 18 || b[0] !== 0x1f || b[1] !== 0x8b) throw new Error('zlib: not a gzip stream'); if (b[2] !== 8) throw new Error('zlib: unsupported gzip compression method'); var flg = b[3], off = 10; if (flg & 4){ var xlen = b[off] | (b[off+1] << 8); off += 2 + xlen; } if (flg & 8){ while (b[off] !== 0) off++; off++; } if (flg & 16){ while (b[off] !== 0) off++; off++; } if (flg & 2){ off += 2; } var body = b.subarray(off, b.length - 8); return globalThis.Buffer.from(inflateRaw(body)); }
  function deflateSync(data, opts){ var src = toU8(data); var body = deflateRaw(src); var ad = adler32(src); var out = new Uint8Array(2 + body.length + 4); out[0] = 0x78; out[1] = 0x9c; out.set(body, 2); var o = 2 + body.length; out[o]=(ad>>>24)&0xff; out[o+1]=(ad>>>16)&0xff; out[o+2]=(ad>>>8)&0xff; out[o+3]=ad&0xff; return globalThis.Buffer.from(out); }
  function inflateSync(data){ var b = toU8(data); var off = 0; if (b.length >= 2 && (b[0] & 0x0f) === 8 && ((b[0] << 8 | b[1]) % 31) === 0){ off = 2; if (b[1] & 0x20) off += 4; } var end = off === 0 ? b.length : b.length - 4; return globalThis.Buffer.from(inflateRaw(b.subarray(off, end))); }
  function deflateRawSync(data){ return globalThis.Buffer.from(deflateRaw(toU8(data))); }
  function inflateRawSync(data){ return globalThis.Buffer.from(inflateRaw(toU8(data))); }
  function unzipSync(data){ var b = toU8(data); if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return gunzipSync(b); return inflateSync(b); }
  // async = sync wrapped in a microtask-resolved callback/Promise (deterministic; the VM has no
  // background thread, so "async" just defers to the job queue). cb(err,result) Node-style.
  function mkAsync(syncFn){ return function(data, opts, cb){ if (typeof opts === 'function'){ cb = opts; opts = undefined; } if (typeof cb === 'function'){ queueMicrotask(function(){ var r, e=null; try { r = syncFn(data, opts); } catch(err){ e = err; } cb(e, r); }); return; } return new Promise(function(res, rej){ queueMicrotask(function(){ try { res(syncFn(data, opts)); } catch(err){ rej(err); } }); }); }; }
  function brotliUnsupported(){ throw new Error('NotSupportedError: brotli is not available in this VM (pure-JS brotli needs the static dictionary). Use gzip/deflate, or fetch with accept-encoding: gzip.'); }
  return {
    gzipSync: gzipSync, gunzipSync: gunzipSync, deflateSync: deflateSync, inflateSync: inflateSync,
    deflateRawSync: deflateRawSync, inflateRawSync: inflateRawSync, unzipSync: unzipSync,
    gzip: mkAsync(gzipSync), gunzip: mkAsync(gunzipSync), deflate: mkAsync(deflateSync), inflate: mkAsync(inflateSync),
    deflateRaw: mkAsync(deflateRawSync), inflateRaw: mkAsync(inflateRawSync), unzip: mkAsync(unzipSync),
    brotliCompressSync: brotliUnsupported, brotliDecompressSync: brotliUnsupported,
    brotliCompress: function(d,o,cb){ var c = typeof o === 'function' ? o : cb; if (c) queueMicrotask(function(){ c(new Error('NotSupportedError: brotli unavailable in this VM')); }); else return Promise.reject(new Error('NotSupportedError: brotli unavailable in this VM')); },
    brotliDecompress: function(d,o,cb){ var c = typeof o === 'function' ? o : cb; if (c) queueMicrotask(function(){ c(new Error('NotSupportedError: brotli unavailable in this VM')); }); else return Promise.reject(new Error('NotSupportedError: brotli unavailable in this VM')); },
    crc32: crc32, adler32: adler32,
    constants: { Z_NO_FLUSH:0, Z_SYNC_FLUSH:2, Z_FULL_FLUSH:3, Z_FINISH:4, Z_OK:0, Z_STREAM_END:1, Z_BEST_SPEED:1, Z_BEST_COMPRESSION:9, Z_DEFAULT_COMPRESSION:-1 },
  };
})();

// ===== url (node:url) — the LEGACY url module (parse/format/resolve/Url) + the WHATWG
//       URL/URLSearchParams (re-exported from the BOOTSTRAP globals). =====
var __url = (function(){
  function Url(){ this.protocol=null; this.slashes=null; this.auth=null; this.host=null; this.port=null; this.hostname=null; this.hash=null; this.search=null; this.query=null; this.pathname=null; this.path=null; this.href=null; }
  function parse(urlStr, parseQueryString, slashesDenoteHost){
    var u = new Url(); urlStr = String(urlStr); u.href = urlStr;
    var rest = urlStr, hashIdx = rest.indexOf('#'); if (hashIdx >= 0){ u.hash = rest.slice(hashIdx); rest = rest.slice(0, hashIdx); }
    var protoMatch = /^([a-zA-Z][a-zA-Z0-9+.\-]*:)/.exec(rest); if (protoMatch){ u.protocol = protoMatch[1].toLowerCase(); rest = rest.slice(protoMatch[1].length); }
    var hasSlashes = false; if (rest.slice(0,2) === '//'){ hasSlashes = true; u.slashes = true; rest = rest.slice(2); }
    if (hasSlashes || (slashesDenoteHost && rest.slice(0,2) === '//')){
      var pathStart = rest.search(/[\/?#]/); var authority = pathStart < 0 ? rest : rest.slice(0, pathStart); rest = pathStart < 0 ? '' : rest.slice(pathStart);
      var atIdx = authority.lastIndexOf('@'); if (atIdx >= 0){ u.auth = authority.slice(0, atIdx); authority = authority.slice(atIdx + 1); }
      u.host = authority.toLowerCase();
      var portMatch = /:(\d+)$/.exec(authority); if (portMatch){ u.port = portMatch[1]; u.hostname = authority.slice(0, authority.length - portMatch[0].length).toLowerCase(); } else { u.hostname = authority.toLowerCase(); }
    }
    var searchIdx = rest.indexOf('?'); if (searchIdx >= 0){ u.search = rest.slice(searchIdx); u.query = parseQueryString ? globalThis.__builtins.querystring.parse(u.search.slice(1)) : u.search.slice(1); rest = rest.slice(0, searchIdx); } else if (parseQueryString){ u.query = {}; }
    u.pathname = rest || (u.host !== null ? '/' : null);
    u.path = (u.pathname || '') + (u.search || '') || null;
    return u;
  }
  function format(obj){
    if (typeof obj === 'string') return obj;
    if (obj instanceof globalThis.URL) return obj.toString();
    var proto = obj.protocol || ''; if (proto && proto.slice(-1) !== ':') proto += ':';
    var host = obj.host || ((obj.hostname || '') + (obj.port ? ':' + obj.port : ''));
    var auth = obj.auth ? obj.auth + '@' : '';
    var slashes = (obj.slashes || (host && proto)) ? '//' : '';
    var pathname = obj.pathname || '';
    var search = obj.search || (obj.query ? '?' + (typeof obj.query === 'string' ? obj.query : globalThis.__builtins.querystring.stringify(obj.query)) : '');
    if (search && search[0] !== '?') search = '?' + search;
    var hash = obj.hash || ''; if (hash && hash[0] !== '#') hash = '#' + hash;
    return proto + slashes + auth + host + pathname + search + hash;
  }
  function resolve(from, to){ try { return new globalThis.URL(to, from).toString(); } catch(e){ if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(to)) return to; return to; } }
  function fileURLToPath(u){ var s = (u instanceof globalThis.URL) ? u.toString() : String(u); return s.replace(/^file:\/\//, '') || '/'; }
  function pathToFileURL(p){ return new globalThis.URL('file://' + (String(p)[0] === '/' ? '' : '/') + String(p)); }
  function urlToHttpOptions(u){ return { protocol: u.protocol, hostname: typeof u.hostname === 'string' ? u.hostname.replace(/^\[|\]$/g,'') : u.hostname, port: u.port, path: (u.pathname||'') + (u.search||''), hash: u.hash, search: u.search, href: u.href, auth: u.username ? u.username + (u.password ? ':' + u.password : '') : undefined }; }
  return { parse: parse, format: format, resolve: resolve, Url: Url, URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams, fileURLToPath: fileURLToPath, pathToFileURL: pathToFileURL, urlToHttpOptions: urlToHttpOptions, domainToASCII: function(d){ return String(d); }, domainToUnicode: function(d){ return String(d); } };
})();

// ===== http / https (node:http, node:https) — CLIENT ONLY over the binary-safe host.fetch. =====
// request()/get() return a ClientRequest (a Writable-ish EventEmitter); the response callback gets
// an IncomingMessage (a Readable EventEmitter) carrying {statusCode, statusMessage, headers} and the
// body via 'data'/'end' + async-iteration. NO server (createServer throws — servers are EXCLUDED).
// Backed by globalThis.fetch (the only host effect), so it honours the fetch allowlist + bytes.
var __http = (function(EventEmitter, defaultProtocol){
  function normalizeArgs(urlOrOpts, optsOrCb, cb){
    var opts = {}, callback;
    if (typeof urlOrOpts === 'string'){ var pu = __url.parse(urlOrOpts); opts.protocol = pu.protocol; opts.hostname = pu.hostname; opts.port = pu.port; opts.path = pu.path || '/'; opts.auth = pu.auth; }
    else if (urlOrOpts instanceof globalThis.URL){ opts.protocol = urlOrOpts.protocol; opts.hostname = urlOrOpts.hostname; opts.port = urlOrOpts.port; opts.path = (urlOrOpts.pathname||'/') + (urlOrOpts.search||''); opts.auth = urlOrOpts.username ? urlOrOpts.username + (urlOrOpts.password ? ':' + urlOrOpts.password : '') : undefined; }
    else if (urlOrOpts && typeof urlOrOpts === 'object'){ for (var k in urlOrOpts) opts[k] = urlOrOpts[k]; }
    if (typeof optsOrCb === 'function'){ callback = optsOrCb; }
    else if (optsOrCb && typeof optsOrCb === 'object'){ for (var k2 in optsOrCb) opts[k2] = optsOrCb[k2]; if (typeof cb === 'function') callback = cb; }
    return { opts: opts, callback: callback };
  }
  function buildUrl(opts){ var proto = opts.protocol || defaultProtocol; var host = opts.hostname || opts.host || 'localhost'; var port = opts.port ? ':' + opts.port : ''; var path = opts.path || '/'; if (path[0] !== '/') path = '/' + path; return proto + '//' + host + port + path; }
  function IncomingMessage(){ EventEmitter.call(this); this.statusCode = 0; this.statusMessage = ''; this.headers = {}; this.complete = false; this._body = null; this.aborted = false; this.url = ''; this.method = null; this.socket = {}; }
  Object.setPrototypeOf(IncomingMessage.prototype, EventEmitter.prototype);
  IncomingMessage.prototype.setEncoding = function(enc){ this._encoding = enc; return this; };
  IncomingMessage.prototype.pause = function(){ return this; };
  IncomingMessage.prototype.resume = function(){ return this; };
  IncomingMessage.prototype.setTimeout = function(){ return this; };
  IncomingMessage.prototype.destroy = function(){ this.destroyed = true; return this; };
  IncomingMessage.prototype[Symbol.asyncIterator] = function(){ var self = this; var done = false, chunk = self._body; return { next: function(){ if (done) return Promise.resolve({ done:true, value:undefined }); done = true; return Promise.resolve({ done:false, value: chunk }); }, return: function(){ done = true; return Promise.resolve({ done:true, value:undefined }); }, [Symbol.asyncIterator]: function(){ return this; } }; };
  function ClientRequest(opts, callback){ EventEmitter.call(this); this._opts = opts; this._chunks = []; this._ended = false; this._aborted = false; if (callback) this.once('response', callback); }
  Object.setPrototypeOf(ClientRequest.prototype, EventEmitter.prototype);
  ClientRequest.prototype.setHeader = function(k, v){ this._opts.headers = this._opts.headers || {}; this._opts.headers[k] = v; return this; };
  ClientRequest.prototype.getHeader = function(k){ return this._opts.headers && this._opts.headers[k]; };
  ClientRequest.prototype.removeHeader = function(k){ if (this._opts.headers) delete this._opts.headers[k]; };
  ClientRequest.prototype.setTimeout = function(){ return this; };
  ClientRequest.prototype.write = function(chunk){ if (chunk != null) this._chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : (chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))); return true; };
  ClientRequest.prototype.abort = function(){ this._aborted = true; this.emit('abort'); };
  ClientRequest.prototype.destroy = function(e){ this._aborted = true; if (e) this.emit('error', e); return this; };
  ClientRequest.prototype.end = function(chunk){
    if (this._ended) return this; this._ended = true; var self = this;
    if (chunk != null) this.write(chunk);
    var method = (this._opts.method || 'GET').toUpperCase();
    var init = { method: method, headers: this._opts.headers || {} };
    if (this._chunks.length){ var total = 0, i; for (i=0;i<this._chunks.length;i++) total += this._chunks[i].length; var body = new Uint8Array(total), off = 0; for (i=0;i<this._chunks.length;i++){ body.set(this._chunks[i], off); off += this._chunks[i].length; } init.body = body; }
    var url = buildUrl(this._opts);
    Promise.resolve().then(function(){ return globalThis.fetch(url, init); }).then(function(r){
      var im = new IncomingMessage(); im.statusCode = r.status; im.statusMessage = r.statusText || ''; im.url = url; im.method = method;
      var hdrs = {}; if (r.headers && typeof r.headers.forEach === 'function'){ r.headers.forEach(function(v, k){ hdrs[String(k).toLowerCase()] = v; }); } else if (r.headers){ for (var hk in r.headers) hdrs[String(hk).toLowerCase()] = r.headers[hk]; }
      im.headers = hdrs;
      self.emit('response', im);
      return r.arrayBuffer().then(function(ab){ return { im: im, bytes: new Uint8Array(ab) }; });
    }).then(function(res){
      var im = res.im; im._body = im._encoding ? globalThis.Buffer.from(res.bytes).toString(im._encoding) : globalThis.Buffer.from(res.bytes);
      queueMicrotask(function(){ if (im._body != null && im._body.length !== 0) im.emit('data', im._body); im.complete = true; im.emit('end'); im.emit('close'); });
    }).catch(function(e){ self.emit('error', e instanceof Error ? e : new Error(String(e))); });
    return this;
  };
  function request(a, b, c){ var na = normalizeArgs(a, b, c); na.opts.protocol = na.opts.protocol || defaultProtocol; return new ClientRequest(na.opts, na.callback); }
  function get(a, b, c){ var req = request(a, b, c); req.end(); return req; }
  function createServer(){ throw new Error('NotSupportedError: http/https servers are EXCLUDED in this VM (no networking listen). This is a client-only http over the mediated host.fetch.'); }
  var Agent = function(o){ this.options = o || {}; };
  return { request: request, get: get, createServer: createServer, IncomingMessage: IncomingMessage, ClientRequest: ClientRequest, Agent: Agent, globalAgent: new Agent(), METHODS: ['GET','POST','PUT','DELETE','HEAD','OPTIONS','PATCH'], STATUS_CODES: { 200:'OK', 201:'Created', 204:'No Content', 301:'Moved Permanently', 302:'Found', 304:'Not Modified', 400:'Bad Request', 401:'Unauthorized', 403:'Forbidden', 404:'Not Found', 500:'Internal Server Error', 502:'Bad Gateway', 503:'Service Unavailable' } };
})(__events, 'http:');
// https.request/get must default to https:; a thin variant whose default protocol is https:.
var __httpsClient = (function(EventEmitter){
  function req(a, b, c){
    // reuse the http machinery but force protocol https: when not explicitly set.
    var url = a, opts = b, cb = c;
    if (typeof a === 'string'){ var r = __http.request(a, b, c); return r; }
    if (a instanceof globalThis.URL){ return __http.request(a, b, c); }
    var o = {}; if (a && typeof a === 'object'){ for (var k in a) o[k] = a[k]; } if (!o.protocol) o.protocol = 'https:'; return __http.request(o, b, c);
  }
  function get(a, b, c){ var r = req(a, b, c); r.end(); return r; }
  var out = {}; for (var k in __http) out[k] = __http[k]; out.request = req; out.get = get; return out;
})(__events);

globalThis.__builtins = {
  crypto: __crypto,
  zlib: __zlib,
  url: __url,
  http: __http,
  https: __httpsClient,
  events: __events,
  util: __util,
  path: __path,
  assert: __assert,
  stream: __stream,
  querystring: __querystring,
  string_decoder: __string_decoder,
  os: { platform: function(){ return 'engram'; }, EOL: '\n', homedir: function(){ return '/'; }, tmpdir: function(){ return '/tmp'; }, hostname: function(){ return 'engram'; }, arch: function(){ return 'wasm'; }, cpus: function(){ return []; }, type: function(){ return 'Engram'; }, release: function(){ return '0.0.0'; }, totalmem: function(){ return 0; }, freemem: function(){ return 0; }, uptime: function(){ return 0; }, endianness: function(){ return 'LE'; } },
  buffer: { Buffer: globalThis.Buffer, kMaxLength: 0x7fffffff, constants: { MAX_LENGTH: 0x7fffffff, MAX_STRING_LENGTH: 0x1fffffff } },
};
// node:-prefixed + submodule aliases (stream/promises, fs/promises, util/types, assert/strict).
(function(){
  var B = globalThis.__builtins;
  Object.keys(B).forEach(function(k){ B['node:' + k] = B[k]; });
  B['stream/promises'] = __stream.promises; B['node:stream/promises'] = __stream.promises;
  B['stream/web'] = __stream; B['node:stream/web'] = __stream;
  B['util/types'] = __util.types; B['node:util/types'] = __util.types;
  B['assert/strict'] = __assert; B['node:assert/strict'] = __assert;
  B['path/posix'] = __path; B['node:path/posix'] = __path;
})();

// ===== DISCOVERABILITY: globalThis.__nodeCompat — let the model ENUMERATE the surface =====
// A driving LLM can read this to know exactly which `require('x')` builtins exist, which heavier
// npm packages it must `await use('x')` instead, and the determinism caveats — so it stops
// hallucinating net/child_process/real-timers. Surfaced to the actor guide in ouru/ax-turn.ts.
globalThis.__nodeCompat = {
  builtins: ['assert','buffer','crypto','events','fs','fs/promises','http','https','os','path','querystring','stream','stream/promises','string_decoder','url','util','util/types','zlib'].filter(function(v,i,a){ return a.indexOf(v) === i; }),
  globals: ['Buffer','TextEncoder','TextDecoder','URL','URLSearchParams','Headers','Request','Response','Blob','File','FormData','AbortController','AbortSignal','structuredClone','crypto','fetch','queueMicrotask','setTimeout','setImmediate','process','console','performance'],
  stdlib: ['fs (in-heap VFS, sync + promises + createReadStream/createWriteStream + readdir withFileTypes Dirent)', 'path (full posix)', 'stream (Readable/Writable/Duplex/Transform/PassThrough + pipeline/finished)', 'util.inspect/format/types/promisify', 'assert (structural deepStrictEqual)', 'Buffer (full read/write matrix)', 'crypto (randomBytes/randomUUID/randomInt + createHash sha256|sha1|md5 + createHmac + scryptSync)', 'zlib (gzip/gunzip/deflate/inflate sync+async; pure-JS DEFLATE; NO brotli)', 'url (legacy parse/format/resolve + WHATWG URL/URLSearchParams)', 'http/https (CLIENT request/get over host.fetch; NO server)', 'WHATWG fetch: fetch()->Response + Request/Response/Headers/Blob/File/FormData/AbortController'],
  use: "await use('pkgname') — fetch+eval a self-contained CJS/UMD npm bundle from a CDN (esm.sh ?bundle&cjs, then jsDelivr). Async; pin a version with use('pkg@1.2.3'); override the URL with use('pkg', {url}). ESM-only packages surface an actionable error suggesting the esm.sh ?bundle CJS build. Use this for any npm package not in builtins.",
  excluded: ['net','dns','tls','http-server','https-server','child_process','cluster','worker_threads','dgram','v8','vm','repl'],
  caveats: [
    'Deterministic sandbox: Date.now()/Math.random() are SEEDED (reproducible across restore), not wall-clock/entropy.',
    'Timers are IMMEDIATE: setTimeout/setImmediate fire on the microtask queue ignoring the delay; setInterval is a no-op. No wall-clock timers.',
    'fs is an in-heap virtual filesystem (durable across hibernate), NOT the host disk; sync methods work under the default vfs provider. createReadStream/createWriteStream stream over the VFS bytes; readdirSync(dir,{withFileTypes:true}) returns Dirent[].',
    'fetch() resolves to a REAL Response (ok/status/statusText/headers:Headers/url/redirected/.json()/.text()/.arrayBuffer()/.bytes()/.blob()/.clone()); new Request/Response/Headers/Blob/FormData and AbortController all work; bytes cross the host boundary base64-exact. It is the only host effect.',
    'AbortSignal.timeout(ms) aborts on the microtask queue (~immediately), not after ms — there is no wall clock; fetch({signal}) rejects with an AbortError/TimeoutError when the signal aborts.',
    'http/https are CLIENT-ONLY over the mediated host.fetch (createServer throws); the response is a Readable IncomingMessage with statusCode/headers + data/end events.',
    'zlib is pure-JS DEFLATE/INFLATE (gzip/deflate/raw, sync + microtask-async); brotli* is NOT available (no static dictionary).',
    'crypto.createHash supports sha256/sha1/md5 only; randomBytes/randomUUID/randomInt are SEEDED (deterministic); host crypto global is NOT clobbered by `const crypto = require("crypto")` (it stays cell-local).',
    'process presents as Node v20 on linux/x64 (process.platform/arch/versions.node/env/nextTick/hrtime); process.exit(code) throws a CATCHABLE ProcessExit and does NOT kill the kernel.',
    'A cell may end with a top-level `return <expr>` (its completion value) OR a trailing expression — both work.',
    'No server/networking modules (net/tls/dns/http-server) — this is a compute + mediated-fetch + durable-fs sandbox, not a server runtime.',
    'stream backpressure settles on microtasks (deterministic), so pipe/pipeline complete within the cell drain.',
  ],
};

// require(name): sync resolver. Built-ins + already-loaded packages (use() cache). Throws a clear,
// ENUMERATED error for anything not preloaded (the VM has no SYNC host IO, so require can't fetch).
// Strips a leading 'node:' and bare relative paths fall through to the cache by basename.
globalThis.require = function(name){
  var raw = String(name);
  var n = raw.replace(/^node:/, '');
  if (globalThis.__builtins[raw] !== undefined) return globalThis.__builtins[raw];
  if (globalThis.__builtins[n] !== undefined) return globalThis.__builtins[n];
  if (globalThis.__mods[raw] !== undefined) return globalThis.__mods[raw];
  if (globalThis.__mods[n] !== undefined) return globalThis.__mods[n];
  var base = n.split('/').pop();
  if (globalThis.__mods[base] !== undefined) return globalThis.__mods[base];
  var avail = Object.keys(globalThis.__builtins).filter(function(k){ return k.indexOf('node:') !== 0 && k.indexOf('/') < 0; }).sort().join(', ');
  var excluded = (globalThis.__nodeCompat && globalThis.__nodeCompat.excluded) || [];
  var hint = excluded.indexOf(n) >= 0
    ? " — module '" + n + "' is architecturally EXCLUDED from this deterministic sandbox (no networking/process/threads). See globalThis.__nodeCompat.caveats."
    : " — not a built-in. Available builtins: [" + avail + "]. For an npm package, `await use('" + base + "')` it first (the VM cannot synchronously fetch).";
  throw new Error("require('" + raw + "')" + hint);
};

// ===== IN-HEAP VIRTUAL FILESYSTEM — a SYNCHRONOUS, Node-like `fs` =====
// Backed by a plain object in the heap (globalThis.__vfs), so the whole fs API can be SYNC
// (readFileSync etc.) — impossible for a host-backed fs, where IO is async (parked VM). Because
// it lives in the heap it is DURABLE (snapshot-persisted; survives hibernate/cold-restore) and
// DETERMINISTIC (no host entropy). It is the VM's OWN scratch disk: NOT shared with the host /
// thinkx tools, and bounded by the heap size-admission cap. For a shared/host-backed workspace,
// register an async host module (host.fs.*) instead — that can only expose fs.promises.*.
globalThis.__vfs = globalThis.__vfs || { files: {}, dirs: { '/': true } };
(function(){
  var V = globalThis.__vfs;
  var ENC = new TextEncoder(), DEC = new TextDecoder();
  function norm(p){
    p = String(p == null ? '' : p);
    if (p[0] !== '/') p = '/' + p;
    var parts = p.split('/'), out = [];
    for (var i=0;i<parts.length;i++){ var s = parts[i]; if (s === '' || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
    return '/' + out.join('/');
  }
  function parent(p){ var i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
  function ENOENT(p){ var e = new Error("ENOENT: no such file or directory, '" + p + "'"); e.code = 'ENOENT'; return e; }
  function EISDIR(p){ var e = new Error("EISDIR: illegal operation on a directory, '" + p + "'"); e.code = 'EISDIR'; return e; }
  function toBytes(data, enc){ if (data instanceof Uint8Array) return data.slice(); if (typeof data === 'string') return (enc === 'base64') ? Uint8Array.from(atob(data), function(c){return c.charCodeAt(0);}) : ENC.encode(data); if (data && data.buffer) return new Uint8Array(data.buffer.slice(0)); return ENC.encode(String(data)); }
  // decode(bytes, enc): Node fs semantics — a STRING encoding ('utf8'/'base64'/...) OR an options
  // object WITH a string `.encoding` returns a string; NO encoding (undefined / 'buffer' / {} with
  // no .encoding) returns the raw bytes (Buffer). CRITICAL: isomorphic-git reads binary files with
  // `readFile(path, {})` — an empty options object must yield BYTES, not a lossy utf8 string (that
  // corrupted the packfile .idx magic and broke clone).
  function decode(bytes, enc){
    var e = (typeof enc === 'string') ? enc : (enc && typeof enc.encoding === 'string' ? enc.encoding : null);
    if (!e || e === 'buffer') return bytes.slice();
    if (e === 'base64') return btoa(String.fromCharCode.apply(null, bytes));
    if (e === 'hex'){ var h = ''; for (var i=0;i<bytes.length;i++) h += (bytes[i] + 0x100).toString(16).slice(1); return h; }
    if (e === 'latin1' || e === 'binary' || e === 'ascii'){ var s=''; for (var j=0;j<bytes.length;j++) s += String.fromCharCode(bytes[j] & (e==='ascii'?0x7f:0xff)); return s; }
    return DEC.decode(bytes);
  }
  function existsSync(p){ p = norm(p); return !!V.files[p] || !!V.dirs[p]; }
  function mkdirSync(p, opts){ p = norm(p); var rec = opts && opts.recursive; if (rec){ var parts = p.split('/').filter(Boolean), cur = ''; for (var i=0;i<parts.length;i++){ cur += '/' + parts[i]; V.dirs[cur] = true; } } else { if (!V.dirs[parent(p)]) throw ENOENT(parent(p)); V.dirs[p] = true; } return p; }
  function ensureParent(p){ var d = parent(p); if (!V.dirs[d]){ var parts = d.split('/').filter(Boolean), cur=''; for (var i=0;i<parts.length;i++){ cur += '/' + parts[i]; V.dirs[cur] = true; } } }
  function writeFileSync(p, data, enc){ p = norm(p); if (V.dirs[p]) throw EISDIR(p); ensureParent(p); V.files[p] = { data: toBytes(data, enc && enc.encoding ? enc.encoding : enc), mtime: 0 }; }
  function appendFileSync(p, data, enc){ p = norm(p); var prev = V.files[p] ? V.files[p].data : new Uint8Array(0); var add = toBytes(data, enc); var out = new Uint8Array(prev.length + add.length); out.set(prev); out.set(add, prev.length); ensureParent(p); V.files[p] = { data: out, mtime: 0 }; }
  function readFileSync(p, enc){ p = norm(p); var f = V.files[p]; if (!f){ if (V.dirs[p]) throw EISDIR(p); throw ENOENT(p); } return decode(f.data, enc && enc.encoding ? enc.encoding : enc); }
  function unlinkSync(p){ p = norm(p); if (!V.files[p]) throw ENOENT(p); delete V.files[p]; }
  function rmSync(p, opts){ p = norm(p); var rec = opts && opts.recursive, force = opts && opts.force; if (V.files[p]) { delete V.files[p]; return; } if (V.dirs[p]) { if (rec){ Object.keys(V.files).forEach(function(k){ if (k === p || k.indexOf(p + '/') === 0) delete V.files[k]; }); Object.keys(V.dirs).forEach(function(k){ if (k === p || k.indexOf(p + '/') === 0) delete V.dirs[k]; }); } else { delete V.dirs[p]; } return; } if (!force) throw ENOENT(p); }
  // Dirent (fs.Dirent): name + type predicates. Returned by readdirSync(dir,{withFileTypes:true})
  // — many tools (bundlers, test runners, recursive walkers) iterate entries by isDirectory()/isFile().
  function Dirent(name, isDir, parentPath){ this.name = name; this._d = isDir; this.path = parentPath; this.parentPath = parentPath; }
  Dirent.prototype.isFile = function(){ return !this._d; };
  Dirent.prototype.isDirectory = function(){ return this._d; };
  Dirent.prototype.isSymbolicLink = function(){ return false; };
  Dirent.prototype.isBlockDevice = function(){ return false; };
  Dirent.prototype.isCharacterDevice = function(){ return false; };
  Dirent.prototype.isFIFO = function(){ return false; };
  Dirent.prototype.isSocket = function(){ return false; };
  function readdirSync(p, opts){ p = norm(p); if (!V.dirs[p] && p !== '/') throw ENOENT(p); var set = {}, pre = p === '/' ? '/' : p + '/'; function add(k){ if (k.indexOf(pre) === 0){ var rest = k.slice(pre.length); if (rest){ var name = rest.split('/')[0]; if (name) set[name] = true; } } } Object.keys(V.files).forEach(add); Object.keys(V.dirs).forEach(function(k){ if (k !== p) add(k); }); var names = Object.keys(set); var withFileTypes = opts && typeof opts === 'object' && opts.withFileTypes; if (!withFileTypes) return names; return names.map(function(name){ var full = (p === '/' ? '/' : p + '/') + name; return new Dirent(name, !!V.dirs[full], p); }); }
  function renameSync(a, b){ a = norm(a); b = norm(b); if (V.files[a]){ ensureParent(b); V.files[b] = V.files[a]; delete V.files[a]; } else if (V.dirs[a]){ V.dirs[b] = true; delete V.dirs[a]; } else throw ENOENT(a); }
  function copyFileSync(a, b){ a = norm(a); b = norm(b); var f = V.files[a]; if (!f) throw ENOENT(a); ensureParent(b); V.files[b] = { data: f.data.slice(), mtime: 0 }; }
  function statSync(p){ p = norm(p); var isF = !!V.files[p], isD = !!V.dirs[p]; if (!isF && !isD) throw ENOENT(p); var size = isF ? V.files[p].data.length : 0; return { size: size, mtimeMs: 0, mode: isD ? 16877 : 33188, isFile: function(){ return isF; }, isDirectory: function(){ return isD; }, isSymbolicLink: function(){ return false; } }; }
  // VFS has no symlinks: readlink always EINVAL (isomorphic-git catches it), symlink writes the
  // target as a regular file (best-effort; the durable VFS is a flat byte store). These exist so
  // libraries (isomorphic-git) that BIND every fs method at construction don't fail on undefined.
  function readlinkSync(p){ var e = new Error("EINVAL: invalid argument, readlink '" + norm(p) + "'"); e.code = 'EINVAL'; throw e; }
  function symlinkSync(target, p){ p = norm(p); ensureParent(p); V.files[p] = { data: toBytes(String(target)), mtime: 0 }; }
  var P = function(fn){ return function(){ var a = arguments; return new Promise(function(res, rej){ try { res(fn.apply(null, a)); } catch(e){ rej(e); } }); }; };

  // ----- provider dispatch -----------------------------------------------------------------
  // globalThis.__fsProvider is set by the host glue at create/restore from config.fs.provider.
  // 'vfs' (default) = in-heap (above). Anything else = HOST-BACKED (r2/s3): the kernel services
  // a `host.__fs` effect DO-side. Host-backed IO is ASYNC, so SYNC methods THROW a typed error
  // and only fs.promises.* work.
  function provider(){ return globalThis.__fsProvider || 'vfs'; }
  function asyncOnly(name){ var e = new Error("FsAsyncError: " + name + " is async-only under the '" + provider() + "' fs provider — use fs.promises." + name.replace(/Sync$/, '')); e.code = 'ERR_FS_ASYNC_ONLY'; return e; }
  // host round-trip: host.__fs({op, path, ...}) -> { ok, data?(base64), names?, size?, isFile?, isDirectory?, error? }
  function hostFs(op, args){ return globalThis.host.__fs(Object.assign({ op: op }, args || {})); }
  function hostThrow(res, p){ if (res && res.error){ var e = new Error(res.error); e.code = (res.error.indexOf('ENOENT') === 0) ? 'ENOENT' : (res.code || undefined); throw e; } return res; }
  async function hReadFile(p, enc){ var r = hostThrow(await hostFs('read', { path: norm(p) }), p); var bytes = r.data ? Uint8Array.from(atob(r.data), function(c){return c.charCodeAt(0);}) : new Uint8Array(0); return decode(bytes, enc && enc.encoding ? enc.encoding : enc); }
  async function hWriteFile(p, data, enc){ var bytes = toBytes(data, enc && enc.encoding ? enc.encoding : enc); var b64 = btoa(String.fromCharCode.apply(null, bytes)); hostThrow(await hostFs('write', { path: norm(p), data: b64 }), p); }
  async function hAppendFile(p, data, enc){ var cur; try { cur = await hReadFile(p); } catch(e){ cur = new Uint8Array(0); } var add = toBytes(data, enc); var out = new Uint8Array(cur.length + add.length); out.set(cur); out.set(add, cur.length); await hWriteFile(p, out); }
  async function hUnlink(p){ hostThrow(await hostFs('delete', { path: norm(p) }), p); }
  async function hReaddir(p){ var r = hostThrow(await hostFs('list', { path: norm(p) }), p); return r.names || []; }
  async function hStat(p){ var r = hostThrow(await hostFs('stat', { path: norm(p) }), p); return { size: r.size || 0, mtimeMs: r.mtimeMs || 0, isFile: function(){ return !!r.isFile; }, isDirectory: function(){ return !!r.isDirectory; }, isSymbolicLink: function(){ return false; } }; }
  async function hExists(p){ var r = await hostFs('stat', { path: norm(p) }); return !(r && r.error); }

  // realpathSync: the VFS has no symlinks, so the canonical path is just the normalized path —
  // but it must EXIST (Node throws ENOENT for a missing path). promises.realpath mirrors it.
  function realpathSync(p, opts){ p = norm(p); if (!V.files[p] && !V.dirs[p] && p !== '/') throw ENOENT(p); return p; }

  // ----- fs STREAMS (WAVE 4) — createReadStream/createWriteStream over the VFS bytes -----------
  // Built on the in-VM `stream` module (Wave 1). createReadStream reads the file's bytes and pushes
  // them (honouring {encoding, start, end} — a byte slice + optional decode); 'data'/'end'/'error'/
  // 'close' fire on microtasks (deterministic). createWriteStream buffers writes and commits the
  // whole buffer to the VFS on end()/finish (the VFS is a flat byte store; there is no incremental
  // file handle), with flags 'w' (truncate, default) / 'a' (append). Both are vfs-only (sync core);
  // under a host-backed provider they throw the same async-only error as the sync methods.
  function createReadStream(p, opts){
    if (provider() !== 'vfs') throw asyncOnly('createReadStream');
    if (typeof opts === 'string') opts = { encoding: opts };
    opts = opts || {};
    // With an encoding set, Node emits STRING chunks; the base Readable re-encodes a pushed string
    // to bytes UNLESS objectMode — so use objectMode for the encoded case and push the decoded
    // string verbatim. No encoding → push raw bytes (the binary path PDFs/packfiles need).
    var hasEnc = !!opts.encoding;
    var rd = new __stream.Readable({ read: function(){}, objectMode: hasEnc });
    rd.path = norm(p);
    if (hasEnc && rd.setEncoding) rd.setEncoding(opts.encoding);
    queueMicrotask(function(){
      try {
        var f = V.files[norm(p)];
        if (!f){ rd.destroy(V.dirs[norm(p)] ? EISDIR(norm(p)) : ENOENT(norm(p))); return; }
        var bytes = f.data;
        var start = opts.start|0; var end = (opts.end === undefined) ? bytes.length : (opts.end|0) + 1; // Node `end` is INCLUSIVE
        var sliced = bytes.subarray(Math.max(0, start), Math.min(bytes.length, Math.max(start, end)));
        var chunk = hasEnc ? decode(sliced.slice(), opts.encoding) : sliced.slice();
        rd.push(chunk);
        rd.push(null);
        rd.emit('open', 0); rd.emit('ready');
      } catch(e){ rd.destroy(e instanceof Error ? e : new Error(String(e))); }
    });
    return rd;
  }
  function createWriteStream(p, opts){
    if (provider() !== 'vfs') throw asyncOnly('createWriteStream');
    if (typeof opts === 'string') opts = { encoding: opts };
    opts = opts || {};
    var flags = opts.flags || 'w';
    var path = norm(p);
    var parts = [];
    var w = new __stream.Writable({
      write: function(chunk, enc, cb){ parts.push((chunk instanceof Uint8Array) ? chunk : toBytes(chunk, opts.encoding)); cb(); },
      final: function(cb){
        try {
          var total = 0, i; for (i=0;i<parts.length;i++) total += parts[i].length;
          var all = new Uint8Array(total), off = 0; for (i=0;i<parts.length;i++){ all.set(parts[i], off); off += parts[i].length; }
          if (flags.indexOf('a') >= 0){ appendFileSync(path, all); } else { writeFileSync(path, all); }
          w.bytesWritten = total;
          cb();
        } catch(e){ cb(e instanceof Error ? e : new Error(String(e))); }
      },
    });
    w.path = path; w.bytesWritten = 0;
    queueMicrotask(function(){ w.emit('open', 0); w.emit('ready'); });
    return w;
  }

  // sync method: in-heap for vfs, THROW for host-backed providers.
  function S(name, vfsFn){ return function(){ if (provider() !== 'vfs') throw asyncOnly(name); return vfsFn.apply(null, arguments); }; }
  // promises method: in-heap (wrapped) for vfs, host round-trip otherwise.
  function A(vfsFn, hostFn){ return function(){ var a = arguments; return (provider() === 'vfs') ? new Promise(function(res, rej){ try { res(vfsFn.apply(null, a)); } catch(e){ rej(e); } }) : hostFn.apply(null, a); }; }

  var fs = {
    existsSync: S('existsSync', existsSync), mkdirSync: S('mkdirSync', mkdirSync),
    writeFileSync: S('writeFileSync', writeFileSync), appendFileSync: S('appendFileSync', appendFileSync),
    readFileSync: S('readFileSync', readFileSync), unlinkSync: S('unlinkSync', unlinkSync),
    rmSync: S('rmSync', rmSync), rmdirSync: S('rmdirSync', rmSync), readdirSync: S('readdirSync', readdirSync),
    renameSync: S('renameSync', renameSync), copyFileSync: S('copyFileSync', copyFileSync),
    statSync: S('statSync', statSync), lstatSync: S('lstatSync', statSync),
    readlinkSync: S('readlinkSync', readlinkSync), symlinkSync: S('symlinkSync', symlinkSync),
    realpathSync: S('realpathSync', realpathSync),
    // fs STREAMS (Wave 4): Readable/Writable over the VFS bytes.
    createReadStream: createReadStream, createWriteStream: createWriteStream,
    // Dirent constructor exposed for `instanceof` checks (fs.Dirent).
    Dirent: Dirent,
    promises: {
      readFile: A(readFileSync, hReadFile), writeFile: A(writeFileSync, hWriteFile),
      appendFile: A(appendFileSync, hAppendFile), mkdir: A(mkdirSync, async function(){ /* r2 has no dirs */ }),
      readdir: A(readdirSync, hReaddir), rm: A(rmSync, hUnlink), rmdir: A(rmSync, hUnlink), unlink: A(unlinkSync, hUnlink),
      rename: A(renameSync, async function(a,b){ var d = await hReadFile(a); await hWriteFile(b, d); await hUnlink(a); }),
      copyFile: A(copyFileSync, async function(a,b){ await hWriteFile(b, await hReadFile(a)); }),
      stat: A(statSync, hStat), lstat: A(statSync, hStat),
      readlink: A(readlinkSync, async function(p){ return readlinkSync(p); }),
      symlink: A(symlinkSync, async function(t,p){ await hWriteFile(p, String(t)); }),
      realpath: A(realpathSync, async function(p){ if (!(await hExists(p))) throw ENOENT(norm(p)); return norm(p); }),
      access: A(function(p){ if (!existsSync(p)) throw ENOENT(norm(p)); }, async function(p){ if (!(await hExists(p))) throw ENOENT(norm(p)); }),
    },
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_TRUNC: 512, O_APPEND: 1024, COPYFILE_EXCL: 1 },
    Stats: function(){},
  };
  globalThis.__builtins.fs = fs;
  globalThis.__builtins['node:fs'] = fs;
  globalThis.__builtins['fs/promises'] = fs.promises;
  globalThis.fs = fs;
})();
// ===== END IN-HEAP VIRTUAL FILESYSTEM =====

// use(name) — load an npm package at RUNTIME by fetching a pre-bundled CDN build (the "bundler"
// is jsDelivr/esm.sh) and evaluating it into the heap. Handles CJS (module.exports) and UMD
// (attaches a global). The bundle frame is given a working `require` (built-in shims + the use()
// cache), so a self-contained CJS bundle that requires e.g. 'crypto' resolves. Result is cached in
// globalThis.__mods and snapshot-persists, so a cold wake keeps the module without re-fetching.
// ASYNC (the VM has no synchronous host IO), so use `const _ = await use('lodash')`. Determinism:
// source eval adds no entropy; pin a version with `use('lodash@4.17.21')`. Requires the package
// host on the fetch allowlist (e.g. cdn.jsdelivr.net). NOT require() (sync) and does NOT resolve
// nested ESM imports — it works for the large set of libraries that ship a self-contained
// CJS/UMD bundle (deps either inlined or limited to the built-in shims above).
globalThis.use = async function(name, opts){
  opts = opts || {};
  if (globalThis.__mods[name] !== undefined) return globalThis.__mods[name];
  // CANDIDATE URL CHAIN (WAVE 4 hardening): try CDNs that emit SELF-CONTAINED CJS so an ESM-only
  // npm package does not SyntaxError in the CJS frame. esm.sh `?bundle&cjs` inlines deps + emits a
  // CommonJS module; jsDelivr serves the package's own `main` (usually UMD/CJS). An explicit
  // opts.url overrides the chain. We read the FULL bytes (bodyB64), NOT the capped utf8 `body`
  // preview — a real bundle is far larger than the 64KB preview, so reading `body` truncated it.
  function decodeFull(r){ if (typeof r.bodyB64 === 'string'){ var bin = atob(r.bodyB64); var u8 = new Uint8Array(bin.length); for (var i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i); return new TextDecoder().decode(u8); } return r.body || ''; }
  var urls = opts.url ? [opts.url] : [
    'https://esm.sh/' + name + '?bundle&cjs&target=es2022',
    'https://cdn.jsdelivr.net/npm/' + name,
  ];
  var src = null, usedUrl = null, lastErr = null, lastStatus = 0;
  for (var ui=0; ui<urls.length; ui++){
    try {
      var r = await globalThis.host.fetch(urls[ui]);
      if (r && r.ok){ src = decodeFull(r); usedUrl = urls[ui]; break; }
      lastStatus = (r && r.status) || 0;
    } catch(e){ lastErr = e; }
  }
  if (src === null) throw new Error('use("' + name + '"): fetch failed (status ' + lastStatus + (lastErr ? ', ' + (lastErr.message || lastErr) : '') + ') from ' + JSON.stringify(urls) + '. Check the package name + that the CDN host is on the fetch allowlist.');
  var before = new Set(Object.getOwnPropertyNames(globalThis));
  var module = { exports: {} };
  // CJS frame (with require + Buffer + process + __dirname/__filename in scope); a UMD bundle with
  // no module system attaches a global instead, which we detect by diffing globalThis.
  var frame;
  try {
    frame = (0, eval)('(function(module, exports, require, Buffer, process, global, __dirname, __filename){\n' + src + '\n})');
  } catch(e){
    // A compile error here is almost always raw ESM (`export`/`import` at top level) that the CJS
    // frame cannot parse. Surface an ACTIONABLE error naming the cause + the esm.sh ?bundle fix.
    var isEsm = /\b(export\s+(default|const|function|class|\{|\*)|import\s+[\s\S]*?from|import\s*\()/.test(src);
    if (isEsm) throw new Error('use("' + name + '"): the bundle from ' + usedUrl + ' is ES MODULE syntax (export/import), which this CJS loader cannot eval. Retry with a CJS build: use("' + name + '", { url: "https://esm.sh/' + name + '?bundle&cjs" }), or pick a package that ships a UMD/CJS bundle. (The async ESM module loader is not yet wired — see __nodeCompat.caveats.)');
    throw new Error('use("' + name + '"): bundle from ' + usedUrl + ' failed to compile: ' + (e && e.message || e));
  }
  try {
    frame(module, module.exports, globalThis.require, globalThis.Buffer, globalThis.process, globalThis, '/', '/index.js');
  } catch(e){
    // A RUNTIME error inside the bundle frame: most often a missing builtin the CJS frame needs.
    // require() already throws an ENUMERATED message listing builtins; re-surface with use() context.
    throw new Error('use("' + name + '"): bundle from ' + usedUrl + ' threw while initialising: ' + (e && e.message || e));
  }
  var val;
  if (module.exports && (typeof module.exports === 'function' || Object.keys(module.exports).length)) {
    val = module.exports;
  } else {
    for (var k of Object.getOwnPropertyNames(globalThis)) { if (!before.has(k)) { val = globalThis[k]; break; } }
  }
  if (opts.global) val = globalThis[opts.global];
  // cache under the requested spec AND its bare basename so require('pkg') resolves post-use().
  globalThis.__mods[name] = val;
  var base = String(name).split('@')[0].split('/').pop();
  if (base && globalThis.__mods[base] === undefined) globalThis.__mods[base] = val;
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

// __hasTopLevelReturn(src): true iff `src` contains a `return` KEYWORD at brace-depth 0 (a
// top-level return statement). A depth-0, string/template/regex/line+block-comment-aware token
// scan — so `return` inside a nested function, a string, or a regex is IGNORED. Used by the cell
// driver to route a top-level-`return` cell to the async-function-BODY form (which yields the
// return value) instead of the global-eval form (which SyntaxErrors on a top-level return).
// Conservative: on any scan ambiguity it returns false (cell falls through to the existing paths,
// preserving today's behaviour). Pure, deterministic, snapshot-persisted.
globalThis.__hasTopLevelReturn = function(src){
  if (typeof src !== 'string' || src.indexOf('return') < 0) return false;
  try {
    var n = src.length, i = 0, depth = 0, prev = 'start';
    var idStart = function(c){ return /[A-Za-z_$]/.test(c); };
    var idPart  = function(c){ return /[A-Za-z0-9_$]/.test(c); };
    while (i < n) {
      var c = src[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      if (c === '/' && src[i+1] === '/') { i += 2; while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i+1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i+1] === '/')) i++; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') {
        var q = c; i++;
        while (i < n) { var d = src[i]; if (d === '\\') { i += 2; continue; } if (d === q) { i++; break; } if (d === '\n' && q !== '`') return false; i++; }
        prev = 'val'; continue;
      }
      if (c === '/') {
        var rxOk = prev === 'start' || prev === 'op' || prev === 'kw' || prev === 'open' || prev === 'semi';
        if (rxOk) { i++; var inCls = false; while (i < n) { var e = src[i]; if (e === '\\') { i += 2; continue; } if (e === '[') inCls = true; else if (e === ']') inCls = false; else if (e === '/' && !inCls) { i++; break; } else if (e === '\n') return false; i++; } while (i < n && idPart(src[i])) i++; prev = 'val'; continue; }
        i++; prev = 'op'; continue;
      }
      if (c === '(' || c === '[' || c === '{') { depth++; i++; prev = 'open'; continue; }
      if (c === ')' || c === ']' || c === '}') { depth--; if (depth < 0) return false; i++; prev = 'val'; continue; }
      if (c === ';') { i++; prev = 'semi'; continue; }
      if (c === ',') { i++; prev = 'op'; continue; }
      if (idStart(c)) {
        var s = i; i++; while (i < n && idPart(src[i])) i++;
        var w = src.slice(s, i);
        if (w === 'return' && depth === 0) return true;
        prev = (w === 'return' || w === 'typeof' || w === 'instanceof' || w === 'in' || w === 'of' || w === 'new' || w === 'delete' || w === 'void' || w === 'yield' || w === 'await' || w === 'case' || w === 'do' || w === 'else' || w === 'throw') ? 'kw' : 'val';
        continue;
      }
      i++; prev = 'op';
    }
  } catch (e) { return false; }
  return false;
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
                    // (2) Multi-statement cell that USES await OR has a TOP-LEVEL `return`: compile as
                    // an async function BODY (top-level await works inside it; a top-level `return
                    // <expr>` becomes the completion value instead of SyntaxError-ing under the
                    // global-eval path (3), which forbids `return` outside a function). Declarations
                    // are function-scoped, so the REPL persistence contract is `globalThis.x = ...`
                    // (the host-side transform already globalizes top-level let/const/function/class
                    // before the engine sees the cell, so persistence is preserved in the deployed
                    // path). __hasTopLevelReturn is a depth-0, string/regex/comment-aware scan so a
                    // `return` nested in a function/string never mis-triggers this (that case still
                    // takes path (1) or (3) and keeps its trailing-expression completion value).
                    if (!fn && (/\bawait\b/.test(globalThis.__cellSrc) || globalThis.__hasTopLevelReturn(globalThis.__cellSrc))) {
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
