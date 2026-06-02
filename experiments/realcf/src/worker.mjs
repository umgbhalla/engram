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
import { gzipSync, gunzipSync } from "node:zlib";
import { DOStore, CHUNK_BYTES, gz } from "./store.mjs";
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

  // ===== R2-TAIL MITIGATION MODES ==========================================
  // Build a real QuickJS heap image of ~targetMb raw by allocating incompressible
  // (entropy) data so gzip can't cheat. Returns {image, rawBytes, usedHeap}.
  async _buildImage(targetMb) {
    const s = new Session();
    await s.create();
    // ~targetMb of unique-byte strings => incompressible, mirrors a real working set.
    const cell = `var blob=[]; for(let i=0;i<${targetMb};i++){ var s=""; for(let j=0;j<131072;j++){ s+=String.fromCharCode((i*2654435761 + j*2246822519)&0xff,((i*40503+j*12345)>>3)&0xff,(i^j^(j<<3))&0xff,(i*7+j*131)&0xff,(j*5)&0xff,(i+j)&0xff,(j>>2)&0xff,(i*13)&0xff); } blob.push(s); } blob.length`;
    s.eval(cell);
    const image = s.dump();
    const usedHeap = s.usedHeap();
    s.dispose();
    return { image, rawBytes: image.byteLength, usedHeap };
  }

  // MODE 1: HOT-TIER. Force a ~5MB gzip image to be stored SPLIT across DO-SQLite
  // 64KB rows (bypassing the >=2MB R2-overflow rule), then restore from those rows.
  // Measures whether SQLite chunked storage dodges the R2-GET cold tail entirely.
  async _hotTier(body) {
    const mb = body.mb || 5;
    const built = await this._buildImage(mb);
    const gzBytes = await gz(built.image); // platform gzip (level ~6)
    const key = `bench/${this.doId}/hottier/img`;

    // write: chunk gz bytes straight into blob_chunk (no R2, regardless of size)
    const w0 = Date.now();
    this.ctx.storage.sql.exec(`DELETE FROM blob_chunk WHERE key = ?`, key);
    let seq = 0;
    for (let i = 0; i < gzBytes.byteLength; i += CHUNK_BYTES) {
      const c = gzBytes.subarray(i, Math.min(i + CHUNK_BYTES, gzBytes.byteLength));
      this.ctx.storage.sql.exec(`INSERT INTO blob_chunk (key, seq, data) VALUES (?, ?, ?)`, key, seq, c);
      seq++;
    }
    const writeMs = Date.now() - w0;

    // read back: concat all rows -> gunzip -> deserialize -> restore VM
    const r0 = Date.now();
    const chunks = [];
    for (const r of this.ctx.storage.sql.exec(`SELECT data FROM blob_chunk WHERE key = ? ORDER BY seq`, key)) {
      chunks.push(new Uint8Array(r.data));
    }
    let total = 0; for (const c of chunks) total += c.byteLength;
    const merged = new Uint8Array(total); let o = 0;
    for (const c of chunks) { merged.set(c, o); o += c.byteLength; }
    const readMs = Date.now() - r0;

    const g0 = Date.now();
    const ds = new DecompressionStream("gzip");
    const dw = ds.writable.getWriter(); dw.write(merged); dw.close();
    const raw = new Uint8Array(await new Response(ds.readable).arrayBuffer());
    const gunzipMs = Date.now() - g0;

    const i0 = Date.now();
    const snap = QuickJS.deserializeSnapshot(raw);
    const sess = new Session();
    sess.vm = await QuickJS.restore(snap, sess._opts());
    const instantiateMs = Date.now() - i0;
    const probe = String(sess.eval("blob.length"));
    sess.dispose();
    this.ctx.storage.sql.exec(`DELETE FROM blob_chunk WHERE key = ?`, key);

    return json({
      ok: true, mode: "hot-tier-sqlite-rows", mb,
      rawImageBytes: built.rawBytes, gzBytes: gzBytes.byteLength, nRows: seq,
      restoreSource: "sqlite-restore",
      writeMs, readMs, gunzipMs, instantiateMs,
      totalRestoreMs: readMs + gunzipMs + instantiateMs,
      fidelity: probe === String(mb), probeBlobLen: probe,
      note: "gz image forced into DO-SQLite 64KB rows (no R2); restore reads rows in-turn (no network GET)",
    });
  }

  // MODE 2: chunked-parallel. Store a big gz image as K R2 objects, restore via
  // Promise.all concurrent GET. Measures whether parallel R2 GETs beat one big GET.
  async _chunkedParallel(body) {
    const mb = body.mb || 5;
    const k = body.k || 8;
    const built = await this._buildImage(mb);
    const gzBytes = await gz(built.image);
    const base = `bench/${this.doId}/chunkpar/`;
    const partLen = Math.ceil(gzBytes.byteLength / k);

    const w0 = Date.now();
    const writes = [];
    const parts = [];
    for (let i = 0; i < k; i++) {
      const start = i * partLen;
      if (start >= gzBytes.byteLength) break;
      const part = gzBytes.subarray(start, Math.min(start + partLen, gzBytes.byteLength));
      parts.push({ key: `${base}p${i}`, len: part.byteLength });
      writes.push(this.env.SNAPSHOTS.put(`${base}p${i}`, part));
    }
    await Promise.all(writes);
    const writeMs = Date.now() - w0;

    // PARALLEL restore: concurrent GET of all K objects
    const r0 = Date.now();
    const objs = await Promise.all(parts.map((p) => this.env.SNAPSHOTS.get(p.key)));
    const bufs = await Promise.all(objs.map((o) => o.arrayBuffer()));
    const readMs = Date.now() - r0;

    let total = 0; for (const b of bufs) total += b.byteLength;
    const merged = new Uint8Array(total); let o = 0;
    for (const b of bufs) { merged.set(new Uint8Array(b), o); o += b.byteLength; }

    const g0 = Date.now();
    const ds = new DecompressionStream("gzip");
    const dw = ds.writable.getWriter(); dw.write(merged); dw.close();
    const raw = new Uint8Array(await new Response(ds.readable).arrayBuffer());
    const gunzipMs = Date.now() - g0;

    const i0 = Date.now();
    const snap = QuickJS.deserializeSnapshot(raw);
    const sess = new Session();
    sess.vm = await QuickJS.restore(snap, sess._opts());
    const instantiateMs = Date.now() - i0;
    const probe = String(sess.eval("blob.length"));
    sess.dispose();

    // SEQUENTIAL baseline: one big GET of the whole gz for comparison
    const wholeKey = `${base}whole`;
    await this.env.SNAPSHOTS.put(wholeKey, gzBytes);
    const sr0 = Date.now();
    const wholeObj = await this.env.SNAPSHOTS.get(wholeKey);
    await wholeObj.arrayBuffer();
    const seqReadMs = Date.now() - sr0;

    await Promise.all([...parts.map((p) => this.env.SNAPSHOTS.delete(p.key)), this.env.SNAPSHOTS.delete(wholeKey)]);

    return json({
      ok: true, mode: "chunked-parallel-r2", mb, k: parts.length,
      rawImageBytes: built.rawBytes, gzBytes: gzBytes.byteLength, partBytes: partLen,
      restoreSource: "r2-restore",
      writeMs, parallelReadMs: readMs, seqWholeReadMs: seqReadMs,
      readSpeedupVsSeq: seqReadMs > 0 ? Number((seqReadMs / readMs).toFixed(2)) : null,
      gunzipMs, instantiateMs, totalRestoreMs: readMs + gunzipMs + instantiateMs,
      fidelity: probe === String(mb), probeBlobLen: probe,
      note: "K R2 objects fetched concurrently via Promise.all vs one whole-object GET",
    });
  }

  // MODE 3: prefer-SQLite-gz9. Compress with zlib level 9. Measure gz9 size vs the
  // platform gzip (~level 6), and whether a normally-R2 image (>=2MB gz) now fits
  // under the 2MB-gz SQLite threshold (=> dodges R2 entirely).
  async _preferGz9(body) {
    const mb = body.mb || 5;
    const built = await this._buildImage(mb);

    const p0 = Date.now();
    const gzPlatform = await gz(built.image);
    const platformMs = Date.now() - p0;

    const z0 = Date.now();
    const gz9 = gzipSync(Buffer.from(built.image.buffer, built.image.byteOffset, built.image.byteLength), { level: 9 });
    const gz9Ms = Date.now() - z0;
    const gz9u = new Uint8Array(gz9.buffer, gz9.byteOffset, gz9.byteLength);

    const THRESH = 2 * 1024 * 1024;
    const platformWouldR2 = gzPlatform.byteLength >= THRESH;
    const gz9WouldR2 = gz9u.byteLength >= THRESH;
    const nowFitsSqlite = platformWouldR2 && !gz9WouldR2;

    // verify gz9 round-trips and the route it would take (sqlite vs r2)
    const route = gz9WouldR2 ? "r2" : "sqlite";
    let fidelity = false, probe = "n/a", restoreMs = 0;
    if (route === "sqlite") {
      // store gz9 in SQLite rows, read back, gunzip via zlib, restore
      const key = `bench/${this.doId}/gz9/img`;
      this.ctx.storage.sql.exec(`DELETE FROM blob_chunk WHERE key = ?`, key);
      let seq = 0;
      for (let i = 0; i < gz9u.byteLength; i += CHUNK_BYTES) {
        const c = gz9u.subarray(i, Math.min(i + CHUNK_BYTES, gz9u.byteLength));
        this.ctx.storage.sql.exec(`INSERT INTO blob_chunk (key, seq, data) VALUES (?, ?, ?)`, key, seq, c);
        seq++;
      }
      const r0 = Date.now();
      const chunks = [];
      for (const r of this.ctx.storage.sql.exec(`SELECT data FROM blob_chunk WHERE key = ? ORDER BY seq`, key)) {
        chunks.push(new Uint8Array(r.data));
      }
      let total = 0; for (const c of chunks) total += c.byteLength;
      const merged = new Uint8Array(total); let o = 0;
      for (const c of chunks) { merged.set(c, o); o += c.byteLength; }
      const raw = gunzipSync(Buffer.from(merged.buffer, merged.byteOffset, merged.byteLength));
      const snap = QuickJS.deserializeSnapshot(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
      const sess = new Session();
      sess.vm = await QuickJS.restore(snap, sess._opts());
      probe = String(sess.eval("blob.length"));
      sess.dispose();
      restoreMs = Date.now() - r0;
      fidelity = probe === String(mb);
      this.ctx.storage.sql.exec(`DELETE FROM blob_chunk WHERE key = ?`, key);
    }

    return json({
      ok: true, mode: "prefer-sqlite-gz9", mb,
      rawImageBytes: built.rawBytes,
      platformGzBytes: gzPlatform.byteLength, platformGzMs: platformMs,
      gz9Bytes: gz9u.byteLength, gz9Ms,
      gz9ReductionVsPlatformPct: Number(((1 - gz9u.byteLength / gzPlatform.byteLength) * 100).toFixed(2)),
      sqliteThresholdBytes: THRESH,
      platformRoute: platformWouldR2 ? "r2" : "sqlite",
      gz9Route: route,
      nowFitsSqlite,
      restoreMsSqlite: restoreMs, fidelity, probeBlobLen: probe,
      note: nowFitsSqlite
        ? "gz9 shrank a normally-R2 image under 2MB => routes to SQLite, dodges R2 cold GET"
        : "gz9 did not change the routing tier for this size",
    });
  }

  // ===== BAKE-OFF: HOT-TIER (DO-SQLite rows) vs R2 restore, SAME 5MB image ====
  // Build ONE incompressible ~mb image, store it BOTH ways once, then loop N restore
  // reps per tier measuring totalMs = read + gunzip + deserialize + VM-restore (the
  // full path a cold wake pays in-turn). Reports both distributions (p50/p95) + the
  // SQLite-size cost of holding the gz image as 64KB rows. Apples-to-apples: identical
  // bytes, identical gunzip + deserialize + restore, only the read source differs.
  async _bakeoffRestore(body) {
    const mb = body.mb || 5;
    const n = body.n || 10;

    // 1. build ONE image, gzip it ONCE. QuickJS string heaps compress ~8:1 so a valid
    // restorable image can't reach a 5MB GZ without crossing the snapshot-dump crash
    // ceiling (~18MB raw). To faithfully measure the READ-tier cost for a ~5MB STORED
    // blob (the size the baseline measured), pad the stored payload to padToMb with
    // incompressible random bytes APPENDED after the real gz; on read we slice the real
    // gz prefix back out (4-byte LE length header) so the VM still restores correctly.
    // Both tiers store + read the identical padded blob => identical read cost.
    const padToMb = body.padToMb != null ? body.padToMb : 5;
    const built = await this._buildImage(mb);
    const realGz = await gz(built.image);
    const realGzLen = realGz.byteLength;
    const targetBytes = Math.round(padToMb * 1024 * 1024);
    const headerLen = 4;
    const padLen = Math.max(0, targetBytes - headerLen - realGzLen);
    const gzBytes = new Uint8Array(headerLen + realGzLen + padLen);
    new DataView(gzBytes.buffer).setUint32(0, realGzLen, true);
    gzBytes.set(realGz, headerLen);
    // incompressible random pad so the STORED blob ~= targetBytes (gzip can't shrink it)
    if (padLen > 0) {
      const padView = gzBytes.subarray(headerLen + realGzLen);
      for (let i = 0; i < padView.byteLength; i += 65536) {
        crypto.getRandomValues(padView.subarray(i, Math.min(i + 65536, padView.byteLength)));
      }
    }
    const gzLen = gzBytes.byteLength;
    const unpad = (blob) => {
      const n = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0, true);
      return blob.subarray(headerLen, headerLen + n);
    };

    const sqliteKey = `bench/${this.doId}/bakeoff/sqlite`;
    const r2Key = `bench/${this.doId}/bakeoff/r2`;

    // 2. store HOT-TIER (SQLite 64KB rows, forced regardless of size)
    this.ctx.storage.sql.exec(`DELETE FROM blob_chunk WHERE key = ?`, sqliteKey);
    let nRows = 0;
    for (let i = 0; i < gzLen; i += CHUNK_BYTES) {
      const c = gzBytes.subarray(i, Math.min(i + CHUNK_BYTES, gzLen));
      this.ctx.storage.sql.exec(`INSERT INTO blob_chunk (key, seq, data) VALUES (?, ?, ?)`, sqliteKey, nRows, c);
      nRows++;
    }
    // measure the SQLite holding cost (database_size delta is global; measure the rows)
    const rowBytes = [...this.ctx.storage.sql.exec(
      `SELECT SUM(LENGTH(data)) AS b, COUNT(*) AS n FROM blob_chunk WHERE key = ?`, sqliteKey)][0];
    let dbSize = null;
    try { dbSize = this.ctx.storage.sql.databaseSize; } catch {}

    // 3. store R2 (one object)
    await this.env.SNAPSHOTS.put(r2Key, gzBytes);

    const restoreFrom = async (padded) => {
      const raw = unpad(padded); // slice real gz prefix out of the padded blob
      const g0 = Date.now();
      const ds = new DecompressionStream("gzip");
      const dw = ds.writable.getWriter(); dw.write(raw); dw.close();
      const plain = new Uint8Array(await new Response(ds.readable).arrayBuffer());
      const gunzipMs = Date.now() - g0;
      const i0 = Date.now();
      const snap = QuickJS.deserializeSnapshot(plain);
      const sess = new Session();
      sess.vm = await QuickJS.restore(snap, sess._opts());
      const instantiateMs = Date.now() - i0;
      const probe = String(sess.eval("blob.length"));
      sess.dispose();
      return { gunzipMs, instantiateMs, fidelity: probe === String(mb) };
    };

    const sqliteReps = [];
    const r2Reps = [];
    let fidelityOk = true;

    for (let rep = 0; rep < n; rep++) {
      // --- HOT-TIER restore: read rows in-turn, no network ---
      {
        const t0 = Date.now();
        const r0 = Date.now();
        const chunks = [];
        for (const r of this.ctx.storage.sql.exec(`SELECT data FROM blob_chunk WHERE key = ? ORDER BY seq`, sqliteKey)) {
          chunks.push(new Uint8Array(r.data));
        }
        let total = 0; for (const c of chunks) total += c.byteLength;
        const merged = new Uint8Array(total); let o = 0;
        for (const c of chunks) { merged.set(c, o); o += c.byteLength; }
        const readMs = Date.now() - r0;
        const rest = await restoreFrom(merged);
        sqliteReps.push({ readMs, gunzipMs: rest.gunzipMs, instantiateMs: rest.instantiateMs, totalMs: Date.now() - t0 });
        if (!rest.fidelity) fidelityOk = false;
      }
      // --- R2 restore: GET the object (network), then identical restore ---
      {
        const t0 = Date.now();
        const r0 = Date.now();
        const obj = await this.env.SNAPSHOTS.get(r2Key);
        const raw = new Uint8Array(await obj.arrayBuffer());
        const readMs = Date.now() - r0;
        const rest = await restoreFrom(raw);
        r2Reps.push({ readMs, gunzipMs: rest.gunzipMs, instantiateMs: rest.instantiateMs, totalMs: Date.now() - t0 });
        if (!rest.fidelity) fidelityOk = false;
      }
    }

    // cleanup
    this.ctx.storage.sql.exec(`DELETE FROM blob_chunk WHERE key = ?`, sqliteKey);
    await this.env.SNAPSHOTS.delete(r2Key);

    const pctl = (arr, p) => {
      const s = [...arr].sort((a, b) => a - b);
      const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
      return s[idx];
    };
    const summarize = (reps) => {
      const tot = reps.map((r) => r.totalMs);
      const rd = reps.map((r) => r.readMs);
      return {
        totalMs: { p50: pctl(tot, 50), p95: pctl(tot, 95), min: Math.min(...tot), max: Math.max(...tot), all: tot },
        readMs: { p50: pctl(rd, 50), p95: pctl(rd, 95), max: Math.max(...rd) },
        gunzipMsP50: pctl(reps.map((r) => r.gunzipMs), 50),
        instantiateMsP50: pctl(reps.map((r) => r.instantiateMs), 50),
      };
    };

    return json({
      ok: true,
      mode: "bakeoff-restore-hottier-vs-r2",
      mb, n,
      image: { rawImageBytes: built.rawBytes, realGzBytes: realGzLen, storedBlobBytes: gzLen, padBytes: padLen, usedHeap: built.usedHeap },
      fidelity: fidelityOk,
      hotTier: {
        restoreSource: "sqlite-restore",
        ...summarize(sqliteReps),
        sqliteCost: {
          gzBytesStored: gzLen,
          rowBytesSum: rowBytes ? Number(rowBytes.b) : null,
          nRows: rowBytes ? Number(rowBytes.n) : nRows,
          chunkBytes: CHUNK_BYTES,
          overheadVsGzPct: rowBytes ? Number((((Number(rowBytes.b) - gzLen) / gzLen) * 100).toFixed(3)) : null,
          databaseSizeBytes: dbSize,
        },
      },
      r2: {
        restoreSource: "r2-restore",
        ...summarize(r2Reps),
      },
      note: "SAME gz image fed to both tiers; only the read source differs. R2 reps are warm-bucket in-loop GETs (cold tail is higher, see baseline ~908ms p50). Hot-tier reads SQLite rows in-turn (no network).",
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/bakeoff-restore") {
        const body = await request.json().catch(() => ({}));
        return await this._bakeoffRestore(body);
      }
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
      if (request.method === "POST" && url.pathname === "/hot-tier") {
        const body = await request.json().catch(() => ({}));
        return await this._hotTier(body);
      }
      if (request.method === "POST" && url.pathname === "/chunked-parallel") {
        const body = await request.json().catch(() => ({}));
        return await this._chunkedParallel(body);
      }
      if (request.method === "POST" && url.pathname === "/prefer-sqlite-gz9") {
        const body = await request.json().catch(() => ({}));
        return await this._preferGz9(body);
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
