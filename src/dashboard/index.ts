// Dashboard: a local status + management page for this PANSA instance.
//
// Security posture, by design:
// - Binds 127.0.0.1 only. Any other host is refused, not honoured — the
//   page must never be reachable from the network on its own. (If an
//   operator reverse-proxies it, e.g. nginx, that proxy is what makes it
//   reachable, and the operator owns that exposure decision.)
// - Login gate: every route except /login and POST /api/login requires
//   a session cookie issued after the dashboard password. Default
//   password is "password" (the operator's explicit choice); override
//   with PANSA_DASHBOARD_PASSWORD. Change it — anyone who finds the URL
//   can guess the default.
// - Provider CRUD only: POST/PUT/DELETE /api/providers manage the custom
//   provider registry (config) and their keys (encrypted secrets store).
//   There is still no endpoint that can move funds, sign, approve, or
//   broadcast — a dashboard that could do that from a browser click
//   would bypass the human-confirmation flow the signer is built around.
// - No secrets in the output: wallet names and addresses only (the same
//   data `pansa wallet list` and `pansa balance` already print to a
//   terminal), task prompts and results as already redacted by the
//   scheduler, and log lines passed through redactLogLine before they
//   are served. Provider keys are never returned, never logged, and
//   never appear in HTML or JSON. Never mnemonics, keys, passphrases,
//   or secret values.
// - ONE deliberate exception: POST /api/wallets/export serves an
//   ENCRYPTED V3 keystore file for one wallet, and only after BOTH the
//   dashboard session and the shared wallet password check out. The
//   plaintext private key never leaves the signer process; the
//   dashboard only forwards the encrypted JSON to the browser download.
//   The wallet password itself is never stored, logged, or returned —
//   only its scrypt hash lives in the gateway DB.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cpus, freemem, loadavg, totalmem, uptime, homedir } from "node:os";
import { statfsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CustomProviderView, ProviderInput, ProviderTestResult, FetchModelsResult, ProviderApi } from "../providers/index.js";
import { getUsageTotals } from "../usage.js";
import type { UsageTotals } from "../usage.js";
import { verifyTelegramInitData, initDataDiag, hasWalletPassword, setWalletPassword, verifyWalletPassword, TelegramBot } from "../gateway/telegram.js";
import { getSignerClient } from "../signer/client.js";
import { secretsLoad, secretsGet } from "../secrets.js";
import { loadConfig } from "../config.js";

export interface ProviderStore {
  list(): CustomProviderView[];
  create(input: ProviderInput): CustomProviderView;
  update(id: string, patch: Partial<ProviderInput>): CustomProviderView;
  remove(id: string): void;
  test(id: string): Promise<ProviderTestResult>;
  fetchModels(baseUrl: string, apiKey?: string, api?: ProviderApi): Promise<FetchModelsResult>;
  setModel(id: string, model: string, enabled: boolean): CustomProviderView;
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

// Dashboard password: only its sha256 hash is ever stored, never the
// password itself. A hash file written by POST /api/password wins over
// opts/env/default on the next start, so a changed password survives
// restarts without editing env. Path resolves lazily (os.homedir reads
// $HOME per call) so tests can isolate it with a temp HOME.
function dashboardPasswordFile(): string {
  return join(homedir(), ".pansa", "dashboard-password");
}

function readStoredPasswordHash(): Buffer | null {
  try {
    const text = readFileSync(dashboardPasswordFile(), "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(text)) return null;
    return Buffer.from(text, "hex");
  } catch {
    return null;
  }
}

function storePasswordHash(hash: Buffer): void {
  const file = dashboardPasswordFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, hash.toString("hex"), { mode: 0o600 });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function readJsonBody(req: IncomingMessage, limit = 65536): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("Body terlalu besar.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text) as unknown;
}

function loginPageHtml(error: boolean): string {
  return `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PANSA Dashboard — Masuk</title>
<style>${CSS}</style>
<style>.tg-loading{display:none}.tg-autologin .tg-loading{display:flex;position:fixed;inset:0;z-index:9999;background:#fff;flex-direction:column;align-items:center;justify-content:center;gap:16px}.tg-autologin .wrap{display:none}.tg-loading .pl-spin{width:48px;height:48px;border:4px solid #000;border-top-color:#FFDC58;border-radius:50%;animation:pansa-spin 1s linear infinite}@keyframes pansa-spin{to{transform:rotate(360deg)}}.tg-loading p{font-weight:700}</style>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script>
(function(){try{var w=window.Telegram&&window.Telegram.WebApp;if(w&&w.initData){document.documentElement.className+=" tg-autologin";}}catch(e){}})();
</script>
</head><body><div class="tg-loading"><div class="pl-spin"></div><p>Membuka dashboard…</p></div><div class="wrap" style="max-width:420px;margin-top:80px">
<h1>PANSA Dashboard</h1>
<div class="card"><form id="login-form">
<div class="label" style="margin-bottom:6px">Password dashboard</div>
<input id="password" type="password" autocomplete="current-password" autofocus style="width:100%;border:3px solid #000;padding:10px 12px;font:inherit;box-sizing:border-box">
${error ? `<p class="note" style="color:#cf222e;font-weight:700">Password salah.</p>` : ""}
<div style="margin-top:14px"><button type="submit" style="background:#FFDC58">Masuk</button></div>
<p class="note" id="login-msg" style="color:#cf222e;font-weight:700"></p>
<p class="note">Password default: <code>password</code> — ganti lewat env PANSA_DASHBOARD_PASSWORD.</p>
</form></div></div>
<script>
(function(){var w=window.Telegram&&window.Telegram.WebApp;if(!w||!w.initData){return;}try{w.ready();w.expand();}catch(e){}function showForm(msg){document.documentElement.className=document.documentElement.className.replace(" tg-autologin","");var m=document.getElementById("login-msg");if(m){m.textContent=msg;}}fetch("api/telegram-webapp-auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({initData:w.initData})}).then(function(r){if(r.ok){var p=location.pathname;location=p.endsWith("/login")?p.slice(0,-6)||"/":"/";}else{showForm("Login otomatis Telegram gagal — silakan masuk dengan password.");}}).catch(function(){showForm("Gagal menghubungi server — cek koneksi lalu coba lagi.");});})();
</script>
<script>
document.getElementById("login-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const msg=document.getElementById("login-msg");
  msg.textContent="";
  const password=document.getElementById("password").value;
  let r;
  try {
    r=await fetch("api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password})});
  } catch (err) {
    msg.textContent="Gagal menghubungi server — cek koneksi lalu coba lagi.";
    return;
  }
  if(r.ok) { const p=location.pathname; location=p.endsWith("/login") ? p.slice(0, -6) || "/" : "/"; } else location=location.pathname + "?error=1";
});
</script></body></html>`;
}

export interface DashboardWallet {
  name: string;
  address: string;
  family: string;
}

export interface DashboardTask {
  id: string;
  prompt: string;
  run_at: string;
  status: string;
  last_run_at?: string | null;
  last_result?: string | null;
}

export interface DashboardAlert {
  id: string;
  token: string;
  op: string;
  price_usd: number;
  note: string;
  status: string;
  created_at: string;
  triggered_at?: string | null;
}

export interface SystemMetrics {
  cpuLoad1: number;
  cpuCount: number;
  memTotal: number;
  memFree: number;
  memUsedPct: number;
  diskTotal: number | null;
  diskFree: number | null;
  diskUsedPct: number | null;
  uptimeSec: number;
  processUptimeSec: number;
  processRss: number;
}

export interface DashboardData {
  wallets: DashboardWallet[];
  models: string[];
  gatewayEnabled: boolean;
  gatewayAllowedUsers: number;
  testnetOnly?: boolean;
  scheduledPending: number;
  scheduledTotal: number;
  alertsActive: number;
  alertsTotal: number;
  tasks: DashboardTask[];
  alerts: DashboardAlert[];
  logs: string[];
}

export interface DaemonModel {
  id: string;
  name?: string;
  source: string;
  reasoning?: boolean;
  tools?: boolean;
  context?: number | null;
}

export interface ProviderSource {
  source: string;
  count: number;
  models: DaemonModel[];
}

export interface ProvidersInfo {
  reachable: boolean;
  base: string;
  sources: ProviderSource[];
}

export interface DashboardHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

function parseDaemonModels(json: unknown): DaemonModel[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null && typeof m.id === "string")
    .map((m) => ({
      id: m.id as string,
      name: typeof m.name === "string" ? m.name : undefined,
      source:
        typeof m.source === "string"
          ? m.source
          : typeof m.owned_by === "string"
            ? m.owned_by
            : "unknown",
      reasoning: m.reasoning === true,
      tools: m.supports_tools === true,
      context:
        typeof m.context_window === "number"
          ? m.context_window
          : typeof m.context_length === "number"
            ? m.context_length
            : null,
    }));
}

/** Fetch the daemon's live model catalog (loopback only). Fail-soft by
 *  design: an unreachable daemon yields [], never a throw — the
 *  dashboard must stay up when the daemon is down. */
export async function fetchDaemonModels(base: string): Promise<DaemonModel[]> {
  const info = await getProvidersInfo(base);
  return info.sources.flatMap((s) => s.models);
}

export function groupModels(models: DaemonModel[]): ProviderSource[] {
  const by = new Map<string, DaemonModel[]>();
  for (const m of models) {
    const list = by.get(m.source) ?? [];
    list.push(m);
    by.set(m.source, list);
  }
  return [...by.entries()]
    .map(([source, list]) => ({ source, count: list.length, models: list }))
    .sort((a, b) => b.count - a.count);
}

export async function getProvidersInfo(base: string): Promise<ProvidersInfo> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/models`, { signal: ctrl.signal });
    if (!res.ok) return { reachable: false, base, sources: [] };
    return { reachable: true, base, sources: groupModels(parseDaemonModels(await res.json())) };
  } catch {
    return { reachable: false, base, sources: [] };
  } finally {
    clearTimeout(timer);
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Mask secret-looking values in a log line before it is served. Wallet
 *  addresses (40-hex) are deliberately NOT masked: they are public
 *  on-chain data and already shown in the wallets table. */
export function redactLogLine(line: string): string {
  let out = line.replace(
    /(api[_-]?key|apikey|token|secret|password|passwd|bearer|mnemonic|private[_-]?key)\s*[:=]\s*\S+/gi,
    "$1: [REDACTED]",
  );
  out = out.replace(/Authorization:.*/gi, "Authorization: [REDACTED]");
  return out.slice(0, 500);
}

export function collectSystemMetrics(): SystemMetrics {
  const memTotal = totalmem();
  const memFree = freemem();
  let diskTotal: number | null = null;
  let diskFree: number | null = null;
  let diskUsedPct: number | null = null;
  try {
    const s = statfsSync("/");
    diskTotal = s.blocks * s.bsize;
    diskFree = s.bavail * s.bsize;
    diskUsedPct = diskTotal > 0 ? ((diskTotal - diskFree) / diskTotal) * 100 : 0;
  } catch {
    // statfs is not available everywhere; disk cards render as "—".
  }
  return {
    cpuLoad1: loadavg()[0] ?? 0,
    cpuCount: cpus().length || 1,
    memTotal,
    memFree,
    memUsedPct: memTotal > 0 ? ((memTotal - memFree) / memTotal) * 100 : 0,
    diskTotal,
    diskFree,
    diskUsedPct,
    uptimeSec: uptime(),
    processUptimeSec: process.uptime(),
    processRss: process.memoryUsage().rss,
  };
}

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

function fmtPct(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(1)}%`;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}h ${h}j`;
  if (h > 0) return `${h}j ${m}m`;
  return `${m}m`;
}

function trunc(s: string | null | undefined, n: number): string {
  if (!s) return "—";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function badge(status: string): string {
  const map: Record<string, [string, string]> = {
    pending: ["warn", "pending"],
    active: ["ok", "aktif"],
    done: ["ok", "selesai"],
    triggered: ["warn", "terpicu"],
    failed: ["bad", "gagal"],
    cancelled: ["muted", "batal"],
  };
  const [cls, label] = map[status] ?? ["muted", status];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function walletRows(wallets: DashboardWallet[]): string {
  if (!wallets.length) return `<tr><td colspan="4">(kosong — belum ada dompet di registry)</td></tr>`;
  return wallets
    .map(
      (w) =>
        `<tr><td>${escapeHtml(w.name)}</td><td>${escapeHtml(w.family)}</td><td class="addr" title="${escapeHtml(w.address)}">${escapeHtml(w.address)}</td><td>${w.family === "evm" ? `<button type="button" data-wallet-export="${escapeHtml(w.name)}">Unduh keystore</button>` : "—"}</td></tr>`,
    )
    .join("\n");
}

function taskRows(tasks: DashboardTask[]): string {
  if (!tasks.length) return `<tr><td colspan="5">(belum ada tugas terjadwal)</td></tr>`;
  return tasks
    .map(
      (t) =>
        `<tr><td class="mono">${escapeHtml(t.id.slice(0, 8))}</td><td title="${escapeHtml(t.prompt)}">${escapeHtml(trunc(t.prompt, 90))}</td><td>${escapeHtml(t.run_at)}</td><td>${badge(t.status)}</td><td title="${escapeHtml(t.last_result ?? "")}">${escapeHtml(trunc(t.last_result, 60))}</td></tr>`,
    )
    .join("\n");
}

function alertRows(alerts: DashboardAlert[]): string {
  if (!alerts.length) return `<tr><td colspan="5">(belum ada price alert)</td></tr>`;
  return alerts
    .map(
      (a) =>
        `<tr><td class="mono">${escapeHtml(a.token)}</td><td>${escapeHtml(a.op)} $${a.price_usd}</td><td title="${escapeHtml(a.note)}">${escapeHtml(trunc(a.note, 60))}</td><td>${badge(a.status)}</td><td>${escapeHtml(a.created_at)}</td></tr>`,
    )
    .join("\n");
}

const CSS = `:root{--bg:#FFF6E9;--card:#fff;--text:#000;--muted:#333;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--yellow:#FFDC58;color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}
.wrap{max-width:1080px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
h1{font-size:clamp(1.4rem,4vw,2rem);margin:0;font-weight:900;background:var(--yellow);border:3px solid #000;box-shadow:4px 4px 0 #000;padding:6px 14px}
h2{font-size:.9rem;letter-spacing:.08em;text-transform:uppercase;margin:32px 0 12px;font-weight:800;border-left:6px solid #000;padding-left:10px}
.live{display:flex;align-items:center;gap:8px;font-size:.9rem;font-weight:700}
.dot{width:12px;height:12px;background:#B9FF66;border:2px solid #000}
.dot.off{background:#FF6B6B}
button{border:3px solid #000;background:#fff;color:#000;border-radius:0;padding:8px 14px;cursor:pointer;font:inherit;font-weight:800;box-shadow:4px 4px 0 #000;transition:transform .08s,box-shadow .08s}
button:active{transform:translate(4px,4px);box-shadow:0 0 0 #000}
button:disabled{opacity:.55;cursor:wait}
section{animation:secin .25s ease}
@keyframes secin{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
#dot:not(.off){animation:pulse 2s infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(0,0,0,.35)}50%{box-shadow:0 0 0 6px rgba(0,0,0,0)}}
#toasts{position:fixed;top:16px;right:16px;z-index:50;display:flex;flex-direction:column;gap:10px;max-width:340px}
.toast{border:3px solid #000;box-shadow:4px 4px 0 #000;padding:12px 14px;font-weight:800;animation:toastin .25s ease;cursor:pointer}
.toast.ok{background:#B9FF66}
.toast.bad{background:#FF6B6B}
.toast.info{background:#FFDC58}
.toast.out{opacity:0;transition:opacity .3s}
@keyframes toastin{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:none}}
#custom-rows tr.flash td{animation:flashfade 2.5s forwards}
@keyframes flashfade{from{background:#FFDC58}to{background:transparent}}
button:active{transform:translate(4px,4px);box-shadow:0 0 0 #000}
input,textarea,select{color:#000;background:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}
.card{background:var(--card);border:3px solid #000;border-radius:0;padding:16px 18px;box-shadow:4px 4px 0 #000}
.label{font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;font-weight:800}
.value{font-size:1.7rem;font-weight:900;margin-top:2px}.sub{font-size:.85rem;color:var(--muted)}
.tablewrap{overflow-x:auto;background:var(--card);border:3px solid #000;box-shadow:4px 4px 0 #000}
table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{padding:9px 12px;text-align:left;border-bottom:2px solid #000;vertical-align:top}
th{background:#000;color:#fff;font-size:.75rem;letter-spacing:.06em;text-transform:uppercase}tr:last-child td{border-bottom:0}
td.addr{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mono{font-family:ui-monospace,monospace;font-size:.85rem}
.badge{display:inline-block;padding:1px 8px;border-radius:0;font-size:.8rem;font-weight:800;border:2px solid #000;box-shadow:2px 2px 0 #000}
.badge.ok{color:var(--ok);background:#d4edda}.badge.warn{color:var(--warn);background:#FFF3CD}.badge.bad{color:var(--bad);background:#F8D7DA}.badge.muted{color:var(--muted);background:#eee}
.mod{display:block;font-size:.85rem;line-height:1.6;overflow-wrap:break-word}.mod.off{opacity:.55}
td.mcol{min-width:170px;max-width:320px}
pre.log{background:#111;color:#e5e5e5;border:3px solid #000;border-radius:0;padding:14px 16px;font-size:.82rem;line-height:1.6;max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word;box-shadow:4px 4px 0 #FFDC58}
.note{color:var(--muted);font-size:.88rem}
@media (max-width:640px){.wrap{padding:16px 12px 32px}.card{padding:14px}td.addr{max-width:140px}table{font-size:.82rem}th,td{padding:7px 8px}}
.layout{display:flex;align-items:stretch}
.sidebar{width:230px;flex-shrink:0;position:sticky;top:0;height:100vh;background:#fff;border-right:3px solid #000;padding:20px 0;overflow-y:auto}
.brand{font-weight:900;font-size:1.3rem;padding:0 18px 14px;border-bottom:3px solid #000}
.brand small{display:block;font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
nav a{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:11px 18px;font-weight:800;text-decoration:none;color:#000;border-bottom:2px solid #000}
nav a.active{background:var(--yellow)}
nav a .count{background:#000;color:#fff;padding:0 7px;font-size:.8rem;font-weight:800}
.dot-nav{width:10px;height:10px;border:2px solid #000;background:#B9FF66;flex-shrink:0}
.dot-nav.off{background:#FF6B6B}
main{flex:1;min-width:0}
.sidebar{transition:transform .2s}
.backdrop{display:none}
@media (min-width:821px){.layout.sidebar-collapsed .sidebar{display:none}}
@media (max-width:820px){.layout{flex-direction:column}.sidebar{position:fixed;top:0;left:0;height:100vh;z-index:10;transform:translateX(-105%);border-right:3px solid #000;box-shadow:8px 0 0 rgba(0,0,0,.2)}.layout.sidebar-open .sidebar{transform:none}.layout.sidebar-open .backdrop{display:block;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9}}
.modal-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:50;align-items:center;justify-content:center}
.modal-backdrop.open{display:flex}
.modal{background:#fff;border:3px solid #000;box-shadow:8px 8px 0 #000;padding:20px;max-width:420px;width:calc(100% - 32px)}
.modal h3{margin-top:0}
.modal input{width:100%;border:3px solid #000;padding:10px 12px;font:inherit;box-sizing:border-box;margin-bottom:10px}
.modal .row{display:flex;gap:10px;justify-content:flex-end;margin-top:6px}
.modal .err{color:#cf222e;font-weight:700;min-height:1.2em}`;

const JS = `(function(){var o=document.getElementById("page-loading");if(o){var done=false;function hide(){if(done){return;}done=true;o.className+=" done";setTimeout(function(){o.style.display="none";},500);}if(document.readyState==="complete"){hide();}else{window.addEventListener("load",hide);}setTimeout(hide,5000);}})();
const esc=s=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const fmtB=n=>n>=(1<<30)?(n/(1<<30)).toFixed(1)+" GB":n>=(1<<20)?(n/(1<<20)).toFixed(0)+" MB":(n/1024).toFixed(0)+" KB";
const fmtP=n=>n===null||n===undefined?"—":n.toFixed(1)+"%";
const fmtU=s=>{const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d>0?d+"h "+h+"j":h>0?h+"j "+m+"m":m+"m";};
const trunc=(s,n)=>!s?"—":s.length>n?s.slice(0,n)+"…":s;
const badge=st=>{const m={pending:["warn","pending"],active:["ok","aktif"],done:["ok","selesai"],triggered:["warn","terpicu"],failed:["bad","gagal"],cancelled:["muted","batal"]};const [c,l]=m[st]||["muted",st];return '<span class="badge '+c+'">'+esc(l)+'</span>';};
const SECTIONS=["status","provider","model","usage","dompet","tugas","alert","log"];
const dashPrefix=location.pathname.endsWith("/") ? location.pathname.slice(0, -1) : location.pathname;
function showSection(id){
  if(!SECTIONS.includes(id)) id="status";
  SECTIONS.forEach(s=>{const el=document.getElementById("sec-"+s);if(el) el.style.display=s===id?"":"none";});
  document.querySelectorAll("nav a[data-sec]").forEach(a=>{a.className=a.getAttribute("data-sec")===id?"active":"";});
}
document.querySelectorAll("nav a[data-sec]").forEach(a=>{
  a.addEventListener("click",e=>{e.preventDefault();const id=a.getAttribute("data-sec");showSection(id);history.replaceState(null,"","#"+id);});
});
window.addEventListener("hashchange",()=>showSection(location.hash.replace("#","")));
showSection(location.hash.replace("#","")||"status");
function providerStatusHtml(p){
  const total=p.sources.reduce((n,s)=>n+s.count,0);
  if(!p.reachable) return 'Daemon LLM: <b>tidak terjangkau</b> ('+esc(p.base)+') — daftar provider/model kosong sampai daemon jalan.';
  return 'Daemon LLM: <b>terjangkau</b> · '+esc(p.base)+' · '+total+' model dari '+p.sources.length+' sumber (keyless, bansos v1).';
}
function providerRows(p){
  if(!p.sources.length) return '<tr><td colspan="3">(tidak ada sumber — daemon tidak terjangkau atau katalog kosong)</td></tr>';
  return p.sources.map(s=>{
    const names=s.models.slice(0,5).map(m=>m.name||m.id).join(", ");
    const more=s.count>5?' …dan '+(s.count-5)+' lagi':"";
    return '<tr><td class="mono">'+esc(s.source)+'</td><td>'+s.count+'</td><td>'+esc(names+more)+'</td></tr>';
  }).join("");
}
function modelRows(p){
  const all=[];p.sources.forEach(s=>s.models.forEach(m=>all.push(m)));
  if(!all.length) return '<tr><td colspan="5">(tidak ada model — daemon tidak terjangkau atau katalog kosong)</td></tr>';
  return all.map(m=>'<tr><td class="mono" title="'+esc(m.name||"")+'">'+esc(m.id)+'</td><td>'+esc(m.source)+'</td><td>'+(m.context?m.context.toLocaleString("id-ID")+" token":"—")+'</td><td>'+(m.reasoning?"ya":"tidak")+'</td><td>'+(m.tools?"ya":"tidak")+'</td></tr>').join("");
}
const layoutEl=document.querySelector(".layout");
const isMobile=()=>window.innerWidth<=820;
try{ if(localStorage.getItem("pansa-sidebar-collapsed")==="1"&&!isMobile()) layoutEl.classList.add("sidebar-collapsed"); }catch(e){}
document.getElementById("sidebar-toggle").addEventListener("click",()=>{
  if(isMobile()){ layoutEl.classList.toggle("sidebar-open"); }
  else{
    const collapsed=layoutEl.classList.toggle("sidebar-collapsed");
    try{ localStorage.setItem("pansa-sidebar-collapsed",collapsed?"1":"0"); }catch(e){}
  }
});
document.getElementById("backdrop").addEventListener("click",()=>layoutEl.classList.remove("sidebar-open"));
document.getElementById("logout").addEventListener("click",()=>{ try{ fetch("api/logout",{method:"POST",keepalive:true}).catch(()=>{}); }catch(e){} location=dashPrefix + "/login"; });
async function api(path,method,body){
  const r=await fetch(path,{method,headers:{"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});
  if(r.status===401){ location=dashPrefix + "/login"; throw new Error("Belum masuk."); }
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||("HTTP "+r.status));
  return j;
}
function toast(msg,kind){
  const box=document.getElementById("toasts"); if(!box) return;
  const t=document.createElement("div"); t.className="toast "+(kind||"info"); t.textContent=msg;
  t.addEventListener("click",()=>t.remove()); box.appendChild(t);
  setTimeout(()=>{ t.classList.add("out"); setTimeout(()=>t.remove(),350); },4500);
}
let customCache=[];
let armedDel="";
let lastTouchedId="";
function modelChips(p){ const off=new Set(p.disabledModels||[]); if(!p.models.length) return "(tidak ada model)"; return p.models.map(m=>'<span class="mod'+(off.has(m)?' off':'')+'">'+(off.has(m)?'✗ ':'✓ ')+esc(m)+'</span>').join(""); }
function customRowsHtml(list){
  if(!list.length) return '<tr><td colspan="6">(belum ada provider custom — tambah lewat form di bawah)</td></tr>';
  return list.map(p=>'<tr><td>'+esc(p.name)+'</td><td class="mono">'+esc(p.baseUrl)+'</td><td class="mcol">'+modelChips(p)+'</td><td>'+(p.enabled?'<span class="badge ok">aktif</span>':'<span class="badge muted">nonaktif</span>')+'</td><td>'+(p.hasKey?"ada":"tidak ada")+'</td><td><button type="button" data-act="test" data-id="'+esc(p.id)+'">Uji</button> <button type="button" data-act="edit" data-id="'+esc(p.id)+'">Edit</button> <button type="button" data-act="toggle" data-id="'+esc(p.id)+'">'+(p.enabled?"Nonaktifkan":"Aktifkan")+'</button> <button type="button" data-act="del" data-id="'+esc(p.id)+'">'+(armedDel===p.id?"Yakin hapus?":"Hapus")+'</button></td></tr>').join("");
}
function renderCustom(list){
  customCache=list;
  document.getElementById("custom-rows").innerHTML=customRowsHtml(list);
  if(lastTouchedId){
    const btns=document.getElementById("custom-rows").querySelectorAll("button[data-id]");
    btns.forEach(b=>{ if(b.getAttribute("data-id")===lastTouchedId){ const tr=b.closest("tr"); if(tr) tr.classList.add("flash"); } });
  }
}
async function refreshCustom(){
  const j=await api("api/providers","GET");
  renderCustom(j.providers||[]);
}
document.getElementById("custom-rows").addEventListener("click",async e=>{
  const btn=e.target.closest("button[data-act]"); if(!btn||btn.disabled) return;
  const id=btn.getAttribute("data-id"); const act=btn.getAttribute("data-act");
  const msg=document.getElementById("provider-msg");
  btn.disabled=true;
  try{
    let doneMsg="";
    if(act==="del"){ if(armedDel!==id){ armedDel=id; renderCustom(customCache); setTimeout(()=>{ if(armedDel===id){ armedDel=""; renderCustom(customCache); } },5000); return; } armedDel=""; await api("api/providers/"+encodeURIComponent(id),"DELETE"); doneMsg="Provider dihapus."; }
    else if(act==="toggle"){ const cur=customCache.find(x=>x.id===id); if(!cur) return; await api("api/providers/"+encodeURIComponent(id),"PUT",{enabled:!cur.enabled}); lastTouchedId=id; doneMsg="Status provider diubah."; }
    else if(act==="model"){ const model=btn.getAttribute("data-model"); const cur=customCache.find(x=>x.id===id); if(!cur||!model) return; const off=(cur.disabledModels||[]).includes(model); await api("api/providers/"+encodeURIComponent(id)+"/model","POST",{model,enabled:off}); lastTouchedId=id; doneMsg=off?("Model diaktifkan: "+model):("Model dinonaktifkan: "+model); }
    else if(act==="test"){ const res=await api("api/providers/"+encodeURIComponent(id)+"/test","POST"); msg.textContent=res.ok?("Uji OK: "+res.count+" model ("+(res.sample||[]).join(", ")+")"):("Uji gagal: "+res.error); toast(msg.textContent,res.ok?"ok":"bad"); return; }
    else if(act==="edit"){ let p=customCache.find(x=>x.id===id); if(!p){ await refreshCustom(); p=customCache.find(x=>x.id===id); } if(!p){ msg.textContent="Error: provider tidak ditemukan, coba muat ulang halaman."; toast(msg.textContent,"bad"); return; } document.getElementById("pf-id").value=p.id; document.getElementById("pf-name").value=p.name; document.getElementById("pf-base").value=p.baseUrl; document.getElementById("pf-api").value=p.api||"openai"; document.getElementById("pf-models").value=p.models.join(", "); renderModelList(p.models,p.disabledModels||[]); document.getElementById("pf-key").value=""; document.getElementById("pf-enabled").checked=!!p.enabled; document.getElementById("provider-form").scrollIntoView(); return; }
    await refreshCustom();
    msg.textContent=doneMsg;
    if(doneMsg) toast(doneMsg,"ok");
  }catch(err){ msg.textContent="Error: "+err.message; toast(msg.textContent,"bad"); }
  finally{ btn.disabled=false; }
});
function renderModelList(models,disabled){
  const box=document.getElementById("pf-models-list"); if(!box) return;
  const off=new Set(disabled||[]);
  if(!models.length){ box.innerHTML=""; return; }
  box.innerHTML='<div style="margin-bottom:6px"><button type="button" id="pf-models-all">Semua</button> <button type="button" id="pf-models-none">Tidak ada</button></div>'+models.map(m=>'<label style="display:block;font-weight:400;margin:3px 0"><input type="checkbox" data-model-item value="'+esc(m)+'"'+(off.has(m)?"":" checked")+"> "+esc(m)+'</label>').join("");
  const allBtn=document.getElementById("pf-models-all"); if(allBtn) allBtn.addEventListener("click",()=>{ box.querySelectorAll("input[data-model-item]").forEach(c=>{ c.checked=true; }); });
  const noneBtn=document.getElementById("pf-models-none"); if(noneBtn) noneBtn.addEventListener("click",()=>{ box.querySelectorAll("input[data-model-item]").forEach(c=>{ c.checked=false; }); });
}
function readModelList(){
  const box=document.getElementById("pf-models-list"); if(!box) return null;
  const items=box.querySelectorAll("input[data-model-item]"); if(!items.length) return null;
  const models=[]; const disabled=[];
  items.forEach(c=>{ models.push(c.value); if(!c.checked) disabled.push(c.value); });
  return {models,disabled};
}
document.getElementById("provider-connect").addEventListener("click",async()=>{
  const btn=document.getElementById("provider-connect"); if(btn.disabled) return;
  const msg=document.getElementById("provider-msg");
  const baseUrl=document.getElementById("pf-base").value; const key=document.getElementById("pf-key").value; const apiType=document.getElementById("pf-api").value;
  if(!baseUrl){ msg.textContent="Error: isi Base URL dulu sebelum Connect."; toast(msg.textContent,"bad"); return; }
  btn.disabled=true; const oldLabel=btn.textContent; btn.textContent="Menghubungkan…";
  msg.textContent="Menghubungkan, mengambil daftar model…";
  try{
    const res=await api("api/providers/fetch-models","POST",{baseUrl,apiKey:key||undefined,api:apiType});
    if(!res.ok){ msg.textContent="Connect gagal: "+(res.error||"tidak diketahui"); toast(msg.textContent,"bad"); return; }
    const models=res.models||[];
    document.getElementById("pf-models").value=models.join(", ");
    renderModelList(models,[]);
    msg.textContent=models.length?("Connect OK: "+models.length+" model ditemukan, centang yang aktif lalu Simpan."):("Connect OK: endpoint tidak mengembalikan model, isi manual di kolom Model.");
    toast(msg.textContent,"ok");
  }catch(err){ msg.textContent="Error: "+err.message; toast(msg.textContent,"bad"); }
  finally{ btn.disabled=false; btn.textContent=oldLabel; }
});
document.getElementById("provider-testconn").addEventListener("click",async()=>{
  const btn=document.getElementById("provider-testconn"); if(btn.disabled) return;
  const msg=document.getElementById("provider-msg");
  const baseUrl=document.getElementById("pf-base").value; const key=document.getElementById("pf-key").value; const apiType=document.getElementById("pf-api").value;
  if(!baseUrl){ msg.textContent="Error: isi Base URL dulu sebelum Test koneksi."; toast(msg.textContent,"bad"); return; }
  btn.disabled=true; const oldLabel=btn.textContent; btn.textContent="Menguji…";
  const started=Date.now();
  try{
    const res=await api("api/providers/fetch-models","POST",{baseUrl,apiKey:key||undefined,api:apiType});
    const ms=Date.now()-started;
    if(!res.ok){ msg.textContent="Test koneksi gagal: "+(res.error||"tidak diketahui")+" ("+ms+" ms)"; toast(msg.textContent,"bad"); return; }
    const models=res.models||[];
    msg.textContent="Test koneksi OK ("+apiType+"): "+models.length+" model, "+ms+" ms"+(models.length?" — contoh: "+models.slice(0,5).join(", "):"");
    toast(msg.textContent,"ok");
  }catch(err){ msg.textContent="Error: "+err.message; toast(msg.textContent,"bad"); }
  finally{ btn.disabled=false; btn.textContent=oldLabel; }
});
let submitting=false;
document.getElementById("provider-form").addEventListener("submit",async e=>{
  e.preventDefault();
  if(submitting) return;
  submitting=true;
  const submitBtn=document.querySelector('#provider-form button[type="submit"]'); if(submitBtn) submitBtn.disabled=true;
  const msg=document.getElementById("provider-msg");
  const id=document.getElementById("pf-id").value;
  const picked=readModelList();
  const payload={name:document.getElementById("pf-name").value,baseUrl:document.getElementById("pf-base").value,api:document.getElementById("pf-api").value,models:picked?picked.models:document.getElementById("pf-models").value.split(","),enabled:document.getElementById("pf-enabled").checked};
  if(picked) payload.disabledModels=picked.disabled;
  const key=document.getElementById("pf-key").value; if(key) payload.apiKey=key;
  try{
    let saved=null;
    if(id) saved=await api("api/providers/"+encodeURIComponent(id),"PUT",payload);
    else saved=await api("api/providers","POST",payload);
    if(saved&&saved.provider) lastTouchedId=saved.provider.id;
    document.getElementById("pf-id").value=""; document.getElementById("pf-name").value=""; document.getElementById("pf-base").value=""; document.getElementById("pf-api").value="openai"; document.getElementById("pf-models").value=""; renderModelList([],[]); document.getElementById("pf-key").value=""; document.getElementById("pf-enabled").checked=true;
    await refreshCustom();
    msg.textContent="Provider tersimpan.";
    toast(msg.textContent,"ok");
  }catch(err){ msg.textContent="Error: "+err.message; toast(msg.textContent,"bad"); }
  finally{ submitting=false; if(submitBtn) submitBtn.disabled=false; }
});
document.getElementById("provider-cancel").addEventListener("click",()=>{
  document.getElementById("pf-id").value=""; document.getElementById("pf-name").value=""; document.getElementById("pf-base").value=""; document.getElementById("pf-api").value="openai"; document.getElementById("pf-models").value=""; renderModelList([],[]); document.getElementById("pf-key").value=""; document.getElementById("pf-enabled").checked=true;
});
function render(d){
  document.getElementById("m-cpu").innerHTML=d.system.cpuLoad1.toFixed(2)+' <span class="sub">/ '+d.system.cpuCount+' core</span>';
  document.getElementById("m-ram").innerHTML=fmtP(d.system.memUsedPct)+' <span class="sub">'+fmtB(d.system.memTotal-d.system.memFree)+' / '+fmtB(d.system.memTotal)+'</span>';
  document.getElementById("m-disk").innerHTML=fmtP(d.system.diskUsedPct)+' <span class="sub">'+(d.system.diskTotal===null?"—":fmtB(d.system.diskTotal-d.system.diskFree)+' / '+fmtB(d.system.diskTotal))+'</span>';
  document.getElementById("m-up").innerHTML=fmtU(d.system.uptimeSec)+' <span class="sub">proses '+fmtU(d.system.processUptimeSec)+' · RSS <span style="white-space:nowrap">'+fmtB(d.system.processRss)+'</span></span>';
  document.getElementById("wallets").innerHTML=d.wallets.length?d.wallets.map(w=>'<tr><td>'+esc(w.name)+'</td><td>'+esc(w.family)+'</td><td class="addr" title="'+esc(w.address)+'">'+esc(w.address)+'</td><td>'+(w.family===\"evm\"?'<button type=\"button\" data-wallet-export=\"'+esc(w.name)+'\">Unduh keystore</button>':\"—\")+'</td></tr>').join(\"\"):'<tr><td colspan=\"4\">(kosong — belum ada dompet di registry)</td></tr>';
  document.getElementById("cfg").innerHTML='Model: '+esc(d.models.join(", ")||"(tidak ada)")+'<br>Gateway Telegram: '+(d.gatewayEnabled?"aktif":"nonaktif")+' · pengguna terdaftar: '+d.gatewayAllowedUsers+'<br>Testnet only: '+(d.testnetOnly===undefined?"tidak diketahui":d.testnetOnly?"ya":"tidak")+'<br>Tugas terjadwal pending: '+d.scheduledPending+' dari '+d.scheduledTotal+' · Price alert aktif: '+d.alertsActive+' dari '+d.alertsTotal;
  document.getElementById("tasks").innerHTML=d.tasks.length?d.tasks.map(t=>'<tr><td class="mono">'+esc(t.id.slice(0,8))+'</td><td title="'+esc(t.prompt)+'">'+esc(trunc(t.prompt,90))+'</td><td>'+esc(t.run_at)+'</td><td>'+badge(t.status)+'</td><td title="'+esc(t.last_result||"")+'">'+esc(trunc(t.last_result,60))+'</td></tr>').join(""):'<tr><td colspan="5">(belum ada tugas terjadwal)</td></tr>';
  document.getElementById("alerts").innerHTML=d.alerts.length?d.alerts.map(a=>'<tr><td class="mono">'+esc(a.token)+'</td><td>'+esc(a.op)+' $'+a.price_usd+'</td><td title="'+esc(a.note)+'">'+esc(trunc(a.note,60))+'</td><td>'+badge(a.status)+'</td><td>'+esc(a.created_at)+'</td></tr>').join(""):'<tr><td colspan="5">(belum ada price alert)</td></tr>';
  document.getElementById("logs").textContent=d.logs.length?d.logs.join("\\n"):"(tidak ada log yang dikonfigurasi — set PANSA_DASHBOARD_LOG ke path file log.)";
  document.getElementById("badge-tugas").textContent=d.scheduledPending>0?d.scheduledPending:"";
  document.getElementById("badge-alert").textContent=d.alertsActive>0?d.alertsActive:"";
  if(d.providers){
    document.getElementById("dot-provider").className=d.providers.reachable?"dot-nav":"dot-nav off";
    document.getElementById("provider-status").innerHTML=providerStatusHtml(d.providers);
    document.getElementById("provider-rows").innerHTML=providerRows(d.providers);
    document.getElementById("model-pinned").innerHTML='Model terkunci (config): '+esc(d.models.join(", ")||"(tidak ada — daemon memilih)");
    document.getElementById("model-rows").innerHTML=modelRows(d.providers);
  }
  if(d.customProviders){
    renderCustom(d.customProviders);
  }
  if(d.usage){
    const fmtN=n=>n.toLocaleString("id-ID");
    const fmtC=c=>c===null?"—":"$"+c.toFixed(4);
    document.getElementById("usage-summary").textContent=d.usage.calls===0?"(belum ada pemakaian tercatat — pemakaian dicatat setiap chat selesai)":'Total: '+fmtN(d.usage.totalTokens)+' token · in '+fmtN(d.usage.inputTokens)+' · out '+fmtN(d.usage.outputTokens)+' · '+d.usage.calls+' panggilan · estimasi biaya '+fmtC(d.usage.costUsd)+' — rincian per model dan per provider ada di halaman Penggunaan.';
    document.getElementById("usage-card-total").textContent=fmtN(d.usage.totalTokens);
    document.getElementById("usage-card-in").textContent=fmtN(d.usage.inputTokens);
    document.getElementById("usage-card-out").textContent=fmtN(d.usage.outputTokens);
    document.getElementById("usage-card-cost").innerHTML=d.usage.costUsd===null?"—"+' <span class="sub">tidak ada model yang harganya diketahui</span>':"$"+d.usage.costUsd.toFixed(4)+' <span class="sub">hanya model yang harganya diketahui</span>';
    document.getElementById("usage-card-calls").textContent=String(d.usage.calls);
    document.getElementById("usage-card-avg").textContent=d.usage.calls?fmtN(Math.round(d.usage.totalTokens/d.usage.calls)):"—";
    const topM=d.usage.byModel[0], topP=d.usage.byProvider[0];
    document.getElementById("usage-card-topmodel").innerHTML=topM?esc(topM.model)+' <span class="sub">'+fmtN(topM.totalTokens)+' token</span>':"—";
    document.getElementById("usage-card-topprovider").innerHTML=topP?esc(topP.provider)+' <span class="sub">'+fmtN(topP.totalTokens)+' token</span>':"—";
    document.getElementById("usage-rows").innerHTML=d.usage.byModel.length?d.usage.byModel.map(r=>'<tr><td class="mono">'+esc(r.model)+'</td><td>'+esc(r.provider)+'</td><td>'+fmtN(r.inputTokens)+'</td><td>'+fmtN(r.outputTokens)+'</td><td>'+fmtN(r.totalTokens)+'</td><td>'+fmtC(r.costUsd)+'</td><td>'+r.calls+'</td></tr>').join(""):'<tr><td colspan="7">(belum ada pemakaian tercatat — pemakaian dicatat setiap chat selesai)</td></tr>';
    document.getElementById("usage-provider-rows").innerHTML=d.usage.byProvider.length?d.usage.byProvider.map(r=>'<tr><td>'+esc(r.provider)+'</td><td>'+fmtN(r.inputTokens)+'</td><td>'+fmtN(r.outputTokens)+'</td><td>'+fmtN(r.totalTokens)+'</td><td>'+fmtC(r.costUsd)+'</td><td>'+r.calls+'</td></tr>').join(""):'<tr><td colspan="6">(belum ada pemakaian tercatat — pemakaian dicatat setiap chat selesai)</td></tr>';
  }
}
async function manualRefresh(){
  try{
    const r=await fetch("api/status",{cache:"no-store"});
    if(!r.ok) throw new Error("HTTP "+r.status);
    const d=await r.json(); render(d);
    document.getElementById("dot").className="dot";
    document.getElementById("updated").textContent="live · "+new Date().toLocaleTimeString("id-ID");
  }catch(e){
    document.getElementById("dot").className="dot off";
    document.getElementById("updated").textContent="koneksi terputus — mencoba lagi…";
  }
}
document.getElementById("refresh").addEventListener("click",manualRefresh);
document.getElementById("password-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const btn=document.querySelector('#password-form button[type="submit"]'); if(btn&&btn.disabled) return;
  const msg=document.getElementById("password-msg");
  const current=document.getElementById("pw-current").value;
  const next=document.getElementById("pw-next").value;
  const confirm=document.getElementById("pw-confirm").value;
  if(next!==confirm){ msg.textContent="Error: password baru tidak sama dengan ulangannya."; toast(msg.textContent,"bad"); return; }
  if(btn) btn.disabled=true;
  try{
    await api("api/password","POST",{current,next});
    document.getElementById("pw-current").value=""; document.getElementById("pw-next").value=""; document.getElementById("pw-confirm").value="";
    msg.textContent="Password berhasil diganti. Sesi lain sudah dicabut.";
    toast(msg.textContent,"ok");
  }catch(err){ msg.textContent="Error: "+err.message; toast(msg.textContent,"bad"); }
  finally{ if(btn) btn.disabled=false; }
});
// Wallet keystore modal: export (enter/create) + change password.
// Passwords live only in these inputs during the flow and are cleared
// on close; they are never stored, logged, or sent anywhere except the
// session-gated export/password endpoints over this same origin.
var walletModal={mode:"export",name:""};
function walletModalShow(mode,name){
  walletModal.mode=mode; walletModal.name=name||"";
  var bd=document.getElementById("wallet-modal-backdrop");
  var title=document.getElementById("wallet-modal-title");
  var note=document.getElementById("wallet-modal-note");
  var submit=document.getElementById("wallet-modal-submit");
  document.getElementById("wallet-modal-enter").style.display="none";
  document.getElementById("wallet-modal-create").style.display="none";
  document.getElementById("wallet-modal-change").style.display="none";
  document.getElementById("wallet-modal-err").textContent="";
  ["wallet-modal-password","wallet-modal-new","wallet-modal-confirm","wallet-modal-old","wallet-modal-new2","wallet-modal-confirm2"].forEach(function(id){var el=document.getElementById(id); if(el) el.value="";});
  if(mode==="change"){
    title.textContent="Ubah password dompet";
    note.textContent="Password lama diverifikasi dulu — tanpa itu password tidak bisa diubah.";
    document.getElementById("wallet-modal-change").style.display="";
    submit.textContent="Simpan";
    bd.classList.add("open");
    document.getElementById("wallet-modal-old").focus();
    return;
  }
  title.textContent="Unduh keystore "+name;
  submit.textContent="Unduh";
  bd.classList.add("open");
  api("api/wallets/password-status","GET").then(function(s){
    if(s.hasPassword){
      note.textContent="Masukkan password dompet untuk mengunduh file keystore terenkripsi (V3).";
      document.getElementById("wallet-modal-enter").style.display="";
      document.getElementById("wallet-modal-password").focus();
    } else {
      note.textContent="Belum ada password dompet. Buat dulu — password ini dipakai semua dompet dan wajib dimasukkan setiap unduhan.";
      document.getElementById("wallet-modal-create").style.display="";
      document.getElementById("wallet-modal-new").focus();
    }
  }).catch(function(err){
    document.getElementById("wallet-modal-err").textContent="Error: "+err.message;
  });
}
function walletModalHide(){
  document.getElementById("wallet-modal-backdrop").classList.remove("open");
  ["wallet-modal-password","wallet-modal-new","wallet-modal-confirm","wallet-modal-old","wallet-modal-new2","wallet-modal-confirm2"].forEach(function(id){var el=document.getElementById(id); if(el) el.value="";});
}
document.getElementById("wallet-modal-cancel").addEventListener("click",walletModalHide);
document.getElementById("wallet-modal-backdrop").addEventListener("click",function(e){ if(e.target===this) walletModalHide(); });
document.getElementById("wallets").addEventListener("click",function(e){
  var btn=e.target.closest?e.target.closest("[data-wallet-export]"):null;
  if(btn) walletModalShow("export",btn.getAttribute("data-wallet-export"));
});
document.getElementById("wallet-password-change").addEventListener("click",function(){ walletModalShow("change",""); });
document.getElementById("wallet-modal-submit").addEventListener("click",async function(){
  var err=document.getElementById("wallet-modal-err");
  var btn=document.getElementById("wallet-modal-submit");
  if(btn.disabled) return;
  err.textContent="";
  try{
    if(walletModal.mode==="change"){
      var oldPw=document.getElementById("wallet-modal-old").value;
      var nw=document.getElementById("wallet-modal-new2").value;
      var cf=document.getElementById("wallet-modal-confirm2").value;
      if(nw!==cf){ err.textContent="Password baru tidak sama dengan ulangannya."; return; }
      btn.disabled=true;
      await api("api/wallets/password","POST",{oldPassword:oldPw,newPassword:nw});
      toast("Password dompet berhasil diubah.","ok");
      walletModalHide();
      return;
    }
    var pw="";
    var st=await api("api/wallets/password-status","GET");
    if(!st.hasPassword){
      var n1=document.getElementById("wallet-modal-new").value;
      var n2=document.getElementById("wallet-modal-confirm").value;
      if(n1!==n2){ err.textContent="Password baru tidak sama dengan ulangannya."; return; }
      btn.disabled=true;
      await api("api/wallets/password","POST",{newPassword:n1});
      pw=n1;
    } else {
      pw=document.getElementById("wallet-modal-password").value;
      btn.disabled=true;
    }
    var r=await fetch("api/wallets/export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:walletModal.name,password:pw})});
    if(r.status===401){ location=dashPrefix+"/login"; return; }
    if(!r.ok){
      var j=await r.json().catch(function(){return {};});
      throw new Error(j.error||("HTTP "+r.status));
    }
    var cd=r.headers.get("Content-Disposition")||"";
    if(!cd){
      // Bot delivery: the file went to the owner's Telegram chat as a
      // document (no browser download involved).
      var dj=await r.json().catch(function(){return {};});
      if(dj.delivered==="telegram"){
        toast("Keystore "+walletModal.name+" terkirim ke Telegram — buka chat bot untuk mengunduh file-nya.","ok");
        walletModalHide();
        return;
      }
      throw new Error("Respons export tidak dikenali.");
    }
    var blob=await r.blob();
    var m=/filename="([^"]+)"/.exec(cd);
    var filename=m?m[1]:("pansa-wallet-"+walletModal.name+"-keystore.json");
    var a=document.createElement("a");
    a.href=URL.createObjectURL(blob);
    a.download=filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); },5000);
    toast("Keystore "+walletModal.name+" terunduh.","ok");
    walletModalHide();
  }catch(e){
    err.textContent="Error: "+e.message;
  } finally {
    btn.disabled=false;
  }
});
let es=null; let lastAuthCheck=0;
function startEvents(){
  if(es) es.close();
  es=new EventSource("api/events");
  es.onmessage=e=>{ try{ const d=JSON.parse(e.data); render(d); document.getElementById("dot").className="dot"; document.getElementById("updated").textContent="live · "+new Date().toLocaleTimeString("id-ID"); }catch(err){} };
  es.onerror=()=>{ document.getElementById("dot").className="dot off"; document.getElementById("updated").textContent="koneksi terputus — mencoba lagi…"; const now=Date.now(); if(now-lastAuthCheck>10000){ lastAuthCheck=now; fetch("api/status",{cache:"no-store"}).then(r=>{ if(r.status===401) location=dashPrefix+"/login"; }).catch(()=>{}); } };
}
startEvents();
document.addEventListener("visibilitychange",()=>{ if(!document.hidden && es && es.readyState===EventSource.CLOSED) startEvents(); });
`;

function providerStatusHtml(providers: ProvidersInfo): string {
  const total = providers.sources.reduce((n, s) => n + s.count, 0);
  if (!providers.reachable) {
    return `Daemon LLM: <b>tidak terjangkau</b> (${escapeHtml(providers.base)}) — daftar provider/model kosong sampai daemon jalan.`;
  }
  return `Daemon LLM: <b>terjangkau</b> · ${escapeHtml(providers.base)} · ${total} model dari ${providers.sources.length} sumber (keyless, bansos v1).`;
}

function providerRows(providers: ProvidersInfo): string {
  if (!providers.sources.length) return `<tr><td colspan="3">(tidak ada sumber — daemon tidak terjangkau atau katalog kosong)</td></tr>`;
  return providers.sources
    .map((s) => {
      const names = s.models.slice(0, 5).map((m) => m.name || m.id).join(", ");
      const more = s.count > 5 ? ` …dan ${s.count - 5} lagi` : "";
      return `<tr><td class="mono">${escapeHtml(s.source)}</td><td>${s.count}</td><td>${escapeHtml(names + more)}</td></tr>`;
    })
    .join("\n");
}

function modelRows(providers: ProvidersInfo): string {
  const all = providers.sources.flatMap((s) => s.models);
  if (!all.length) return `<tr><td colspan="5">(tidak ada model — daemon tidak terjangkau atau katalog kosong)</td></tr>`;
  return all
    .map(
      (m) =>
        `<tr><td class="mono" title="${escapeHtml(m.name ?? "")}">${escapeHtml(m.id)}</td><td>${escapeHtml(m.source)}</td><td>${m.context ? m.context.toLocaleString("id-ID") + " token" : "—"}</td><td>${m.reasoning ? "ya" : "tidak"}</td><td>${m.tools ? "ya" : "tidak"}</td></tr>`,
    )
    .join("\n");
}

function modelChipsHtml(p: CustomProviderView): string {
  const off = new Set(p.disabledModels ?? []);
  if (!p.models.length) return "(tidak ada model)";
  return p.models
    .map(
      (m) =>
        `<span class="mod${off.has(m) ? " off" : ""}">${off.has(m) ? "✗ " : "✓ "}${escapeHtml(m)}</span>`,
    )
    .join("");
}

function fmtNum(n: number): string {
  return n.toLocaleString("id-ID");
}

function fmtCost(cost: number | null): string {
  return cost === null ? "—" : `$${cost.toFixed(4)}`;
}

function usageCardsHtml(usage: UsageTotals | null | undefined): string {
  const topModel = usage?.byModel[0];
  const topProvider = usage?.byProvider[0];
  const card = (label: string, id: string, value: string, sub?: string): string =>
    `<div class="card"><div class="label">${label}</div><div class="value" id="${id}">${value}${sub ? ` <span class="sub">${sub}</span>` : ""}</div></div>`;
  return [
    card("Total token", "usage-card-total", usage ? fmtNum(usage.totalTokens) : "—"),
    card("Token masuk (in)", "usage-card-in", usage ? fmtNum(usage.inputTokens) : "—"),
    card("Token keluar (out)", "usage-card-out", usage ? fmtNum(usage.outputTokens) : "—"),
    card("Estimasi biaya", "usage-card-cost", usage ? fmtCost(usage.costUsd) : "—", usage ? (usage.costUsd === null ? "tidak ada model yang harganya diketahui" : "hanya model yang harganya diketahui") : undefined),
    card("Panggilan", "usage-card-calls", usage ? String(usage.calls) : "—"),
    card("Rata-rata token / panggilan", "usage-card-avg", usage && usage.calls ? fmtNum(Math.round(usage.totalTokens / usage.calls)) : "—"),
    card("Model teratas", "usage-card-topmodel", topModel ? escapeHtml(topModel.model) : "—", topModel ? `${fmtNum(topModel.totalTokens)} token` : undefined),
    card("Provider teratas", "usage-card-topprovider", topProvider ? escapeHtml(topProvider.provider) : "—", topProvider ? `${fmtNum(topProvider.totalTokens)} token` : undefined),
  ].join("\n");
}

function usageSummaryHtml(usage: UsageTotals): string {
  if (usage.calls === 0) return "(belum ada pemakaian tercatat — pemakaian dicatat setiap chat selesai)";
  return `Total: ${fmtNum(usage.totalTokens)} token · in ${fmtNum(usage.inputTokens)} · out ${fmtNum(usage.outputTokens)} · ${usage.calls} panggilan · estimasi biaya ${fmtCost(usage.costUsd)} — rincian per model dan per provider ada di halaman Penggunaan.`;
}

function usageProviderRowsHtml(usage: UsageTotals): string {
  if (!usage.byProvider.length) return `<tr><td colspan="6">(belum ada pemakaian tercatat — pemakaian dicatat setiap chat selesai)</td></tr>`;
  return usage.byProvider
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.provider)}</td><td>${fmtNum(r.inputTokens)}</td><td>${fmtNum(r.outputTokens)}</td><td>${fmtNum(r.totalTokens)}</td><td>${fmtCost(r.costUsd)}</td><td>${r.calls}</td></tr>`,
    )
    .join("\n");
}

function usageRowsHtml(usage: UsageTotals): string {
  if (!usage.byModel.length) return `<tr><td colspan="7">(belum ada pemakaian tercatat — pemakaian dicatat setiap chat selesai)</td></tr>`;
  return usage.byModel
    .map(
      (r) =>
        `<tr><td class="mono">${escapeHtml(r.model)}</td><td>${escapeHtml(r.provider)}</td><td>${fmtNum(r.inputTokens)}</td><td>${fmtNum(r.outputTokens)}</td><td>${fmtNum(r.totalTokens)}</td><td>${fmtCost(r.costUsd)}</td><td>${r.calls}</td></tr>`,
    )
    .join("\n");
}

function customRows(custom: CustomProviderView[]): string {
  if (!custom.length) return `<tr><td colspan="6">(belum ada provider custom — tambah lewat form di bawah)</td></tr>`;
  return custom
    .map(
      (p) =>
        `<tr><td>${escapeHtml(p.name)}</td><td class="mono">${escapeHtml(p.baseUrl)}</td><td class="mcol">${modelChipsHtml(p)}</td><td>${p.enabled ? '<span class="badge ok">aktif</span>' : '<span class="badge muted">nonaktif</span>'}</td><td>${p.hasKey ? "ada" : "tidak ada"}</td><td><button type="button" data-act="test" data-id="${escapeHtml(p.id)}">Uji</button> <button type="button" data-act="edit" data-id="${escapeHtml(p.id)}">Edit</button> <button type="button" data-act="toggle" data-id="${escapeHtml(p.id)}">${p.enabled ? "Nonaktifkan" : "Aktifkan"}</button> <button type="button" data-act="del" data-id="${escapeHtml(p.id)}">Hapus</button></td></tr>`,
    )
    .join("\n");
}

const PROVIDER_KEY_NOTE = `Kunci API provider disimpan terenkripsi di secrets store (bukan di config) dan tidak pernah ditampilkan kembali — form edit yang dikosongkan berarti kunci lama tetap dipakai. Tombol Uji memanggil /v1/models endpoint provider untuk memastikan ia menjawab.`;

export function renderDashboardHtml(data: DashboardData, system: SystemMetrics, providers: ProvidersInfo, customProviders: CustomProviderView[], usage?: UsageTotals): string {
  return `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PANSA Dashboard</title>
<style>${CSS}</style>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script>
(function(){var w=window.Telegram&&window.Telegram.WebApp;if(!w){return;}try{w.ready();w.expand();}catch(e){}})();
</script>
<style>#page-loading{position:fixed;inset:0;z-index:9999;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;transition:opacity .4s}#page-loading.done{opacity:0;pointer-events:none}#page-loading .pl-spin{width:48px;height:48px;border:4px solid #000;border-top-color:#FFDC58;border-radius:50%;animation:pansa-spin 1s linear infinite}@keyframes pansa-spin{to{transform:rotate(360deg)}}#page-loading p{font-weight:700}</style>
</head><body><div id="page-loading"><div class="pl-spin"></div><p>Memuat dashboard…</p></div><noscript><style>#page-loading{display:none}</style></noscript><div class="layout">
<div class="backdrop" id="backdrop"></div>
<aside class="sidebar"><div class="brand">PANSA<small>Dashboard</small></div><nav>
<a href="#status" data-sec="status" class="active">Status</a>
<a href="#provider" data-sec="provider">Provider <span class="dot-nav${providers.reachable ? "" : " off"}" id="dot-provider"></span></a>
<a href="#model" data-sec="model">Model</a>
<a href="#usage" data-sec="usage">Penggunaan</a>
<a href="#dompet" data-sec="dompet">Dompet</a>
<a href="#tugas" data-sec="tugas">Tugas <span class="count" id="badge-tugas">${data.scheduledPending > 0 ? data.scheduledPending : ""}</span></a>
<a href="#alert" data-sec="alert">Alert <span class="count" id="badge-alert">${data.alertsActive > 0 ? data.alertsActive : ""}</span></a>
<a href="#log" data-sec="log">Log</a>
</nav></aside>
<main><div class="wrap">
<header><button id="sidebar-toggle" type="button" aria-label="Buka/tutup sidebar">☰</button><h1>PANSA Dashboard</h1><div class="live"><span id="dot" class="dot"></span><span id="updated">live · refresh tiap 3 detik</span><button id="refresh" type="button">Perbarui sekarang</button><button id="logout" type="button">Keluar</button></div></header>
<p class="note">Halaman ini tidak bisa memindahkan dana, sign, atau approve apa pun — yang bisa diubah hanya registry provider custom.</p>
<section id="sec-status">
<h2>Status</h2>
<div class="grid">
<div class="card"><div class="label">CPU load (1 menit)</div><div class="value" id="m-cpu">${system.cpuLoad1.toFixed(2)} <span class="sub">/ ${system.cpuCount} core</span></div></div>
<div class="card"><div class="label">RAM terpakai</div><div class="value" id="m-ram">${fmtPct(system.memUsedPct)} <span class="sub">${fmtBytes(system.memTotal - system.memFree)} / ${fmtBytes(system.memTotal)}</span></div></div>
<div class="card"><div class="label">Disk terpakai</div><div class="value" id="m-disk">${fmtPct(system.diskUsedPct)} <span class="sub">${system.diskTotal === null ? "—" : `${fmtBytes(system.diskTotal - (system.diskFree ?? 0))} / ${fmtBytes(system.diskTotal)}`}</span></div></div>
<div class="card"><div class="label">Uptime</div><div class="value" id="m-up">${fmtUptime(system.uptimeSec)} <span class="sub">proses ${fmtUptime(system.processUptimeSec)} · RSS ${fmtBytes(system.processRss)}</span></div></div>
</div>
<h2>Konfigurasi</h2>
<div class="card" id="cfg">Model: ${escapeHtml(data.models.join(", ") || "(tidak ada)")}<br>Gateway Telegram: ${data.gatewayEnabled ? "aktif" : "nonaktif"} · pengguna terdaftar: ${data.gatewayAllowedUsers}<br>Testnet only: ${data.testnetOnly === undefined ? "tidak diketahui" : data.testnetOnly ? "ya" : "tidak"}<br>Tugas terjadwal pending: ${data.scheduledPending} dari ${data.scheduledTotal} · Price alert aktif: ${data.alertsActive} dari ${data.alertsTotal}</div>
<h2>Penggunaan LLM</h2>
<div class="card" id="usage-summary">${usage ? usageSummaryHtml(usage) : "(belum ada pemakaian tercatat)"}</div>
<h2>Ganti password</h2>
<div class="card"><form id="password-form">
<div class="label" style="margin-bottom:6px">Password saat ini</div>
<input id="pw-current" type="password" autocomplete="current-password" style="width:100%;border:3px solid #000;padding:10px 12px;font:inherit;box-sizing:border-box;margin-bottom:10px">
<div class="label" style="margin-bottom:6px">Password baru (minimal 8 karakter)</div>
<input id="pw-next" type="password" autocomplete="new-password" style="width:100%;border:3px solid #000;padding:10px 12px;font:inherit;box-sizing:border-box;margin-bottom:10px">
<div class="label" style="margin-bottom:6px">Ulangi password baru</div>
<input id="pw-confirm" type="password" autocomplete="new-password" style="width:100%;border:3px solid #000;padding:10px 12px;font:inherit;box-sizing:border-box;margin-bottom:10px">
<div style="margin-top:6px"><button type="submit">Ganti password</button></div>
<p class="note" id="password-msg"></p>
</form></div>
</section>
<section id="sec-provider">
<h2>Provider</h2>
<div class="card" id="provider-status">${providerStatusHtml(providers)}</div>
<div class="tablewrap"><table><tr><th>Sumber</th><th>Jumlah</th><th>Contoh model</th></tr><tbody id="provider-rows">
${providerRows(providers)}</tbody></table></div>
<h2>Tambah provider</h2>
<div class="card">${escapeHtml(PROVIDER_KEY_NOTE)}</div>
<h2>Provider custom</h2>
<div class="tablewrap"><table><tr><th>Nama</th><th>Base URL</th><th>Model</th><th>Status</th><th>Kunci</th><th>Aksi</th></tr><tbody id="custom-rows">
${customRows(customProviders)}</tbody></table></div>
<div class="card"><form id="provider-form">
<input type="hidden" id="pf-id">
<div class="label" style="margin-bottom:6px">Nama</div>
<input id="pf-name" style="width:100%;border:3px solid #000;padding:10px 12px;font:inherit;box-sizing:border-box;margin-bottom:10px" placeholder="mis. openrouter">
<div class="label" style="margin-bottom:6px">Base URL (OpenAI-compatible)</div>
<input id="pf-base" style="width:100%;border:3px solid #000;padding:10px 12px;font:inherit;box-sizing:border-box;margin-bottom:10px" placeholder="https://openrouter.ai/api/v1">
<div class="label" style="margin-bottom:6px">Jenis API</div>
<select id="pf-api" style="width:100%;border:3px solid #000;padding:10px 12px;font:inherit;box-sizing:border-box;margin-bottom:10px"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select>
<div style="margin-bottom:10px"><button type="button" id="provider-connect">Connect (ambil semua model)</button> <button type="button" id="provider-testconn">Test koneksi</button></div>
<div class="label" style="margin-bottom:6px">Model (pisahkan koma)</div>
<input id="pf-models" style="width:100%;border:3px solid #000;padding:10px 12px;font:inherit;box-sizing:border-box;margin-bottom:10px" placeholder="model-a, model-b">
<div id="pf-models-list" style="margin-bottom:10px"></div>
<div class="label" style="margin-bottom:6px">API key (kosongkan = pakai kunci lama / tanpa kunci)</div>
<input id="pf-key" type="password" autocomplete="off" style="width:100%;border:3px solid #000;padding:10px 12px;font:inherit;box-sizing:border-box;margin-bottom:10px">
<label style="font-weight:700"><input id="pf-enabled" type="checkbox" checked> Aktif</label>
<div style="margin-top:14px"><button type="submit">Simpan provider</button> <button type="button" id="provider-cancel">Batal</button></div>
<p class="note" id="provider-msg"></p>
</form></div>
</section>
<section id="sec-model">
<h2>Model</h2>
<div class="card" id="model-pinned">Model terkunci (config): ${escapeHtml(data.models.join(", ") || "(tidak ada — daemon memilih)")}</div>
<div class="tablewrap"><table><tr><th>ID</th><th>Sumber</th><th>Konteks</th><th>Reasoning</th><th>Tools</th></tr><tbody id="model-rows">
${modelRows(providers)}</tbody></table></div>
</section>
<section id="sec-usage">
<h2>Penggunaan LLM</h2>
<div class="grid" id="usage-cards">${usageCardsHtml(usage)}</div>
<h2>Per model</h2>
<div class="tablewrap"><table><tr><th>Model</th><th>Provider</th><th>In</th><th>Out</th><th>Total</th><th>Estimasi biaya</th><th>Panggilan</th></tr><tbody id="usage-rows">
${usage ? usageRowsHtml(usage) : `<tr><td colspan="7">(tidak ada data)</td></tr>`}</tbody></table></div>
<h2>Per provider</h2>
<div class="tablewrap"><table><tr><th>Provider</th><th>In</th><th>Out</th><th>Total</th><th>Estimasi biaya</th><th>Panggilan</th></tr><tbody id="usage-provider-rows">
${usage ? usageProviderRowsHtml(usage) : `<tr><td colspan="6">(tidak ada data)</td></tr>`}</tbody></table></div>
<p class="note">Estimasi biaya hanya dari model yang harganya diketahui; model lain tidak dihitung, bukan nol. Pemakaian dicatat setiap chat selesai dan diperbarui live lewat stream.</p>
</section>
<section id="sec-dompet">
<h2>Dompet</h2>
<div class="tablewrap"><table><tr><th>Nama</th><th>Rantai</th><th>Alamat</th><th>Aksi</th></tr><tbody id="wallets">
${walletRows(data.wallets)}</tbody></table></div>
<p class="note">File keystore terenkripsi (V3, bisa di-import MetaMask/Rabby) hanya untuk dompet EVM. Password dompet dipakai semua dompet dan wajib dimasukkan setiap unduhan — password tidak pernah disimpan dalam bentuk polos.</p>
<div><button type="button" id="wallet-password-change">Ubah password dompet</button></div>
</section>
<section id="sec-tugas">
<h2>Tugas Terjadwal</h2>
<div class="tablewrap"><table><tr><th>ID</th><th>Perintah</th><th>Jadwal</th><th>Status</th><th>Hasil terakhir</th></tr><tbody id="tasks">
${taskRows(data.tasks)}</tbody></table></div>
</section>
<section id="sec-alert">
<h2>Price Alert</h2>
<div class="tablewrap"><table><tr><th>Token</th><th>Target</th><th>Catatan</th><th>Status</th><th>Dibuat</th></tr><tbody id="alerts">
${alertRows(data.alerts)}</tbody></table></div>
</section>
<section id="sec-log">
<h2>Log</h2>
<pre class="log" id="logs">${data.logs.length ? escapeHtml(data.logs.join("\n")) : "(tidak ada log yang dikonfigurasi — set PANSA_DASHBOARD_LOG ke path file log.)"}</pre>
</section>
<p class="note">Untuk saldo, jalankan <code>pansa portfolio</code>. Log yang tampil sudah disaring dari nilai yang tampak seperti secret.</p>
</div></main></div><div class="modal-backdrop" id="wallet-modal-backdrop"><div class="modal">
<h3 id="wallet-modal-title">Unduh keystore</h3>
<p class="note" id="wallet-modal-note"></p>
<div id="wallet-modal-enter">
<div class="label" style="margin-bottom:6px">Password dompet</div>
<input id="wallet-modal-password" type="password" autocomplete="current-password">
</div>
<div id="wallet-modal-create" style="display:none">
<div class="label" style="margin-bottom:6px">Password dompet baru (min 8 karakter, dipakai semua dompet)</div>
<input id="wallet-modal-new" type="password" autocomplete="new-password">
<div class="label" style="margin-bottom:6px">Ulangi password baru</div>
<input id="wallet-modal-confirm" type="password" autocomplete="new-password">
</div>
<div id="wallet-modal-change" style="display:none">
<div class="label" style="margin-bottom:6px">Password dompet lama</div>
<input id="wallet-modal-old" type="password" autocomplete="current-password">
<div class="label" style="margin-bottom:6px">Password dompet baru (min 8 karakter)</div>
<input id="wallet-modal-new2" type="password" autocomplete="new-password">
<div class="label" style="margin-bottom:6px">Ulangi password baru</div>
<input id="wallet-modal-confirm2" type="password" autocomplete="new-password">
</div>
<p class="err" id="wallet-modal-err"></p>
<div class="row"><button type="button" id="wallet-modal-cancel">Batal</button><button type="button" id="wallet-modal-submit" style="background:#FFDC58">Unduh</button></div>
</div></div><div id="toasts"></div><script>${JS}</script></body></html>`;
}

export async function startDashboard(opts: {
  port: number;
  host?: string;
  daemonBase?: string;
  password?: string;
  providers?: ProviderStore;
  data: () => DashboardData | Promise<DashboardData>;
}): Promise<DashboardHandle> {
  // Loopback-only, unconditionally: a dashboard reachable from the
  // network would expose wallet inventory to anyone who finds the port.
  if (opts.host !== undefined && opts.host !== "127.0.0.1" && opts.host !== "localhost") {
    throw new Error("Dashboard hanya boleh bind ke 127.0.0.1 (loopback).");
  }
  const expectedHashInit =
    readStoredPasswordHash() ?? sha256(opts.password ?? process.env.PANSA_DASHBOARD_PASSWORD ?? "password");
  let expectedHash = expectedHashInit;
  const sessions = new Set<string>();
  const isAuthed = (req: IncomingMessage): boolean => {
    const token = parseCookies(req.headers.cookie).pansa_session;
    return typeof token === "string" && sessions.has(token);
  };
  // Satu payload status untuk /api/status dan stream SSE.
  const buildStatus = async () => {
    const raw = await opts.data();
    const data: DashboardData = { ...raw, logs: raw.logs.map(redactLogLine) };
    const system = collectSystemMetrics();
    const providers = await getProvidersInfo(
      opts.daemonBase ?? process.env.PANSA_LLM_BASE ?? "http://127.0.0.1:17070",
    );
    const customProviders = opts.providers ? opts.providers.list() : [];
    let usage: UsageTotals;
    try {
      usage = getUsageTotals();
    } catch {
      usage = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, byModel: [], byProvider: [] };
    }
    return { ...data, system, providers, customProviders, usage, readOnly: false, host: "127.0.0.1" };
  };
  // SSE, bukan polling: client membuka SATU stream; server yang mendorong
  // snapshot. Satu timer server melayani semua tab (bukan satu timer per
  // tab), dan setiap mutasi provider mendorong snapshot baru seketika.
  // Heartbeat 5 detik menjaga stream tetap hidup lewat proxy (nginx
  // /pansa/ menutup koneksi yang diam 10 detik) dan header
  // X-Accel-Buffering menonaktifkan buffering proxy untuk respons ini.
  const sseClients = new Set<ServerResponse>();
  let sseTimer: ReturnType<typeof setInterval> | null = null;
  let sseHeartbeat: ReturnType<typeof setInterval> | null = null;
  let sseBusy = false;
  let sseDirty = false;
  const ssePush = (payload: string) => {
    for (const client of [...sseClients]) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  };
  const sseBroadcast = async () => {
    if (sseBusy) {
      sseDirty = true;
      return;
    }
    sseBusy = true;
    try {
      ssePush(JSON.stringify(await buildStatus()));
    } catch {
      // Stream tetap hidup lewat heartbeat; tick berikutnya mencoba lagi.
    }
    sseBusy = false;
    if (sseDirty) {
      sseDirty = false;
      void sseBroadcast();
    }
  };
  const sseEnsureTimers = () => {
    if (sseTimer) return;
    sseTimer = setInterval(() => {
      void sseBroadcast();
    }, 3000);
    sseHeartbeat = setInterval(() => {
      for (const client of [...sseClients]) {
        try {
          client.write(": ping\n\n");
        } catch {
          sseClients.delete(client);
        }
      }
    }, 5000);
  };
  const sseStopTimersIfIdle = () => {
    if (sseClients.size === 0) {
      if (sseTimer) clearInterval(sseTimer);
      sseTimer = null;
      if (sseHeartbeat) clearInterval(sseHeartbeat);
      sseHeartbeat = null;
    }
  };
  const sseNotifyMutation = () => {
    void sseBroadcast();
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // Public: login page + login/logout actions.
      if (url.pathname === "/login" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(loginPageHtml(url.searchParams.get("error") === "1"));
        return;
      }
      if (url.pathname === "/api/login" && req.method === "POST") {
        const body = (await readJsonBody(req)) as { password?: unknown };
        const provided = typeof body.password === "string" ? body.password : "";
        if (timingSafeEqual(sha256(provided), expectedHash)) {
          const token = randomBytes(32).toString("hex");
          sessions.add(token);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": `pansa_session=${token}; HttpOnly; Path=/; SameSite=Lax`,
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Password salah." }));
        }
        return;
      }
      if (url.pathname === "/api/logout" && req.method === "POST") {
        const token = parseCookies(req.headers.cookie).pansa_session;
        if (token) sessions.delete(token);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "pansa_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0",
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // Telegram Web App auth (public, like /api/login): the dashboard
      // page opened from the bot's menu button posts Telegram's
      // initData; when the HMAC checks out AND the initData user is in
      // allowedUsers, the same session cookie is issued — no password
      // typing inside Telegram. Fail-closed: without a stored bot token
      // the endpoint is unavailable (503), and a bad initData is 401.
      if (url.pathname === "/api/telegram-webapp-auth" && req.method === "POST") {
        const body = (await readJsonBody(req)) as { initData?: unknown };
        const initData = typeof body.initData === "string" ? body.initData : "";
        const pass = process.env.PANSA_PASSPHRASE;
        const botToken = pass ? secretsGet(secretsLoad(pass), "telegram_bot_token") : undefined;
        const users = loadConfig().gateways?.telegram?.allowedUsers ?? [];
        const result = botToken ? verifyTelegramInitData(initData, botToken, users) : { ok: false as const, reason: "no_token" };
        if (!result.ok) {
          // Log only the reason code + initData SHAPE (field names and
          // value lengths), never initData itself.
          console.error(`Web App auth gagal: ${result.reason ?? "unknown"} | ${initDataDiag(initData) ?? "no-diag"}`);
          res.writeHead(botToken ? 401 : 503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: botToken ? "Web App auth gagal." : "Web App auth tidak tersedia." }));
        } else {
          console.error(`Web App auth OK via variant ${result.variant ?? "unknown"}`);
          const session = randomBytes(32).toString("hex");
          sessions.add(session);
          // Persistent for Web App opens: the owner reopens the mini app
          // often, and a session cookie would die with the WebView,
          // forcing a login-page round-trip every time. 30 days.
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": `pansa_session=${session}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`,
          });
          res.end(JSON.stringify({ ok: true }));
        }
        return;
      }
      // Everything else requires a session.
      if (!isAuthed(req)) {
        if (url.pathname.startsWith("/api/")) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Belum masuk." }));
        } else {
          // Redirect relatif (bukan "/login" absolut) supaya tetap benar
          // saat dashboard di-mount di balik prefix seperti /pansa/.
          res.writeHead(302, { Location: "login" });
          res.end();
        }
        return;
      }
      // Ganti password dashboard (session-gated). Sesi lain dicabut,
      // sesi pemohon dipertahankan supaya tidak langsung terlempar.
      if (url.pathname === "/api/password" && req.method === "POST") {
        const body = (await readJsonBody(req)) as { current?: unknown; next?: unknown };
        const current = typeof body.current === "string" ? body.current : "";
        const next = typeof body.next === "string" ? body.next : "";
        const fail = (error: string) => {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error }));
        };
        if (!timingSafeEqual(sha256(current), expectedHash)) {
          fail("Password saat ini salah.");
          return;
        }
        if (next.length < 8) {
          fail("Password baru minimal 8 karakter.");
          return;
        }
        if (timingSafeEqual(sha256(next), expectedHash)) {
          fail("Password baru harus berbeda dari yang lama.");
          return;
        }
        const hash = sha256(next);
        storePasswordHash(hash);
        expectedHash = hash;
        const mine = parseCookies(req.headers.cookie).pansa_session;
        for (const token of [...sessions]) if (token !== mine) sessions.delete(token);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // Wallet keystore export (session-gated + wallet-password-gated).
      // The wallet password is verified against its scrypt hash only;
      // the password value itself is never stored, logged, or returned.
      // The plaintext private key never leaves the signer process: the
      // signer builds the encrypted V3 keystore and this route only
      // forwards that JSON as a browser download.
      if (url.pathname === "/api/wallets/password-status" && req.method === "GET") {
        try {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, hasPassword: hasWalletPassword() }));
        } catch {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Tidak bisa memeriksa password dompet." }));
        }
        return;
      }
      if (url.pathname === "/api/wallets/password" && req.method === "POST") {
        const body = (await readJsonBody(req)) as { oldPassword?: unknown; newPassword?: unknown };
        const fail = (error: string) => {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error }));
        };
        try {
          const next = typeof body.newPassword === "string" ? body.newPassword : "";
          if (next.length < 8) {
            fail("Password dompet minimal 8 karakter.");
            return;
          }
          if (hasWalletPassword()) {
            const old = typeof body.oldPassword === "string" ? body.oldPassword : "";
            if (!verifyWalletPassword(old)) {
              fail("Password dompet lama salah.");
              return;
            }
          }
          setWalletPassword(next);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          fail("Gagal menyimpan password dompet.");
        }
        return;
      }
      if (url.pathname === "/api/wallets/export" && req.method === "POST") {
        const body = (await readJsonBody(req)) as { name?: unknown; password?: unknown };
        const fail = (status: number, error: string) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error }));
        };
        try {
          const name = typeof body.name === "string" ? body.name : "";
          const password = typeof body.password === "string" ? body.password : "";
          if (!name) {
            fail(400, "Nama dompet wajib diisi.");
            return;
          }
          if (!hasWalletPassword()) {
            fail(400, "Belum ada password dompet.");
            return;
          }
          if (!verifyWalletPassword(password)) {
            fail(403, "Password dompet salah.");
            return;
          }
          const res2 = await getSignerClient().request("wallet.export", {
            name,
            passphrase: process.env.PANSA_PASSPHRASE ?? "",
            exportPassword: password,
          });
          if (!res2.ok) {
            fail(400, res2.error ?? "Export gagal.");
            return;
          }
          const r = res2.result as { name: string; family: string; address: string; filename: string; json: string };
          // Delivery: the bot sends the file as a Telegram document to
          // the owner — on mobile Telegram that reliably arrives as a
          // file, while a WebView blob download renders as text (seen
          // on iOS). Only the ENCRYPTED file travels through chat; the
          // wallet password never does. If bot delivery is unavailable
          // (no token, no allowed user, send error), fall back to the
          // browser download so the user still gets the file.
          const pass = process.env.PANSA_PASSPHRASE;
          const botToken = pass ? secretsGet(secretsLoad(pass), "telegram_bot_token") : undefined;
          const ownerId = loadConfig().gateways?.telegram?.allowedUsers?.[0];
          if (botToken && typeof ownerId === "number") {
            try {
              await new TelegramBot(botToken).sendDocument(
                ownerId,
                r.filename,
                Buffer.from(r.json, "utf8"),
                `Keystore ${r.name} (${r.address}) — import ke MetaMask/Rabby dengan password dompet.`,
              );
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, delivered: "telegram", filename: r.filename }));
              return;
            } catch {
              // Fall through to the browser download below.
            }
          }
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="${r.filename}"`,
          });
          res.end(r.json);
        } catch (err) {
          fail(400, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      // Provider CRUD (session-gated; keys never leave the server).
      if (url.pathname === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        sseClients.add(res);
        sseEnsureTimers();
        void sseBroadcast();
        req.on("close", () => {
          sseClients.delete(res);
          sseStopTimersIfIdle();
        });
        return;
      }
      if (url.pathname === "/api/providers" || url.pathname.startsWith("/api/providers/")) {
        if (!opts.providers) {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Provider store tidak dikonfigurasi." }));
          return;
        }
        const rest = url.pathname.slice("/api/providers".length);
        try {
          if (rest === "" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ providers: opts.providers.list() }));
            return;
          }
          if (rest === "" && req.method === "POST") {
            const input = (await readJsonBody(req)) as ProviderInput;
            const created = opts.providers.create(input);
            sseNotifyMutation();
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ provider: created }));
            return;
          }
          if (rest === "/fetch-models" && req.method === "POST") {
            const body = (await readJsonBody(req)) as { baseUrl?: string; apiKey?: string; api?: ProviderApi };
            if (!body.baseUrl) throw new Error("baseUrl wajib diisi.");
            const result = await opts.providers.fetchModels(body.baseUrl, body.apiKey, body.api);
            res.writeHead(result.ok ? 200 : 502, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
            return;
          }
          const m = rest.match(/^\/([^/]+)(\/test|\/model)?$/);
          if (m) {
            const id = decodeURIComponent(m[1]!);
            if (m[2] === "/test" && req.method === "POST") {
              const result = await opts.providers.test(id);
              res.writeHead(result.ok ? 200 : 502, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
              return;
            }
            if (m[2] === "/model" && req.method === "POST") {
              const body = (await readJsonBody(req)) as { model?: string; enabled?: boolean };
              if (!body.model || typeof body.enabled !== "boolean") throw new Error("Butuh model dan enabled.");
              const updated = opts.providers.setModel(id, body.model, body.enabled);
              sseNotifyMutation();
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ provider: updated }));
              return;
            }
            if (req.method === "PUT") {
              const patch = (await readJsonBody(req)) as Partial<ProviderInput>;
              const updated = opts.providers.update(id, patch);
              sseNotifyMutation();
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ provider: updated }));
              return;
            }
            if (req.method === "DELETE") {
              opts.providers.remove(id);
              sseNotifyMutation();
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true }));
              return;
            }
          }
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Tidak ditemukan.\n");
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("Method tidak diizinkan.\n");
        return;
      }
      if (url.pathname === "/" || url.pathname === "/api/status") {
        const status = await buildStatus();
        if (url.pathname === "/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderDashboardHtml(status, status.system, status.providers, status.customProviders, status.usage));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(status));
        }
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Tidak ditemukan.\n");
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (sseTimer) clearInterval(sseTimer);
        sseTimer = null;
        if (sseHeartbeat) clearInterval(sseHeartbeat);
        sseHeartbeat = null;
        // Drop keep-alive connections first: otherwise close() waits
        // forever for a client (e.g. fetch's agent) that holds one open,
        // which also hangs Ctrl+C shutdown, not just tests.
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
