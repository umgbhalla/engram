---
title: Diagrams
description: The four architecture diagrams, authored as Mermaid and rendered to themed SVG.
---

All four architecture diagrams are authored as **Mermaid** source (`docs/diagrams/*.mmd`) and
rendered to themed SVG. They reflect the current all-Rust truth: the kernel is a Rust Durable Object
running the `rquickjs` `engine.wasm` interpreter. Durability is the **W5+W4+E6 delta stack**
(used-heap admission + arena scrub · 256 B byte-delta · E6 oplog crash-tail + engine-migration
journal). Snapshots go to DO SQLite (chunked) with R2 `engram-snapshots` overflow above ~2 MB gz.

Shared theme: dark GitHub palette (`#0d1117` bg, `#e6edf3` fg, `#4493f8` accent, `#161b22`
surface), Inter font.

## Architecture

Single-tenant kernel topology — client over WS/HTTP into the `engram-kernel` Rust Durable Object,
driving the `rquickjs` VM, with the snapshot pipeline writing to DO SQLite spilling to R2.

![Architecture diagram](/diagrams/architecture.svg)

## Snapshot / restore

The eval → snapshot → evict → cold-wake sequence between Client, Rust DO, `engine.wasm`, the delta
stack, DO SQLite, and R2.

![Snapshot/restore sequence diagram](/diagrams/snapshot-restore.svg)

## Session states

The lifecycle of one session: Cold → Creating → Live (idle ⇄ evaluating ⇄ checkpoint) →
Hibernating → ColdRestore → Live.

![Session state machine diagram](/diagrams/session-states.svg)

## Multi-tenant

The `engram-cloud` supervisor model: tenant client → SupervisorDO shard → per-session KernelFacets
with isolated SQLite.

![Multi-tenant topology diagram](/diagrams/multi-tenant.svg)

## Regenerating

```sh
for k in architecture multi-tenant session-states snapshot-restore; do
  npx @mermaid-js/mermaid-cli -i docs/diagrams/$k.mmd -o docs/diagrams/$k.svg -b "#0d1117"
done
```
