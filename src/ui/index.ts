import { stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Agent } from "../agent.js";
import { ContextManager } from "../context.js";
import { loadContextFiles } from "../context.js";
import { buildAgentTools, buildAgentToolsWithMcp } from "../tools.js";
import { loadConfig, PANSA_DIR } from "../config.js";
import { ensureDaemon, fetchLiveModels } from "../llm.js";
import { humanConfirm, humanReject } from "../human-confirm.js";
import { getPolicy, listPendingConfirmations } from "../signer/policy.js";
import { getSpentToday } from "../signer/ledger.js";
import { walletRegistryLoad, defaultPath } from "../signer/keystore.js";
import { getSignerClient } from "../signer/client.js";
import { generateMnemonic } from "../mnemonic.js";
import { redact } from "../redact.js";
import { matchCommand } from "../commands.js";
import type { Command } from "../commands.js";
import { listSkillDocs } from "../skills/loader.js";
import { resolveRestore, startRunSession, finishRunSession } from "../session-flow.js";
import type { RunSession } from "../session-flow.js";
import { sessionManager } from "../session-manager.js";
import { resolveEvmRpc, getEvmBalance, formatEth } from "../evm-rpc.js";
import { tracker } from "../tracker/index.js";
import { createReportTool } from "../tracker/tools.js";
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
      // Redacted on save too: a history file written by an older version
      // (or edited by hand) must not re-persist a secret.
      writeFileSync(historyPath(), this.lines.map((l) => redact(l)).join("\n"), "utf8");
    } catch {
      // ignore save errors
    }
  }

  get(): string[] {
    return this.lines;
  }

  add(line: string): void {
    const trimmed = redact(line.trim());
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

// Light markdown renderer. Fenced code blocks render inside a box
// (never mangled by the inline rules); lists and tables pass through
// unmangled, with bold/inline-code styling still applied inside cells.
export class MarkdownRenderer {
  public color: boolean;

  constructor(options: { color?: boolean } = {}) {
    this.color = options.color !== false && supportsColor();
  }

  render(text: string): string {
    if (!text) return "";
    if (!this.color || isPlain()) {
      return this.renderSegments(text, (s) => this.plainNormal(s), (l, c) => this.plainFence(l, c));
    }
    return this.renderSegments(text, (s) => this.colorNormal(s), (l, c) => this.colorFence(l, c));
  }

  // Split fenced blocks from normal text so inline rules never rewrite
  // code content. Unclosed fences fall through as normal text.
  private renderSegments(
    text: string,
    normal: (s: string) => string,
    fence: (lang: string, code: string) => string,
  ): string {
    const out: string[] = [];
    const re = /```(\w*)\n([\s\S]*?)```/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(normal(text.slice(last, m.index)));
      out.push(fence(m[1] ?? "", m[2]));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(normal(text.slice(last)));
    return out.join("");
  }

  private plainNormal(text: string): string {
    return text
      .replace(/\*\*([^\*]+)\*\*/g, "$1")
      .replace(/\*([^\*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
  }

  private plainFence(_lang: string, code: string): string {
    // Code content keeps its text but loses markdown markers (a fenced
    // block is not a bold/italic context).
    return this.plainNormal(code.replace(/\n$/, ""));
  }

  private colorNormal(text: string): string {
    return text
      .replace(/\*\*([^\*]+)\*\*/g, `${COLORS.bold}$1${COLORS.reset}`)
      .replace(/\*([^\*]+)\*/g, `${COLORS.bold}$1${COLORS.reset}`)
      .replace(/`([^`]+)`/g, `${COLORS.cyan}$1${COLORS.reset}`);
  }

  private colorFence(_lang: string, code: string): string {
    const lines = code.replace(/\n$/, "").split("\n");
    const width = Math.max(0, ...lines.map((l) => l.length));
    const top = `${COLORS.cyan}╭${"─".repeat(width + 2)}╮${COLORS.reset}`;
    const mid = lines.map((l) => `│ ${l.padEnd(width)} │`).join("\n");
    const bottom = `${COLORS.cyan}╰${"─".repeat(width + 2)}╯${COLORS.reset}`;
    return `${top}\n${mid}\n${bottom}`;
  }
}

// Tab completion for the readline prompt (U3). The second tuple element
// is the word being replaced, so multi-word commands complete their last
// word (e.g. "/model deep" completes model ids, not the whole line).
export interface CompleteOptions {
  wallets?: string[];
  skills?: string[];
  models?: string[];
}

const SLASH_COMMANDS = [
  "help", "status", "model", "wallet", "balance", "skills", "skill",
  "tracker", "report", "policy", "gateway", "setup", "sessions", "resume",
  "compact", "clear", "verbose", "theme", "doctor", "export", "exit",
];

export function completeLine(line: string, opts: CompleteOptions = {}): [string[], string] {
  if (line.startsWith("/model ")) {
    const prefix = line.slice("/model ".length);
    return [(opts.models ?? []).filter((m) => m.startsWith(prefix)), prefix];
  }
  if (line.startsWith("/skill ")) {
    const prefix = line.slice("/skill ".length);
    return [(opts.skills ?? []).filter((s) => s.startsWith(prefix)), prefix];
  }
  if (line.startsWith("/wallet use ")) {
    const prefix = line.slice("/wallet use ".length);
    return [(opts.wallets ?? []).filter((w) => w.startsWith(prefix)), prefix];
  }
  if (line.startsWith("/")) {
    const prefix = line.slice(1);
    return [SLASH_COMMANDS.filter((c) => c.startsWith(prefix)).map((c) => `/${c}`), line];
  }
  return [[], line];
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
  // U3 generation control: abort (Ctrl+C), spinner until first chunk,
  // footer timing, and the run's session (U4).
  private abortCtrl: AbortController | null = null;
  private spinner: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private generationStart = 0;
  private generationModel = "";
  private runSession: RunSession | null = null;
  private restoreOpt?: "last" | string;
  private restoreDone = false;

  constructor(opts: { restore?: "last" | string } = {}) {
    this.history = new History();
    this.renderer = new MarkdownRenderer();
    this.restoreOpt = opts.restore;
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

  private walletNames(): string[] {
    try {
      return walletRegistryLoad().map((w) => w.name);
    } catch {
      return [];
    }
  }

  private refreshStatus(): void {
    processStdout.write(this.renderStatusLine() + "\n");
  }

  start(): void {
    this.rl = createInterface({
      input: processStdin,
      output: processStdout,
      prompt: "❯ ",
      completer: (line: string) =>
        completeLine(line, {
          wallets: this.walletNames(),
          skills: listSkillDocs(),
          models: this.liveModels,
        }),
    });

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

    // Empty line
    if (trimmed === "") {
      processStdout.write(this.prompt());
      return;
    }

    // Multi-line via trailing backslash: accumulate until a line without
    // one. The accumulated buffer is consumed by the final line (the old
    // code appended but never used it, dropping multi-line input).
    let text = trimmed;
    if (this.inputBuf) {
      text = this.inputBuf + trimmed;
      this.inputBuf = "";
    }
    if (text.endsWith("\\")) {
      this.inputBuf = text.slice(0, -1) + " ";
      processStdout.write(this.eraseLine() + this.prompt() + this.inputBuf);
      return;
    }

    // History (completed lines only, never slash commands)
    if (!text.startsWith("/")) {
      this.history.add(text);
    }

    // Exit commands
    if (text === "/exit" || text === "/quit" || text === "exit" || text === "quit") {
      this.exit(0);
      return;
    }
    this.exitCounter = 0;

    // Human-only confirmation: intercepted before the agent ever sees it.
    const confirmMatch = text.match(/^CONFIRM\s+(\S+)$/i);
    if (confirmMatch) {
      void humanConfirm(confirmMatch[1]).then(() => processStdout.write(this.prompt()));
      return;
    }
    const rejectMatch = text.match(/^REJECT\s+(\S+)$/i);
    if (rejectMatch) {
      humanReject(rejectMatch[1]);
      processStdout.write(this.prompt());
      return;
    }

    // Slash commands
    if (text.startsWith("/")) {
      void this.handleSlashCommand(text);
      return;
    }

    // Deterministic commands bypass the LLM (U3): evm/solana/sui/aptos
    // wallet, wallet list/use/unlock/lock, balance, help.
    const dc = matchCommand(text);
    if (dc.kind !== "unknown") {
      void this.handleDeterministic(dc).then(() => processStdout.write(this.prompt()));
      return;
    }

    // Regular input
    void this.processInput(text);
  }

  // Deterministic handlers (no LLM involved). Wallet creation goes
  // through the signer process, exactly like the CLI path; the mnemonic
  // is never printed.
  private async handleDeterministic(dc: Command): Promise<void> {
    try {
      switch (dc.kind) {
        case "wallet_create": {
          const name = await this.createWallet(dc.chain, dc.name);
          if (name) {
            this.wallet = name;
            this.refreshStatus();
          }
          break;
        }
        case "wallet_set": {
          const name = dc.name ?? "default";
          const found = walletRegistryLoad().find((w) => w.name === name);
          if (!found) {
            processStdout.write(`Dompet tidak ditemukan: ${name}\n`);
          } else {
            this.wallet = name;
            processStdout.write(`Wallet set to: ${name}\n`);
            this.refreshStatus();
          }
          break;
        }
        case "wallet_list": {
          const names = walletRegistryLoad().map((w) => `${w.name} (${w.family} ${w.address})`);
          processStdout.write(names.length ? `Wallets:\n${names.map((n) => `  ${n}`).join("\n")}\n` : "Wallets: (none configured)\n");
          break;
        }
        case "wallet_use": {
          const found = walletRegistryLoad().find((w) => w.name === dc.name);
          if (!found) {
            processStdout.write(`Dompet tidak ditemukan: ${dc.name}\n`);
          } else {
            this.wallet = dc.name;
            processStdout.write(`Wallet set to: ${dc.name}\n`);
            this.refreshStatus();
          }
          break;
        }
        case "wallet_unlock": {
          const res = await getSignerClient().request("wallet.unlock", { name: dc.name, passphrase: process.env.PANSA_PASSPHRASE });
          processStdout.write(res.ok ? `Dompet "${dc.name}" di-unlock (15 menit).\n` : `Gagal unlock: ${res.error}\n`);
          break;
        }
        case "wallet_lock": {
          const res = await getSignerClient().request("wallet.lock", { name: dc.name });
          processStdout.write(res.ok ? `Dompet "${dc.name}" di-lock.\n` : `Gagal lock: ${res.error}\n`);
          break;
        }
        case "balance": {
          await this.showBalance(dc.chain ?? "evm");
          break;
        }
        case "help": {
          processStdout.write(this.helpText());
          break;
        }
        default:
          break;
      }
    } catch (err) {
      processStdout.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  private async createWallet(chain: string, name?: string): Promise<string | null> {
    const walletName = name ?? "default";
    try {
      await getSignerClient().request("keystore.create", {
        name: walletName,
        family: chain,
        mnemonic: generateMnemonic(128),
        path: defaultPath(chain),
        passphrase: process.env.PANSA_PASSPHRASE ?? "",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists")) {
        processStdout.write(`Dompet "${walletName}" sudah ada.\n`);
      } else {
        processStdout.write(`Gagal membuat dompet: ${msg}\n`);
        return null;
      }
    }
    processStdout.write(`Dompet ${chain} "${walletName}" siap (default).\n`);
    return walletName;
  }

  private async showBalance(chain: string): Promise<void> {
    const cfg = loadConfig();
    const defs = (cfg as { defaultWallets?: Record<string, string> }).defaultWallets ?? {};
    const name = this.wallet || defs[chain];
    if (!name) {
      processStdout.write(`Belum ada dompet untuk ${chain} (pilih dengan /wallet use <nama> atau buat via /wallet new ${chain}).\n`);
      return;
    }
    const record = walletRegistryLoad().find((w) => w.name === name && w.family === chain);
    if (!record) {
      processStdout.write(`Dompet "${name}" tidak ditemukan di registry untuk ${chain}.\n`);
      return;
    }
    if (chain !== "evm") {
      processStdout.write(`Balance lookup belum didukung untuk ${chain} (hanya EVM via RPC).\n${chain} ${name}: ${record.address}\n`);
      return;
    }
    const rpcUrl = resolveEvmRpc();
    if (!rpcUrl) {
      processStdout.write(`Tidak ada endpoint EVM RPC. Set PANSA_EVM_RPC atau evmRpc di config.\n${chain} ${name}: ${record.address}\n`);
      return;
    }
    try {
      const balance = await getEvmBalance(record.address, rpcUrl);
      processStdout.write(`${chain} ${name}: ${record.address}\nSaldo: ${await formatEth(balance)} ETH\n`);
    } catch (err) {
      processStdout.write(`Gagal ambil saldo: ${err instanceof Error ? err.message : String(err)}\n`);
    }
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
          this.refreshStatus();
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
              this.refreshStatus();
            }
          } else if (sub === "new" && parts[2]) {
            const chain = parts[2];
            if (!["evm", "solana", "sui", "aptos"].includes(chain)) {
              processStdout.write(`Rantai tidak valid: ${chain} (pilih evm|solana|sui|aptos)\n`);
            } else {
              const name = await this.createWallet(chain, parts[3]);
              if (name) {
                this.wallet = name;
                this.refreshStatus();
              }
            }
          } else {
            processStdout.write("Usage: /wallet [list|use <name>|new <chain> [name]]\n");
          }
          break;
        }
        case "balance": {
          await this.showBalance(parts[1] || "evm");
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
          const gw = loadConfig().gateways?.telegram;
          if (!gw) {
            processStdout.write("Gateway Telegram: belum dikonfigurasi (pansa setup gateway).\n");
          } else {
            processStdout.write(
              `Gateway Telegram: ${gw.enabled ? "aktif" : "nonaktif"} | allowlist: ${gw.allowlist.length} chat | konfirmasi mainnet via gateway: selalu ditolak\n`,
            );
          }
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
        case "resume": {
          const id = parts[1];
          if (!id) {
            const sessions = await sessionManager.listSessions();
            if (sessions.length === 0) {
              processStdout.write("Sessions: (kosong)\nUsage: /resume <id>\n");
            } else {
              processStdout.write(`Sessions:\n${sessions.slice(0, 10).map((s) => `  ${s.id} - ${s.title} (${s.updated_at})`).join("\n")}\nUsage: /resume <id>\n`);
            }
            break;
          }
          await this.ensureAgent();
          if (!this.agentContext) {
            processStdout.write("Resume: agent belum siap.\n");
            break;
          }
          const restored = await resolveRestore({ resumeId: id });
          if (!restored) {
            processStdout.write(`Session tidak ditemukan: ${id}\n`);
            break;
          }
          this.runSession = await startRunSession(this.agentContext, "", restored);
          processStdout.write(`Session dilanjutkan: ${restored}\n`);
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
          if (parts[1] === "json") {
            const file = `${PANSA_DIR}/export-${Date.now()}.json`;
            writeFileSync(file, JSON.stringify(this.agentContext.messagesForLlm(), null, 2), { mode: 0o600 });
            processStdout.write(`Export tersimpan: ${file}\n`);
            break;
          }
          // Default: Markdown transcript (U4), user + assistant turns only,
          // redacted (content was already redacted at add-time; redact
          // again as defense in depth for transcripts).
          const turns = this.agentContext.messagesForLlm().filter((m) => m.role === "user" || m.role === "assistant");
          const md = ["# PANSA transcript", "", ...turns.map((m) => `## ${m.role}\n\n${redact(m.content)}`)].join("\n");
          const file = `${PANSA_DIR}/export-${Date.now()}.md`;
          writeFileSync(file, md, { mode: 0o600 });
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
  /wallet [list|use <n>|new <chain> [name]]
  /balance [chain] Check balance (real, EVM via RPC)
  /skills          List agent tools
  /skill <name>    Show tool info
  /tracker         Show pending tasks
  /report          Generate report
  /policy          Show current policy
  /gateway         Gateway status (Telegram)
  /setup           Pointer to CLI setup
  /sessions        List sessions
  /resume [id]     Continue a session (or list sessions)
  /compact         Summarize old turns
  /clear           Clear screen
  /verbose         Toggle verbose error detail
  /doctor          Show system info
  /export [md|json] Export redacted transcript (default md)
  /exit            Exit PANSA

Deterministic (no slash, bypasses the LLM):
  evm|solana|sui|aptos wallet [name], wallet list|use|unlock|lock, balance

Keybindings: Ctrl+C cancel generation (twice within 1s to exit), Ctrl+D exit
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
      tools: await buildAgentToolsWithMcp(),
      liveModels: live,
      cfg: { preferReasoning: cfg.preferReasoning, preferCheap: cfg.preferCheap, models: cfg.models },
      onChunk: (t) => this.handleChunk(t),
      onToolCall: (info) => {
        processStdout.write(`\n⏵ ${info.name} … ${info.ok ? "✓" : "✗"} ${info.summary} (${info.ms} ms)\n`);
      },
    });
    if (this.model) agent.setModel(this.model);
    this.agent = agent;
    this.agentContext = ctx;
    return agent;
  }

  // Streaming chunks clear the spinner on first arrival (U3).
  private handleChunk(t: string): void {
    if (this.spinner) this.stopSpinner();
    this.agentStreamed += t;
    processStdout.write(t);
  }

  private startSpinner(): void {
    if (this.spinner) return;
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const started = Date.now();
    this.spinnerFrame = 0;
    this.spinner = setInterval(() => {
      const frame = frames[this.spinnerFrame++ % frames.length];
      processStdout.write(`\r${frame} ${Date.now() - started} ms`);
    }, 80);
    (this.spinner as unknown as { unref?: () => void }).unref?.();
  }

  private stopSpinner(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = null;
    processStdout.write("\r\x1b[2K");
  }

  private async ensureSessionForRun(firstText: string): Promise<RunSession | null> {
    if (this.runSession) return this.runSession;
    if (!this.agentContext) return null;
    try {
      if (this.restoreOpt && !this.restoreDone) {
        this.restoreDone = true;
        const id = await resolveRestore(this.restoreOpt === "last" ? { continueLast: true } : { resumeId: this.restoreOpt });
        if (id) {
          this.runSession = await startRunSession(this.agentContext, firstText, id);
          if (this.runSession) return this.runSession;
        }
      }
      this.runSession = await startRunSession(this.agentContext, firstText, null);
      return this.runSession;
    } catch {
      return null;
    }
  }

  private async processInput(input: string): Promise<void> {
    const cfg = loadConfig();
    let out = "";
    let wasAborted = false;
    try {
      const agent = await this.ensureAgent();
      const session = await this.ensureSessionForRun(input);
      this.agentStreamed = "";
      this.abortCtrl = new AbortController();
      this.generationStart = Date.now();
      this.generationModel = this.model || "auto";
      this.startSpinner();
      try {
        out = await agent.run(input, { signal: this.abortCtrl.signal });
      } finally {
        wasAborted = this.abortCtrl.signal.aborted;
        this.stopSpinner();
        this.abortCtrl = null;
      }
      if (!this.agentStreamed) processStdout.write(out + "\n");
      else processStdout.write("\n");
      if (!wasAborted) {
        const ms = Date.now() - this.generationStart;
        const chars = Math.max(this.agentStreamed.length, out.length);
        const tokens = Math.max(1, Math.round(chars / 4));
        processStdout.write(`— model ${this.generationModel} · ${ms} ms · ~${tokens} token\n`);
      }
      await finishRunSession(session, input, out, this.liveModels, {
        preferReasoning: cfg.preferReasoning,
        preferCheap: cfg.preferCheap,
        models: cfg.models,
      });
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
      return;
    }
    // First Ctrl+C aborts the live generation for real (AbortController);
    // a second one within 1s exits (existing behavior preserved).
    // When a generation is live, processInput prints the next prompt on
    // completion, so the abort path prints no prompt here (no doubles).
    if (this.abortCtrl && !this.abortCtrl.signal.aborted) {
      this.abortCtrl.abort();
      processStdout.write("\nGenerasi dibatalkan.\n");
    } else {
      processStdout.write("\nCancelling current generation...\n");
      processStdout.write(this.prompt());
    }
    setTimeout(() => {
      this.exitCounter = 0;
    }, 1000);
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