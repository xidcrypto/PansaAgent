import { stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

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

const HISTORY_PATH = `${process.env.HOME ?? ""}/.pansa/history`;
const MAX_HISTORY = 500;

export class History {
  public lines: string[] = [];
  public pos = 0;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const data = readFileSync(HISTORY_PATH, "utf8").trim();
      if (data) {
        this.lines = data.split("\\n").slice(-MAX_HISTORY);
      }
    } catch {
      // no history file yet
    }
  }

  save(): void {
    try {
      mkdirSync(dirname(HISTORY_PATH), { recursive: true });
      writeFileSync(HISTORY_PATH, this.lines.join("\\n"), "utf8");
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

  constructor() {
    this.history = new History();
    this.renderer = new MarkdownRenderer();
    if (processStdout.isTTY) {
      processStdout.write(this.clearScreen());
    }
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

  // Header rendering

  renderHeader(version = "v0.1.0"): string {
    const mainnet = !this.testnet ? `${COLORS.red}MAINNET${COLORS.reset}` : "TESTNET";
    const walletDisplay = this.wallet ? `${this.wallet.substring(0, 6)}…${this.wallet.substring(-4)}` : "-";
    const port = process.env.PORT || "17070";
    return `
  ╭─ PANSA · crypto airdrop agent ───── ${version} ──────────────────╮
  │ ● bansos-router :${port}  12 models live                │
  │ │ model   deepseek-v4-flash-free                     │
  │ │ wallet  ${walletDisplay.padEnd(37)}│
  │ │ mode    ${mainnet} · spend ${this.spend} · gateway: ${this.gateway}     │
  │ │ due     2 tasks in 24h · pending confirms: 0       │
  ╰────────────────────────────────────────────────────────╯`;
  }

  // Status line

  renderStatusLine(): string {
    this.statusLine = `model · ${this.wallet} · ${this.testnet ? "TESTNET" : "MAINNET"} · spend/${this.spend} · gateway: ${this.gateway}`;
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

    processStdin.setRawMode(false);
    processStdin.on("keypress", (_stream, key) => {
      if (key && key.name === "l" && key.ctrl) {
        processStdout.write(this.clearScreen());
        processStdout.write(this.renderHeader() + "\n");
        processStdout.write(this.renderStatusLine() + "\n");
        processStdout.write(this.prompt());
      }
      if (key && key.name === "escape") {
        this.exitCounter = 0;
        processStdout.write(this.prompt());
      }
    });

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

    // Slash commands
    if (trimmed.startsWith("/")) {
      this.handleSlashCommand(trimmed);
      return;
    }

    // Regular input
    this.processInput(trimmed);
  }

  public handleSlashCommand(cmd: string): void {
    const parts = cmd.slice(1).split(/\s+/);
    const command = parts[0];

    switch (command) {
      case "help": {
        processStdout.write(this.helpText());
        break;
      }
      case "status": {
        processStdout.write(`Status: model=${this.model || "auto"}, wallet=${this.wallet || "none"}, ${this.testnet ? "TESTNET" : "MAINNET"}, spend=${this.spend}, gateway=${this.gateway}\n`);
        break;
      }
      case "model": {
        const m = parts[1] || this.model || "deepseek-v4-flash-free";
        this.model = m;
        processStdout.write(`Model set to: ${m}\n`);
        break;
      }
      case "wallet": {
        const sub = parts[1];
        if (sub === "list") {
          processStdout.write("Wallets: (none configured)\n");
        } else if (sub === "use" && parts[2]) {
          this.wallet = parts[2];
          processStdout.write(`Wallet set to: ${parts[2]}\n`);
        } else {
          processStdout.write("Usage: /wallet [list|use <name>]\n");
        }
        break;
      }
      case "balance": {
        const chain = parts[1] || "evm";
        processStdout.write(`Balance for ${chain}: checking...\n`);
        break;
      }
      case "skills": {
        processStdout.write("Available skills: scout, scam-check, testnet, mint, baw, tracker, report\n");
        break;
      }
      case "skill": {
        const skillName = parts[1];
        if (skillName) {
          processStdout.write(`Skill: ${skillName} - loading...\n`);
        } else {
          processStdout.write("Usage: /skill <name>\n");
        }
        break;
      }
      case "tracker": {
        processStdout.write("Tracker: showing pending tasks...\n");
        break;
      }
      case "report": {
        processStdout.write("Report: generating summary...\n");
        break;
      }
      case "policy": {
        processStdout.write("Policy: showing current policy...\n");
        break;
      }
      case "gateway": {
        processStdout.write("Gateway: status check...\n");
        break;
      }
      case "setup": {
        processStdout.write("Setup wizard - starting...\n");
        break;
      }
      case "sessions": {
        processStdout.write("Sessions: listing recent sessions...\n");
        break;
      }
      case "compact": {
        processStdout.write("Compact: summarizing old turns...\n");
        break;
      }
      case "clear": {
        processStdout.write(this.clearScreen());
        processStdout.write(this.renderHeader() + "\n");
        processStdout.write(this.renderStatusLine() + "\n");
        break;
      }
      case "verbose": {
        processStdout.write("Verbose mode toggled\n");
        break;
      }
      case "theme": {
        processStdout.write("Theme: default\n");
        break;
      }
      case "doctor": {
        processStdout.write(`Doctor: Node ${process.version}\n`);
        break;
      }
      case "export": {
        processStdout.write("Export: exporting session...\n");
        break;
      }
      default: {
        processStdout.write(`Unknown command: /${command}\n`);
        processStdout.write(this.helpText());
        break;
      }
    }
    processStdout.write(this.prompt());
  }

  private helpText(): string {
    return `
PANSA Slash Commands:
  /help            Show this help
  /status          Show current status
  /model [id]      Pick model (arrow-key picker)
  /wallet [list|use <n>]
  /balance [chain] Check balance
  /skills          List available skills
  /skill <name>    Load a skill
  /tracker         Show pending tasks
  /report          Generate report
  /policy          Show current policy
  /gateway         Gateway status/control
  /setup           Setup wizard
  /sessions        List sessions
  /compact         Summarize old turns
  /clear           Clear screen
  /verbose         Toggle verbose output
  /doctor          Show system info
  /export          Export session
  /exit            Exit PANSA

Keybindings: Ctrl+C cancel, Ctrl+D exit, Ctrl+L clear, Esc cancel input
`;
  }

  private processInput(_input: string): void {
    // Send input to agent
    processStdout.write(`Processing: ${_input}\n`);
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

// Entry point

async function main(): Promise<void> {
  // Check if stdin is a TTY
  const isTTYMode = processStdin.isTTY && processStdout.isTTY;

  if (!isTTYMode) {
    // Non-TTY mode: plain text, no interactive features
    processStdout.write("PANSA - non-interactive mode\n");
    processStdout.write("Use: pansa run \"<prompt>\" for headless mode\n");
    return;
  }

  // First-run check: if config missing, run setup
  const configPath = `${process.env.HOME ?? ""}/.pansa/config.json`;
  if (!existsSync(configPath)) {
    processStdout.write("First run detected. Running setup...\n");
    processStdout.write("Setup complete.\n");
  }

  const tui = new TUI();
  tui.run();
}

// Run if executed directly (ESM-compatible)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    processStdout.write(`Fatal error: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
}