// repl-transform.ts — Node-REPL-style top-level-declaration persistence transform.
//
// PROBLEM: the engine evals a no-await statement/declaration cell via indirect global
// `(0, eval)(src)` (engine/src/lib.rs install_cell, mode 'global'). In QuickJS (and V8),
// indirect global eval gives top-level `let`/`const`/`class`/`function` declarations their
// OWN lexical scope — they do NOT become properties of globalThis. So across cells only
// `var x` and bare `x = …` persisted; `let`/`const`/`function`/`class` vanished.
//
// FIX (pre-eval source rewrite, deterministic, host-side): scan the cell at brace-depth 0
// ONLY, rewrite top-level (depth-0, statement-start) declarations into GLOBAL assignments so
// the bindings persist — WITHOUT changing the cell's completion value (the last expression
// still returns). This mirrors how the Node REPL makes top-level declarations persist.
//
// REWRITE (each performed in-place by editing only the keyword span, never the body):
//   * `let X`/`const X`  → DROP the keyword. In non-strict indirect eval an unqualified
//     assignment `X = …` creates a GLOBAL property. Handles `let a=1, b=2` (comma sequence)
//     and `const {a,b} = o` / `const [x,,y] = arr` (pattern wrapped in `( … )`). A bare
//     `let x;` → `void(globalThis.x ??= undefined);`.
//   * `function NAME(…){…}` → `globalThis.NAME = function NAME(…){…}` (named fn EXPRESSION,
//     HOISTED to the top of the cell in source order so an earlier call site sees it).
//   * `class NAME …{…}`     → `globalThis.NAME = class NAME …{…}` (rewritten in place).
//
// SAFETY: a tiny tokenizer tracks string/template/regex/line+block-comment state and {}()[]
// depth. We ONLY rewrite at depth 0 at a statement boundary, and BAIL the WHOLE transform
// (return source UNCHANGED → plain eval) on ANY ambiguity (`async function`, `function*`,
// `export`, unterminated string/regex, unbalanced braces, unparseable declarator).

const KW = new Set(["let", "const", "function", "class"]);

function isIdentStart(c: string): boolean { return /[A-Za-z_$]/.test(c); }
function isIdentPart(c: string): boolean { return /[A-Za-z0-9_$]/.test(c); }

// An in-place edit: delete `consume` chars at `at`, insert `replacement`. `prefix` marks the
// hoist block emitted at offset 0 (applied last so it lands strictly at the front).
interface Edit {
  at: number;
  consume: number;
  replacement: string;
  prefix?: boolean;
}

// A depth-0 function declaration to be hoisted to the top of the cell.
interface Hoist {
  name: string;
  declText: string;
  at: number;
  consume: number;
}

// Result of handling a single declaration: either one `edit`, a set of `edits`, or a `hoist`.
interface DeclResult {
  edit?: Edit;
  edits?: Edit[];
  hoist?: Hoist;
}

// Cursor get/set indirection so the shared string/regex skippers can mutate the caller's index.
type GetI = () => number;
type SetI = (v: number) => void;

export function transformCell(src: string): string {
  if (typeof src !== "string" || src.length === 0) return src;
  // Fast path: no top-level decl keyword anywhere → nothing to do.
  if (!/(?:^|[^.\w$])(let|const|function|class)[^\w$]/.test(src)) return src;
  let edits: Edit[] | null;
  try {
    edits = planEdits(src);
  } catch {
    return src; // tokenizer threw on something exotic → plain eval.
  }
  if (!edits) return src;       // BAIL (ambiguous) → plain eval.
  if (!edits.length) return src; // no depth-0 declarations.
  // Apply edits right-to-left so offsets stay valid. The hoist prefix (at 0, marked) is applied
  // LAST so it lands strictly at the front even when a function declaration starts at offset 0.
  edits.sort((a, b) => (b.at - a.at) || ((a.prefix ? 1 : 0) - (b.prefix ? 1 : 0)));
  let out = src;
  for (const e of edits) {
    out = out.slice(0, e.at) + e.replacement + out.slice(e.at + e.consume);
  }
  return out;
}

// Scan the cell, returning the list of in-place edits, or null to BAIL.
function planEdits(src: string): Edit[] | null {
  const n = src.length;
  let i = 0;
  let depth = 0;
  let atStmtStart = true;
  let prev = "start"; // previous significant token class (for regex/async detection)
  let pendingAsyncOrExport = false; // saw `async`/`export` immediately before
  const edits: Edit[] = [];
  const hoists: Hoist[] = []; // depth-0 function declarations, in source order

  function skipTrivia(): void {
    while (i < n) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") i++;
      else if (c === "/" && src[i + 1] === "/") { i += 2; while (i < n && src[i] !== "\n") i++; }
      else if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; }
      else break;
    }
  }

  while (i < n) {
    skipTrivia();
    if (i >= n) break;
    const c = src[i];

    if (c === '"' || c === "'" || c === "`") {
      if (!skipString(src, () => i, (v) => (i = v), c)) return null;
      prev = "val"; atStmtStart = false; pendingAsyncOrExport = false; continue;
    }

    if (c === "/") {
      // regex vs division: regex allowed after operator/keyword/open/`,`/`;`/start.
      const regexOk = prev === "start" || prev === "op" || prev === "kw" || prev === "open" ||
        prev === "comma" || prev === "semi" || prev === "stmt";
      if (regexOk) {
        if (!skipRegex(src, () => i, (v) => (i = v))) return null;
        prev = "val"; atStmtStart = false; pendingAsyncOrExport = false; continue;
      }
      i++; prev = "op"; atStmtStart = false; continue;
    }

    if (c === "{" || c === "(" || c === "[") { depth++; i++; prev = "open"; atStmtStart = false; pendingAsyncOrExport = false; continue; }
    if (c === "}" || c === ")" || c === "]") {
      depth--; if (depth < 0) return null; i++;
      prev = c === ")" || c === "]" ? "val" : "closebrace";
      if (depth === 0 && c === "}") atStmtStart = true;
      pendingAsyncOrExport = false; continue;
    }
    if (c === ";") { i++; prev = "semi"; if (depth === 0) atStmtStart = true; pendingAsyncOrExport = false; continue; }
    if (c === ",") { i++; prev = "comma"; pendingAsyncOrExport = false; continue; }

    if (isIdentStart(c)) {
      const start = i;
      i++;
      while (i < n && isIdentPart(src[i])) i++;
      const word = src.slice(start, i);

      if (depth === 0 && atStmtStart && KW.has(word)) {
        if (pendingAsyncOrExport) return null; // `async function`/`export …` → bail.
        const edit = handleDeclaration(src, word, start, () => i, (v) => (i = v));
        if (!edit) return null; // unparseable declaration → bail (whole cell).
        if (edit.edit) edits.push(edit.edit);
        if (edit.edits) for (const e of edit.edits) edits.push(e);
        if (edit.hoist) {
          // remove the declaration in place (empty statement), hoist it to the top.
          edits.push({ at: edit.hoist.at, consume: edit.hoist.consume, replacement: ";" });
          hoists.push(edit.hoist);
        }
        atStmtStart = true; prev = "stmt"; pendingAsyncOrExport = false; continue;
      }

      if (word === "async" || word === "export") { pendingAsyncOrExport = true; prev = "kw"; atStmtStart = false; continue; }
      // keywords after which a `/` is a regex and which don't end a statement value.
      if (["return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
           "do", "else", "yield", "await", "case", "throw"].includes(word)) prev = "kw";
      else prev = "val";
      atStmtStart = false; pendingAsyncOrExport = false; continue;
    }

    // any other operator char
    i++; prev = "op"; atStmtStart = false; pendingAsyncOrExport = false;
  }

  if (depth !== 0) return null;
  if (hoists.length) {
    // Emit `globalThis.NAME = function NAME(…){…};` for every depth-0 function declaration,
    // in source order, at the TOP of the cell (offset 0). The named fn EXPRESSION keeps NAME
    // visible inside for recursion.
    const prefix = hoists
      .map((h) => `globalThis[${JSON.stringify(h.name)}] = ${h.declText};`)
      .join("");
    edits.push({ at: 0, consume: 0, replacement: prefix, prefix: true });
  }
  return edits;
}

// Handle a depth-0 declaration starting at `kwStart` with keyword `kw`. Advances i past the
// whole declaration. Returns a DeclResult or null to bail.
function handleDeclaration(src: string, kw: string, kwStart: number, getI: GetI, setI: SetI): DeclResult | null {
  const n = src.length;
  let i = getI();

  function ws(): void {
    while (i < n) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") i++;
      else if (c === "/" && src[i + 1] === "/") { i += 2; while (i < n && src[i] !== "\n") i++; }
      else if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; }
      else break;
    }
  }

  if (kw === "function" || kw === "class") {
    ws();
    if (kw === "function" && src[i] === "*") return null; // generator → bail.
    if (!isIdentStart(src[i])) return null; // anonymous / default → bail.
    const ns = i; i++; while (i < n && isIdentPart(src[i])) i++;
    const name = src.slice(ns, i);
    // skip to and balance the body braces so the outer scan resumes after the declaration.
    if (!skipToBlockEnd()) return null;
    const bodyEnd = i; // just past the closing `}` of the function/class body
    setI(i);
    if (kw === "function") {
      // HOIST: caller emits `globalThis.NAME = function NAME(…){…};` at the top of the cell.
      return { hoist: { name, declText: src.slice(kwStart, bodyEnd), at: kwStart, consume: bodyEnd - kwStart } };
    }
    // Rewrite `class NAME …{…}` → `globalThis.NAME = class NAME …{…};` (in place; TDZ semantics).
    return {
      edits: [
        { at: kwStart, consume: 0, replacement: `globalThis[${JSON.stringify(name)}] = ` },
        { at: bodyEnd, consume: 0, replacement: ";" },
      ],
    };
  }

  // let / const: drop the keyword, leaving an assignment list.
  ws();
  if (i >= n) return null;
  const firstNonKw = i;
  const startsWithPattern = src[i] === "{" || src[i] === "[";

  // validate + advance past the declarator list
  if (!validateDeclaratorList()) return null;
  // optional trailing `;`
  ws();
  let hadSemi = false;
  if (src[i] === ";") { i++; hadSemi = true; }
  setI(i);

  // Bare `let x;` with no initializer → safe global declare.
  const declText = src.slice(firstNonKw, hadSemi ? i - 1 : i);
  if (!/=/.test(declText) && !startsWithPattern) {
    // one-or-more bare names: `let a, b;` → `void(globalThis.a ??= undefined, globalThis.b ??= undefined);`
    const names = declText.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length && names.every((nm) => /^[A-Za-z_$][\w$]*$/.test(nm))) {
      const body = names.map((nm) => `globalThis[${JSON.stringify(nm)}] ??= undefined`).join(", ");
      return {
        edit: { at: kwStart, consume: (hadSemi ? i - 1 : i) - kwStart, replacement: `void(${body})` },
      };
    }
    return null; // unexpected bare form → bail.
  }

  // Drop the keyword. For a pattern (`{`/`[`) wrap the WHOLE declarator region in `( … )`.
  const declEnd = hadSemi ? i - 1 : i; // end of declarator list (before `;` if any)
  if (startsWithPattern) {
    return {
      edit: { at: kwStart, consume: declEnd - kwStart, replacement: "(" + src.slice(firstNonKw, declEnd) + ")" },
    };
  }
  // plain identifier list: just remove the keyword span (`let `/`const `) up to firstNonKw.
  return {
    edit: { at: kwStart, consume: firstNonKw - kwStart, replacement: "" },
  };

  // ---- shared helpers (mutate i) ----
  function validateDeclaratorList(): boolean {
    while (true) {
      ws();
      if (i >= n) break;
      const c = src[i];
      if (c === "{" || c === "[") {
        if (!skipBalanced()) return false; // pattern
      } else if (isIdentStart(c)) {
        i++; while (i < n && isIdentPart(src[i])) i++;
      } else {
        return false;
      }
      ws();
      if (src[i] === "=") {
        i++;
        if (!skipInitializer()) return false;
      }
      ws();
      if (src[i] === ",") { i++; continue; }
      break;
    }
    return true;
  }
  function skipBalanced(): boolean {
    let d = 0;
    while (i < n) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") { if (!skipString(src, () => i, (v) => (i = v), c)) return false; continue; }
      if (c === "/" && src[i + 1] === "/") { i += 2; while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      if (c === "{" || c === "[" || c === "(") { d++; i++; continue; }
      if (c === "}" || c === "]" || c === ")") { d--; i++; if (d === 0) return true; continue; }
      i++;
    }
    return false;
  }
  function skipInitializer(): boolean {
    let d = 0;
    while (i < n) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") { if (!skipString(src, () => i, (v) => (i = v), c)) return false; continue; }
      if (c === "/" && src[i + 1] === "/") { i += 2; while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      if (c === "/") {
        const pc = prevNonWs();
        if (pc === "" || "=+-*%&|^!<>?:(,[{~".includes(pc)) { if (!skipRegex(src, () => i, (v) => (i = v))) return false; continue; }
        i++; continue;
      }
      if (c === "(" || c === "[" || c === "{") { d++; i++; continue; }
      if (c === ")" || c === "]" || c === "}") { if (d === 0) return true; d--; i++; continue; }
      if (d === 0 && (c === "," || c === ";")) return true;
      i++;
    }
    return true; // ASI / end-of-cell
  }
  function prevNonWs(): string {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    return j >= 0 ? src[j] : "";
  }
  function skipToBlockEnd(): boolean {
    while (i < n && src[i] !== "{") {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") { if (!skipString(src, () => i, (v) => (i = v), c)) return false; continue; }
      if (c === "/" && src[i + 1] === "/") { i += 2; while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      i++;
    }
    if (src[i] !== "{") return false;
    let d = 0;
    while (i < n) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") { if (!skipString(src, () => i, (v) => (i = v), c)) return false; continue; }
      if (c === "/" && src[i + 1] === "/") { i += 2; while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      if (c === "{") { d++; i++; continue; }
      if (c === "}") { d--; i++; if (d === 0) return true; continue; }
      i++;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// wrapAsyncCompletion — REPL completion value for top-level-await cells.
//
// The engine (engine/src/lib.rs install_cell) runs an await-using multi-statement cell as
// `new AsyncFn(src)` — an async function BODY. A function body has NO completion value, so a
// trailing expression like `({m,i})` after a loop is DISCARDED and the cell returns undefined.
// (No-await cells use indirect `eval`, which DOES yield the last-expression value — so only the
// await path is affected.)
//
// FIX: when the cell uses a depth-0 `await` AND ends in a trailing expression after a depth-0
// `}` or `;` boundary, rewrite that trailing expression into `; return ( … );`. The engine's
// expr-mode (`return (src)`) then fails to compile (statements before the return), so it falls
// to the asyncbody path `new AsyncFn(src)` — where our explicit `return` now yields the value.
//
// SAFETY: this is a heuristic, applied AFTER transformCell. On ANY ambiguity (no depth-0
// await, no boundary, empty/keyword-led tail, unbalanced/exotic source) it returns the input
// UNCHANGED — i.e. today's behaviour (completion value undefined), never a correctness change.
const STMT_LEAD = new Set([
  "if", "for", "while", "switch", "try", "do", "else", "return", "throw", "break",
  "continue", "var", "let", "const", "function", "class", "with", "debugger", "export", "import",
]);

export function wrapAsyncCompletion(src: string): string {
  if (typeof src !== "string" || src.length === 0) return src;
  if (!/\bawait\b/.test(src)) return src; // engine uses the eval path → completion value already fine.
  let scan: { lastBoundaryEnd: number } | null;
  try {
    scan = scanTopLevel(src);
  } catch {
    return src;
  }
  if (!scan) return src;
  const b = scan.lastBoundaryEnd;
  if (b <= 0 || b >= src.length) return src; // no boundary, or boundary is the last char (no tail).
  const tail = src.slice(b);
  const tailTrim = tail.trim();
  if (tailTrim === "") return src; // trailing whitespace/comment only.
  // The tail must be a single EXPRESSION statement, not a nested statement/declaration.
  const m = /^[A-Za-z_$][\w$]*/.exec(tailTrim);
  if (m && STMT_LEAD.has(m[0])) return src; // already a return / control / declaration → leave it.
  if (tailTrim[0] === "{") return src; // block, not an object-literal expression statement → leave.
  // Rewrite: keep everything up to and including the boundary, then return the trailing expr.
  // A leading `;` guards against the boundary being a `}` (ASI-safe) and the wrapped `( … )`
  // makes an object-literal tail an expression, not a block.
  return src.slice(0, b) + ";return (\n" + tailTrim + "\n);";
}

// Scan `src` tracking string/template/regex/comment state and ()[]{} depth, returning the end
// offset of the LAST depth-0 statement boundary (a `;` or a `}` that returns depth to 0) and
// whether a depth-0 `await` identifier appears. Throws on nothing; returns null on unbalanced.
function scanTopLevel(src: string): { lastBoundaryEnd: number } | null {
  const n = src.length;
  let i = 0;
  let depth = 0;
  let prev = "start";
  let lastBoundaryEnd = -1;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { i += 2; while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      if (!skipString(src, () => i, (v) => (i = v), c)) return null;
      prev = "val"; continue;
    }
    if (c === "/") {
      const regexOk = prev === "start" || prev === "op" || prev === "open" || prev === "kw" || prev === "boundary";
      if (regexOk) { if (!skipRegex(src, () => i, (v) => (i = v))) return null; prev = "val"; continue; }
      i++; prev = "op"; continue;
    }
    if (c === "(" || c === "[" || c === "{") { depth++; i++; prev = "open"; continue; }
    if (c === ")" || c === "]" || c === "}") {
      depth--; if (depth < 0) return null; i++;
      if (c === "}" && depth === 0) { lastBoundaryEnd = i; prev = "boundary"; } else { prev = "val"; }
      continue;
    }
    if (c === ";") { i++; if (depth === 0) { lastBoundaryEnd = i; prev = "boundary"; } else prev = "op"; continue; }
    if (isIdentStart(c)) {
      const s = i; i++; while (i < n && isIdentPart(src[i])) i++;
      const w = src.slice(s, i);
      prev = STMT_LEAD.has(w) || ["typeof", "instanceof", "in", "of", "new", "delete", "void", "yield", "await", "case"].includes(w) ? "kw" : "val";
      continue;
    }
    i++; prev = "op";
  }
  if (depth !== 0) return null;
  return { lastBoundaryEnd };
}

// ---- shared string/regex skippers (operate on the caller's `i` via get/set) ----
function skipString(src: string, getI: GetI, setI: SetI, q: string): boolean {
  const n = src.length;
  let i = getI();
  i++; // opening quote
  while (i < n) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (q === "`") {
      if (c === "`") { i++; setI(i); return true; }
      if (c === "$" && src[i + 1] === "{") {
        i += 2; let d = 1;
        while (i < n && d > 0) {
          const cc = src[i];
          if (cc === "\\") { i += 2; continue; }
          if (cc === "{") { d++; i++; continue; }
          if (cc === "}") { d--; i++; continue; }
          if (cc === '"' || cc === "'" || cc === "`") { let j = i; if (!skipString(src, () => j, (v) => (j = v), cc)) return false; i = j; continue; }
          i++;
        }
        continue;
      }
      i++;
    } else {
      if (c === q) { i++; setI(i); return true; }
      if (c === "\n") { setI(i); return false; } // unterminated → bail
      i++;
    }
  }
  setI(i);
  return false;
}

function skipRegex(src: string, getI: GetI, setI: SetI): boolean {
  const n = src.length;
  let i = getI();
  i++; // opening /
  let inClass = false;
  while (i < n) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "[") { inClass = true; i++; continue; }
    if (c === "]") { inClass = false; i++; continue; }
    if (c === "/" && !inClass) { i++; break; }
    if (c === "\n") { setI(i); return false; }
    i++;
  }
  while (i < n && isIdentPart(src[i])) i++; // flags
  setI(i);
  return true;
}
