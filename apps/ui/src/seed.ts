// Seed notebook — a realistic story of a durable, hibernating TypeScript REPL.
//
// Every default cell (kind: "story") runs GREEN on the live engram-kernel with the
// DEFAULT session config (seeded clock, NO stdlib modules, fetch OFF). The kernel
// strips the TypeScript types host-side, so the code below is authored as plain
// strings with type annotations for readability. The two "advanced" cells are
// presented as examples only — they need config toggled on, so they are NOT part
// of "Run all" by default and carry an inline note.

export interface SeedCell {
  /** Short label shown in the cell gutter. */
  title: string;
  /** Source the kernel evaluates (TypeScript; types are erased host-side). */
  code: string;
  /** "story" cells run on the default config; "advanced" need config toggled. */
  kind: "story" | "advanced";
  /** Optional one-line requirement note (rendered above advanced cells). */
  note?: string;
}

export const SEED_CELLS: SeedCell[] = [
  {
    title: "1 · A typed domain model",
    kind: "story",
    code: `// A typed domain model. The interface is compile-time only (erased host-side);
// the array lives in the durable heap and will grow across the cells below.
interface Task {
  id: number;
  title: string;
  done: boolean;
  createdAt: number;
}

// Just a normal top-level declaration — no globalThis prefix. Engram persists
// top-level let/const/function/class across cells (and across hibernation).
let tasks: Task[] = [];
tasks.length;`,
  },
  {
    title: "2 · A live id sequence (closure)",
    kind: "story",
    code: `// A closure holding a live counter. Every cell that adds a task draws from the
// SAME sequence — proof the namespace is genuinely persistent, never replayed.
function makeIdSeq(start = 0): () => number {
  let n = start;
  return () => ++n;
}
const nextId = makeIdSeq(0);
nextId();`,
  },
  {
    title: "3 · Typed mutators grow the state",
    kind: "story",
    code: `// Typed functions that mutate the durable array. Run this cell again to add
// more tasks — the array keeps growing because it lives in the heap.
function addTask(title: string): Task {
  const t: Task = { id: nextId(), title, done: false, createdAt: Date.now() };
  tasks.push(t);
  return t;
}
function completeTask(id: number): boolean {
  const t = tasks.find((x: Task) => x.id === id);
  if (!t) return false;
  t.done = true;
  return true;
}

const first = addTask("Compile QuickJS to WASM");
addTask("Snapshot the linear-memory heap");
addTask("Resume with full live state");
completeTask(first.id);

({ tasks: tasks.length, titles: tasks.map((t: Task) => t.title) });`,
  },
  {
    title: "4 · A generic helper + computation",
    kind: "story",
    code: `// A generic helper computing a summary over the durable data.
function summarize<T, K extends string | number>(
  xs: T[],
  key: (x: T) => K,
): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const x of xs) {
    const k = key(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const byStatus = summarize(tasks, (t: Task) => (t.done ? "done" : "open"));
({ total: tasks.length, byStatus });`,
  },
  {
    title: "5 · The durability pitch",
    kind: "story",
    code: `// THE DURABILITY PITCH
// Press Hibernate in the toolbar — the in-memory kernel is evicted and ONLY a
// heap snapshot remains in the Durable Object's SQLite. Then run THIS cell
// again: 'tasks' returns the SAME data, restored from the snapshot. No code
// re-ran, no side effects re-fired — the live heap was literally persisted and
// blitted back. That is what makes Engram a durable, hibernating REPL.
({
  restoredTasks: tasks.length,
  firstTitle: tasks[0]?.title ?? null,
  completed: tasks.filter((t: Task) => t.done).length,
});`,
  },
  {
    title: "6 · Network egress via host.fetch",
    kind: "advanced",
    note: "Needs fetch enabled in Config (set Fetch to true or an allowlist).",
    code: `// host.fetch performs network egress from the Durable Object. Eval is async,
// so you can await the response right inside a cell.
const res = await host.fetch("https://api.github.com/repos/cloudflare/workerd", {
  headers: { "User-Agent": "engram-notebook" },
});
const repo: { full_name: string; stargazers_count: number } = JSON.parse(res.body);
console.log("status", res.status, repo.full_name, "★", repo.stargazers_count);`,
  },
  {
    title: "7 · Bundled stdlib modules",
    kind: "advanced",
    note: 'Needs stdlib modules enabled in Config (e.g. set Modules to "dayjs,nanoid").',
    code: `// Selected pure-JS libraries are evaled into the heap at session create and
// snapshot-persist, so they survive hibernation with no re-injection.
const id = nanoid();
const today = dayjs("2026-06-03").format("dddd, MMMM D YYYY");
({ id, idLength: id.length, today });`,
  },
];
