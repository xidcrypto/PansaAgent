import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { matchCommand } from "./commands.js";
import { loadConfig, saveConfig, PANSA_DIR, CONFIG_FILE, POLICY_FILE } from "./config.js";
import { ensureDaemon, fetchLiveModels } from "./llm.js";
import { ContextManager } from "./context.js";
import { loadContextFiles } from "./context.js";
import { Agent } from "./agent.js";
import { generateMnemonic } from "./mnemonic.js";
import { SignerClient, getSignerClient, closeSignerClient } from "./signer/client.js";
import { keystoreUnlock, ensureKeystoreDir, keystorePath, defaultPath } from "./signer/keystore.js";
import { walletRegistryLoad } from "./signer/keystore.js";
import { getPolicy, savePolicy } from "./signer/policy.js";
import { secretsLoad, secretsSave, secretsGet, secretsSet } from "./secrets.js";
import { runDoctor, formatDoctor } from "./doctor.js";
import { resolveEvmRpc, getEvmBalance, formatEth } from "./evm-rpc.js";
import { buildAgentToolsWithMcp } from "./tools.js";
import { humanConfirm, humanReject } from "./human-confirm.js";
import { TUI } from "./ui/index.js";
import { resolveRestore, startRunSession, finishRunSession } from "./session-flow.js";
import type { RestoreRequest, RunSession } from "./session-flow.js";
import { checkUpdate } from "./update.js";
import { scheduleTask, listScheduled, cancelScheduled, runDue } from "./scheduler/index.js";
import { TelegramBot, createPairing, runGatewayLoop, gatewayConfirmAllowed } from "./gateway/telegram.js";
import { McpClient } from "./mcp/client.js";
import { openPage } from "./browser/index.js";

// Pure restore flags (no command, no other flags) open the TUI with a
// session restore: `pansa -c` (last session) or `pansa --resume <id>`.
// Returns "last", a session id, or undefined (not a bare restore launch).
function tuiRestoreFromArgv(argv: string[]): "last" | string | undefined {
  let restore: "last" | string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-c" || a === "--continue") {
      if (restore !== undefined) return undefined;
      restore = "last";
      i++;
    } else if (a === "--resume") {
      const id = argv[i + 1];
      if (!id || restore !== undefined) return undefined;
      restore = id;
      i += 2;
    } else if (a.startsWith("--resume=")) {
      const id = a.slice("--resume=".length);
      if (!id || restore !== undefined) return undefined;
      restore = id;
      i++;
    } else {
      return undefined;
    }
  }
  return restore;
}

const HELP = `PANSA - crypto airdrop agent (CLI + TUI)

Usage:
  pansa                    TUI interaktif
  pansa run "<prompt>"     Jalankan satu prompt
  pansa -p "<prompt>"      Satu prompt, cetak jawaban akhir saja (tanpa streaming)
  pansa -c                 Lanjutkan sesi terakhir (TUI jika TTY, REPL jika bukan)
  pansa --resume <id>      Lanjutkan sesi tertentu
  pansa --plain            Output teks polos (tanpa warna/markdown)
  pansa --no-color         Nonaktifkan warna ANSI
  pansa update             Cek pembaruan (hanya info, tidak auto-install)
  pansa gateway [status|pair|start]
  pansa schedule [add|list|cancel|run-once|watch]
  pansa mcp [list|tools|call]
  pansa browse <url>       Baca halaman web (butuh browser: true + playwright)
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

export { resolveSignerEntry } from "./signer/entry.js";

function getSigner(): SignerClient {
  return getSignerClient();
}

// Close the signer child if one was created. One-shot commands must call
// this before returning, otherwise the child keeps the event loop alive and
// the CLI never exits.
function closeSigner(): void {
  closeSignerClient();
}

export async function main(argv: string[]): Promise<number> {
  if (process.env.PANSA_SIGNER_SERVER === "1") {
    const { runStdio } = await import("./signer/server.js");
    runStdio();
    return 0;
  }

  // TTY auto-start: if no args and stdin is TTY, launch TUI. Pure
  // restore flags (`pansa -c`, `pansa --resume <id>`) also open the TUI
  // with that session restored.
  const tuiRestore = tuiRestoreFromArgv(argv);
  if (process.stdin.isTTY && (argv.length === 0 || tuiRestore !== undefined)) {
    // First run (U3): missing config -> inline setup, then into the UI.
    if (!existsSync(CONFIG_FILE)) {
      await setupCmd([]);
    }
    const tui = new TUI(tuiRestore !== undefined ? { restore: tuiRestore } : {});
    tui.run();
    return new Promise(() => {}); // Keep process alive for TUI event loop
  }

  const parsed = parseArgs({
    args: argv,
    boolean: ["help", "h", "plain", "no-color", "c", "continue"],
    string: ["prompt", "p", "print", "resume"],
    allowNegatives: false,
    strict: false,
  });
  const values = parsed.values as { help?: boolean; h?: boolean; prompt?: string; plain?: boolean; "no-color"?: boolean; c?: boolean; continue?: boolean; p?: string; print?: string; resume?: string };
  const positionals: string[] = parsed.positionals as string[];

  if (values.plain) process.env.PLAIN = "1";
  if (values["no-color"]) process.env.NO_COLOR = "1";

  if (values.help || values.h) {
    process.stdout.write(HELP);
    return 0;
  }

  // Session restore for headless runs (U4).
  const restoreReq: RestoreRequest =
    values.resume !== undefined ? { resumeId: values.resume } : values.c || values.continue ? { continueLast: true } : {};

  const cmd: string | undefined = positionals[0];
  if (cmd === undefined) {
    // Print-only mode: `pansa -p "<prompt>"` prints the final answer
    // without streaming.
    const printPrompt = values.p ?? values.print;
    if (printPrompt) return runPrompt(printPrompt, { stream: false, restore: restoreReq });
    return repl(restoreReq);
  }

  const rest = positionals.slice(1);

  switch (cmd) {
    case "run": {
      const prompt = (values.prompt as string | undefined) ?? rest.join(" ");
      if (!prompt) {
        process.stderr.write("Usage: pansa run \"<prompt>\"\n");
        return 1;
      }
      return runPrompt(prompt, { restore: restoreReq });
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
    case "update":
      return updateCmd();
    case "gateway":
      return gatewayCmd(rest);
    case "schedule":
      return scheduleCmd(rest);
    case "mcp":
      return mcpCmd(rest);
    case "browse":
      return browseCmd(rest);
    default:
      process.stderr.write(`Perintah tidak dikenal: ${cmd}\n${HELP}\n`);
      return 1;
  }
}

// Headless agent run returning the final answer (scheduler, gateway).
// No streaming, no session persistence: the caller owns reporting.
// The MCP-augmented tool set is built once per process: a long-running
// `schedule watch` must not spawn a fresh MCP server per task.
let cachedMcpTools: Promise<Map<string, import("./agent.js").Tool>> | null = null;

async function agentAnswer(prompt: string, tools?: Map<string, import("./agent.js").Tool>): Promise<string> {
  const cfg = loadConfig();
  await ensureDaemon();
  const live = await fetchLiveModels().catch((): string[] => []);
  const ctx = new ContextManager();
  for (const f of loadContextFiles()) ctx.appendFileContext(f);
  if (!tools) {
    if (!cachedMcpTools) cachedMcpTools = buildAgentToolsWithMcp();
    tools = await cachedMcpTools;
  }
  const agent = new Agent({
    context: ctx,
    tools,
    liveModels: live,
    cfg: { preferReasoning: cfg.preferReasoning, preferCheap: cfg.preferCheap, models: cfg.models },
  });
  return agent.run(prompt);
}

async function updateCmd(): Promise<number> {
  const info = await checkUpdate();
  if (info.latest === null) {
    process.stdout.write(`Tidak dapat memeriksa pembaruan (registry tidak terjangkau). Versi terinstal: ${info.current}\n`);
    return 1;
  }
  if (!info.updateAvailable) {
    process.stdout.write(`PANSA sudah terbaru (v${info.current}).\n`);
    return 0;
  }
  process.stdout.write(`Pembaruan tersedia: v${info.current} -> v${info.latest}\nJalankan: npm i -g pansa-agent@latest\n`);
  return 0;
}

async function gatewayCmd(rest: string[]): Promise<number> {
  const sub = rest[0];
  const cfg = loadConfig();
  const gw = cfg.gateways?.telegram;
  if (sub === "status") {
    if (!gw) {
      process.stdout.write("Gateway Telegram: belum dikonfigurasi. Jalankan: pansa setup gateway\n");
      return 0;
    }
    process.stdout.write(
      `Gateway Telegram: ${gw.enabled ? "aktif" : "nonaktif"}\nAllowlist: ${gw.allowlist.length} chat\nKonfirmasi via gateway: mainnet selalu ditolak; testnet ${gw.confirmTestnet ? "diizinkan" : "tidak diizinkan"} (eksekusi tetap manusia di TUI/CLI).\n`,
    );
    return 0;
  }
  if (sub === "pair") {
    const code = createPairing();
    process.stdout.write(`Kode pairing (berlaku 5 menit, sekali pakai): ${code}\nKirim /pair ${code} ke bot dari chat pribadi.\n`);
    return 0;
  }
  if (sub === "start") {
    const pass = process.env.PANSA_PASSPHRASE;
    if (!pass) {
      process.stderr.write("PANSA_PASSPHRASE diperlukan untuk membaca token bot dari secrets store.\n");
      return 1;
    }
    const token = secretsGet(secretsLoad(pass), "telegram_bot_token");
    if (!token) {
      process.stderr.write("Token bot belum disimpan. Jalankan: pansa setup gateway\n");
      return 1;
    }
    // The gateway's signing proposals are the "testnet confirm path":
    // enabled only when explicitly configured. Otherwise the sign tool
    // is removed from the gateway agent entirely (mainnet can never be
    // enabled via the gateway). Execution of any pending confirmation
    // always stays human-only (TUI/CLI CONFIRM).
    const confirmTestnet = loadConfig().gateways?.telegram?.confirmTestnet === true;
    const tools = await buildAgentToolsWithMcp();
    if (!gatewayConfirmAllowed(true, confirmTestnet)) tools.delete("sign");
    const bot = new TelegramBot(token);
    const abort = new AbortController();
    process.on("SIGINT", () => abort.abort());
    process.on("SIGTERM", () => abort.abort());
    process.stdout.write("Gateway Telegram berjalan (Ctrl+C untuk berhenti).\n");
    await runGatewayLoop({
      bot,
      allowlist: () => loadConfig().gateways?.telegram?.allowlist ?? [],
      onPaired: async (userId, chatId) => {
        const c = loadConfig();
        const g = c.gateways?.telegram ?? { enabled: true, adapter: "telegram", allowlist: [], features: [] };
        const entry = `${userId}:${chatId}`;
        if (!g.allowlist.includes(entry)) g.allowlist.push(entry);
        c.gateways = { ...(c.gateways ?? {}), telegram: g };
        saveConfig(c);
      },
      onAgentText: async (_userId, _chatId, text) => {
        try {
          return await agentAnswer(text, tools);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      signal: abort.signal,
    });
    return 0;
  }
  process.stderr.write("Usage: pansa gateway [status|pair|start]\n");
  return 1;
}

async function scheduleCmd(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub === "add") {
    const runAt = rest[1];
    const prompt = rest.slice(2).join(" ");
    if (!runAt || !prompt || Number.isNaN(Date.parse(runAt))) {
      process.stderr.write('Usage: pansa schedule add <ISO-time> "<prompt>"\n');
      return 1;
    }
    const task = scheduleTask(prompt, new Date(runAt).toISOString());
    process.stdout.write(`Tugas dijadwalkan: ${task.id} @ ${task.run_at}\n`);
    return 0;
  }
  if (sub === "list") {
    const tasks = listScheduled();
    if (!tasks.length) {
      process.stdout.write("Tugas terjadwal: (kosong)\n");
      return 0;
    }
    for (const t of tasks) {
      process.stdout.write(`${t.id} | ${t.run_at} | ${t.status} | ${t.prompt.slice(0, 80)}\n`);
    }
    return 0;
  }
  if (sub === "cancel") {
    if (!rest[1]) {
      process.stderr.write("Usage: pansa schedule cancel <id>\n");
      return 1;
    }
    const ok = cancelScheduled(rest[1]);
    process.stdout.write(ok ? `Tugas ${rest[1]} dibatalkan.\n` : `Tugas tidak ditemukan atau sudah berjalan: ${rest[1]}\n`);
    return ok ? 0 : 1;
  }
  if (sub === "run-once") {
    const due = await runDue((prompt) => agentAnswer(prompt));
    if (!due.length) {
      process.stdout.write("Tidak ada tugas jatuh tempo.\n");
      return 0;
    }
    for (const t of due) {
      process.stdout.write(`${t.id}: dijalankan.\n`);
    }
    return 0;
  }
  if (sub === "watch") {
    process.stdout.write("Scheduler watch berjalan (cek tiap 60 detik, Ctrl+C untuk berhenti).\n");
    const abort = new AbortController();
    process.on("SIGINT", () => abort.abort());
    process.on("SIGTERM", () => abort.abort());
    // Abort-aware sleep: Ctrl+C stops promptly instead of waiting out
    // the full 60s interval.
    const sleepAbortable = (ms: number) =>
      new Promise<void>((resolve) => {
        if (abort.signal.aborted) return resolve();
        const timer = setTimeout(() => resolve(), ms);
        abort.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    while (!abort.signal.aborted) {
      const due = await runDue((prompt) => agentAnswer(prompt));
      for (const t of due) {
        process.stdout.write(`${t.id}: dijalankan @ ${new Date().toISOString()}.\n`);
      }
      await sleepAbortable(60000);
    }
    return 0;
  }
  process.stderr.write("Usage: pansa schedule [add <ISO-time> \"<prompt>\"|list|cancel <id>|run-once|watch]\n");
  return 1;
}

async function mcpCmd(rest: string[]): Promise<number> {
  const sub = rest[0];
  const servers = loadConfig().mcpServers ?? {};
  if (sub === "list") {
    const names = Object.keys(servers);
    if (!names.length) {
      process.stdout.write("MCP servers: (tidak ada yang dikonfigurasi; set mcpServers di config)\n");
      return 0;
    }
    for (const n of names) process.stdout.write(`${n}: ${servers[n]}\n`);
    return 0;
  }
  if (sub === "tools") {
    const name = rest[1];
    const command = name ? servers[name] : undefined;
    if (!command) {
      process.stderr.write(`MCP server tidak ditemukan: ${name ?? ""}\n`);
      return 1;
    }
    const client = new McpClient(command);
    try {
      await client.start();
      const tools = await client.listTools();
      if (!tools.length) process.stdout.write("Tidak ada tool.\n");
      for (const t of tools) process.stdout.write(`${t.name}: ${t.description ?? ""}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`MCP gagal: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    } finally {
      client.close();
    }
  }
  if (sub === "call") {
    const name = rest[1];
    const tool = rest[2];
    const argsJson = rest[3] ?? "{}";
    const command = name ? servers[name] : undefined;
    if (!command || !tool) {
      process.stderr.write("Usage: pansa mcp call <server> <tool> <json-args>\n");
      return 1;
    }
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      process.stderr.write("Argumen JSON tidak valid.\n");
      return 1;
    }
    const client = new McpClient(command);
    try {
      await client.start();
      const result = await client.callTool(tool, args);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`MCP gagal: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    } finally {
      client.close();
    }
  }
  process.stderr.write("Usage: pansa mcp [list|tools <server>|call <server> <tool> <json-args>]\n");
  return 1;
}

async function browseCmd(rest: string[]): Promise<number> {
  const url = rest[0];
  if (!url) {
    process.stderr.write("Usage: pansa browse <url>\n");
    return 1;
  }
  try {
    const snap = await openPage(url);
    process.stdout.write(`Judul: ${snap.title}\nURL: ${snap.url}\n${snap.text}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`Browse gagal: ${err instanceof Error ? err.message : String(err)}\n`);
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
    process.stdout.write(`${chain} ${name}: ${record.address}\nSaldo: ${await formatEth(balance)} ETH\n`);
  } catch (err) {
    process.stderr.write(`Gagal ambil saldo: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  return 0;
}

async function runPrompt(prompt: string, opts: { stream?: boolean; restore?: RestoreRequest } = {}): Promise<number> {
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
  const restoreId = await resolveRestore(opts.restore ?? {});
  if (opts.restore?.resumeId && restoreId === null) {
    process.stderr.write(`Session tidak ditemukan: ${opts.restore.resumeId}\n`);
    return 1;
  }
  const session = await startRunSession(ctx, prompt, restoreId);
  let streamed = "";
  const agent = new Agent({
    context: ctx,
    tools: await buildAgentToolsWithMcp(),
    liveModels: live,
    cfg: { preferReasoning: cfg.preferReasoning, preferCheap: cfg.preferCheap, models: cfg.models },
    onChunk: opts.stream === false ? undefined : (t) => { streamed += t; process.stdout.write(t); },
  });
  const out = await agent.run(prompt);
  if (opts.stream === false) process.stdout.write(out + "\n");
  else if (!streamed) process.stdout.write(out + "\n");
  else process.stdout.write("\n");
  await finishRunSession(session, prompt, out, live, {
    preferReasoning: cfg.preferReasoning,
    preferCheap: cfg.preferCheap,
    models: cfg.models,
  });
  return 0;
}

async function repl(restore: RestoreRequest = {}): Promise<number> {
  const cfg = loadConfig();
  try {
    await ensureDaemon();
  } catch (err) {
    process.stdout.write(`Peringatan: LLM daemon tidak tersedia (${err instanceof Error ? err.message : String(err)}); perintah dompet tetap jalan.\n`);
  }
  const live = await fetchLiveModels().catch((): string[] => []);
  const ctx = new ContextManager();
  for (const f of loadContextFiles()) ctx.appendFileContext(f);
  const restoreId = await resolveRestore(restore);
  if (restore.resumeId && restoreId === null) {
    process.stderr.write(`Session tidak ditemukan: ${restore.resumeId}\n`);
    return 1;
  }
  let session: RunSession | null = null;
  let streamed = "";
  const agent = new Agent({
    context: ctx,
    tools: await buildAgentToolsWithMcp(),
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
          if (!session) session = await startRunSession(ctx, input, restoreId);
          const out = await agent.run(input);
          if (!streamed) process.stdout.write(out + "\n");
          else process.stdout.write("\n");
          await finishRunSession(session, input, out, live, {
            preferReasoning: cfg.preferReasoning,
            preferCheap: cfg.preferCheap,
            models: cfg.models,
          });
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
  // Telegram gateway setup (U5): the bot token comes ONLY from the
  // PANSA_TELEGRAM_BOT_TOKEN env var and is stored in the encrypted
  // secrets store (never printed, never in config).
  if (rest[0] === "gateway") {
    const token = process.env.PANSA_TELEGRAM_BOT_TOKEN;
    const pass = process.env.PANSA_PASSPHRASE;
    if (!token || !pass) {
      process.stderr.write("Setup gateway butuh PANSA_TELEGRAM_BOT_TOKEN dan PANSA_PASSPHRASE di environment.\n");
      return 1;
    }
    const store = secretsLoad(pass);
    secretsSet(store, "telegram_bot_token", token);
    secretsSet(store, "telegram_callback_key", randomBytes(32).toString("hex"));
    secretsSave(store, pass);
    const cfg = loadConfig();
    const existing = cfg.gateways?.telegram;
    cfg.gateways = {
      ...(cfg.gateways ?? {}),
      telegram: { enabled: true, adapter: "telegram", allowlist: existing?.allowlist ?? [], features: existing?.features ?? [] },
    };
    saveConfig(cfg);
    process.stdout.write("Gateway Telegram dikonfigurasi. Jalankan `pansa gateway pair`, lalu kirim /pair <kode> ke bot dari chat pribadi.\n");
    return 0;
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
