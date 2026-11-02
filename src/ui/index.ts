import { stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Agent } from "../agent.js";
import { ContextManager } from "../context.js";
import { loadContextFiles } from "../context.js";
import { buildAgentTools } from "../tools.js";
import { loadConfig, PANSA_DIR } from "../config.js";
import { ensureDaemon, fetchLiveModels } from "../llm.js";
import { humanConfirm, humanReject } from "../human-confirm.js";
import { getPolicy, listPendingConfirmations } from "../signer/policy.js";
import { getSpentToday } from "../signer/ledger.js";
import { walletRegistryLoad } from "../signer/keystore.js";
import { resolveEvmRpc, getEvmBalance, formatEth } from "../evm-rpc.js";
import { tracker } from "../tracker/index.js";
import { createReportTool } from "../tracker/tools.js";
import { sessionManager } from "../session-manager.js";
import { runDoctor, formatDoctor } from "../doctor.js";

// Color support using 16-color ANSI palette

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  underline: "\x1b[4m",
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgBlack: "\x1b[40m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
  bgWhite: "\x1b[47m",
};

// Terminal detection

export function isPlain(): boolean {
  return process.env.PLAIN !== undefined;
}

export function supportsColor(): boolean {
  if (!processStdout.isTTY) return false;
  return process.env.NO_COLOR === undefined;
}

export function isTTY(): boolean {
  return processStdin.isTTY && processStdout.isTTY;
}

// History management

function historyPath(): string {
  return `${process.env.HOME ?? ""}/.pansa/history`;
}
const MAX_HISTORY = 500;

export class History {
  public lines: string[] = [];
  public pos = 0;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const data = readFileSync(historyPath(), "utf8").trim();
      if (data) {
        this.lines = data.split("\n").slice(-MAX_HISTORY);
      }
    } catch {
      // no history file yet
    }
  }

  save(): void {
    try {
      mkdirSync(dirname(historyPath()), { recursive: true });
      writeFileSync(historyPath(), this.lines.join("\n"), "utf8");
    } catch {
      // ignore save errors
    }
  }

  get(): string[] {
    return this.lines;
  }

  add(line: string): void {
    const trimmed = line.trim();
    if (trimmed && this.lines[this.lines.length - 1] !== trimmed) {
      this.lines.push(trimmed);
      if (this.lines.length > MAX_HISTORY) this.lines.shift();
      this.save();
    }
  }

  up(): string | null {
    if (this.lines.length === 0) return null;
    if (this.pos >= this.lines.length) this.pos = this.lines.length;
    if (this.pos > 0) {
      this.pos--;
      return this.lines[this.pos];
    }
    return null;
  }

  down(): string | null {
    if (this.pos >= this.lines.length) return null;
    this.pos++;
    if (this.pos < this.lines.length) {
      return this.lines[this.pos];
    }
    this.pos = this.lines.length;
    return null;
  }
}

// Light markdown renderer

export class MarkdownRenderer {
  public color: boolean;

  constructor(options: { color?: boolean } = {}) {
    this.color = options.color !== false && supportsColor();
  }

  render(text: string): string {
    if (!text) return "";
    if (!this.color || isPlain()) {
      return this.plainRender(text);
    }
    return this.colorRender(text);
  }

  private plainRender(text: string): string {
    return text
      .replace(/\*\*([^\*]+)\*\*/g, "$1")
      .replace(/\*([^\*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
  }

  private colorRender(text: string): string {
    return text
      .replace(/\*\*([^\*]+)\*\*/g, `${COLORS.bold}$1${COLORS.reset}`)
      .replace(/\*([^\*]+)\*/g, `${COLORS.bold}$1${COLORS.reset}`)
      .replace(/`([^`]+)`/g, `${COLORS.cyan}$1${COLORS.reset}`);
  }
}

// Main TUI Class

export class TUI {
  private rl: ReturnType<typeof createInterface> | null = null;
  public history: History;
  public renderer: MarkdownRenderer;
  private inputBuf = "";
  private exitCounter = 0;
  private statusLine = "";
  public model = "";
  public wallet = "";
  public testnet = true;
  public spend = "0.00/0.05";
  public gateway = "off";
  public verbose = false;
  private liveModels: string[] = [];
  private agent: Agent | null = null;
  // Owns the agent's conversation context (used by /export and /compact).
  public agentContext: ContextManager | null = null;
  private agentStreamed = "";

  constructor() {
    this.history = new History();
    this.renderer = new MarkdownRenderer();
  }

  private clearScreen(): string {
    return `\x1b[2J\x1b[H`;
  }

  private eraseLine(): string {
    return "\x1b[2K";
  }

  private cursorShow(): string {
    return "\x1b[?25h";
  }

  // Header rendering (M1): every number shown is real data, never a
  // hardcoded claim. Counts fall back to "?" when their store is
  // unreachable instead of inventing a value.
  private spendDisplay(): string {
    try {
      const policy = getPolicy();
      if (this.wallet) {
        const spent = getSpentToday(this.wallet, "evm");
        return `${spent.toFixed(4)}/${policy.spendCapPerDay}`;
      }
      return `cap ${policy.spendCapPerDay}/day`;
    } catch {
      return this.spend;
    }
  }

  private pendingTasksCount(): string {
    try {
      return String(tracker.listTasks({ pending: true }).length);
    } catch {
      return "?";
    }
  }

  private pendingConfirmsCount(): string {
    try {
      return String(listPendingConfirmations().length);
    } catch {
      return "?";
    }
  }

  renderHeader(version = "v0.1.0"): string {
    const mainnet = !this.testnet ? `${COLORS.red}MAINNET${COLORS.reset}` : "TESTNET";
    const walletDisplay = this.wallet ? `${this.wallet.substring(0, 6)}…${this.wallet.slice(-4)}` : "-";
    const modelDisplay = this.model || "auto";
    return `
  ╭─ PANSA · crypto airdrop agent ───── ${version} ──────────────────╮
  │ model   ${modelDisplay.padEnd(37)}│
  │ wallet  ${walletDisplay.padEnd(37)}│
  │ mode    ${mainnet} · spend ${this.spendDisplay()} · gateway: ${this.gateway}     │
  │ due     ${this.pendingTasksCount()} pending tasks · pending confirms: ${this.pendingConfirmsCount()}       │
  ╰────────────────────────────────────────────────────────╯`;
  }

  // Status line

  renderStatusLine(): string {
    this.statusLine = `model ${this.model || "auto"} · ${this.wallet} · ${this.testnet ? "TESTNET" : "MAINNET"} · spend/${this.spendDisplay()} · gateway: ${this.gateway}`;
    return this.statusLine;
  }

  // Output rendering (token streaming)

  renderOutput(text: string): string {
    return this.renderer.render(text);
  }

  // Input handling

  start(): void {
    this.rl = createInterface({ input: processStdin, output: processStdout, prompt: "❯ " });

    this.rl.on("line", (line: string) => this.handleLine(line));
    this.rl.on("close", () => this.exit(0));

    process.on("SIGINT", () => this.ctrlC());
    process.on("SIGTERM", () => this.exit(0));

    // NOTE (D9): no keypress handler here. With raw mode off, stdin never
    // emits keypress events, so the old Ctrl+L/Esc handler was dead code.
    // Screen clearing is available via /clear; Ctrl+C/Ctrl+D are handled
    // by readline and the SIGINT handler above.

    process.on("SIGWINCH", () => {
      processStdout.write(this.clearScreen());
      processStdout.write(this.renderHeader() + "\n");
      processStdout.write(this.renderStatusLine() + "\n");
      processStdout.write(this.prompt());
    });

    // Initial render
    processStdout.write(this.renderHeader() + "\n");
    processStdout.write(this.renderStatusLine() + "\n");
    processStdout.write(this.prompt());
  }

  private prompt(): string {
    return processStdout.isTTY && !isPlain() ? "❯ " : "pansa> ";
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();

    // History
    if (trimmed && !trimmed.startsWith("/")) {
      this.history.add(trimmed);
    }

    // Empty line
    if (trimmed === "") {
      processStdout.write(this.prompt());
      return;
    }

    // Exit commands
    if (trimmed === "/exit" || trimmed === "/quit" || trimmed === "exit" || trimmed === "quit") {
      this.exit(0);
      return;
    }

    // Ctrl+C was already handled, but double Ctrl+C exits
    if (this.exitCounter > 0 && trimmed === "") {
      this.exit(0);
      return;
    }
    this.exitCounter = 0;

    // Multi-line via trailing backslash
    if (trimmed.endsWith("\\")) {
      this.inputBuf += trimmed.slice(0, -1) + " ";
      processStdout.write(this.eraseLine() + this.prompt() + this.inputBuf);
      return;
    }

    // Human-only confirmation: intercepted before the agent ever sees it.
    const confirmMatch = trimmed.match(/^CONFIRM\s+(\S+)$/i);
    if (confirmMatch) {
      void humanConfirm(confirmMatch[1]).then(() => processStdout.write(this.prompt()));
      return;
    }
    const rejectMatch = trimmed.match(/^REJECT\s+(\S+)$/i);
    if (rejectMatch) {
      humanReject(rejectMatch[1]);
      processStdout.write(this.prompt());
      return;
    }

    // Slash commands
    if (trimmed.startsWith("/")) {
      this.handleSlashCommand(trimmed);
      return;
    }

    // Regular input
    this.processInput(trimmed);
  }

  public async handleSlashCommand(cmd: string): Promise<void> {
    const parts = cmd.slice(1).split(/\s+/);
    const command = parts[0];

    try {
      switch (command) {
        case "help": {
          processStdout.write(this.helpText());
          break;
        }
        case "status": {
          processStdout.write(`Status: model=${this.model || "auto"}, wallet=${this.wallet || "none"}, ${this.testnet ? "TESTNET" : "MAINNET"}, spend=${this.spendDisplay()}, gateway=${this.gateway}, pending tasks=${this.pendingTasksCount()}, pending confirms=${this.pendingConfirmsCount()}\n`);
          break;
        }
        case "model": {
          const m = parts[1];
          if (!m) {
            const live = await fetchLiveModels().catch(() => this.liveModels);
            processStdout.write(`Model saat ini: ${this.model || "auto"}\nModel live: ${live.length ? live.join(", ") : "(tidak ada data)"}\nUsage: /model <id>\n`);
            break;
          }
          const live = await fetchLiveModels().catch(() => this.liveModels);
          if (live.length > 0 && !live.includes(m)) {
            processStdout.write(`Model ${m} tidak ada di daftar live. Daftar live: ${live.join(", ")}\n`);
            break;
          }
          this.model = m;
          if (this.agent) this.agent.setModel(m);
          processStdout.write(`Model set to: ${m}\n`);
          break;
        }
        case "wallet": {
          const sub = parts[1];
          if (sub === "list") {
            const names = walletRegistryLoad().map((w) => `${w.name} (${w.family} ${w.address})`);
            processStdout.write(names.length ? `Wallets:\n${names.map((n) => `  ${n}`).join("\n")}\n` : "Wallets: (none configured)\n");
          } else if (sub === "use" && parts[2]) {
            const found = walletRegistryLoad().find((w) => w.name === parts[2]);
            if (!found) {
              processStdout.write(`Dompet tidak ditemukan: ${parts[2]}\n`);
            } else {
              this.wallet = parts[2];
              processStdout.write(`Wallet set to: ${parts[2]}\n`);
            }
          } else {
            processStdout.write("Usage: /wallet [list|use <name>]\n");
          }
          break;
        }
        case "balance": {
          const chain = parts[1] || "evm";
          const cfg = loadConfig();
          const defs = (cfg as { defaultWallets?: Record<string, string> }).defaultWallets ?? {};
          const name = this.wallet || defs[chain];
          if (!name) {
            processStdout.write(`Belum ada dompet untuk ${chain} (pilih dengan /wallet use <nama> atau buat via CLI).\n`);
            break;
          }
          const record = walletRegistryLoad().find((w) => w.name === name && w.family === chain);
          if (!record) {
            processStdout.write(`Dompet "${name}" tidak ditemukan di registry untuk ${chain}.\n`);
            break;
          }
          if (chain !== "evm") {
            processStdout.write(`Balance lookup belum didukung untuk ${chain} (hanya EVM via RPC).\n${chain} ${name}: ${record.address}\n`);
            break;
          }
          const rpcUrl = resolveEvmRpc();
          if (!rpcUrl) {
            processStdout.write(`Tidak ada endpoint EVM RPC. Set PANSA_EVM_RPC atau evmRpc di config.\n${chain} ${name}: ${record.address}\n`);
            break;
          }
          try {
            const balance = await getEvmBalance(record.address, rpcUrl);
            processStdout.write(`${chain} ${name}: ${record.address}\nSaldo: ${formatEth(balance)} ETH\n`);
          } catch (err) {
            processStdout.write(`Gagal ambil saldo: ${err instanceof Error ? err.message : String(err)}\n`);
          }
          break;
        }
        case "skills": {
          const tools = [...buildAgentTools().values()];
          processStdout.write(`Agent tools:\n${tools.map((t) => `  ${t.name} - ${t.description}`).join("\n")}\n`);
          break;
        }
        case "skill": {
          const skillName = parts[1];
          if (!skillName) {
            processStdout.write("Usage: /skill <name>\n");
            break;
          }
          const tool = buildAgentTools().get(skillName);
          if (!tool) {
            processStdout.write(`Tool tidak ditemukan: ${skillName} (lihat /skills)\n`);
          } else {
            processStdout.write(`Tool: ${tool.name}\nDeskripsi: ${tool.description}\nParameter: ${JSON.stringify(tool.parameters)}\n`);
          }
          break;
        }
        case "tracker": {
          const tasks = tracker.listTasks({ pending: true });
          if (tasks.length === 0) {
            processStdout.write("Tracker: tidak ada tugas pending.\n");
          } else {
            processStdout.write(`Tracker: ${tasks.length} tugas pending:\n${tasks.slice(0, 10).map((t) => `  [${t.status}] ${t.title}`).join("\n")}\n`);
          }
          break;
        }
        case "report": {
          const res = await createReportTool().execute({});
          if (!res.ok) processStdout.write(`Report gagal: ${res.error}\n`);
          else processStdout.write(JSON.stringify(res.data, null, 2) + "\n");
          break;
        }
        case "policy": {
          processStdout.write(JSON.stringify(getPolicy(), null, 2) + "\n");
          break;
        }
        case "gateway": {
          processStdout.write("Gateway tidak tersedia di PANSA dan tidak lagi dijanjikan.\n");
          break;
        }
        case "setup": {
          processStdout.write("Jalankan `pansa setup` dari shell (TUI tidak menjalankan setup).\n");
          break;
        }
        case "sessions": {
          const sessions = await sessionManager.listSessions();
          if (sessions.length === 0) {
            processStdout.write("Sessions: (kosong)\n");
          } else {
            processStdout.write(`Sessions:\n${sessions.slice(0, 10).map((s) => `  ${s.id} - ${s.title} (${s.updated_at})`).join("\n")}\n`);
          }
          break;
        }
        case "compact": {
          if (!this.agentContext) {
            processStdout.write("Compact: belum ada percakapan agent.\n");
            break;
          }
          const before = this.agentContext.messagesForLlm().length;
          this.agentContext.compact();
          const after = this.agentContext.messagesForLlm().length;
          processStdout.write(`Compact: ${before} -> ${after} pesan.\n`);
          break;
        }
        case "clear": {
          processStdout.write(this.clearScreen());
          processStdout.write(this.renderHeader() + "\n");
          processStdout.write(this.renderStatusLine() + "\n");
          break;
        }
        case "verbose": {
          this.verbose = !this.verbose;
          processStdout.write(`Verbose mode: ${this.verbose ? "on" : "off"}\n`);
          break;
        }
        case "theme": {
          processStdout.write("Theme: default (satu-satunya tema yang tersedia)\n");
          break;
        }
        case "doctor": {
          const checks = await runDoctor();
          processStdout.write(formatDoctor(checks) + "\n");
          break;
        }
        case "export": {
          if (!this.agentContext) {
            processStdout.write("Export: belum ada percakapan agent.\n");
            break;
          }
          mkdirSync(PANSA_DIR, { recursive: true, mode: 0o700 });
          const file = `${PANSA_DIR}/export-${Date.now()}.json`;
          writeFileSync(file, JSON.stringify(this.agentContext.messagesForLlm(), null, 2), { mode: 0o600 });
          processStdout.write(`Export tersimpan: ${file}\n`);
          break;
        }
        default: {
          processStdout.write(`Unknown command: /${command}\n`);
          processStdout.write(this.helpText());
          break;
        }
      }
    } catch (err) {
      processStdout.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    processStdout.write(this.prompt());
  }

  private helpText(): string {
    return `
PANSA Slash Commands:
  /help            Show this help
  /status          Show current status
  /model [id]      Pin agent to a live model
  /wallet [list|use <n>]
  /balance [chain] Check balance (real, EVM via RPC)
  /skills          List agent tools
  /skill <name>    Show tool info
  /tracker         Show pending tasks
  /report          Generate report
  /policy          Show current policy
  /gateway         Gateway (not available)
  /setup           Pointer to CLI setup
  /sessions        List sessions
  /compact         Summarize old turns
  /clear           Clear screen
  /verbose         Toggle verbose error detail
  /doctor          Show system info
  /export          Export transcript to a file
  /exit            Exit PANSA

Keybindings: Ctrl+C cancel, Ctrl+D exit
`;
  }

  private async ensureAgent(): Promise<Agent> {
    if (this.agent && this.agentContext) return this.agent;
    const cfg = loadConfig();
    try {
      await ensureDaemon();
    } catch {
      // Daemon down: agent still builds; run() reports no-model on use.
    }
    const live = await fetchLiveModels().catch((): string[] => []);
    this.liveModels = live;
    const ctx = new ContextManager();
    for (const f of loadContextFiles()) ctx.appendFileContext(f);
    const agent = new Agent({
      context: ctx,
      tools: buildAgentTools(),
      liveModels: live,
      cfg: { preferReasoning: cfg.preferReasoning, preferCheap: cfg.preferCheap, models: cfg.models },
      onChunk: (t) => { this.agentStreamed += t; processStdout.write(t); },
    });
    if (this.model) agent.setModel(this.model);
    this.agent = agent;
    this.agentContext = ctx;
    return agent;
  }

  private async processInput(input: string): Promise<void> {
    try {
      const agent = await this.ensureAgent();
      this.agentStreamed = "";
      const out = await agent.run(input);
      if (!this.agentStreamed) processStdout.write(out + "\n");
      else processStdout.write("\n");
    } catch (err) {
      // /verbose controls error detail: message only by default, full
      // stack when verbose is on.
      const detail = this.verbose && err instanceof Error && err.stack ? err.stack : (err instanceof Error ? err.message : String(err));
      processStdout.write(`Error: ${detail}\n`);
    }
    processStdout.write(this.prompt());
  }

  // Keyboard handling

  private ctrlC(): void {
    this.exitCounter++;
    if (this.exitCounter >= 2) {
      this.exit(0);
    } else {
      processStdout.write("\nCancelling current generation...\n");
      processStdout.write(this.prompt());
      setTimeout(() => {
        this.exitCounter = 0;
      }, 1000);
    }
  }

  // Exit

  exit(code = 0): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.history.save();
    processStdout.write(this.cursorShow());
    processStdout.write("\nSelamat tinggal.\n");
    process.exit(code);
  }

  // Run loop

  run(): void {
    try {
      this.start();
    } catch (err) {
      processStdout.write(`Error: ${err instanceof Error ? err.message : err}\n`);
      this.exit(1);
    }
  }
}

// Entry point lives only in src/cli.ts. This module used to self-execute
// when bundled (import.meta.url matched the bundle), starting a second TUI
// on TTY and printing a non-interactive banner on non-TTY stdout (B11).
// It is now a pure library: import { TUI } and run it explicitly.