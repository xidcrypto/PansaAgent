import { chat, ChatMessage, ToolDef, LlmError } from "./llm.js";
import { ContextManager } from "./context.js";
import { redact } from "./redact.js";

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  // Static hint: true when executing this tool can move money. The agent
  // serializes such calls; per-action tools (e.g. baw) leave this unset
  // and are classified by their arguments in isSigning().
  signs?: boolean;
  // execute returns { ok, data, error? }; signing tools set signs: true
  execute(args: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; error?: string; signs?: boolean }>;
}

export interface AgentOptions {
  context: ContextManager;
  tools: Map<string, Tool>;
  liveModels: string[];
  cfg: { preferReasoning?: string[]; preferCheap?: string[]; models?: string[] };
  onChunk?: (text: string) => void;
  // Injectable chat function for tests (defaults to the real LLM chat).
  // Production always uses the default; tests inject a fake to drive
  // tool-flow scenarios without a daemon or network.
  chatFn?: typeof chat;
}

export class AgentError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

export class Agent {
  private readonly context: ContextManager;
  private readonly tools: Map<string, Tool>;
  private readonly liveModels: string[];
  private readonly cfg: AgentOptions["cfg"];
  private readonly onChunk?: (text: string) => void;
  private readonly chatFn: NonNullable<AgentOptions["chatFn"]>;

  constructor(opts: AgentOptions) {
    this.context = opts.context;
    this.tools = opts.tools;
    this.liveModels = opts.liveModels;
    this.cfg = opts.cfg;
    this.onChunk = opts.onChunk;
    this.chatFn = opts.chatFn ?? chat;
  }

  // Pin the agent to one model (used by the TUI /model command). Takes
  // effect on the next run, since chat() re-reads cfg per call.
  setModel(model: string): void {
    this.cfg.models = [model];
    this.cfg.preferReasoning = [model];
    this.cfg.preferCheap = [model];
  }

  async run(prompt: string): Promise<string> {
    this.context.addUser(prompt);
    let steps = 0;
    while (steps < 14) {
      steps++;
      const toolsDefs: ToolDef[] = [...this.tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
      const messages: ChatMessage[] = this.context.messagesForLlm().map((m) => ({
        role: m.role as ChatMessage["role"],
        content: m.content,
      }));
      let result;
      try {
        result = await this.chatFn(
          { messages, tools: toolsDefs, toolChoice: this.tools.size > 0 ? "required" : "auto", kind: "reasoning", onChunk: this.onChunk },
          this.liveModels,
          this.cfg,
        );
      } catch (err) {
        if (err instanceof LlmError && err.code === "no_model") {
          return "Model tidak tersedia. Jalankan `pansa setup` atau pastikan bansos-router berjalan.";
        }
        throw err;
      }
      const msg = result.message;
      this.context.addAssistant(msg.content ?? "");
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return msg.content ?? "Selesai.";
      }
      // Separate signing vs read-only
      const signing = msg.tool_calls.filter((tc) => this.isSigning(tc));
      const readonly = msg.tool_calls.filter((tc) => !this.isSigning(tc));
      if (signing.length > 0) {
        // serialize signing, one at a time
        for (const tc of signing) {
          const res = await this.executeOne(tc);
          this.context.addToolResult(tc.function.name, res.data, res.ok, res.error);
          if (!res.ok) {
            // corrective feedback, max repair handled by next loop
            this.context.addUser(`Tool ${tc.function.name} gagal: ${res.error}. Perbaiki argumen atau batalkan.`);
          }
        }
        continue;
      }
      // parallelize independent read-only
      const results = await Promise.all(readonly.map((tc) => this.executeOne(tc)));
      for (let i = 0; i < readonly.length; i++) {
        this.context.addToolResult(readonly[i].function.name, results[i].data, results[i].ok, results[i].error);
        if (!results[i].ok) {
          this.context.addUser(`Tool ${readonly[i].function.name} gagal: ${results[i].error}.`);
        }
      }
    }
    return "Melebihi batas langkah agent (14). Selesaikan tugas secara manual atau coba prompt yang lebih spesifik.";
  }

  private isSigning(tc: { id: string; function: { name: string; arguments: string } }): boolean {
    const tool = this.tools.get(tc.function.name);
    if (tool && typeof tool.signs === "boolean") return tool.signs;
    // Per-action tools (baw mixes reads and money-moving actions): classify
    // by the requested action, not just the tool name.
    if (tc.function.name === "baw") {
      try {
        const args = JSON.parse(tc.function.arguments ?? "{}") as { action?: string };
        if (args.action === "transfer" || args.action === "swap" || args.action === "claim") return true;
      } catch {
        // fall through to the name heuristic
      }
    }
    return /sign|send|mint|swap|transfer|bridge|confirm/i.test(tc.function.name);
  }

  private async executeOne(tc: { id: string; function: { name: string; arguments: string } }): Promise<{ ok: boolean; data: unknown; error?: string }> {
    const tool = this.tools.get(tc.function.name);
    if (!tool) return { ok: false, data: null, error: `tool ${tc.function.name} tidak dikenal` };
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.function.arguments ?? "{}");
    } catch {
      return { ok: false, data: null, error: "argumen tool tidak valid JSON" };
    }
    try {
      const res = await tool.execute(args);
      return { ok: res.ok, data: res.data, error: res.error };
    } catch (err) {
      return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function redactToolOutput(text: string): string {
  return redact(text);
}
