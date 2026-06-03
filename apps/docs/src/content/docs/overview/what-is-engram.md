---
title: What is Engram
description: A durable, hibernating, multi-tenant JavaScript / TypeScript REPL kernel on Cloudflare.
---

**Engram is a durable, hibernating, multi-tenant JavaScript / TypeScript REPL kernel on Cloudflare.**

Engram runs untrusted / agent-authored JavaScript in a sandboxed [QuickJS](https://github.com/quickjs-ng/quickjs)
interpreter compiled to WASM, hosted inside a Cloudflare Durable Object. A session keeps a **live
interpreter namespace** — variables, closures, pending promises, injected stdlib — that **survives
idle eviction and cold restart with no replay and no re-fired side effects**, because the entire
interpreter heap is snapshotted to durable storage and blitted back on wake.

It is a Jupyter / IPython kernel for the edge: a REPL that sleeps when idle and resumes with full
live state. On top of that core it ships a codemode / RLM execution backend, per-tenant auth +
metering, an SDK, a CLI, and a browser notebook.

## The one-liner

> A durable, hibernating, dynamically-configured **stateful JavaScript REPL** on Cloudflare — the
> live QuickJS interpreter heap is snapshotted to a Durable Object's SQLite, so a session sleeps
> when idle and wakes with full live state, **no replay**.

## Why this matters

A normal serverless REPL loses everything on eviction. To "resume" it would replay your source —
which re-runs every side effect (re-sends emails, re-charges cards, re-mutates databases). Engram
never replays. It persists the literal interpreter heap, so resuming is byte-identical to where you
left off: the same object identities, the same closures, the same pending promises.

## Provenance

Formerly `montydyn`, renamed to **Engram** on the rebrand — the heap snapshot *is* an engram, a
memory trace. The on-disk folder stays `montydyn/`; brand, repo, and deployed worker names changed.

The kernel is **Rust**: the live engine is `rquickjs` compiled to `engine.wasm`, driven by a Rust
Durable Object shell, with a thin (~400-line) WASI/DO plumbing layer. The hand-written JS brain is
gone; eval, snapshot, guards, determinism, durability, and Tier-0 extensions all live in Rust.
