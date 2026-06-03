// repl-transform.mjs — Node-REPL-style top-level-declaration persistence transform.
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
//     assignment `X = …` creates a GLOBAL property. The assignment's value IS the cell's
//     completion value when the declaration is the last statement (parity with what an
//     expression cell returns). Handles `let a=1, b=2` (the comma sequence assigns both
//     globally) and `const {a,b} = o` (the pattern is wrapped in `( … )` so the leading `{`
//     is parsed as an object pattern, not a block) and `const [x,,y] = arr`.
//     A bare `let x;` (no initializer) → `void(globalThis.x ??= undefined);` — declares the
//     global without clobbering an existing value, empty-ish completion.
//   * `function NAME(…){…}` → `globalThis.NAME = function NAME(…){…}` (named function
//     EXPRESSION: `NAME` stays visible inside for recursion, and is published globally). The
//     completion value is the function only if it is the last statement (REPL-correct).
//   * `class NAME …{…}`     → `globalThis.NAME = class NAME …{…}`.
//
// COMPLETION VALUE: verified in Node (same eval-completion rules as QuickJS) — `x = 41; x+1`
// → 42; `({a,b}=o); a+b` → sum; a trailing decl-as-assignment → the value/fn/class. The last
// value-producing statement still wins.
//
// SAFETY: a real tiny tokenizer tracks string/template/regex/line+block-comment state and
// {}()[] depth. We ONLY rewrite at depth 0 at a statement boundary, so `for(let i…)`, a `let`
// inside a nested block/function/arrow, and any `let`/`const`/`class`/`function` inside a
// string/template/regex/comment are untouched. We BAIL the WHOLE transform (return the source
// UNCHANGED → plain eval) on ANY ambiguity: `async function`, `function*`/generator, `export`,
// unterminated string/regex, unbalanced braces, or a declaration we can't cleanly parse. We
// never corrupt the cell.
//
// HOISTING CAVEAT (documented, accepted): rewriting `function f(){}` to an assignment removes
// the var-hoist, so calling `f()` on a line ABOVE the declaration within the SAME cell no
// longer works. This is rare in REPL cells and the safer behavior; cross-cell calls are
// unaffected (the global is published by the time the next cell runs).

const KW = new Set(["let", "const", "function", "class"]);

function isIdentStart(c) { return /[A-Za-z_$]/.test(c); }
function isIdentPart(c) { return /[A-Za-z0-9_$]/.test(c); }

// Edit record: replace src[start,kwEnd) and optionally wrap. We accumulate edits then splice.
// Each edit is { at, remove, insert } meaning: delete `remove` chars at `at`, insert `insert`.

export function transformCell(src) {
  if (typeof src !== "string" || src.length === 0) return src;
  // Fast path: no top-level decl keyword anywhere → nothing to do.
  if (!/(?:^|[^.\w$])(let|const|function|class)[^\w$]/.test(src)) return src;
  let edits;
  try {
    edits = planEdits(src);
  } catch {
    return src; // tokenizer threw on something exotic → plain eval.
  }
  if (!edits) return src;       // BAIL (ambiguous) → plain eval.
  if (!edits.length) return src; // no depth-0 declarations.
  // Apply edits right-to-left so offsets stay valid. Each edit replaces src[at, at+consume)
  // with `replacement`.
  edits.sort((a, b) => b.at - a.at);
  let out = src;
  for (const e of edits) {
    out = out.slice(0, e.at) + e.replacement + out.slice(e.at + e.consume);
  }
  return out;
}

// Scan the cell, returning the list of in-place edits, or null to BAIL.
function planEdits(src) {
  const n = src.length;
  let i = 0;
  let depth = 0;
  let atStmtStart = true;
  let prev = "start"; // previous significant token class (for regex/async detection)
  let pendingAsyncOrExport = false; // saw `async`/`export` immediately before
  const edits = [];

  function skipTrivia() {
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
  return edits;
}

// Handle a depth-0 declaration starting at `kwStart` with keyword `kw`. Advances i past the
// whole declaration. Returns { edit } (edit may be null if no rewrite needed) or null to bail.
function handleDeclaration(src, kw, kwStart, getI, setI) {
  const n = src.length;
  let i = getI();

  function ws() {
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
    // Rewrite `function NAME(…){…}` → `globalThis.NAME = function NAME(…){…};`. The declaration
    // becomes a named function/class EXPRESSION (NAME still visible inside for recursion). We
    // PREPEND `globalThis.NAME = ` and APPEND `;` so the expression statement is terminated (a
    // bare named-fn-expression statement followed by the next token would mis-parse / be a syntax
    // error). The trailing `;` does not affect completion: when this decl is the LAST statement
    // its completion is the fn/class (correct REPL value); a `;` after it is an empty statement.
    return {
      edits: [
        { at: kwStart, consume: 0, replacement: `globalThis[${JSON.stringify(name)}] = ` },
        { at: bodyEnd, consume: 0, replacement: ";" },
      ],
    };
  }

  // let / const: drop the keyword, leaving an assignment list. Validate by scanning the
  // declarator list (bail on anything unparseable), but the actual rewrite is just deleting
  // the keyword span (and wrapping a leading-`{`/`[` pattern in parens so it's an expression).
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

  // Bare `let x;` with no initializer: rewriting to `x;` would be a ReferenceError (TDZ-free
  // global read of an undefined name in sloppy mode is actually fine → yields undefined, but a
  // bare unknown identifier reference is `ReferenceError` in QuickJS strict-ish). Make it a
  // safe global declare instead. Detect "no `=` and single identifier".
  // We only special-case the simplest bare form; anything else keeps the drop-keyword rewrite.
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

  // Drop the keyword (and any whitespace up to the first declarator). For a pattern (`{`/`[`)
  // wrap the WHOLE declarator region in `( … )` so `{a}=o` is an object-destructuring assignment,
  // not a block. We do this by inserting `(` at firstNonKw and `)` after the declarator list end.
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
  function validateDeclaratorList() {
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
  function skipBalanced() {
    const open = src[i];
    const close = open === "{" ? "}" : open === "[" ? "]" : ")";
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
  function skipInitializer() {
    let d = 0;
    while (i < n) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") { if (!skipString(src, () => i, (v) => (i = v), c)) return false; continue; }
      if (c === "/" && src[i + 1] === "/") { i += 2; while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      if (c === "/") {
        // regex allowed at start of initializer or after operators — be permissive: treat `/`
        // following `=`,`(`,`,`,`[`,`{`,operators as regex. Simplify: if previous non-ws char is
        // one of those, read a regex; else division.
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
  function prevNonWs() {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    return j >= 0 ? src[j] : "";
  }
  function skipToBlockEnd() {
    while (i < n && src[i] !== "{") {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") { if (!skipString(src, () => i, (v) => (i = v), c)) return false; continue; }
      if (c === "/" && src[i + 1] === "/") { i += 2; while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      // `(` for function params is fine; just keep scanning to the body `{`.
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

// ---- shared string/regex skippers (operate on the caller's `i` via get/set) ----
function skipString(src, getI, setI, q) {
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

function skipRegex(src, getI, setI) {
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
