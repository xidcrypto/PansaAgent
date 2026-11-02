// Dashboard: a read-only local status page for this PANSA instance.
//
// Security posture, by design:
// - Binds 127.0.0.1 only. Any other host is refused, not honoured — the
//   page must never be reachable from the network on its own. (If an
//   operator reverse-proxies it, e.g. nginx, that proxy is what makes it
//   reachable, and the operator owns that exposure decision.)
// - Read-only: GET / and GET /api/status exist, nothing else. Any other
//   method gets 405, any other path 404. There is no endpoint that can
//   mutate state, sign, approve, or broadcast, and none is planned: a
//   dashboard that could move funds from a browser click would bypass
//   the human-confirmation flow the signer is built around.
// - No secrets in the output: wallet names and addresses only (the same
//   data `pansa wallet list` and `pansa balance` already print to a
//   terminal), task prompts and results as already redacted by the
//   scheduler, and log lines passed through redactLogLine before they
//   are served. Never mnemonics, keys, passphrases, or secret values.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";
import { statfsSync } from "node:fs";

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

export interface DashboardHandle {
  url: string;
  port: number;
  close(): Promise<void>;
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
  if (!wallets.length) return `<tr><td colspan="3">(kosong — belum ada dompet di registry)</td></tr>`;
  return wallets
    .map(
      (w) =>
        `<tr><td>${escapeHtml(w.name)}</td><td>${escapeHtml(w.family)}</td><td class="addr" title="${escapeHtml(w.address)}">${escapeHtml(w.address)}</td></tr>`,
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

const CSS = `:root{--bg:#FFF6E9;--card:#fff;--text:#000;--muted:#333;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--yellow:#FFDC58}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}
.wrap{max-width:1080px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
h1{font-size:clamp(1.4rem,4vw,2rem);margin:0;font-weight:900;background:var(--yellow);border:3px solid #000;box-shadow:4px 4px 0 #000;padding:6px 14px}
h2{font-size:.9rem;letter-spacing:.08em;text-transform:uppercase;margin:32px 0 12px;font-weight:800;border-left:6px solid #000;padding-left:10px}
.live{display:flex;align-items:center;gap:8px;font-size:.9rem;font-weight:700}
.dot{width:12px;height:12px;background:#B9FF66;border:2px solid #000}
.dot.off{background:#FF6B6B}
button{border:3px solid #000;background:#fff;border-radius:0;padding:8px 14px;cursor:pointer;font:inherit;font-weight:800;box-shadow:4px 4px 0 #000}
button:active{transform:translate(4px,4px);box-shadow:0 0 0 #000}
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
pre.log{background:#111;color:#e5e5e5;border:3px solid #000;border-radius:0;padding:14px 16px;font-size:.82rem;line-height:1.6;max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word;box-shadow:4px 4px 0 #FFDC58}
.note{color:var(--muted);font-size:.88rem}
@media (max-width:640px){.wrap{padding:16px 12px 32px}.card{padding:14px}td.addr{max-width:140px}}`;

const JS = `const esc=s=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const fmtB=n=>n>=(1<<30)?(n/(1<<30)).toFixed(1)+" GB":n>=(1<<20)?(n/(1<<20)).toFixed(0)+" MB":(n/1024).toFixed(0)+" KB";
const fmtP=n=>n===null||n===undefined?"—":n.toFixed(1)+"%";
const fmtU=s=>{const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d>0?d+"h "+h+"j":h>0?h+"j "+m+"m":m+"m";};
const trunc=(s,n)=>!s?"—":s.length>n?s.slice(0,n)+"…":s;
const badge=st=>{const m={pending:["warn","pending"],active:["ok","aktif"],done:["ok","selesai"],triggered:["warn","terpicu"],failed:["bad","gagal"],cancelled:["muted","batal"]};const [c,l]=m[st]||["muted",st];return '<span class="badge '+c+'">'+esc(l)+'</span>';};
function render(d){
  document.getElementById("m-cpu").innerHTML=d.system.cpuLoad1.toFixed(2)+' <span class="sub">/ '+d.system.cpuCount+' core</span>';
  document.getElementById("m-ram").innerHTML=fmtP(d.system.memUsedPct)+' <span class="sub">'+fmtB(d.system.memTotal-d.system.memFree)+' / '+fmtB(d.system.memTotal)+'</span>';
  document.getElementById("m-disk").innerHTML=fmtP(d.system.diskUsedPct)+' <span class="sub">'+(d.system.diskTotal===null?"—":fmtB(d.system.diskTotal-d.system.diskFree)+' / '+fmtB(d.system.diskTotal))+'</span>';
  document.getElementById("m-up").innerHTML=fmtU(d.system.uptimeSec)+' <span class="sub">proses '+fmtU(d.system.processUptimeSec)+' · RSS '+fmtB(d.system.processRss)+'</span>';
  document.getElementById("wallets").innerHTML=d.wallets.length?d.wallets.map(w=>'<tr><td>'+esc(w.name)+'</td><td>'+esc(w.family)+'</td><td class="addr" title="'+esc(w.address)+'">'+esc(w.address)+'</td></tr>').join(""):'<tr><td colspan="3">(kosong — belum ada dompet di registry)</td></tr>';
  document.getElementById("cfg").innerHTML='Model: '+esc(d.models.join(", ")||"(tidak ada)")+'<br>Gateway Telegram: '+(d.gatewayEnabled?"aktif":"nonaktif")+' · pengguna terdaftar: '+d.gatewayAllowedUsers+'<br>Testnet only: '+(d.testnetOnly===undefined?"tidak diketahui":d.testnetOnly?"ya":"tidak")+'<br>Tugas terjadwal pending: '+d.scheduledPending+' dari '+d.scheduledTotal+' · Price alert aktif: '+d.alertsActive+' dari '+d.alertsTotal;
  document.getElementById("tasks").innerHTML=d.tasks.length?d.tasks.map(t=>'<tr><td class="mono">'+esc(t.id.slice(0,8))+'</td><td title="'+esc(t.prompt)+'">'+esc(trunc(t.prompt,90))+'</td><td>'+esc(t.run_at)+'</td><td>'+badge(t.status)+'</td><td title="'+esc(t.last_result||"")+'">'+esc(trunc(t.last_result,60))+'</td></tr>').join(""):'<tr><td colspan="5">(belum ada tugas terjadwal)</td></tr>';
  document.getElementById("alerts").innerHTML=d.alerts.length?d.alerts.map(a=>'<tr><td class="mono">'+esc(a.token)+'</td><td>'+esc(a.op)+' $'+a.price_usd+'</td><td title="'+esc(a.note)+'">'+esc(trunc(a.note,60))+'</td><td>'+badge(a.status)+'</td><td>'+esc(a.created_at)+'</td></tr>').join(""):'<tr><td colspan="5">(belum ada price alert)</td></tr>';
  document.getElementById("logs").textContent=d.logs.length?d.logs.join("\\n"):"(tidak ada log yang dikonfigurasi — set PANSA_DASHBOARD_LOG ke path file log.)";
}
async function tick(){
  try{
    const r=await fetch("api/status",{cache:"no-store"});
    if(!r.ok) throw new Error("HTTP "+r.status);
    const d=await r.json(); render(d);
    document.getElementById("dot").className="dot";
    document.getElementById("updated").textContent="diperbarui "+new Date().toLocaleTimeString("id-ID");
  }catch(e){
    document.getElementById("dot").className="dot off";
    document.getElementById("updated").textContent="koneksi terputus — mencoba lagi…";
  }
}
document.getElementById("refresh").addEventListener("click",tick);
setInterval(tick,3000);`;

export function renderDashboardHtml(data: DashboardData, system: SystemMetrics): string {
  return `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PANSA Dashboard</title>
<style>${CSS}</style>
</head><body><div class="wrap">
<header><h1>PANSA Dashboard</h1><div class="live"><span id="dot" class="dot"></span><span id="updated">live · refresh tiap 3 detik</span><button id="refresh" type="button">Perbarui sekarang</button></div></header>
<p class="note">Read-only · halaman ini tidak bisa memindahkan dana, sign, atau approve apa pun.</p>
<h2>Sistem</h2>
<div class="grid">
<div class="card"><div class="label">CPU load (1 menit)</div><div class="value" id="m-cpu">${system.cpuLoad1.toFixed(2)} <span class="sub">/ ${system.cpuCount} core</span></div></div>
<div class="card"><div class="label">RAM terpakai</div><div class="value" id="m-ram">${fmtPct(system.memUsedPct)} <span class="sub">${fmtBytes(system.memTotal - system.memFree)} / ${fmtBytes(system.memTotal)}</span></div></div>
<div class="card"><div class="label">Disk terpakai</div><div class="value" id="m-disk">${fmtPct(system.diskUsedPct)} <span class="sub">${system.diskTotal === null ? "—" : `${fmtBytes(system.diskTotal - (system.diskFree ?? 0))} / ${fmtBytes(system.diskTotal)}`}</span></div></div>
<div class="card"><div class="label">Uptime</div><div class="value" id="m-up">${fmtUptime(system.uptimeSec)} <span class="sub">proses ${fmtUptime(system.processUptimeSec)} · RSS ${fmtBytes(system.processRss)}</span></div></div>
</div>
<h2>Dompet</h2>
<div class="tablewrap"><table><tr><th>Nama</th><th>Rantai</th><th>Alamat</th></tr><tbody id="wallets">
${walletRows(data.wallets)}</tbody></table></div>
<h2>Konfigurasi</h2>
<div class="card" id="cfg">Model: ${escapeHtml(data.models.join(", ") || "(tidak ada)")}<br>Gateway Telegram: ${data.gatewayEnabled ? "aktif" : "nonaktif"} · pengguna terdaftar: ${data.gatewayAllowedUsers}<br>Testnet only: ${data.testnetOnly === undefined ? "tidak diketahui" : data.testnetOnly ? "ya" : "tidak"}<br>Tugas terjadwal pending: ${data.scheduledPending} dari ${data.scheduledTotal} · Price alert aktif: ${data.alertsActive} dari ${data.alertsTotal}</div>
<h2>Tugas Terjadwal</h2>
<div class="tablewrap"><table><tr><th>ID</th><th>Perintah</th><th>Jadwal</th><th>Status</th><th>Hasil terakhir</th></tr><tbody id="tasks">
${taskRows(data.tasks)}</tbody></table></div>
<h2>Price Alert</h2>
<div class="tablewrap"><table><tr><th>Token</th><th>Target</th><th>Catatan</th><th>Status</th><th>Dibuat</th></tr><tbody id="alerts">
${alertRows(data.alerts)}</tbody></table></div>
<h2>Log</h2>
<pre class="log" id="logs">${data.logs.length ? escapeHtml(data.logs.join("\n")) : "(tidak ada log yang dikonfigurasi — set PANSA_DASHBOARD_LOG ke path file log.)"}</pre>
<p class="note">Untuk saldo, jalankan <code>pansa portfolio</code>. Log yang tampil sudah disaring dari nilai yang tampak seperti secret.</p>
</div><script>${JS}</script></body></html>`;
}

export async function startDashboard(opts: {
  port: number;
  host?: string;
  data: () => DashboardData | Promise<DashboardData>;
}): Promise<DashboardHandle> {
  // Loopback-only, unconditionally: a dashboard reachable from the
  // network would expose wallet inventory to anyone who finds the port.
  if (opts.host !== undefined && opts.host !== "127.0.0.1" && opts.host !== "localhost") {
    throw new Error("Dashboard hanya boleh bind ke 127.0.0.1 (loopback).");
  }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("Method tidak diizinkan (dashboard read-only).\n");
        return;
      }
      if (url.pathname === "/" || url.pathname === "/api/status") {
        const raw = await opts.data();
        const data: DashboardData = { ...raw, logs: raw.logs.map(redactLogLine) };
        const system = collectSystemMetrics();
        if (url.pathname === "/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderDashboardHtml(data, system));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...data, system, readOnly: true, host: "127.0.0.1" }));
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
        // Drop keep-alive connections first: otherwise close() waits
        // forever for a client (e.g. fetch's agent) that holds one open,
        // which also hangs Ctrl+C shutdown, not just tests.
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
