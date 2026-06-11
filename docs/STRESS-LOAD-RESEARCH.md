# Engram Stress, Load, Rich Results, and File Sync Research

This is the working plan for pushing one Engram environment hard without confusing safe
operator load tests with destructive platform experiments.

## Current Runner

scripts/stress-single-instance.mjs drives one logical environment through the public
kernel WebSocket endpoint from config/deployed-endpoints.json.

Default run:

    bun run stress:single -- --out scratch/stress/latest.json --markdown scratch/stress/latest.md

Useful knobs:

    bun run stress:single -- --cells 1000 --hibernateEvery 100 --out scratch/stress/cells-1000.json
    bun run stress:single -- --burstSockets 32 --burstCells 25 --skipPayload --out scratch/stress/burst-32x25.json
    bun run stress:single -- --skipSequence --skipBurst --payloadKb 64,256,512,1024 --out scratch/stress/payloads.json
    bun run stress:single -- --memoryMb 16 --memoryChunkMb 1 --out scratch/stress/memory-16mb.json

Safety defaults:

- Fresh session IDs; no deploys and no global Cloudflare mutations.
- Incompressible memory is disabled unless --dangerIncompressible is passed.
- The runner writes artifacts only when --out or --markdown is provided.
- The known dangerous edge is still the one in docs/SYSTEM-LIMITS.md: incompressible raw heap
  near 28 MB can close the socket/kill the DO below the higher used-heap guard.

## What To Measure Next

1. Cell count ceiling: run --cells 1k, 5k, 10k, then inspect p95 eval, checkpoint mode,
   checkpoint size, and whether W4 base cadence keeps restore bounded.
2. Single-instance contention: run burst grids like 8x50, 32x25, 64x10; require distinct
   monotonic values and no lost increments.
3. Payload return ceiling: run payloadKb 64,256,512,1024,2048; decide where to switch from
   inline return to artifact handles.
4. Memory envelope recheck: compressible first; only then run explicit low-step incompressible
   probes below the documented danger cliff.
5. Cold restore under history: combine high cell count with --hibernateEvery; check whether
   restore is still bounded by base cadence or if metadata/history storage becomes the hidden cost.

## Initial Live Findings

Artifacts from the first safe run live under scratch/stress/. They are intentionally not committed
as source-of-truth docs because they are timestamped measurements against the current remote worker.

Current verified datapoints:

- Smoke: 5 sequential cells, 2 sockets by 2 burst cells, and 1/4 KiB payloads passed.
  Artifact: scratch/stress/smoke.json.
- Sequential history: 100 cells with a forced evict after cell 50 passed. p95 eval was about
  606 ms, final value was 100, and the final checkpoint stayed in SQLite delta mode.
  Artifact: scratch/stress/seq-100.json.
- Single-session contention: 3 sockets by 5 cells passed with 15 distinct monotonic increments.
  4 sockets by 5 cells failed: 17/20 replies arrived, and the missing replies were socket closures
  before the fifth eval reply on three sockets. Artifacts: scratch/stress/burst-3x5.json and
  scratch/stress/burst-4x5.json.
- Inline payloads: 64 KiB and 256 KiB string returns were clean. 512 KiB and 1 MiB returned large
  strings but lost reliable valueType metadata, and the 512 KiB case reported an unexpected 1 MiB
  returned length. Treat 256 KiB as the current clean inline return ceiling until the value protocol
  is audited. Artifact: scratch/stress/payload-1mb.json.
- Memory: 1 MiB compressible heap growth survived evict and restored via sqlite-restore.
  Artifact: scratch/stress/memory-1.json.

Observed tool gap:

- Longer sequence attempts need progress/partial files enabled. One 200-cell run ended before writing
  an artifact, so it is not counted as a measured system result.

## 2026-06-11 Live Limit Recheck

Recent deployed codeId observed through smoke:live: rustkernel-a41a123a789e8069.

Feature probes against engram-kernel:

- Default egress is live: fetch("https://example.com/") works without setting config.fetch.
- Default stdlib preload is live, but lodash is stable as globalThis.lodash; _ is not a safe
  lodash alias because it is also the REPL last-value slot. lodash.sum([1,2,3]) === 6.
- Runtime ESM module loading works: await use("lodash-es@4.17.21") returned a namespace with
  322 exports, and the namespace survived evict with sqlite-restore.
- Binary fetch practical limit is lower than the code comments imply in this live path:
  2 MiB arrayBuffer() returned cleanly; 3 MiB and 4 MiB closed the socket before a reply.

Stress probes:

- Live smoke passed for kernel/cloud/UI/docs.
- Sequential evals: 20 cells passed; a 75-cell bounded probe closed at cell 29; another 50-cell
  attempt wrote a partial artifact at cell 10. Treat long same-socket eval streaks as unstable
  above roughly 20-30 cells until the socket-close cause is traced.
- Same-session contention: 2 sockets by 5 cells passed with 10/10 distinct monotonic increments.
- Inline return payloads: 64 KiB and 256 KiB strings returned cleanly with valueType:"string".
- Compressible memory: 1 MiB retained heap survived evict and restored via sqlite-restore.

Immediate follow-up: inspect Workers logs / AE around the sequence and fetch socket closes before
raising any documented hard limit. The client sees clean WebSocket closure, not a typed kernel error.

## 2026-06-11 Optimization Pass: Streaming Fetch

Optimization target found: the live fetch path was buffering unknown-size responses inline. In
practice, speed.cloudflare.com returns transfer-encoding: chunked and no content-length, but the
host shim treated absent content-length as 0. That made multi-megabyte responses take the inline
bodyB64 path instead of the streamRead path.

Fixes deployed to engram-kernel:

- WebSocket auth attachment now marks log-only traffic as authed when auth enforcement is disabled,
  avoiding per-frame unauth telemetry/log overhead in log-only mode.
- Streaming host-call dispatch is wired for fetchStream, streamRead, streamCancel, and streamWrite.
- fetchStream now only inlines a response when content-length is actually present and below the
  inline threshold; absent/unknown length streams.
- Deployment path fix: deploy from a clean staging directory with the build hook and migrations
  removed. Direct no-bundle deploy from apps/kernel accidentally attached target/.wrangler artifacts
  and produced a 158 MiB dry-run upload. The clean staged bundle uploads about 7.8 MiB raw /
  2.1 MiB gzip.

Deploy evidence:

- First coherent streaming deploy: engram-kernel version 9157698a-ab78-4656-9d23-aed03bf98c3a.
- Content-length fix deploy: engram-kernel version 3cc85586-df64-40ac-9f14-f53890e6f60e.
- Result overflow guard deploy: engram-kernel version b46d45cf-e14b-4193-8d55-d9be5cf152a4.
- Preview-cap deploy: engram-kernel version 7ed6c508-cc53-427c-9699-135b07b03f35.
- smoke-live passed after deploy for kernel websocket eval, cloud /health, cloud /usage 401 gate,
  UI HTML, and docs HTML.

Post-fix fetch probes:

- Before the content-length fix: 2 MiB arrayBuffer returned, 3 MiB closed WS 1006, 4 MiB errored.
- After the fix: 2 MiB, 3 MiB, and 4 MiB arrayBuffer() all returned successfully with exact lengths.
- 3 MiB response.body.getReader() drained 3,145,728 bytes in 844 chunks and checkpointed cleanly
  (sqlite, raw about 7.99 MiB, used heap about 2.93 MiB).
- 8 MiB pure stream drain succeeded with total 8,388,608 bytes, max chunk 4 KiB, checkpoint raw about
  8.06 MiB and used heap about 1.80 MiB. 16 MiB against speed.cloudflare.com returned origin 403, so
  it is not a kernel limit datapoint.

Post-fix stress probes:

- Sequence: 60 cells with forced evict every 20 passed; p95 eval about 530 ms. Artifact:
  scratch/stress/post-streamfix-seq-60.json.
- Same-session burst: 4 sockets by 5 cells passed with 20/20 distinct increments; p95 about 1592 ms.
  Artifact: scratch/stress/post-streamfix-burst-4x5.json.
- Payload return probe after the result guard: 64 KiB and 256 KiB string returns remain clean.
  512 KiB returns a typed ProtocolSizeError and keeps the socket alive. Artifact:
  scratch/stress/post-resultguard-payload-v2.json.
- Sequence after the result guard: 30 cells with a forced evict after cell 15 passed; p95 eval about
  515 ms. Artifact: scratch/stress/post-resultguard-seq-30.json.
- Payload return probe after preview capping: 64 KiB, 256 KiB, 512 KiB, and 768 KiB string returns
  are clean inline values; 1 MiB returns typed ProtocolSizeError and keeps the socket alive. Artifact:
  scratch/stress/post-previewcap-payload.json.
- Direct same-socket sequence after preview capping: 30/30 evals passed with a forced evict before
  cell 16 and sqlite-restore on cell 16. A stress-harness run with the same shape still saw an
  intermittent socket close at cell 29, so long same-socket harness runs should be interpreted as
  transport stability probes, not pure kernel state failures.

Result-framing limit after guard:

- Direct boundary probe: 262,143; 262,144; 262,145; 300,000; and 400,000 character strings returned
  correctly.
- After capping string previews to 4 KiB, 524,288 and 786,432 character strings return inline
  correctly. 1,048,576 characters returns typed ProtocolSizeError.
- Current clean inline string ceiling is 768 KiB in the stress preset. Larger values should use
  artifact/display handles.
- Correct next improvement is still framed/chunked eval results or artifact handles; the guard makes
  the limit stable and explicit but does not make large inline values a good transport.

Source/deploy consistency note:

- As of the 2026-06-11 CPU-spike check, live engram-kernel still reports engine hash
  rust-16db98f565825e50a79b659c0647fb6d and retains the preview cap / ProtocolSizeError behavior
  above: 786,432 characters inline, 1,048,576 characters guarded.
- The checked-out main branch had advanced to 60070f2 (host.ws) and the tracked engine hash matched
  live, but apps/kernel/engine/src/lib.rs did not contain the preview-cap/result-guard source edits.
  Treat the current source-vs-engine.wasm drift as a release hygiene bug before the next rebuild:
  either re-land the source edits or regenerate engine.wasm from the intended source and rerun the
  payload boundary probes.
- A scoped worker-shell cargo check on wasm32-unknown-unknown produced wasm-bindgen const-eval
  warnings and left rustc consuming about one core; it was terminated. Use TypeScript checks and
  engine-target checks freely, but avoid full worker-shell builds/checks during interactive stress
  work unless the machine is cool or the command is time-boxed.

## 2026-06-11 Continuation: Source Drift, Engine Redeploy, and R2 Hot-Tier Work

Optimization targets handled in this continuation:

- Fixed source/deploy drift for the live result-size guard. The tracked engine source again contains
  the 4 KiB string preview cap plus typed RESULT-buffer overflow guard, and apps/kernel/src/engine.wasm
  was rebuilt to engine hash rust-16db98f565825e50a79b659c0647fb6d.
- Fixed the stale apps/kernel/package.json build:engine script, which pointed to removed .mjs build
  files. The verified command is now node scripts/build-engine.ts && node scripts/engine-hash.ts.
- Added shell-source R2 restore resilience work: SQLITE_HOT_MAX is raised from 2 MiB to 8 MiB,
  and the R2 overflow restore path has retry/backoff/timeout plus a circuit breaker that falls back
  to oplog replay instead of bubbling an R2 transient as a session-losing error.

Deploy evidence:

- A first engine-only redeploy with hash rust-692442ddeebdc5d0f9eb6d0339ed1489 regressed the
  payload boundary because the engine source patch had been overwritten before rebuild. It was
  superseded immediately and should not be treated as the good version.
- Corrected engine-only deploy: engram-kernel version 4b4016d6-0a33-4e91-aa48-0fa47ff7860f.
  Dry-run upload was about 7.8 MiB raw / 2.1 MiB gzip. This deploy used the existing worker shell
  bundle, so the R2 shell fallback is in source but not deployed yet.

Post-corrected-deploy verification:

- node scripts/smoke-live.mjs passed for kernel eval, cloud health, usage auth gate, UI HTML, and
  docs HTML.
- Direct payload boundary probe: engine hash rust-16db98f565825e50a79b659c0647fb6d; 524,288 and
  786,432 character strings return inline with preview length 4,115; 1,048,576 characters returns
  typed ProtocolSizeError and checkpoints to SQLite.
- Standard payload stress artifact: scratch/stress/post-engineguard-payload.json passed with
  inlineMax=768KiB and guarded=1024KiB.
- Fetch regression probe: 4 MiB arrayBuffer() returned exactly 4,194,304 bytes and checkpointed
  to SQLite.

Current deployment blocker for shell changes:

- worker-build --release and cargo check --target wasm32-unknown-unknown both hit long
  wasm-bindgen const-eval over the /src/kernel-glue.mjs wasm-bindgen module import; when allowed to
  run interactively they leave rustc consuming roughly one core. Time-boxed runs were terminated.
  The next real optimization target is to split or shrink the wasm-bindgen JS snippet path enough
  that the worker shell can build without a multi-minute single-core compile spike; until then,
  deploy shell changes only from a controlled cool-machine/background lane.
## 2026-06-11 Full-Shell Build Fix and Deploy
Optimization target handled: the worker-shell CPU spike came from generated apps/kernel/src/kernel-glue.mjs being about 9.6 MiB because ts-blank-space bundled the full TypeScript compiler into the wasm-bindgen JS snippet. Replacing that dependency with a small local host-side TypeScript eraser reduced kernel-glue.mjs to about 83 KiB. Canonical build:worker completed in about 5 seconds, including worker-build --release.
Deploy evidence: final full-shell deploy engram-kernel version 80f42803-90d1-4cf1-b81a-d6e197fbb16a. The clean staged upload shrank to about 2.486 MiB raw / 0.874 MiB gzip, with Worker startup time reported as 13 ms. This deploy includes the shell-source R2 restore resilience and SQLite hot-tier change.
Post-full-shell verification: node scripts/smoke-live.mjs passed; TypeScript live probe passed typed let/const, return annotations, generic arrow functions, cold restore of a closure, and enum rejection as TypeScriptError; result boundary still holds with 786,432 chars inline and 1,048,576 chars guarded by typed ProtocolSizeError; 4 MiB fetch arrayBuffer returned exactly 4,194,304 bytes; a 3 MiB incompressible Uint8Array checkpointed to SQLite with sizeGz about 4.2 MiB, proving the 8 MiB SQLite hot tier is live. Stress artifacts passed separately: scratch/stress/post-fullshell-seq-20.json, scratch/stress/post-fullshell-burst-4x5.json, scratch/stress/post-fullshell-payload.json, and final deploy rerun scratch/stress/post-fullshell-final-payload-rerun.json. The first final payload stress attempt saw an intermittent socket close at the expected 1 MiB guard cell, but an exact same-socket repro and rerun returned the typed ProtocolSizeError.

## 2026-06-11 Chunked Text Artifacts

Optimization target handled: large text eval results no longer need to be delivered inline or
rejected at the 1 MiB protocol boundary. The engine now returns a descriptor for text results above
900 Ki chars, and the worker shell serves chunks through a new `{t:"artifact",handle,offset,len}`
frame. Handles are scoped to the committed cell (`cell:<n>:text`) and stale handles reject once a
later cell commits.

Deploy evidence:

- First artifact deploy: engram-kernel version c653d961-42ee-4848-94ee-d80759a0c001. It proved the
  live descriptor and chunk stream, but post-evict artifact retrieval failed because restore
  sanity/config evals overwrite `__cellResult`.
- Corrected artifact deploy: engram-kernel version 3d0bedd1-bb1d-435a-8485-5d8e29c68453. The clean
  staged upload was about 2.496 MiB raw / 0.878 MiB gzip, with Worker startup time reported as 13 ms.

Post-corrected verification:

- node scripts/smoke-live.mjs passed.
- Direct artifact probe on engine hash rust-78ae14d8b910f8b1214fd95029027951: `"x".repeat(1048576)`
  returned `valueType:"artifact"` with handle `cell:0:text`, 1,048,576 chars, chunk size 131,072,
  preview length 4,116, and SQLite checkpoint sizeGz about 1.05 MiB. Eight chunk reads reconstructed
  all 1,048,576 chars. After `{t:"evict"}`, chunk retrieval from the same handle returned 65,536
  chars from the restored heap. After the next eval committed cell 1, the old cell 0 handle rejected
  with ArtifactError.
- Updated stress payload artifact: scratch/stress/post-artifact-payload.json passed with 768 KiB
  inline and 1,024 KiB as an artifact.
- Regression probes: TypeScript typed let and enum rejection still passed; 4 MiB
  `fetch("https://speed.cloudflare.com/__down?bytes=4194304").arrayBuffer()` returned exactly
  4,194,304 bytes and checkpointed to SQLite.

## Rich Return Types

Jupyter's useful model is a MIME bundle: outputs like execute_result, display_data, and
inspect_reply carry a data dictionary keyed by media type plus metadata. Engram already has
plain eval values and the SDK's faithful host.final/FINAL side channel. The least risky next
step is to formalize a compatible shape without claiming full Jupyter wire compatibility:

    type EngramDisplay = {
      kind: "display";
      data: Record<string, unknown>; // text/plain, text/html, image/png, application/json, ...
      metadata?: Record<string, unknown>;
      transient?: Record<string, unknown>;
    };

Recommended rollout:

1. SDK helper: display(data, metadata?) implemented over a reserved host channel, like
   host.final, so rich output bypasses fragile object preview.
2. Kernel protocol: add optional displays: EngramDisplay[] to eval replies; keep value and
   valuePreview unchanged for compatibility.
3. UI renderer: support text/plain, application/json, text/html with sanitization, and
   image/png/image/jpeg as base64 or artifact handles.
4. Size policy: inline small MIME payloads; for large binary or HTML assets, return an artifact
   handle with content type, byte length, digest, and signed/authorized read URL.

## Local Folder Sync / Remote Files

There are two distinct problems:

- Initial filesystem materialization: make a repo/folder visible to the remote environment.
- Gradual bidirectional sync: keep local edits and remote writes coherent over time.

Cloudflare Tunnel can expose a local HTTP/WebSocket sync service to Engram. Official docs show quick
development tunnels with cloudflared tunnel --url http://localhost:8080; those random
trycloudflare.com tunnels are for testing, have a 200 concurrent request limit, and do not support
SSE. For a stable sync bridge, use a named tunnel and put authentication in front of it.

ArtifactFS is different: Cloudflare's docs describe it as a FUSE mount for Git repositories that
starts from a blobless clone, hydrates file contents on demand, and caches later reads locally. That
is attractive for sandbox startup and large Git repos, but it is not the same thing as live syncing
an arbitrary local folder into a Durable Object. It is best treated as a possible substrate for
remote repo materialization, not the whole local-folder-sync answer.

Recommended Engram file-sync design:

1. Host a local sync daemon that exposes a manifest endpoint, file reads, file writes, and a change
   stream over WebSocket. Put it behind a named Cloudflare Tunnel for remote access.
2. In the VM, expose host.fs as a mediated virtual filesystem. Reads page content from local sync
   or R2/SQLite; writes go to a staged overlay.
3. Commit protocol: remote writes are staged with digest/version preconditions, then the local daemon
   applies them to the working tree. Conflict means explicit error, not silent overwrite.
4. Snapshot invariant: VM heap snapshots must not embed full local files by default; they should store
   file handles, digests, and overlay metadata. Large bytes live outside the heap.
5. ArtifactFS option: for Git remote startup, mount/hydrate a repo in a container/VM and point the
   same host.fs abstraction at it. Keep it separate from local live sync.

## Stability Improvements Suggested By This Work

- Add a current CI/load ladder: check, smoke:live, telemetry:probe, then safe stress:single presets.
- Promote stress JSON summaries into a stable schema and compare runs over time.
- Add server-side per-session stats: total cells, checkpoint count, base/delta counts, current raw/gz,
  used heap, restore source, last error, and active socket count.
- Add a first-class result-size policy: inline threshold, artifact threshold, hard reject threshold.
- Add rich result display channels before adding complex UI renderers.
- Treat local folder sync as a host-mediated capability with auth, digests, and conflict handling,
  not direct VM access to the user's machine.

## Sources

- Cloudflare Tunnel setup: https://developers.cloudflare.com/tunnel/setup/
- Cloudflare WebSockets: https://developers.cloudflare.com/network/websockets/
- Cloudflare ArtifactFS: https://developers.cloudflare.com/artifacts/guides/artifact-fs/
- Jupyter messaging protocol: https://jupyter-client.readthedocs.io/en/latest/messaging.html
