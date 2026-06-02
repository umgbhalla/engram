// Render Engram doc diagrams to SVG via beautiful-mermaid (github-dark grey theme).
// Run: bun run scripts/render-diagrams.ts   →   writes docs/diagrams/*.svg
import { renderMermaidSVG } from "../context/beautiful-mermaid/src/index.ts";
import { mkdirSync, writeFileSync } from "node:fs";

// github-dark grey palette (from beautiful-mermaid src/theme.ts)
const THEME = {
  bg: "#0d1117",
  fg: "#e6edf3",
  line: "#3d444d",
  accent: "#4493f8",
  muted: "#9198a1",
  surface: "#161b22",
  border: "#3d444d",
  font: "Inter, system-ui, sans-serif",
};

const DIAGRAMS: Record<string, string> = {
  architecture: `flowchart TD
  client["WS / HTTP client"] -->|"frames: create / eval / ping"| shell["Rust DO shell"]
  shell --> glue["JS glue"]
  glue --> qjs["QuickJS WASM\nlive namespace: vars, closures, promises"]
  qjs -->|"snapshot = memory.buffer + globals + entropy"| sqlite["SQLite\nchunked 64KB rows, under 2MB gz"]
  sqlite -->|"overflow over 2MB gz"| r2["R2 engram-snapshots"]
  qjs -->|"idle: DO evicted, heap gone"| hib["hibernated"]
  hib -->|"wake: new instance, blit bytes, resume"| glue`,

  "snapshot-restore": `sequenceDiagram
  participant G as JS glue
  participant Q as QuickJS WASM
  participant S as SQLite / R2
  Note over G,Q: eval completes
  G->>Q: read memory.buffer + globals + entropy
  G->>G: admit on used heap (not monotonic buffer)
  G->>S: gzip then SQLite chunks, else R2 overflow
  Note over G,S: idle: DO evicted, instance gone
  G->>Q: new instance, re-instantiate Tier-0 natives at fixed bases
  S->>G: read chunks then gunzip
  G->>Q: blit heap bytes back + restore globals
  Q->>G: continues mid-namespace (no replay)`,

  "session-states": `stateDiagram-v2
  [*] --> created
  created --> warm: eval
  warm --> warm: eval
  warm --> hibernated: idle / evict
  hibernated --> restoring: eval (cold)
  restoring --> warm: heap blit
  hibernated --> replaying: engine-hash mismatch
  replaying --> warm: journal replay`,

  "multi-tenant": `flowchart TD
  sid["sessionId"] -->|"shardFor FNV-1a"| sup["SupervisorDO shard\nholds WebSocket (proxy model)"]
  sup -->|"RPC per frame"| f1["KernelFacet tenant:sessionId\nown VM + own SQLite"]
  sup --> f2["KernelFacet ...\nx up to 128 / shard"]
  sup --> warm["keep-warm EWMA + alarm"]`,
};

const outDir = "docs/diagrams";
mkdirSync(outDir, { recursive: true });
for (const [name, src] of Object.entries(DIAGRAMS)) {
  const svg = renderMermaidSVG(src, THEME);
  const path = `${outDir}/${name}.svg`;
  writeFileSync(path, svg);
  console.log(`wrote ${path} (${svg.length} bytes)`);
}
