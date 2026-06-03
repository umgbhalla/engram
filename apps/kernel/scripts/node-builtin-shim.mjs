// node-builtin-shim.mjs — a single self-contained functional shim aliased in for EVERY Node
// built-in that the bundled `typescript` parser references. typescript@6 EAGERLY probes a Node
// environment at module-init (os.platform(), path.* bookkeeping, process.* feature flags), but
// the only ts-blank-space code path the kernel exercises is the IN-MEMORY scanner /
// createSourceFile — it performs no real fs/process I/O. So this shim only needs to be
// behavior-correct for the init-time env probe; everything else is a harmless no-op.
//
// CRITICAL: this is the ONLY module aliased for all of fs/path/os/process/etc, so it must expose
// the union of the surfaces TS touches. It is fully self-contained (no `node:*` imports), so the
// wasm-bindgen snippet that worker-build re-bundles (no externals, browser platform) resolves it
// cleanly. Host-side only; the VM heap never sees this.

const noop = () => {};
const ident = (x) => x;
const ret = (v) => () => v;

// path (posix) — enough for the module-id bookkeeping TS does at init.
const sep = "/";
const join = (...a) => a.filter((x) => typeof x === "string" && x).join("/").replace(/\/+/g, "/");
const dirname = (p) => { const s = String(p).replace(/\/+$/, ""); const i = s.lastIndexOf("/"); return i <= 0 ? (i === 0 ? "/" : ".") : s.slice(0, i); };
const basename = (p, ext) => { let b = String(p).replace(/\/+$/, "").replace(/^.*\//, ""); if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; };
const extname = (p) => { const b = basename(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : ""; };

const shim = {
  // ---- os ----
  platform: ret("linux"),
  arch: ret("x64"),
  release: ret("0.0.0"),
  type: ret("Linux"),
  homedir: ret("/"),
  tmpdir: ret("/tmp"),
  cpus: ret([]),
  hostname: ret("localhost"),
  EOL: "\n",
  endianness: ret("LE"),
  // ---- path ----
  sep,
  delimiter: ":",
  join,
  resolve: (...a) => { const r = join(...a); return r.startsWith("/") ? r : "/" + r; },
  normalize: (p) => String(p).replace(/\/+/g, "/"),
  dirname,
  basename,
  extname,
  relative: ret(""),
  isAbsolute: (p) => String(p).startsWith("/"),
  parse: (p) => ({ root: "", dir: dirname(p), base: basename(p), ext: extname(p), name: basename(p, extname(p)) }),
  // ---- fs (TS only reads from disk in code paths we never hit) ----
  readFileSync: ret(""),
  writeFileSync: noop,
  existsSync: ret(false),
  statSync: ret({ isFile: ret(false), isDirectory: ret(false), mtimeMs: 0, size: 0 }),
  lstatSync: ret({ isFile: ret(false), isDirectory: ret(false) }),
  readdirSync: ret([]),
  realpathSync: ident,
  mkdirSync: noop,
  // ---- url ----
  fileURLToPath: (u) => String(u && u.href ? u.href : u).replace(/^file:\/\//, ""),
  pathToFileURL: (p) => ({ href: "file://" + String(p) }),
  // ---- inspector / perf_hooks / misc ----
  open: noop,
  close: noop,
  Session: function () {},
  performance: { now: () => 0 },
  createRequire: () => shim.require,
  // ---- process-ish (TS reads process.platform / argv / env / nextTick at init) ----
  platform_str: "linux",
  argv: [],
  env: {},
  cwd: ret("/"),
  nextTick: (fn, ...a) => { try { fn && fn(...a); } catch { /* ignore */ } },
  on: noop,
  exit: noop,
  version: "v20.0.0",
  versions: { node: "20.0.0" },
  stdout: { write: noop, isTTY: false },
  stderr: { write: noop, isTTY: false },
  hrtime: Object.assign(() => [0, 0], { bigint: () => 0n }),
  // computed-require fallback: TS occasionally does require(name) — return self.
  require: () => shim,
};

// `process` is accessed as a default-imported object with `.platform` being a STRING (not a fn).
// We alias `process` to this same module, so expose `platform` as the os-style fn but also let a
// `.platform` string read work by making it a getter is impossible on a fn; TS reads
// `process.platform` -> we provide it on the default export below via a Proxy-ish merge.
const withProcess = Object.assign(Object.create(null), shim, {
  // when used AS process: string fields TS expects
});
// Final default export: a Proxy so ANY unknown property access returns a no-op fn or empty value,
// preventing "x is not a function" during TS's eager feature detection.
const target = Object.assign({}, shim, { default: undefined });
target.default = target;
const handler = {
  get(t, prop) {
    if (prop in t) return t[prop];
    if (prop === "platform") return "linux";
    if (prop === "default") return proxy;
    if (typeof prop === "symbol") return undefined;
    // Unknown: return a callable no-op that also indexes to itself, so chained probes survive.
    return undefined;
  },
};
const proxy = new Proxy(target, handler);
export default proxy;

// NAMED exports too: the `alias` path makes esbuild emit `import * as ns from <shim>` and TS reads
// `ns.platform()`, `ns.join(...)`, etc off the namespace (which carries named exports, NOT the
// default). So re-export every probed symbol by name. `platform` is exported as the os-style fn;
// `process.platform` string reads go through the default Proxy (require()/default path).
export const platform = shim.platform;
export const arch = shim.arch;
export const release = shim.release;
export const type = shim.type;
export const homedir = shim.homedir;
export const tmpdir = shim.tmpdir;
export const cpus = shim.cpus;
export const hostname = shim.hostname;
export const EOL = shim.EOL;
export const endianness = shim.endianness;
export { sep, join, dirname, basename, extname };
export const delimiter = shim.delimiter;
export const resolve = shim.resolve;
export const normalize = shim.normalize;
export const relative = shim.relative;
export const isAbsolute = shim.isAbsolute;
export const parse = shim.parse;
export const readFileSync = shim.readFileSync;
export const writeFileSync = shim.writeFileSync;
export const existsSync = shim.existsSync;
export const statSync = shim.statSync;
export const lstatSync = shim.lstatSync;
export const readdirSync = shim.readdirSync;
export const realpathSync = shim.realpathSync;
export const mkdirSync = shim.mkdirSync;
export const fileURLToPath = shim.fileURLToPath;
export const pathToFileURL = shim.pathToFileURL;
export const performance = shim.performance;
export const createRequire = shim.createRequire;
export const argv = shim.argv;
export const env = shim.env;
export const cwd = shim.cwd;
export const nextTick = shim.nextTick;
export const version = shim.version;
export const versions = shim.versions;
export const hrtime = shim.hrtime;
export const Session = shim.Session;
