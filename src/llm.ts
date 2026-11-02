import { DEFAULT_MODEL_PREF, REASONING_MODELS, CHEAP_MODELS } from "./config.js";
import { spawnRouter } from "./router.js";
import { findCustomProvider, getProviderKey } from "./providers/index.js";
import type { CustomProviderConfig } from "./providers/index.js";
import { recordUsage } from "./usage.js";

// Overridable for tests (PANSA_LLM_BASE): points fetchJson/streamChat at
// a local test server instead of the real daemon port.
const BASE = process.env.PANSA_LLM_BASE ?? "http://127.0.0.1:17070";
const MODELS_PATH = "/v1/models";
const CHAT_PATH = "/v1/chat/completions";
const DAEMON_ARGS = ["start", "--bg"];
const START_POLL_MS = 200;
const START_MAX_MS = 5000;
const MODEL_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_FAILS_PER_MODEL = 3;
const CIRCUIT_OPEN_MS = 60_000;

export class LlmError extends Error {
  public readonly code: string;
  public readonly status?: number;
  public readonly retryable: boolean;
  constructor(message: string, opts: { code?: string; status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "LlmError";
    this.code = opts.code ?? "llm_error";
    this.status = opts.status;
    this.retryable = opts.retryable ?? true;
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Token usage of the assistant message that produced this message.
   *  Set only on generator return values; never sent back to an API
   *  (request builders strip it). */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools: ToolDef[];
  toolChoice: "required" | "auto" | "none";
  kind: "reasoning" | "cheap";
  signal?: AbortSignal;
}

interface CircuitState {
  fails: number;
  openUntil: number;
}

const circuits = new Map<string, CircuitState>();

function nowMs(): number {
  return Date.now();
}

function circuitOpen(model: string): boolean {
  const st = circuits.get(model);
  return !!st && st.openUntil > nowMs();
}

function circuitRecordFailure(model: string): void {
  const st = circuits.get(model) ?? { fails: 0, openUntil: 0 };
  st.fails++;
  if (st.fails >= MAX_FAILS_PER_MODEL) st.openUntil = nowMs() + CIRCUIT_OPEN_MS;
  circuits.set(model, st);
}

function circuitReset(model: string): void {
  circuits.set(model, { fails: 0, openUntil: 0 });
}

async function fetchJson(path: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new LlmError(`HTTP ${res.status}`, { code: "http_error", status: res.status, retryable: res.status >= 500 || res.status === 429 });
    try {
      return await res.json();
    } catch {
      throw new LlmError(`Invalid JSON from ${path}`, { code: "bad_json", retryable: false });
    }
  } catch (err) {
    // Every failure surfaces as an LlmError, never a raw TypeError or
    // SyntaxError, so callers can branch on code/retryable (M17).
    if (err instanceof LlmError) throw err;
    if (ctrl.signal.aborted) throw new LlmError(`Request timed out: ${path}`, { code: "timeout", retryable: true });
    throw new LlmError(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`, { code: "fetch_error", retryable: true });
  } finally {
    clearTimeout(t);
  }
}

export async function ensureDaemon(): Promise<void> {
  try {
    await fetchJson(MODELS_PATH, MODEL_TIMEOUT_MS);
    return;
  } catch {
    // daemon may be down
  }
  // try to spawn bansos start --bg. The spawn outcome is captured, not
  // raced against a blind timeout: a binary-missing error must surface as
  // binary_missing, never degrade into a daemon timeout (M17).
  let spawnErr: Error | undefined;
  await new Promise<void>((resolve) => {
    // Resolve the bundled bansos-router first (createRequire), global
    // "bansos" only as fallback: a local install must work without a
    // global binary (U1.5).
    const proc = spawnRouter(DAEMON_ARGS);
    proc.unref();
    const timer = setTimeout(resolve, 1000);
    proc.on("error", (err) => {
      spawnErr = err;
      clearTimeout(timer);
      resolve();
    });
    proc.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (spawnErr) {
    process.stderr.write(`bansos-router not found. Install it: npm i -g bansos-router\n`);
    throw new LlmError("bansos-router binary missing", { code: "binary_missing", retryable: false });
  }
  // poll up to START_MAX_MS
  const deadline = nowMs() + START_MAX_MS;
  while (nowMs() < deadline) {
    try {
      await fetchJson(MODELS_PATH, MODEL_TIMEOUT_MS);
      return;
    } catch {
      await sleep(START_POLL_MS);
    }
  }
  throw new LlmError("bansos-router daemon did not start in time", { code: "daemon_timeout", retryable: true });
}

export async function fetchLiveModels(): Promise<string[]> {
  const data = await fetchJson(MODELS_PATH, MODEL_TIMEOUT_MS);
  const arr = (data as { data?: unknown[] }).data ?? [];
  const models: string[] = [];
  for (const item of arr) {
    const id = (item as { id?: string }).id;
    if (typeof id === "string") models.push(id);
  }
  return models;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffDelay(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return base + Math.floor(Math.random() * 1000);
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string; tool_calls?: unknown[] } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface StreamEndpoint {
  baseUrl: string;
  apiKey?: string;
  api?: "openai" | "anthropic";
}

/** Strip fields an API never accepts (usage lives only on returned
 *  messages) so a strict provider cannot reject the request. */
function sanitizeMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });
}

async function* streamChatOpenAI(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  toolChoice: ChatOptions["toolChoice"],
  signal: AbortSignal,
  endpoint?: StreamEndpoint,
): AsyncGenerator<string, ChatMessage, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: sanitizeMessages(messages),
    stream: true,
  };
  if (tools.length > 0) body.tools = tools.map((t) => ({ type: "function", function: t }));
  if (toolChoice === "required" && tools.length > 0) body.tool_choice = "required";
  else if (toolChoice === "none") body.tool_choice = "none";
  else body.tool_choice = "auto";
  // Usage tokens arrive only when asked (final chunk). Ask only custom
  // endpoints: the daemon path must keep its exact historical request.
  if (endpoint) body.stream_options = { include_usage: true };

  const ctrl = new AbortController();
  signal?.addEventListener("abort", () => ctrl.abort());
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  let accContent = "";
  // Keyed by stream index; the entry keeps the REAL streamed tool-call id
  // when the provider sends one, falling back to call_<index>.
  const accCalls = new Map<string, { id: string; name: string; args: string }>();
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (endpoint?.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
    const res = await fetch(`${endpoint ? endpoint.baseUrl.replace(/\/$/, "") : BASE}${CHAT_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new LlmError(`HTTP ${res.status}: ${txt}`, {
        code: "http_error",
        status: res.status,
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    const stream = res.body as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          let parsed: StreamChunk;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          if (parsed.usage) {
            usage = {
              inputTokens: parsed.usage.prompt_tokens ?? 0,
              outputTokens: parsed.usage.completion_tokens ?? 0,
            };
          }
          for (const choice of parsed.choices ?? []) {
            const delta = choice.delta ?? {};
            if (typeof delta.content === "string") {
              accContent += delta.content;
              yield delta.content;
            }
            for (const tc of delta.tool_calls ?? []) {
              const idx2 = (tc as { index?: number }).index;
              if (typeof idx2 !== "number") continue;
              let entry = accCalls.get(String(idx2));
              if (!entry) { entry = { id: `call_${idx2}`, name: "", args: "" }; accCalls.set(String(idx2), entry); }
              if (typeof (tc as { id?: string }).id === "string" && (tc as { id: string }).id) {
                entry.id = (tc as { id: string }).id;
              }
              if (typeof (tc as { function?: { name?: string } }).function?.name === "string") {
                entry.name = (tc as { function: { name: string } }).function.name;
              }
              if (typeof (tc as { function?: { arguments?: string } }).function?.arguments === "string") {
                entry.args += (tc as { function: { arguments: string } }).function.arguments;
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(t);
  }
  const toolCalls: ToolCall[] = [];
  for (const entry of accCalls.values()) {
    if (entry.name) toolCalls.push({ id: entry.id, type: "function", function: { name: entry.name, arguments: entry.args } });
  }
  return {
    role: "assistant",
    content: accContent,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

/** Convert PANSA messages to Anthropic's wire format. Anthropic needs
 *  strict user/assistant alternation and tool calls as content blocks,
 *  so consecutive same-role messages merge and tool results attach to
 *  the surrounding user turn. */
function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: AnthropicContentBlock[] }>;
} {
  const systemParts: string[] = [];
  const out: Array<{ role: "user" | "assistant"; content: AnthropicContentBlock[] }> = [];
  const push = (role: "user" | "assistant", block: AnthropicContentBlock) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
    } else if (m.role === "assistant") {
      if (m.content) push("assistant", { type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          input = {};
        }
        push("assistant", { type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
    } else if (m.role === "tool") {
      push("user", { type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: m.content });
    } else {
      if (m.content) push("user", { type: "text", text: m.content });
    }
  }
  return { system: systemParts.join("\n\n"), messages: out };
}

async function* streamChatAnthropic(
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  toolChoice: ChatOptions["toolChoice"],
  signal: AbortSignal,
  endpoint: StreamEndpoint,
): AsyncGenerator<string, ChatMessage, unknown> {
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    stream: true,
    messages: anthropicMessages,
  };
  if (system) body.system = system;
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (toolChoice === "required") body.tool_choice = { type: "any" };
    else if (toolChoice === "none") body.tool_choice = { type: "none" };
    else body.tool_choice = { type: "auto" };
  }

  const ctrl = new AbortController();
  signal?.addEventListener("abort", () => ctrl.abort());
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  let accContent = "";
  const accTools = new Map<number, { id: string; name: string; args: string }>();
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    if (endpoint.apiKey) headers["x-api-key"] = endpoint.apiKey;
    const res = await fetch(`${endpoint.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new LlmError(`HTTP ${res.status}: ${txt}`, {
        code: "http_error",
        status: res.status,
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    const stream = res.body as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
          } catch {
            continue;
          }
          const event = eventLine?.slice(7).trim();
          if (event === "message_start") {
            const u = (parsed.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
            if (u) usage = { inputTokens: u.input_tokens ?? 0, outputTokens: 0 };
          } else if (event === "content_block_start") {
            const block = parsed.content_block as { type?: string; id?: string; name?: string } | undefined;
            const index = parsed.index as number | undefined;
            if (block?.type === "tool_use" && typeof index === "number") {
              accTools.set(index, { id: block.id ?? `call_${index}`, name: block.name ?? "", args: "" });
            }
          } else if (event === "content_block_delta") {
            const delta = parsed.delta as { type?: string; text?: string; partial_json?: string } | undefined;
            const index = parsed.index as number | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              accContent += delta.text;
              yield delta.text;
            } else if (delta?.type === "input_json_delta" && typeof index === "number") {
              const entry = accTools.get(index);
              if (entry && typeof delta.partial_json === "string") entry.args += delta.partial_json;
            }
          } else if (event === "message_delta") {
            const u = (parsed.usage as { output_tokens?: number } | undefined);
            if (u && usage) usage = { ...usage, outputTokens: u.output_tokens ?? 0 };
            else if (u) usage = { inputTokens: 0, outputTokens: u.output_tokens ?? 0 };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(t);
  }
  const toolCalls: ToolCall[] = [];
  for (const entry of accTools.values()) {
    if (entry.name) toolCalls.push({ id: entry.id, type: "function", function: { name: entry.name, arguments: entry.args } });
  }
  return {
    role: "assistant",
    content: accContent,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}

const TOOL_FENCE = /```(?:json)?\s*\n([\s\S]*?)\n```/g;

// Extract the first balanced {...} object from text, respecting strings
// and escapes. The old non-greedy regex stopped at the first '}', which
// broke every tool call with nested args objects.
function extractBalancedJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseToolFence(text: string): { name: string; args: Record<string, unknown> } | null {
  TOOL_FENCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_FENCE.exec(text)) !== null) {
    const raw = extractBalancedJson(m[1] ?? "");
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw) as { tool?: unknown; args?: unknown };
      if (obj && typeof obj.tool === "string" && obj.args && typeof obj.args === "object") {
        return { name: obj.tool, args: obj.args as Record<string, unknown> };
      }
    } catch {
      // try the next fence
    }
  }
  return null;
}

export interface ChatResult {
  message: ChatMessage;
  model: string;
}

export async function chat(
  opts: ChatOptions & { onChunk?: (text: string) => void },
  liveModels: string[],
  cfg: { preferReasoning?: string[]; preferCheap?: string[]; models?: string[]; providers?: CustomProviderConfig[]; onlyModel?: string },
): Promise<ChatResult> {
  const candidates = modelsForKind(opts.kind, liveModels, cfg);
  // Custom providers: a model served by an enabled custom provider that
  // the daemon does NOT serve goes first (the user pinned it explicitly).
  // A model that is ALSO daemon-live stays on the daemon path, so
  // existing behavior never changes for daemon models.
  const liveSet = new Set(liveModels);
  const preferred = opts.kind === "reasoning" ? (cfg.preferReasoning ?? REASONING_MODELS) : (cfg.preferCheap ?? CHEAP_MODELS);
  const allCfg = cfg.models ?? [...DEFAULT_MODEL_PREF];
  const customModels: string[] = [];
  for (const m of [...preferred, ...allCfg]) {
    if (!liveSet.has(m) && !customModels.includes(m) && findCustomProvider(m, cfg.providers)) {
      customModels.push(m);
    }
  }
  // Strict pin: when the caller names one model explicitly (the gateway
  // pin), that model is the ONLY candidate. A silent fallback to another
  // model would lie about what served the answer, so any failure here
  // throws instead of moving on. Callers without a pin keep failover.
  const onlyModel = cfg.onlyModel;
  if (onlyModel && !liveSet.has(onlyModel) && !findCustomProvider(onlyModel, cfg.providers)) {
    throw new LlmError(`Model ${onlyModel} tidak tersedia di daemon maupun provider custom`, { code: "model_failed", retryable: false });
  }
  const ordered = onlyModel ? [onlyModel] : [...customModels, ...candidates.filter((m) => !customModels.includes(m))];
  if (ordered.length === 0) throw new LlmError("no live model available", { code: "no_model", retryable: false });

  // Failover, not retry: each candidate gets one attempt; a failure moves
  // to the NEXT model instead of hammering the same one 3 times (M17).
  let lastErr: unknown;
  let attempt = 0;
  for (const model of ordered) {
    // An explicit pin overrides the circuit breaker: the user asked for
    // this model now, so a past failure must not skip it silently.
    if (!onlyModel && circuitOpen(model)) continue;
    try {
      const signal = opts.signal ?? new AbortController().signal;
      const custom = !liveSet.has(model) ? findCustomProvider(model, cfg.providers) : undefined;
      const endpoint: StreamEndpoint | undefined = custom
        ? { baseUrl: custom.baseUrl, apiKey: getProviderKey(custom.id, process.env.PANSA_PASSPHRASE), api: custom.api ?? "openai" }
        : undefined;
      const gen =
        endpoint?.api === "anthropic"
          ? streamChatAnthropic(model, opts.messages, opts.tools, opts.toolChoice, signal, endpoint)
          : streamChatOpenAI(model, opts.messages, opts.tools, opts.toolChoice, signal, endpoint);
      let step = await gen.next();
      while (!step.done) {
        if (typeof step.value === "string") opts.onChunk?.(step.value);
        step = await gen.next();
      }
      const final = step.value as ChatMessage;
      // Usage tracking never breaks a chat: record best-effort, ignore failures.
      try {
        const usage = final.usage;
        if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
          recordUsage({ provider: custom ? custom.id : "daemon", model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
        }
      } catch {
        // ignore
      }
      circuitReset(model);
      return { message: final, model };
    } catch (err) {
      lastErr = err;
      if (onlyModel) {
        throw new LlmError(`Model ${onlyModel} gagal: ${err instanceof Error ? err.message : String(err)}`, { code: "model_failed", retryable: false });
      }
      if (err instanceof LlmError && !err.retryable) throw err;
      circuitRecordFailure(model);
      await sleep(backoffDelay(attempt++));
    }
  }
  throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr));
}

// Ordered candidate models for a task kind: preferred kind models first,
// then every other live model from cfg.models, deduplicated.
function modelsForKind(
  kind: ChatOptions["kind"],
  live: string[],
  cfg: { preferReasoning?: string[]; preferCheap?: string[]; models?: string[] },
): string[] {
  const all = cfg.models ?? [...DEFAULT_MODEL_PREF];
  const liveSet = new Set(live);
  const preferred = kind === "reasoning"
    ? (cfg.preferReasoning ?? REASONING_MODELS)
    : (cfg.preferCheap ?? CHEAP_MODELS);
  const out: string[] = [];
  for (const m of [...preferred, ...all]) {
    if (liveSet.has(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

export { parseToolFence };
