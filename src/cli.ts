import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { matchCommand } from "./commands.js";
import { loadConfig, saveConfig } from "./config.js";
import { ensureDaemon, fetchLiveModels } from "./llm.js";
import { ContextManager } from "./context.js";
import { Agent } from "./agent.js";
import { generateMnemonic } from "./mnemonic.js";
import { SignerClient } from "./signer/client.js";
import { keystoreUnlock } from "./signer/keystore.js";
import { TUI } from "./ui/index.js";

const HELP = `PANSA - crypto airdrop agent (lightweight CLI + gateway)

Usage:
  pansa                    REPL interaktif
  pansa run "<prompt>"     Jalankan satu prompt
  pansa setup              Setup wizard
  pansa setup gateway      Setup gateway (telegram)
  pansa gateway <cmd>      Gateway control (start|stop|status|test|logout)
  pansa daemon             Jalankan gateway daemon
  pansa backup <nama>      Backup mnemonik (hanya TTY)
  pansa doctor             Pemeriksaan kesehatan
  pansa models             Lihat model live
  pansa policy show|edit   Lihat/edit kebijakan
  pansa --help             Bantuan ini

Contoh:
  pansa run "cek saldo evm"
  pansa evm wallet mywallet
  pansa wallet list
  pansa balance evm
`;

let signerClient: SignerClient | null = null;

function getSigner(): SignerClient {
  if (!signerClient) {
    signerClient = new SignerClient(process.argv[1], process.env.PANSA_PASSPHRASE);
  }
  return signerClient;
}

function defaultPath(chain: string): string {
  switch (chain) {
    case "evm": return "m/44'/60'/0'/0/0";
    case "solana": return "m/44'/501'/0'/0'";
    case "sui": return "m/44'/784'/0'/0'/0'";
    case "aptos": return "m/44'/637'/0'/0'/0'";
    default: return "m/44'/60'/0'/0/0";
  }
}

export async function main(argv: string[]): Promise<number> {
  if (process.env.PANSA_SIGNER_SERVER === "1") {
    const { runStdio } = await import("./signer/server.js");
    runStdio();
    return 0;
  }

  // TTY auto-start: if no args and stdin is TTY, launch TUI
  if (argv.length === 0 && process.stdin.isTTY) {
    const tui = new TUI();
    tui.run();
    return new Promise(() => {}); // Keep process alive for TUI event loop
  }

  const parsed = parseArgs({
    args: argv,
    boolean: ["help", "h"],
    string: ["prompt"],
    allowNegatives: false,
    strict: false,
  });
  const values = parsed.values as { help?: boolean; h?: boolean; prompt?: string };
  const positionals: string[] = parsed.positionals as string[];

  if (values.help || values.h) {
    process.stdout.write(HELP);
    return 0;
  }

  const cmd: string | undefined = positionals[0];
  if (cmd === undefined) return repl();

  const rest = positionals.slice(1);

  switch (cmd) {
    case "run": {
      const prompt = (values.prompt as string | undefined) ?? rest.join(" ");
      if (!prompt) {
        process.stderr.write("Usage: pansa run \"<prompt>\"\n");
        return 1;
      }
      return runPrompt(prompt);
    }
    case "evm":
    case "solana":
    case "sui":
    case "aptos": {
      if (rest[0] === "wallet") return chainWallet(cmd, rest.slice(1));
      process.stderr.write(`Usage: pansa ${cmd} wallet [name]\n`);
      return 1;
    }
    case "wallet":
      return walletCmd(rest);
    case "balance":
      return balanceCmd(rest);
    case "setup":
      return setupCmd(rest);
    case "gateway":
      return gatewayCmd(rest);
    case "daemon":
      return daemonCmd();
    case "backup":
      return backupCmd(rest);
    case "doctor":
      return doctorCmd();
    case "models":
      return modelsCmd();
    case "policy":
      return policyCmd(rest);
    default:
      process.stderr.write(`Perintah tidak dikenal: ${cmd}\n${HELP}\n`);
      return 1;
  }
}

async function chainWallet(chain: string, rest: string[]): Promise<number> {
  if (rest[0] !== "wallet") {
    process.stderr.write(`Usage: pansa ${chain} wallet [name]\n`);
    return 1;
  }
  const name = rest[1] ?? "default";
  const mnemonic = generateMnemonic(128);
  try {
    await getSigner().request("keystore.create", {
      name, family: chain as any, mnemonic, path: defaultPath(chain), passphrase: process.env.PANSA_PASSPHRASE ?? "",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists")) {
      process.stdout.write(`Dompet "${name}" sudah ada.\n`);
    } else {
      process.stderr.write(`Gagal membuat dompet: ${msg}\n`);
      return 1;
    }
  }
  setDefaultWallet(chain, name);
  process.stdout.write(`Dompet ${chain} "${name}" siap (default).\n`);
  return 0;
}

async function walletCmd(rest: string[]): Promise<number> {
  const [sub, ...rest2] = rest;
  if (sub === "list") {
    try {
      const res = await getSigner().request("keystore.list");
      if (!res.ok) throw new Error(res.error);
      const names = (res.result as { names: string[] }).names;
      process.stdout.write(names.join("\n") + (names.length ? "\n" : "(kosong)\n"));
    } catch (err) {
      process.stderr.write(`Gagal list dompet: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    return 0;
  }
  if (sub === "create" && rest2.length >= 2) {
    const chain = rest2[0];
    const name = rest2[1];
    const mnemonic = generateMnemonic(128);
    try {
      await getSigner().request("keystore.create", {
        name, family: chain as any, mnemonic, path: defaultPath(chain), passphrase: process.env.PANSA_PASSPHRASE ?? "",
      });
      process.stdout.write(`Dompet ${chain} "${name}" dibuat.\n`);
    } catch (err) {
      process.stderr.write(`Gagal membuat dompet: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    return 0;
  }
  if (sub === "use" && rest2.length >= 1) {
    const name = rest2[0];
    const cfg = loadConfig();
    const defs = (cfg as any).defaultWallets ?? {};
    defs["*"] = name;
    (cfg as any).defaultWallets = defs;
    saveConfig(cfg);
    process.stdout.write(`Dompet default = "${name}".\n`);
    return 0;
  }
  process.stderr.write("Usage: pansa wallet list|create <rantai> <nama>|use <nama>\n");
  return 1;
}

function setDefaultWallet(chain: string, name: string): void {
  const cfg = loadConfig();
  const defs = (cfg as any).defaultWallets ?? {};
  defs[chain] = name;
  (cfg as any).defaultWallets = defs;
  saveConfig(cfg);
}

async function balanceCmd(rest: string[]): Promise<number> {
  const chain = rest[0] ?? "evm";
  const cfg = loadConfig();
  const defs = (cfg as any).defaultWallets ?? {};
  const name = defs[chain];
  if (!name) {
    process.stdout.write(`Belum ada dompet default untuk ${chain}. Buat dengan: pansa ${chain} wallet <nama>\n`);
    return 0;
  }
  try {
    const res = await getSigner().request("wallet.address", { name });
    if (!res.ok) throw new Error(res.error);
    const address = (res.result as { address: string }).address;
    process.stdout.write(`${chain} ${name}: ${address}\n(saldo RPC fase P3)\n`);
  } catch (err) {
    process.stderr.write(`Gagal alamat: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  return 0;
}

async function runPrompt(prompt: string): Promise<number> {
  const cfg = loadConfig();
  await ensureDaemon();
  const live = await fetchLiveModels().catch((): string[] => []);
  const ctx = new ContextManager();
  const agent = new Agent({
    context: ctx,
    tools: new Map(),
    liveModels: live,
    cfg: { preferReasoning: cfg.preferReasoning, preferCheap: cfg.preferCheap, models: cfg.models },
    onChunk: (t) => process.stdout.write(t),
  });
  const out = await agent.run(prompt);
  process.stdout.write(out + "\n");
  return 0;
}

async function repl(): Promise<number> {
  const cfg = loadConfig();
  await ensureDaemon();
  const live = await fetchLiveModels().catch((): string[] => []);
  const ctx = new ContextManager();
  const agent = new Agent({
    context: ctx,
    tools: new Map(),
    liveModels: live,
    cfg: { preferReasoning: cfg.preferReasoning, preferCheap: cfg.preferCheap, models: cfg.models },
    onChunk: (t) => process.stdout.write(t),
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "pansa> " });
  process.stdout.write("PANSA REPL. Ketik 'exit' untuk keluar.\n");
  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (input === "exit" || input === "quit") { rl.close(); return; }
    const cmd = matchCommand(input);
    try {
      switch (cmd.kind) {
        case "help":
          process.stdout.write(HELP);
          break;
        case "wallet_list": {
          const res = await getSigner().request("keystore.list");
          if (!res.ok) throw new Error(res.error);
          const names = (res.result as { names: string[] }).names;
          process.stdout.write(names.join("\n") + (names.length ? "\n" : "(kosong)\n"));
          break;
        }
        case "wallet_create": {
          const mnemonic = generateMnemonic(128);
          const res = await getSigner().request("keystore.create", {
            name: cmd.name ?? "default", family: cmd.chain as any, mnemonic, path: defaultPath(cmd.chain), passphrase: process.env.PANSA_PASSPHRASE ?? "",
          });
          if (!res.ok) throw new Error(res.error);
          setDefaultWallet(cmd.chain, cmd.name ?? "default");
          process.stdout.write(`Dompet ${cmd.chain} "${cmd.name ?? "default"}" dibuat.\n`);
          break;
        }
        case "wallet_set":
        case "wallet_use": {
          const cfg2 = loadConfig();
          const defs = (cfg2 as any).defaultWallets ?? {};
          const ch = cmd.kind === "wallet_set" ? cmd.chain : undefined;
          const nm = cmd.kind === "wallet_set" ? (cmd.name ?? "default") : cmd.name;
          if (ch) defs[ch] = nm;
          else defs["*"] = nm;
          (cfg2 as any).defaultWallets = defs;
          saveConfig(cfg2);
          process.stdout.write(`Default diatur.\n`);
          break;
        }
        case "balance": {
          const bc = cmd.kind === "balance" ? (cmd.chain ?? "evm") : "evm";
          await balanceCmd([bc]);
          break;
        }
        case "unknown": {
          const out = await agent.run(input);
          process.stdout.write(out + "\n");
          break;
        }
      }
    } catch (err) {
      process.stdout.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    rl.prompt();
  });
  rl.on("close", () => process.stdout.write("\nSelamat tinggal.\n"));
  return 0;
}

async function setupCmd(_rest: string[]): Promise<number> {
  process.stdout.write("setup wizard (detail di fase P7)\n");
  return 0;
}
async function gatewayCmd(_rest: string[]): Promise<number> {
  process.stdout.write("gateway (detail di fase P7)\n");
  return 0;
}
async function daemonCmd(): Promise<number> {
  process.stdout.write("daemon (detail di fase P6)\n");
  return 0;
}
async function backupCmd(rest: string[]): Promise<number> {
  const name = rest[0];
  if (!name) {
    process.stderr.write("Usage: pansa backup <nama>\n");
    return 1;
  }
  if (!process.stdout.isTTY) {
    process.stderr.write("backup menolak: stdout bukan TTY\n");
    return 1;
  }
  const passphrase = process.env.PANSA_PASSPHRASE;
  if (!passphrase) {
    process.stderr.write("PANSA_PASSPHRASE diperlukan untuk backup\n");
    return 1;
  }
  try {
    const payload = keystoreUnlock(name, passphrase);
    process.stdout.write(`Mnemonik untuk "${name}": ${payload.mnemonic}\n`);
    process.stdout.write(`Path: ${payload.path}\n`);
  } catch (err) {
    process.stderr.write(`Gagal membuka dompet: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  return 0;
}
async function doctorCmd(): Promise<number> {
  process.stdout.write("doctor: node " + process.version + "\n");
  return 0;
}
async function modelsCmd(): Promise<number> {
  await ensureDaemon();
  const live = await fetchLiveModels();
  process.stdout.write(live.join("\n") + "\n");
  return 0;
}
async function policyCmd(_rest: string[]): Promise<number> {
  process.stdout.write("policy (detail di fase P3)\n");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
