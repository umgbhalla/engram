// worker.mjs — standalone minimal Durable Object that runs the COMBINED durability
// stack (W5 compaction + W4 byte-delta + E6 oplog) on REAL Cloudflare so the bake-off
// claims can be measured. Modeled on the v1.2 facet KernelDO style but standalone.
//
// Bindings (wrangler.jsonc): KERNEL_DO (this DO), SNAPSHOTS (R2 engram-snapshots, keys
// strictly under bench/<doId>/), DO-SQLite for chunked snapshots + delta rows + oplog.
//
// HTTP endpoints (all on the DO via the entry fetch -> stub):
//   POST /run     {workload}  run a standard workload (light/spike/churn/long/bigctx),
//                             checkpointing each cell, forcing one evict+cold-restore at
//                             the workload's midpoint, then verifying fidelity.
//   POST /evict               force in-memory VM drop (genuine eviction).
//   POST /restore             cold-restore + {readMs,gunzipMs,instantiateMs,blitMs,totalMs}
//                             + restoreSource.
//   GET  /metrics             {bytesWritten:{sqlite,r2}, peakImage, deltaCount, oplogLen,...}

import { QuickJS } from "quickjs-wasi";
import { DOStore } from "./store.mjs";
import { Session } from "./session.mjs";
import combined from "./combined.mjs";
import { WORKLOADS, ALIASES } from "./workloads.mjs";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class KernelDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.doId = ctx.id.toString();
    this.store = new DOStore(ctx.storage.sql, env.SNAPSHOTS, `bench/${this.doId}/`);

    // live session state (lost on eviction; durable bits live in this.store)
    this.session = null; // Session | null
    this.generation = 0; // monotonic checkpoint counter
    this.prevImage = null; // previous heapImage (W4 delta reference)
    this.lastStored = null; // token from last onCheckpoint (for /restore)
    this.hostState = {}; // host kv etc.

    // metrics accumulators (per current workload run / lifetime of the DO instance)
    this.peakImageBytes = 0;
    this.peakUsedHeap = 0;
    this.deltaCount = 0;
    this.rebaseCount = 0;
    this.oplogLen = 0;
    this.lastWorkload = null;
    this.cellsRun = 0;

    this.key = `s/${this.doId}`; // strategy session key

    // unique per-instance birth tag (proves a GENUINE reconstruction: a new isolate
    // gets a new tag). Reconstruction count is persisted in ctx.storage.
    this._instanceTag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._ctorTag = this._instanceTag;
    this.ctx.blockConcurrencyWhile(async () => {
      const n = (await this.ctx.storage.get("_ctor_count")) || 0;
      this._ctorCount = n + 1;
      await this.ctx.storage.put("_ctor_count", this._ctorCount);
    });
  }

  // ---- one cell: eval, snapshot, checkpoint through the combined strategy ----
  async _checkpointCell(src) {
    const t0 = Date.now();
    this.session.eval(src);
    const curImage = this.session.dump();
    const usedHeap = this.session.usedHeap();
    if (curImage.byteLength > this.peakImageBytes) this.peakImageBytes = curImage.byteLength;
    if (usedHeap > this.peakUsedHeap) this.peakUsedHeap = usedHeap;

    this.generation++;
    const ctx = { key: this.key, generation: this.generation };
    const hostState = { ...this.hostState, __src: src, __usedHeap: usedHeap, __rng: this.generation };
    const res = await combined.onCheckpoint(this.prevImage, curImage, hostState, this.store, ctx);

    this.prevImage = curImage;
    this.lastStored = res.stored;
    if (res.rebased) this.rebaseCount++;
    else this.deltaCount++;
    this.oplogLen = res.oplogLen;
    this.cellsRun++;
    return { ms: Date.now() - t0, rebased: res.rebased, chainLen: res.chainLen, bytes: res.bytes, rawImageBytes: curImage.byteLength };
  }

  // ---- genuine eviction: drop in-memory VM + strategy base cache ----
  _evict() {
    if (this.session) this.session.dispose();
    this.session = null;
    this.prevImage = null;
    combined.evict(this.key); // force the strategy to re-read durable base on restore
  }

  // ---- cold-restore: rebuild a fresh VM from durable storage ----
  async _restore() {
    const total0 = Date.now();
    const ctx = { key: this.key, generation: this.generation };

    // 1. read durable bytes + replay delta chain -> heapImage (readMs / gunzipMs)
    const r = await combined.onRestore(this.lastStored, this.store, ctx);
    const image = r.image;
    this.hostState = r.hostState || {};

    // restoreSource: r2 if the base manifest row routed to R2, else sqlite
    const baseWhere = await this._baseRouting();
    const restoreSource = baseWhere === "r2" ? "r2-restore" : "sqlite-restore";

    // 2. instantiate a fresh VM + blit the heap image. quickjs-wasi folds module
    // instantiation + memory blit into QuickJS.restore(); we split the timing into
    // deserialize (instantiateMs proxy) vs restore (blitMs) for the breakdown.
    const inst0 = Date.now();
    const snap = QuickJS.deserializeSnapshot(image);
    const instantiateMs = Date.now() - inst0;
    const blit0 = Date.now();
    this.session = new Session();
    this.session.vm = await QuickJS.restore(snap, this.session._opts());
    this.session.generation = ++this.generation;
    const blitMs = Date.now() - blit0;

    this.prevImage = image; // re-establish delta reference (byte-identical image)

    return {
      restoreSource,
      readMs: r.timings.readMs,
      gunzipMs: r.timings.gunzipMs,
      instantiateMs,
      blitMs,
      totalMs: Date.now() - total0,
      chainLen: r.chainLen,
      imageBytes: image.byteLength,
      generation: this.generation,
    };
  }

  async _baseRouting() {
    if (!this.lastStored) return "sqlite";
    const mBytes = await this.store.getRaw(this.lastStored.manifestKey);
    if (!mBytes) return "sqlite";
    const man = JSON.parse(new TextDecoder().decode(mBytes));
    const rows = [
      ...this.ctx.storage.sql.exec(`SELECT where_ FROM blob_manifest WHERE key = ?`, man.baseKey),
    ];
    return rows.length ? rows[0].where_ : "sqlite";
  }

  // ---- run a full standard workload with one mid-run evict+restore ----
  async _run(workloadName) {
    const name = ALIASES[workloadName] || workloadName;
    const gen = WORKLOADS[name];
    if (!gen) {
      return json({ ok: false, error: `unknown workload '${workloadName}'`, known: Object.keys(ALIASES) }, 400);
    }
    const wl = gen();

    // fresh durable + in-memory state for a clean measurement
    await this._reset();
    this.lastWorkload = name;
    this.store.resetCounters();

    this.session = new Session();
    await this.session.create();
    this.generation = 0;

    const cellTimings = [];
    let restoreReport = null;

    for (let i = 0; i < wl.cells.length; i++) {
      const cp = await this._checkpointCell(wl.cells[i]);
      cellTimings.push(cp.ms);
      // force genuine evict + cold-restore at the workload's defined midpoint
      if (i + 1 === wl.evictAfter) {
        this._evict();
        restoreReport = await this._restore();
      }
    }

    // FIDELITY gate: eval the check expr, deep-compare to expected
    const got = this.session.eval(wl.check);
    const fidelity = String(got) === String(wl.expected);

    const st = this.store.stats();
    return json({
      ok: true,
      workload: name,
      cells: wl.cells.length,
      fidelity,
      check: { got: String(got), expected: wl.expected },
      restore: restoreReport,
      bytesWritten: { total: st.bytesWritten, sqlite: st.sqliteBytes, r2: st.r2Bytes },
      peakImage: this.peakImageBytes,
      peakUsedHeap: this.peakUsedHeap,
      deltaCount: this.deltaCount,
      rebaseCount: this.rebaseCount,
      oplogLen: this.oplogLen,
      generation: this.generation,
      cellMsTotal: cellTimings.reduce((a, b) => a + b, 0),
    });
  }

  // ---- BASELINE: full gzipped image stored EVERY cell (the naive strategy the
  // Combined stack is compared against). Measures real durable bytes written so the
  // reduction ratio = baselineBytes / combinedBytes is a REAL on-CF number. ----
  async _baseline(workloadName) {
    const name = ALIASES[workloadName] || workloadName;
    const gen = WORKLOADS[name];
    if (!gen) return json({ ok: false, error: `unknown workload '${workloadName}'` }, 400);
    const wl = gen();

    const s = new Session();
    await s.create();
    this.store.resetCounters();
    const key = `baseline/${this.doId}`;
    let cells = 0;
    let peakImage = 0;
    for (const src of wl.cells) {
      s.eval(src);
      const img = s.dump();
      if (img.byteLength > peakImage) peakImage = img.byteLength;
      // naive: gzip the WHOLE image and store it every cell (overwrite same key)
      await this.store.putSnapshot(`${key}/img`, img);
      cells++;
    }
    const got = s.eval(wl.check);
    const fidelity = String(got) === String(wl.expected);
    s.dispose();
    const st = this.store.stats();
    // clean up the baseline blob
    await this.store.deleteSnapshot(`${key}/img`);
    return json({
      ok: true,
      mode: "baseline-full-image-every-cell",
      workload: name,
      cells,
      fidelity,
      bytesWritten: { total: st.bytesWritten, sqlite: st.sqliteBytes, r2: st.r2Bytes },
      peakImage,
    });
  }

  // ---- LIMITS probe: drive workerd-specific edges the sim cannot. ----
  // mode: "tightloop" (interrupt-throttle), "alloc" (large allocation / OOM),
  // "guard" (confirm combined-stack guards still admit/reject correctly).
  async _limits(body) {
    const mode = body.mode || "tightloop";
    const s = new Session();
    await s.create();
    const out = { ok: true, mode };
    const t0 = Date.now();
    try {
      if (mode === "tightloop") {
        // QuickJS has no interrupt handler wired in this bench Session, so a tight
        // loop runs to completion or hits the workerd CPU/wall limit. Drive a large
        // bounded loop and a heavier one to observe where workerd cuts us off.
        const iters = body.iters || 50_000_000;
        const r = s.eval(`var n=0; for(let i=0;i<${iters};i++){ n+=i; } n`);
        out.loopResult = String(r);
        out.iters = iters;
        out.elapsedMs = Date.now() - t0;
        out.note = "bench Session has no host interrupt; loop ran to completion or workerd killed isolate (1006/exceeded CPU)";
      } else if (mode === "alloc") {
        // Large allocation inside the VM -> grows WASM linear memory monotonically.
        const mb = body.mb || 64;
        const r = s.eval(
          `var blobs=[]; for(let i=0;i<${mb};i++){ blobs.push("x".repeat(1024*1024)); } blobs.length`,
        );
        const used = s.usedHeap();
        const buf = s.bufferBytes();
        out.allocMb = mb;
        out.blobs = String(r);
        out.usedHeap = used;
        out.bufferBytes = buf;
        // now try to snapshot it -> this is the dump that can WS-1006 the DO at scale
        const img = s.dump();
        out.imageBytes = img.byteLength;
        const gzed = await (await import("./store.mjs")).gz(img);
        out.imageGzBytes = gzed.byteLength;
        out.elapsedMs = Date.now() - t0;
      } else if (mode === "guard") {
        // Confirm the size-admission guard the combined stack relies on: used-heap.
        const mb = body.mb || 8;
        s.eval(`var g=[]; for(let i=0;i<${mb};i++){ g.push("z".repeat(1024*1024)); } g.length`);
        const used = s.usedHeap();
        const buf = s.bufferBytes();
        const MAX_DUMP = 18 * 1024 * 1024;
        out.usedHeap = used;
        out.bufferBytes = buf;
        out.wouldAdmit = used < MAX_DUMP;
        out.guardCeilingBytes = MAX_DUMP;
        out.elapsedMs = Date.now() - t0;
      } else {
        out.ok = false;
        out.error = `unknown limits mode '${mode}'`;
      }
    } catch (e) {
      out.ok = false;
      out.threw = true;
      out.error = String((e && e.message) || e);
      out.elapsedMs = Date.now() - t0;
    } finally {
      try { s.dispose(); } catch {}
    }
    return json(out);
  }

  async _reset() {
    if (this.session) this.session.dispose();
    this.session = null;
    this.prevImage = null;
    this.lastStored = null;
    this.hostState = {};
    this.generation = 0;
    this.peakImageBytes = 0;
    this.peakUsedHeap = 0;
    this.deltaCount = 0;
    this.rebaseCount = 0;
    this.oplogLen = 0;
    this.cellsRun = 0;
    combined._st.delete(this.key);
    // wipe durable blobs for this session key (R2 + SQLite) so a re-run is clean
    const rows = [...this.ctx.storage.sql.exec(`SELECT key, where_, r2_key FROM blob_manifest`)];
    for (const r of rows) {
      if (r.where_ === "r2" && r.r2_key) await this.env.SNAPSHOTS.delete(r.r2_key);
    }
    this.ctx.storage.sql.exec(`DELETE FROM blob_chunk`);
    this.ctx.storage.sql.exec(`DELETE FROM blob_manifest`);
  }

  async _metrics() {
    const st = this.store.stats();
    return json({
      ok: true,
      lastWorkload: this.lastWorkload,
      bytesWritten: { total: st.bytesWritten, sqlite: st.sqliteBytes, r2: st.r2Bytes },
      bytesRead: st.bytesRead,
      peakImage: this.peakImageBytes,
      peakUsedHeap: this.peakUsedHeap,
      deltaCount: this.deltaCount,
      rebaseCount: this.rebaseCount,
      oplogLen: this.oplogLen,
      generation: this.generation,
      cellsRun: this.cellsRun,
      inMemory: this.session !== null,
      putCount: st.putCount,
      getCount: st.getCount,
      deleteCount: st.deleteCount,
    });
  }

  // ===== GENUINE-EVICTION compaction test (M2 / W5) =========================
  // Phase 1: run W-spike (grow ~48MB then free), checkpoint each cell through the
  // combined stack, PERSIST durable pointers to ctx.storage so a genuinely
  // reconstructed instance can cold-restore. Records whether baseline (18MB raw
  // dump ceiling) would wedge on the peak cell.
  async _spike(spikeMb = 48, kind = "repeat") {
    await this._reset();
    this.lastWorkload = "W-spike";
    this.store.resetCounters();
    this.session = new Session();
    await this.session.create();
    this.generation = 0;

    // parametric spike: grow `spikeMb` MB then free. kind="repeat" uses highly
    // compressible "x".repeat(1MB) strings (the standard W-spike content, which
    // gzips to ~nothing); kind="entropy" fills each MB with unique per-index bytes
    // (incompressible) to faithfully reproduce the sim's reclaim measurement, which
    // used unique-suffix strings.
    const allocCell =
      kind === "entropy"
        ? `var big = []; for (let i=0;i<${spikeMb};i++){ var s=""; for(let j=0;j<131072;j++){ s += String.fromCharCode((i*2654435761 + j*2246822519) & 0xff, ((i*40503+j*12345)>>3)&0xff, (i^j^(j<<3))&0xff, (i*7+j*131)&0xff, (j*5)&0xff, (i+j)&0xff, (j>>2)&0xff, (i*13)&0xff); } big.push(s); }`
        : `var big = []; for (let i=0;i<${spikeMb};i++){ big.push("x".repeat(1024*1024)); }`;
    const wl = {
      cells: [
        'var keep = "anchor";',
        allocCell,
        "var bigLen = big.length; var bigBytes = big.reduce((s,x)=>s+x.length,0);",
        "big = null;",
        'var afterFree = keep + ":freed";',
      ],
      check: "JSON.stringify({bigLen, afterFree})",
      expected: JSON.stringify({ bigLen: spikeMb, afterFree: "anchor:freed" }),
    };
    const perCell = [];
    let peakBufferBytes = 0;
    for (let i = 0; i < wl.cells.length; i++) {
      const cp = await this._checkpointCell(wl.cells[i]);
      const bufBytes = this.session.bufferBytes();
      if (bufBytes > peakBufferBytes) peakBufferBytes = bufBytes;
      perCell.push({
        cell: i,
        usedHeap: this.session.usedHeap(),
        bufferBytes: bufBytes,
        rawImageBytes: cp.rawImageBytes,
        rebased: cp.rebased,
        chainLen: cp.chainLen,
        storedBytes: cp.bytes,
      });
    }

    const BASELINE_DUMP_CEIL = 18 * 1024 * 1024;
    const peakRawImage = Math.max(...perCell.map((c) => c.rawImageBytes));
    const finalRawImage = perCell[perCell.length - 1].rawImageBytes;
    const baselineWouldWedge = peakRawImage > BASELINE_DUMP_CEIL;

    await this.ctx.storage.put("_bench_state", {
      lastStored: this.lastStored,
      generation: this.generation,
      key: this.key,
      check: wl.check,
      expected: wl.expected,
      peakImageBytes: this.peakImageBytes,
      peakUsedHeap: this.peakUsedHeap,
      peakBufferBytes,
      spikeInstanceTag: this._instanceTag,
    });

    const st = this.store.stats();
    return json({
      ok: true,
      phase: "spike+checkpoint",
      instanceTag: this._instanceTag,
      ctorCount: this._ctorCount,
      cells: wl.cells.length,
      perCell,
      baseline: {
        dumpCeilBytes: BASELINE_DUMP_CEIL,
        peakRawImageBytes: peakRawImage,
        finalRawImageBytes: finalRawImage,
        baselineWouldWedge,
        note: baselineWouldWedge
          ? "baseline 18MB raw-dump ceiling would REFUSE the peak-cell checkpoint -> wedge"
          : "peak image under baseline ceiling",
      },
      combinedAdmitted: true,
      bytesWritten: { total: st.bytesWritten, sqlite: st.sqliteBytes, r2: st.r2Bytes },
      peakImage: this.peakImageBytes,
      peakUsedHeap: this.peakUsedHeap,
      peakBufferBytes,
      deltaCount: this.deltaCount,
      rebaseCount: this.rebaseCount,
      generation: this.generation,
    });
  }

  // Phase 3 (after GENUINE eviction): rehydrate durable pointers, cold-restore,
  // verify fidelity, report reclaim numbers.
  async _coldRestore() {
    const bs = await this.ctx.storage.get("_bench_state");
    if (!bs) return json({ ok: false, error: "no persisted bench state; run /spike first" }, 400);
    if (this.session) return json({ ok: false, error: "still in memory; /abort first" }, 400);

    const genuine = bs.spikeInstanceTag && bs.spikeInstanceTag !== this._instanceTag;

    this.lastStored = bs.lastStored;
    this.generation = bs.generation;
    this.key = bs.key;
    combined.evict(this.key);

    const rep = await this._restore();

    let got, checkErr = null, probe = {};
    try {
      probe.keep = String(this.session.eval("typeof keep + ':' + keep"));
      probe.afterFree = String(this.session.eval("typeof afterFree"));
      probe.bigLen = String(this.session.eval("typeof bigLen + ':' + bigLen"));
      probe.bigBytes = String(this.session.eval("typeof bigBytes"));
    } catch (e) { probe.err = String(e && e.message || e); }
    try {
      got = this.session.eval(bs.check);
    } catch (e) { checkErr = String(e && e.message || e); got = undefined; }
    const fidelity = checkErr === null && String(got) === String(bs.expected);

    const restoredBufferBytes = this.session.bufferBytes();
    const restoredUsedHeap = this.session.usedHeap();
    const peakBufferBytes = bs.peakBufferBytes || 0;

    // FRESH-INSTANCE COMPACTION probe (the sim's W5 reclaim mechanism): re-snapshot
    // the freshly restored VM (which now holds only the post-free live set ~66KB).
    // If quickjs-wasi's snapshot serializes only the live linear pages, the re-dump
    // shrinks; if it serializes the whole monotonic buffer, it stays at high-water.
    this.session.vm.runGC();
    const reDump = this.session.dump();
    const reBuffer = this.session.bufferBytes();
    const reUsed = this.session.usedHeap();
    const reGz = (await import("./store.mjs")).gz;
    const reDumpGz = (await reGz(reDump)).byteLength;
    const peakGzApprox = null; // not stored; compare to base.gz via inspect if needed
    const freshCompaction = {
      reDumpRawBytes: reDump.byteLength,
      reBufferBytes: reBuffer,
      reUsedHeap: reUsed,
      reDumpGzBytes: reDumpGz,
      bufReclaimVsPeakPct:
        peakBufferBytes > 0 ? Number(((1 - reBuffer / peakBufferBytes) * 100).toFixed(2)) : 0,
      rawReclaimVsRestoredPct:
        rep.imageBytes > 0 ? Number(((1 - reDump.byteLength / rep.imageBytes) * 100).toFixed(2)) : 0,
    };
    const reclaimPctBuffer =
      peakBufferBytes > 0 ? (1 - restoredBufferBytes / peakBufferBytes) * 100 : 0;
    const reclaimPctImage =
      bs.peakImageBytes > 0 ? (1 - rep.imageBytes / bs.peakImageBytes) * 100 : 0;

    return json({
      ok: true,
      phase: "genuine-cold-restore",
      genuineEviction: !!genuine,
      spikeInstanceTag: bs.spikeInstanceTag,
      restoreInstanceTag: this._instanceTag,
      ctorCount: this._ctorCount,
      fidelity,
      check: { got: String(got), expected: bs.expected, checkErr, probe },
      restore: rep,
      reclaim: {
        peakImageBytes: bs.peakImageBytes,
        restoredImageBytes: rep.imageBytes,
        reclaimPctImage: Number(reclaimPctImage.toFixed(2)),
        peakBufferBytes,
        restoredBufferBytes,
        reclaimPctBuffer: Number(reclaimPctBuffer.toFixed(2)),
        peakUsedHeap: bs.peakUsedHeap,
        restoredUsedHeap,
        reclaimPctUsedHeap:
          bs.peakUsedHeap > 0
            ? Number(((1 - restoredUsedHeap / bs.peakUsedHeap) * 100).toFixed(2))
            : 0,
      },
      freshCompaction,
      generation: this.generation,
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/spike") {
        const body = await request.json().catch(() => ({}));
        return await this._spike(body.spikeMb || 48, body.kind || "repeat");
      }
      if (request.method === "POST" && url.pathname === "/abort") {
        const reply = json({ ok: true, aborting: true, instanceTag: this._instanceTag });
        // GENUINE eviction: ctx.abort() destroys the in-memory isolate (session +
        // module-global combined._st cache). The next request reconstructs the DO
        // (new instanceTag, bumped _ctor_count). Durable SQLite/R2 + ctx.storage survive.
        this.ctx.abort("bench-genuine-eviction");
        return reply;
      }
      if (request.method === "POST" && url.pathname === "/hardevict") {
        // Faithful genuine-eviction PROXY without ctx.abort (which triggers a
        // workerd request-replay that corrupts the bench). Reproduces the exact
        // state a freshly reconstructed isolate has: session disposed, the
        // module-global combined._st cache entry DELETED (so onRestore must read
        // 100% from durable SQLite/R2), and all in-memory pointers cleared. Only
        // the literal new-isolate identity differs (ctx.abort already proved that
        // genuinely happens: instanceTag + ctorCount bump).
        const wasIn = this.session !== null;
        if (this.session) this.session.dispose();
        this.session = null;
        this.prevImage = null;
        this.lastStored = null;
        this.generation = 0;
        const bs = await this.ctx.storage.get("_bench_state");
        if (bs) combined._st.delete(bs.key);
        return json({ ok: true, hardEvicted: wasIn, inMemory: false, stCacheCleared: true });
      }
      if (request.method === "POST" && url.pathname === "/cold-restore") {
        return await this._coldRestore();
      }
      if (request.method === "GET" && url.pathname === "/inspect") {
        const bs = await this.ctx.storage.get("_bench_state");
        const out = { ok: true, bench_state: bs };
        if (bs && bs.lastStored) {
          const mB = await this.store.getRaw(bs.lastStored.manifestKey);
          out.manifest = mB ? JSON.parse(new TextDecoder().decode(mB)) : null;
          out.manifestRows = [...this.ctx.storage.sql.exec(`SELECT key, where_, n_bytes, n_chunks FROM blob_manifest ORDER BY key`)];
          if (out.manifest) {
            const baseRow = [...this.ctx.storage.sql.exec(`SELECT key, where_, n_bytes FROM blob_manifest WHERE key = ?`, out.manifest.baseKey)];
            out.baseRow = baseRow[0] || null;
          }
        }
        return json(out);
      }
      if (request.method === "GET" && url.pathname === "/genuine-info") {
        const bs = await this.ctx.storage.get("_bench_state");
        return json({
          ok: true,
          inMemory: this.session !== null,
          instanceTag: this._instanceTag,
          ctorCount: this._ctorCount,
          hasPersistedState: !!bs,
          spikeInstanceTag: bs ? bs.spikeInstanceTag : null,
        });
      }
      if (request.method === "POST" && url.pathname === "/run") {
        const body = await request.json().catch(() => ({}));
        return await this._run(body.workload || "light");
      }
      if (request.method === "POST" && url.pathname === "/baseline") {
        const body = await request.json().catch(() => ({}));
        return await this._baseline(body.workload || "long");
      }
      if (request.method === "POST" && url.pathname === "/limits") {
        const body = await request.json().catch(() => ({}));
        return await this._limits(body);
      }
      if (request.method === "POST" && url.pathname === "/evict") {
        const wasIn = this.session !== null;
        this._evict();
        return json({ ok: true, evicted: wasIn, inMemory: false });
      }
      if (request.method === "POST" && url.pathname === "/restore") {
        if (!this.lastStored) return json({ ok: false, error: "nothing checkpointed yet" }, 400);
        if (this.session) return json({ ok: false, error: "still in memory; /evict first" }, 400);
        const rep = await this._restore();
        return json({ ok: true, ...rep });
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        return await this._metrics();
      }
      if (url.pathname === "/health") {
        return json({ ok: true, doId: this.doId, inMemory: this.session !== null });
      }
      return json({ ok: false, error: "not found", endpoints: ["POST /run", "POST /evict", "POST /restore", "GET /metrics", "GET /health"] }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.stack || e) }, 500);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // single fixed DO instance for the bench (named "bench")
    const id = env.KERNEL_DO.idFromName("bench");
    const stub = env.KERNEL_DO.get(id);
    return stub.fetch(request);
  },
};
