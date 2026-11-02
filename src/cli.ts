import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { matchCommand } from "./commands.js";
import { loadConfig, saveConfig, PANSA_DIR, CONFIG_FILE, POLICY_FILE } from "./config.js";
import { ensureDaemon, fetchLiveModels } from "./llm.js";
import { ContextManager } from "./context.js";
import { loadContextFiles } from "./context.js";
import { Agent } from "./agent.js";
import { generateMnemonic } from "./mnemonic.js";
import { SignerClient } from "./signer/client.js";
import { keystoreUnlock, ensureKeystoreDir, keystorePath } from "./signer/keystore.js";
import { walletRegistryLoad } from "./signer/keystore.js";
import { getPolicy, savePolicy } from "./signer/policy.js";
import { secretsLoad, secretsSave } from "./secrets.js";
import { runDoctor, formatDoctor } from "./doctor.js";
import { resolveEvmRpc, getEvmBalance, formatEth } from "./evm-rpc.js";
import { buildAgentTools } from "./tools.js";
import { humanConfirm, humanReject } from "./human-confirm.js";
import { TUI } from "./ui/index.js";

const HELP = `PANSA - crypto airdrop agent (CLI + TUI)

Usage:
  pansa                    TUI interaktif
  pansa run "<prompt>"     Jalankan satu prompt
  pansa setup              Buat direktori + config/policy default
  pansa daemon             Status LLM daemon
  pansa backup <nama>      Ekspor backup terenkripsi ke file
  pansa doctor             Pemeriksaan kesehatan
  pansa models             Lihat model live
  pansa policy show        Lihat kebijakan
  pansa policy set <field> <value>  Ubah kebijakan
  pansa wallet list|create <rantai> <nama>|use <nama>|unlock <nama>|lock <nama>
  pansa evm|solana|sui|aptos wallet [nama]
  pansa balance [evm]      Saldo dompet default (EVM via RPC)
  pansa confirm <id>       Konfirmasi manusia + eksekusi transaksi
  pansa reject <id>        Tolak konfirmasi
  pansa secrets list|set <key> <value>|get <key>  Simpan/ambil secret terenkripsi
  pansa --help             Bantuan ini

Contoh:
  pansa run "cek saldo evm"
  pansa evm wallet mywallet
  pansa wallet list
  pansa balance evm
`;

let signerClient: SignerClient | null = null;

// Resolve the signer server entry point. In production this is the bundle
// itself; in dev (tsx src/cli.ts) the raw .ts file cannot be executed by
// node, so it is run through the tsx CLI instead (B14).
export function resolveSignerEntry(): { file: string; args: string[] } {
  const entry = fileURLToPath(import.meta.url);
  if (!entry.endsWith(".ts")) return { file: entry, args: [] };
  const tsxCli = join(dirname(entry), "..", "node_modules", "tsx", "dist", "cli.mjs");
  if (existsSync(tsxCli)) return { file: tsxCli, args: [entry] };
  return { file: "tsx", args: [entry] };
}

function getSigner(): SignerClient {
  if (!signerClient) {
    const { file, args } = resolveSignerEntry();
    signerClient = new SignerClient(file, process.env.PANSA_PASSPHRASE, args);
  }
  return signerClient;
}

// Close the signer child if one was created. One-shot commands must call
// this before returning, otherwise the child keeps the event loop alive and
// the CLI never exits.
function closeSigner(): void {
  if (signerClient) {
    try { signerClient.close(); } catch { /* ignore */ }
    signerClient = null;
  }
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
    boolean: ["help", "h", "plain"],
    string: ["prompt"],
    allowNegatives: false,
    strict: false,
  });
  const values = parsed.values as { help?: boolean; h?: boolean; prompt?: string; plain?: boolean };
  const positionals: string[] = parsed.positionals as string[];

  if (values.plain) process.env.PLAIN = "1";

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
      if (rest[0] === "wallet") {
        const code = await chainWallet(cmd, rest.slice(1));
        closeSigner();
        return code;
      }
      process.stderr.write(`Usage: pansa ${cmd} wallet [name]\n`);
      return 1;
    }
    case "wallet": {
      const code = await walletCmd(rest);
      closeSigner();
      return code;
    }
    case "confirm": {
      if (!rest[0]) {
        process.stderr.write("Usage: pansa confirm <confirmation_id>\n");
        return 1;
      }
      return humanConfirm(rest[0]);
    }
    case "reject": {
      if (!rest[0]) {
        process.stderr.write("Usage: pansa reject <confirmation_id>\n");
        return 1;
      }
      return humanReject(rest[0]);
    }
    case "secrets":
      return secretsCmd(rest);
    case "balance":
      return balanceCmd(rest);
    case "setup":
      return setupCmd(rest);
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
  // main() already stripped the "wallet" word, so rest[0] is the name (B2).
  const name = rest[0] ?? "default";
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
  if (sub === "unlock" && rest2.length >= 1) {
    const name = rest2[0];
    if (!process.env.PANSA_PASSPHRASE) {
      process.stderr.write("PANSA_PASSPHRASE diperlukan untuk unlock\n");
      return 1;
    }
    try {
      const res = await getSigner().request("wallet.unlock", { name, passphrase: process.env.PANSA_PASSPHRASE });
      if (!res.ok) throw new Error(res.error);
      const addr = (res.result as { address: string }).address;
      process.stdout.write(`Dompet "${name}" di-unlock: ${addr}\n`);
      process.stdout.write("Catatan: unlock sesi hanya berlaku di REPL/TUI; command satu-tembak ini memverifikasi passphrase tanpa menyimpan state unlock.\n");
    } catch (err) {
      process.stderr.write(`Gagal unlock: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    return 0;
  }
  if (sub === "lock" && rest2.length >= 1) {
    const name = rest2[0];
    try {
      const res = await getSigner().request("wallet.lock", { name });
      if (!res.ok) throw new Error(res.error);
      process.stdout.write(`Dompet "${name}" di-lock.\n`);
    } catch (err) {
      process.stderr.write(`Gagal lock: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    return 0;
  }
  process.stderr.write("Usage: pansa wallet list|create <rantai> <nama>|use <nama>|unlock <nama>|lock <nama>\n");
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
  // Address lookup uses the public registry: no unlock needed (B3).
  const record = walletRegistryLoad().find((w) => w.name === name && w.family === chain);
  if (!record) {
    process.stderr.write(`Dompet "${name}" tidak ditemukan di registry untuk ${chain}.\n`);
    return 1;
  }
  if (chain !== "evm") {
    process.stderr.write(`Balance lookup belum didukung untuk ${chain} (hanya EVM via RPC).\n`);
    process.stdout.write(`${chain} ${name}: ${record.address}\n`);
    return 1;
  }
  const rpcUrl = resolveEvmRpc();
  if (!rpcUrl) {
    process.stderr.write("Tidak ada endpoint EVM RPC. Set PANSA_EVM_RPC atau evmRpc di ~/.pansa/config.json.\n");
    process.stdout.write(`${chain} ${name}: ${record.address}\n`);
    return 1;
  }
  try {
    const balance = await getEvmBalance(record.address, rpcUrl);
    process.stdout.write(`${chain} ${name}: ${record.address}\nSaldo: ${formatEth(balance)} ETH\n`);
  } catch (err) {
    process.stderr.write(`Gagal ambil saldo: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  return 0;
}

async function runPrompt(prompt: string): Promise<number> {
  const cfg = loadConfig();
  try {
    await ensureDaemon();
  } catch (err) {
    process.stderr.write(`LLM daemon tidak tersedia: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const live = await fetchLiveModels().catch((): string[] => []);
  const ctx = new ContextManager();
  for (const f of loadContextFiles()) ctx.appendFileContext(f);
  let streamed = "";
  const agent = new Agent({
    context: ctx,
    tools: buildAgentTools(),
    liveModels: live,
    cfg: { preferReasoning: cfg.preferReasoning, preferCheap: cfg.preferCheap, models: cfg.models },
    onChunk: (t) => { streamed += t; process.stdout.write(t); },
  });
  const out = await agent.run(prompt);
  // The final message was already streamed chunk-by-chunk in the common
  // case; only print it when nothing was streamed (error paths).
  if (!streamed) process.stdout.write(out + "\n");
  else process.stdout.write("\n");
  return 0;
}

async function repl(): Promise<number> {
  const cfg = loadConfig();
  try {
    await ensureDaemon();
  } catch (err) {
    process.stdout.write(`Peringatan: LLM daemon tidak tersedia (${err instanceof Error ? err.message : String(err)}); perintah dompet tetap jalan.\n`);
  }
  const live = await fetchLiveModels().catch((): string[] => []);
  const ctx = new ContextManager();
  for (const f of loadContextFiles()) ctx.appendFileContext(f);
  let streamed = "";
  const agent = new Agent({
    context: ctx,
    tools: buildAgentTools(),
    liveModels: live,
    cfg: { preferReasoning: cfg.preferReasoning, preferCheap: cfg.preferCheap, models: cfg.models },
    onChunk: (t) => { streamed += t; process.stdout.write(t); },
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "pansa> " });
  process.stdout.write("PANSA REPL. Ketik 'exit' untuk keluar.\n");
  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (input === "exit" || input === "quit") { rl.close(); return; }
    // Human-only confirmation: intercepted before the agent ever sees it.
    const confirmMatch = input.match(/^CONFIRM\s+(\S+)$/i);
    if (confirmMatch) {
      await humanConfirm(confirmMatch[1]);
      rl.prompt();
      return;
    }
    const rejectMatch = input.match(/^REJECT\s+(\S+)$/i);
    if (rejectMatch) {
      humanReject(rejectMatch[1]);
      rl.prompt();
      return;
    }
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
        case "wallet_unlock": {
          if (!process.env.PANSA_PASSPHRASE) throw new Error("PANSA_PASSPHRASE diperlukan untuk unlock");
          const res = await getSigner().request("wallet.unlock", { name: cmd.name, passphrase: process.env.PANSA_PASSPHRASE });
          if (!res.ok) throw new Error(res.error);
          const addr = (res.result as { address: string }).address;
          process.stdout.write(`Dompet "${cmd.name}" di-unlock untuk sesi ini (15 menit): ${addr}\n`);
          break;
        }
        case "wallet_lock": {
          const res = await getSigner().request("wallet.lock", { name: cmd.name });
          if (!res.ok) throw new Error(res.error);
          process.stdout.write(`Dompet "${cmd.name}" di-lock.\n`);
          break;
        }
        case "balance": {
          const bc = cmd.kind === "balance" ? (cmd.chain ?? "evm") : "evm";
          await balanceCmd([bc]);
          break;
        }
        case "unknown": {
          streamed = "";
          const out = await agent.run(input);
          if (!streamed) process.stdout.write(out + "\n");
          else process.stdout.write("\n");
          break;
        }
      }
    } catch (err) {
      process.stdout.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    rl.prompt();
  });
  rl.on("close", () => {
    closeSigner();
    process.stdout.write("\nSelamat tinggal.\n");
  });
  return 0;
}

async function setupCmd(rest: string[]): Promise<number> {
  // The Telegram gateway is not implemented and is no longer promised:
  // `pansa setup gateway` fails honestly instead of printing a stub.
  if (rest[0] === "gateway") {
    process.stderr.write("Gateway (Telegram) tidak tersedia di PANSA dan tidak lagi dijanjikan.\n");
    return 1;
  }
  mkdirSync(PANSA_DIR, { recursive: true, mode: 0o700 });
  ensureKeystoreDir();
  let created = false;
  if (!existsSync(CONFIG_FILE)) {
    saveConfig(loadConfig());
    created = true;
  }
  if (!existsSync(POLICY_FILE)) {
    savePolicy(getPolicy());
    created = true;
  }
  process.stdout.write(`PANSA dir: ${PANSA_DIR}\n`);
  process.stdout.write(`Config: ${CONFIG_FILE}${created ? " (dibuat)" : ""}\n`);
  process.stdout.write(`Policy: ${POLICY_FILE}\n`);
  process.stdout.write("Setup selesai. Jalankan `pansa doctor` untuk pemeriksaan.\n");
  return 0;
}
async function daemonCmd(): Promise<number> {
  try {
    await ensureDaemon();
    const live = await fetchLiveModels();
    process.stdout.write(`LLM daemon jalan: ${live.length} model live\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`LLM daemon tidak jalan: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
async function backupCmd(rest: string[]): Promise<number> {
  const name = rest[0];
  if (!name) {
    process.stderr.write("Usage: pansa backup <nama>\n");
    return 1;
  }
  const passphrase = process.env.PANSA_PASSPHRASE;
  if (!passphrase) {
    process.stderr.write("PANSA_PASSPHRASE diperlukan untuk backup\n");
    return 1;
  }
  try {
    // Validates the passphrase and that the wallet exists. The mnemonic
    // is NEVER printed: the export contains only the encrypted keystore
    // blob, which is useless without the passphrase.
    keystoreUnlock(name, passphrase);
    const content = readFileSync(keystorePath(name), "utf8");
    const record = walletRegistryLoad().find((w) => w.name === name) ?? null;
    const out = {
      version: 1,
      exportedAt: new Date().toISOString(),
      wallet: name,
      keystore: JSON.parse(content),
      registry: record,
    };
    mkdirSync(PANSA_DIR, { recursive: true, mode: 0o700 });
    const file = `${PANSA_DIR}/backup-${name}-${Date.now()}.json`;
    writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
    process.stdout.write(`Backup terenkripsi tersimpan: ${file}\n`);
    process.stdout.write("Catatan: file ini berisi keystore terenkripsi (bukan mnemonik plaintext). Simpan passphrase Anda secara terpisah.\n");
  } catch (err) {
    process.stderr.write(`Gagal backup: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  return 0;
}
async function doctorCmd(): Promise<number> {
  const checks = await runDoctor();
  process.stdout.write(formatDoctor(checks) + "\n");
  return checks.every((c) => c.ok) ? 0 : 1;
}
async function modelsCmd(): Promise<number> {
  try {
    await ensureDaemon();
    const live = await fetchLiveModels();
    process.stdout.write(live.join("\n") + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`Gagal ambil model: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
async function secretsCmd(rest: string[]): Promise<number> {
  const passphrase = process.env.PANSA_PASSPHRASE;
  if (!passphrase) {
    process.stderr.write("PANSA_PASSPHRASE diperlukan untuk secrets\n");
    return 1;
  }
  const sub = rest[0];
  try {
    if (sub === "list") {
      const store = secretsLoad(passphrase);
      const keys = Object.keys(store);
      process.stdout.write(keys.length ? keys.join("\n") + "\n" : "(kosong)\n");
      return 0;
    }
    if (sub === "set" && rest.length >= 3) {
      const store = secretsLoad(passphrase);
      store[rest[1]] = rest.slice(2).join(" ");
      secretsSave(store, passphrase);
      process.stdout.write(`Secret "${rest[1]}" disimpan (terenkripsi).\n`);
      return 0;
    }
    if (sub === "get" && rest[1]) {
      const store = secretsLoad(passphrase);
      const v = store[rest[1]];
      if (v === undefined) {
        process.stderr.write(`Secret tidak ditemukan: ${rest[1]}\n`);
        return 1;
      }
      process.stdout.write(v + "\n");
      return 0;
    }
  } catch (err) {
    process.stderr.write(`Gagal secrets: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stderr.write("Usage: pansa secrets list|set <key> <value>|get <key>\n");
  return 1;
}

async function policyCmd(rest: string[]): Promise<number> {  const sub = rest[0];
  if (sub === "show" || !sub) {
    process.stdout.write(JSON.stringify(getPolicy(), null, 2) + "\n");
    return 0;
  }
  if (sub === "set" && rest.length >= 3) {
    const field = rest[1];
    const raw = rest[2];
    const policy = getPolicy();
    switch (field) {
      case "spendCapPerTx":
      case "spendCapPerDay": {
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0) {
          process.stderr.write(`Nilai tidak valid untuk ${field}: ${raw} (harus angka >= 0)\n`);
          return 1;
        }
        if (field === "spendCapPerTx") policy.spendCapPerTx = v;
        else policy.spendCapPerDay = v;
        break;
      }
      case "requireConfirmation":
      case "testnetOnly": {
        if (raw !== "true" && raw !== "false") {
          process.stderr.write(`Nilai tidak valid untuk ${field}: ${raw} (harus true/false)\n`);
          return 1;
        }
        if (field === "requireConfirmation") policy.requireConfirmation = raw === "true";
        else policy.testnetOnly = raw === "true";
        break;
      }
      case "allowedChains": {
        const chains = raw.split(",").map((c) => c.trim()).filter(Boolean);
        const valid = ["evm", "solana", "sui", "aptos"];
        if (chains.length === 0 || !chains.every((c) => valid.includes(c))) {
          process.stderr.write(`Rantai tidak valid: ${raw} (pilih dari ${valid.join(",")})\n`);
          return 1;
        }
        policy.allowedChains = chains as typeof policy.allowedChains;
        break;
      }
      default:
        process.stderr.write(`Field tidak dikenal: ${field} (spendCapPerTx, spendCapPerDay, requireConfirmation, testnetOnly, allowedChains)\n`);
        return 1;
    }
    savePolicy(policy);
    process.stdout.write(`Policy ${field} = ${raw}\n`);
    return 0;
  }
  process.stderr.write("Usage: pansa policy show|set <field> <value>\n");
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
