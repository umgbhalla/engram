# Engram — Codebase Design & Internals

Text-first design doc. Every diagram encodes one idea; read the caption as the takeaway.
Source of truth for *where things live*: `v0.9.3/src/{lib.rs,glue.js}` (kernel), `v1.2/src/supervisor.js` (cloud).

═══════════════════════════════════════════════════════════════════════════

## 1. The whole system, layered

Request enters at the top, durability lives at the bottom. Each layer only talks to the one below it.

```
   ┌ clients ─────────────────────────────────────────────────────────┐
   │   notebook UI  ·  @engram/sdk  ·  engram CLI  ·  agent code-mode   │
   ├ ingress ──────────────────────────────────────────────────────────┤
   │   WS frames  ·  HTTP /eval     (stateless; carries sessionId)      │
   ├ supervisor  (v1.2, multi-tenant only) ────────────────────────────┤
   │   64-shard router  ·  auth  ·  metering  ·  keep-warm  ·  egress   │
   ├ kernel host  (lib.rs — Rust Durable Object) ──────────────────────┤
   │   message dispatch  ·  mutex  ·  SQLite/R2 store  ·  AE datapoint  │
   ├ glue  (glue.js — JS) ─────────────────────────────────────────────┤
   │   eval pump  ·  guards  ·  host boundary  ·  dump / restore        │
   ├ interpreter  (QuickJS → WASM) ────────────────────────────────────┤
   │   live namespace: vars · closures · pending promises · stdlib      │
   ├ durable store ────────────────────────────────────────────────────┤
   │   DO SQLite  (chunks <2MB gz)   ──overflow──▶   R2 engram-snapshots │
   └───────────────────────────────────────────────────────────────────┘
```

Single-tenant (`engram-kernel`) skips the supervisor layer — clients hit the kernel DO directly.

═══════════════════════════════════════════════════════════════════════════

## 2. Kernel host — message dispatch  (`lib.rs`)

One Durable Object per session. Every frame funnels through `handle()` (lib.rs:359), each behind the eval mutex.

```
   frame.t
     │
     ├──▶ gen          : generation counter        ← liveness, no instantiate
     ├──▶ ping         : cheap liveness            ← no instantiate
     ├──▶ create       : persist config, fresh VM
     ├──▶ eval         : run a cell  ─────────────▶ §3 eval lifecycle
     ├──▶ reset        : drop kernel + snapshot
     ├──▶ evict        : drop in-memory only       ← test hook (forces cold wake)
     ├──▶ stdlib       : bundle catalog introspect
     ├──▶ setContext   : store RLM context blob
     ├──▶ final        : read back RLM answer
     └──▶ engineBump   : bump engine-hash          ← test hook (forces journal replay)
```

Caption: nine verbs, one door. `eval` is the only one that mutates the heap.

═══════════════════════════════════════════════════════════════════════════

## 3. Eval lifecycle — one cell, end to end

The interesting path. Guards fire *during* execution; checkpoint fires *after* success.

```
   eval ──▶ ensure_glue ──▶ evalCode ──▶ _drivePromise ──┬──▶ ok    ──▶ checkpoint ──▶ reply
            (lib:872)       (glue:1571)  (glue:1676)      │                (lib:1025)
                │                                         └──▶ error ──▶ _formatError ─▶ reply
                │                                                          (glue:1731)
          cold?─┤
                ├─yes─▶ restore  (glue:1459)   ← blit heap, re-register host fns
                └─no──▶ reuse warm instance
```

While `evalCode` runs, `_interruptHandler` (glue:1232) is called on a bytecode interval:

```
   every interrupt tick:
     tick-- ─────────────────────────▶ tick == 0   ⇒ throw TimeoutError
     read buffer.byteLength ──────────▶ +8MB growth ⇒ throw MemoryLimitError
                                        ≥16MB used   ⇒ throw MemoryLimitError
```

Caption: the mutex never escapes — error path still releases it and replies a typed value, so the
next cell works (this is the BUG-1 fix). On error, **no checkpoint** — heap stays at last good state.

═══════════════════════════════════════════════════════════════════════════

## 4. Snapshot / restore — the durability round-trip

State changes as it moves through the pipeline. Second row = what each stage holds.

```
   live heap ─▶ dump ─▶ scrub ─▶ gzip ─▶ admit ─▶ SQLite chunks ─▶ [overflow] R2
     █           █        ▒        ▒       ▒          ▓                  ░
   in VM      buffer+   zero    bytes   used-heap  64KB rows         >2MB gz only
              globals   freed           gate
              +entropy  slack
```

`dump()` (glue:1916) captures `memory.buffer` + mutable globals (`__stack_pointer`) + entropy counters.
`_scrubArena()` (glue:1886) zeroes freed slack so gzip shrinks. Admission is on **used heap**, not the
monotonic buffer — a spike-then-free session can still checkpoint.

The reverse, on a cold DO:

```
   read_chunks ─▶ gunzip ─▶ admit ─▶ new WASM instance ─▶ re-instantiate ─▶ blit heap ─▶ resume
    (lib:1320)              raw≤18MB   Tier-0 natives       at fixed bases   + globals    mid-namespace
                           used≤gate   first                                            (no replay)
```

Caption: natives go back at the **same fixed bases** before the heap blit, or pointers dangle.

═══════════════════════════════════════════════════════════════════════════

## 5. Session lifecycle — state machine

A session is a noun moving between states; verbs are the transitions.

```
      create
        │
        ▼
     created ──── eval ────▶ warm ────────── eval (loop) ──────────┐
        │                     │                                    │
        │                idle / evict                              │
        │                     │                                    │
        │                     ▼                                    │
        │                 hibernated ──── eval (cold) ───▶ restoring│
        │                     ▲                              │     │
        │                     └────── idle again ◀───────────┘     │
        │                                                     warm ◀┘
        │
     engine-hash mismatch on wake
        │
        ▼
     replaying ──▶ warm        ← journal replays per-cell sources (best-effort)
```

Caption: `hibernated` is the durable resting state — heap gone from memory, bytes safe in SQLite.
`restoring` is invisible to the client except as added latency.

═══════════════════════════════════════════════════════════════════════════

## 6. Host boundary — the controlled crossing

Everything non-deterministic or external crosses one fence. Inside = pure seeded VM; outside = the DO.

```
        VM (QuickJS)                 fence                 DO host (lib.rs)
        ────────────            (glue:663 install)         ────────────────
   host.ctx.slice/get/grep ───────────────────────────▶  ctx_chunks SQLite  (≤1MB slice)
   host.fetch(url, init)   ───── allowlist check ──────▶  real fetch()       (≤2MB body, ≤64 hdr)
   host.subLM(...)         ───────────────────────────▶  sub-model call
   host.final(answer)      ───────────────────────────▶  RLM answer store
   host.kv.get/set/keys    ───── serialized in snapshot ▶ kv Map (survives wake)
   Date / Math / crypto    ───── seeded rebind ────────▶  WASI random_get (counted)
                                  (glue:530 REBIND_SRC)
```

Caption: `host.fetch` adds **zero entropy** to the snapshot — determinism survives network I/O.
All args/results fenced at 8MB (`HOST_ARG_MAX_BYTES`).

═══════════════════════════════════════════════════════════════════════════

## 7. Guard stack — defense in depth

Each guard catches a different blast radius, all *below* the WS-1006 crash floor. Bar = how much
headroom before it trips (relative, not to scale).

```
   loop tick-budget      ███░░░░░░░░░░░░░░░░░░░░   1200 ticks   → TimeoutError
   per-cell growth       ████████░░░░░░░░░░░░░░░   +8MB         → MemoryLimitError   (mid-cell)
   mid-cell used heap    ████████████████░░░░░░░   16MB         → MemoryLimitError   (mid-cell)
   native dlmalloc       ████████████████░░░░░░░   16MB         → NativeAllocLimit   (pre-grow)
   snapshot dump ceiling █████████████████░░░░░░   18MB buffer  → SizeAdmissionError (clean reject)
   ─────────────────────────────────────────────────────────────────────────────────
   WS-1006 crash floor   ████████████████████████  ~24-30MB    ← what we must never reach
```

Caption: native dlmalloc limit is the key one — it turns OOM into a *catchable* error **before
`memory.grow` can crash the DO**. That closed the old silent-1006 hole.

═══════════════════════════════════════════════════════════════════════════

## 8. Multi-tenant — containment & routing  (`v1.2/supervisor.js`)

Scope is the point here: who owns what, and the isolation boundaries.

```
   ╭ account ─────────────────────────────────────────────────────────────╮
   │                                                                        │
   │   sessionId ──▶ shardFor() FNV-1a ──▶ one of 64 SupervisorDO shards    │
   │                                                                        │
   │   ┌ SupervisorDO shard ───────────────────────────────────────────┐   │
   │   │  sessions table · tenants cache · keep-warm EWMA · alarm        │   │
   │   │  holds the WebSocket  (proxy model — facets can't hold sockets) │   │
   │   │                                                                 │   │
   │   │   ┌ KernelFacet  (tenant:sessionId) ─────────────────┐          │   │
   │   │   │  own QuickJS VM · OWN isolated SQLite · own heap  │ × ≤128   │   │
   │   │   └───────────────────────────────────────────────────┘          │   │
   │   └─────────────────────────────────────────────────────────────────┘   │
   │                                                                        │
   ╰────────────────────────────────────────────────────────────────────────╯
```

Caption: a facet cannot read its shard's secrets or a sibling facet's SQLite. A bomb in one facet
leaves same-shard neighbours and other tenants untouched (verified). Facets **can't set alarms** →
all idle/TTL/keep-warm scheduling lives on the supervisor.

The WS proxy model, frame by frame:

```
   client ──ws frame──▶ supervisor (holds socket) ──RPC──▶ facet.eval ──▶ result ──▶ client
```

Caption: facet-held hibernating sockets are broken on the platform, so the supervisor owns the
socket and RPCs each frame into the facet. One extra hop; durability unaffected.

═══════════════════════════════════════════════════════════════════════════

## 9. Keep-warm decision  (`_shouldWarm`, supervisor.js:368)

Most sessions eat the ~1.5s cold wake fine. Warm only the ones that are *both* hot and cheap.

```
   warm IF ──┬──▶ evals ≥ WARM_MIN_EVALS           (proven active)
             ├──▶ cadence EWMA ≤ 90s               (returns soon)
             ├──▶ now within WARM_RECENCY_K × EWMA (recently active)
             ├──▶ within 4min horizon              (bounded cost)
             └──▶ image ≤ 512KB gz  OR  flagged    (cheap to hold)
```

Caption: the policy decides *when NOT to warm* — a tight predicate so idle/heavy sessions just hibernate.

═══════════════════════════════════════════════════════════════════════════

## 10. Cold-wake cost — where the time actually goes

Measured. The surprise: our restore code is the *thin* slice.

```
   platform WS connect + DO spin-up  ████████████████████░░░░   ~950ms-1s
   R2 GET (only if >2MB gz image)    ████████░░░░░░░░░░░░░░░░░   ~597ms @ 5MB
   gunzip + blit heap                ░░░░░░░░░░░░░░░░░░░░░░░░░   sub-ms
   QuickJS instantiate               ░░░░░░░░░░░░░░░░░░░░░░░░░   <300µs
                                                     ▲
                                                     │
                                          everything we own is here ◀ negligible
```

Caption: cold start is **platform-bound**, not in-kernel. Only owned lever = keep big images off R2.

═══════════════════════════════════════════════════════════════════════════

## 11. Storage schema — what each table holds  (`lib.rs`)

| table          | line | holds                                              |
|----------------|------|----------------------------------------------------|
| `snap_manifest`| 130  | one row: gen, used_heap, size_raw/gz, store, nChunks |
| `snap_chunks`  | 157  | snapshot bytes, ~64KB BLOB rows (`CHUNK_BYTES`)    |
| `ctx_chunks`   | 169  | RLM host-context store, chunked (>1MB safe)        |
| `cell_journal` | 186  | per-cell sources for engine-migration replay       |

`tenants` + `sessions` (supervisor.js:162/126) live on the shard, not the kernel.

═══════════════════════════════════════════════════════════════════════════

## 12. Key invariants (don't break these)

```
   • dump captures memory.buffer + globals + entropy   ─ miss globals ⇒ corrupt resume
   • Tier-0 natives restore at FIXED bases before blit  ─ else dangling pointers
   • admission gates on USED heap, not buffer length    ─ buffer is monotonic, never shrinks
   • error path releases the mutex + replies typed JSON  ─ else deadlock (BUG-1)
   • seeded entropy counters persisted in snapshot       ─ else determinism breaks on wake
   • checkpoint only on eval success                     ─ never persist a half-mutated heap
```

Caption: these six are the load-bearing wall. Everything else is replaceable.
