// @engram/sdk — type surface for the configurable codemode / RLM infrastructure.

export interface SessionConfig {
  clock?: "seeded" | "real";
  rngSeed?: number;
  capture?: boolean;
  cellBudgetTicks?: number;
  cellBudgetMs?: number;
  /** Egress allowlist: true = all, false = none, [hostnames] = scoped. */
  fetch?: boolean | string[];
  /** Demo/host-tool name allowlist (echo/add/kv); ctx.*/final/subLM are always enabled. */
  tools?: string[];
  /** In-VM stdlib preset: true = all defaults, [names] = subset. */
  modules?: boolean | string[];
  /** Sub-LM bridge endpoint; normally set automatically by onSubLM/the SDK bridge. */
  subLMEndpoint?: string;
}

export interface EvalResult {
  ok: boolean;
  value: unknown;
  valuePreview?: string;
  valueType?: string;
  logs: Array<{ level: string; text: string }>;
  error?: { name: string; message: string; stack?: string };
  cell?: number;
  final?: FinalInfo | Record<string, never>;
  restoreSource?: string;
}

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs: string[];
}

export interface FinalInfo {
  kind: "FINAL" | "FINAL_VAR";
  value?: unknown;
  var?: string;
  subLMCalls?: number;
}

export interface RLMResult {
  answer: unknown;
  kind: "FINAL" | "FINAL_VAR" | "EXHAUSTED";
  steps: number;
  subLMCalls?: number;
  history: Array<unknown>;
}

export type ToolHandler = (...args: any[]) => unknown | Promise<unknown>;
export type SubLMHandler = (req: { prompt: string; opts: Record<string, unknown> }) => string | Promise<string>;
export type RootModel = (ctx: {
  query: string; contextName: string; step: number; history: any[]; session: EngramSession;
}) => string | null | Promise<string | null>;

export interface ConnectOptions {
  endpoint: string;
  id?: string;
  config?: SessionConfig;
  WebSocket?: any;
  subLMEndpoint?: string;
  autoReconnect?: boolean;
}

export class EngramSession {
  id: string;
  config: SessionConfig;
  eval(src: string, timeoutMs?: number): Promise<EvalResult>;
  execute(code: string, fns?: Record<string, ToolHandler>): Promise<ExecuteResult>;
  reset(): Promise<any>;
  gen(): Promise<any>;
  setContext(name: string, blob: string): Promise<{ ok: boolean; name: string; len: number; cell: number }>;
  setContext(blob: string): Promise<{ ok: boolean; name: string; len: number; cell: number }>;
  registerTool(name: string, handler: ToolHandler): this;
  onSubLM(handler: SubLMHandler): this;
  onFinal(handler: (f: FinalInfo) => void | Promise<void>): this;
  hibernate(): Promise<any>;
  resume(): Promise<any>;
  trajectory(): Promise<{ cells: any[]; final: FinalInfo | null }>;
  rlm(query: string, opts?: { contextName?: string; rootModel?: RootModel; maxSteps?: number }): Promise<RLMResult>;
  lambdaRLM(query: string, opts?: LambdaRLMOptions): Promise<LambdaRLMResult>;
  close(): void;
}

/** v0.9.2 LAMBDA-RLM (lambda-calculus RLM): typed SPLIT/MAP/REDUCE, bounded + cost-capped. */
export interface LambdaRLMOptions {
  context?: string;
  ctx?: string;
  split?: number | string | ((text: string) => string[]);
  reduce?: "synthesize" | boolean | ((acc: any, r: any, i: number) => any);
  /** Max recursion depth (each SPLIT level costs 1). Default 2. */
  maxDepth?: number;
  /** HARD cap on total leaf-oracle (host.subLM) calls. Default 32. Guarantees termination. */
  costBudget?: number;
  /** Max chars per leaf prompt. Default 4000. */
  leafChars?: number;
  /** τ* — a part at/below this size is a leaf (no further SPLIT). Default = leafChars. */
  tau?: number;
  maxPumps?: number;
}
export interface LambdaRLMResult {
  answer: any;
  leafCalls: number;
  maxDepthSeen: number | null;
  exhausted: boolean;
  budget: { maxDepth: number; costBudget: number };
  subLMCalls: number;
}

export function connect(opts: ConnectOptions): Promise<EngramSession>;

/** v0.9.2 AGENT code-mode adapter: durable per-agent session; host tools = the agent tool surface. */
export interface AgentTurnResult {
  turn: number;
  code: string;
  ok: boolean;
  result?: any;
  error?: string;
  logs: string[];
  toolCalls: Array<{ tool: string; args: any[]; ok: boolean; result?: any; error?: string; ts: number }>;
}
export class Agent {
  constructor(session: EngramSession, opts?: { tools?: Record<string, ToolHandler> });
  session: EngramSession;
  registerTool(name: string, handler: ToolHandler): this;
  turn(code: string): Promise<AgentTurnResult>;
  hibernate(): Promise<any>;
  resume(): Promise<any>;
  transcript(): AgentTurnResult[];
  close(): void;
}
export function createAgent(opts: ConnectOptions & { tools?: Record<string, ToolHandler>; onSubLM?: SubLMHandler }): Promise<Agent>;

export class EngramExecutor {
  constructor(opts: ConnectOptions);
  execute(code: string, fns?: Record<string, ToolHandler>): Promise<ExecuteResult>;
  close(): Promise<void>;
}

export class EngramEnv {
  constructor(opts: ConnectOptions);
  run(code: string): Promise<{ stdout: string; result: unknown; error?: string }>;
  setContextVar(name: string, value: unknown): Promise<number>;
  installDeps(modules: string[]): Promise<void>;
  close(): Promise<void>;
}

declare const _default: {
  connect: typeof connect;
  EngramSession: typeof EngramSession;
  EngramExecutor: typeof EngramExecutor;
  EngramEnv: typeof EngramEnv;
  Agent: typeof Agent;
  createAgent: typeof createAgent;
};
export default _default;
