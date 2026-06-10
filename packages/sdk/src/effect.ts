/**
 * `@engram/sdk/effect` — an OPTIONAL Effect v4 layer over the durable kernel.
 *
 * Wraps the promise-based SDK ({@link EngramSession}, {@link EngramClient}) into
 * [Effect v4](https://github.com/Effect-TS/effect-smol) values, so substrates built on Effect
 * compose eval/connect with typed errors, retries, scopes, and the rest of the Effect toolbox —
 * without the core SDK taking an Effect dependency.
 *
 * `effect` is a PEER dependency: install it yourself (`npm i effect@^4.0.0-beta`) to use this entry.
 * The base `@engram/sdk` export has zero Effect dependency.
 *
 * The error channel is {@link EngramError} (and its typed subclasses {@link TimeoutError} /
 * {@link MemoryLimitError} / {@link FetchBlockedError} / {@link SizeAdmissionError}), so
 * `Effect.catchTag`-style discrimination works off `error.name`.
 *
 * ```ts
 * import { Effect } from "effect";
 * import { evalEffect, acquireSession } from "@engram/sdk/effect";
 *
 * const program = Effect.gen(function* () {
 *   const s = yield* acquireSession({ url, session: "demo" }); // auto-closed when the scope ends
 *   const r = yield* evalEffect(s, "1 + 1");
 *   return r.value;
 * });
 *
 * const value = await Effect.runPromise(Effect.scoped(program)); // 2
 * ```
 */
import { Effect, Scope } from "effect";
import {
  Engram,
  EngramError,
  EngramSession,
  type EngramClient,
  type ConnectOptions,
  type EvalResult,
} from "./index";

/** Coerce any thrown/rejected value into an {@link EngramError} (preserving SDK-typed errors). */
function asEngramError(e: unknown): EngramError {
  if (e instanceof EngramError) return e;
  if (e instanceof Error) return new EngramError(e.message);
  return new EngramError(String(e));
}

/**
 * Connect (or reattach) to a durable session as an Effect. Fails with {@link EngramError}.
 * Prefer {@link acquireSession} when you want the transport closed automatically.
 */
export function connectEffect(opts: ConnectOptions): Effect.Effect<EngramSession, EngramError> {
  return Effect.tryPromise({ try: () => Engram.connect(opts), catch: asEngramError });
}

/**
 * A SCOPED session: connects on acquire and `close()`s on release, so the transport is torn
 * down when the surrounding `Effect.scoped` finishes (success, failure, or interruption).
 */
export function acquireSession(opts: ConnectOptions): Effect.Effect<EngramSession, EngramError, Scope.Scope> {
  return Effect.acquireRelease(connectEffect(opts), (s) => Effect.sync(() => s.close()));
}

/** Evaluate one cell against a live session as an Effect. Fails with the typed {@link EngramError}. */
export function evalEffect<T = unknown, F = unknown>(
  session: EngramSession,
  code: string,
  opts?: { throwOnError?: boolean; timeoutMs?: number },
): Effect.Effect<EvalResult<T, F>, EngramError> {
  // Force throwOnError so a failed cell lands in the Effect error channel (not a value).
  return Effect.tryPromise({ try: () => session.eval<T, F>(code, { ...opts, throwOnError: true }), catch: asEngramError });
}

/** Connect-or-reuse a fleet session by id ({@link EngramClient}) as an Effect. */
export function clientSessionEffect(
  client: EngramClient,
  id: string,
  overrides?: Partial<ConnectOptions>,
): Effect.Effect<EngramSession, EngramError> {
  return Effect.tryPromise({ try: () => client.session(id, overrides), catch: asEngramError });
}

/** Connect-or-reuse a fleet session by id, then eval one cell — as a single Effect. */
export function clientEvalEffect<T = unknown, F = unknown>(
  client: EngramClient,
  id: string,
  code: string,
  opts?: { timeoutMs?: number },
): Effect.Effect<EvalResult<T, F>, EngramError> {
  return Effect.flatMap(clientSessionEffect(client, id), (s) => evalEffect<T, F>(s, code, opts));
}
