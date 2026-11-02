// Dashboard: a read-only local status page for this PANSA instance.
//
// Security posture, by design:
// - Binds 127.0.0.1 only. Any other host is refused, not honoured — the
//   page must never be reachable from the network.
// - Read-only: GET / and GET /api/status exist, nothing else. Any other
//   method gets 405, any other path 404. There is no endpoint that can
//   mutate state, sign, approve, or broadcast, and none is planned: a
//   dashboard that could move funds from a browser click would bypass
//   the human-confirmation flow the signer is built around.
// - No secrets in the output: wallet names and addresses only (the same
//   data `pansa wallet list` and `pansa balance` already print to a
//   terminal), never mnemonics, keys, passphrases, or secret values.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface DashboardWallet {
  name: string;
  address: string;
  family: string;
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
}

export interface DashboardHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderDashboardHtml(data: DashboardData): string {
  const wallets = data.wallets.length
    ? data.wallets
        .map((w) => `<tr><td>${escapeHtml(w.name)}</td><td>${escapeHtml(w.family)}</td><td>${escapeHtml(w.address)}</td></tr>`)
        .join("\n")
    : `<tr><td colspan="3">(kosong — belum ada dompet di registry)</td></tr>`;
  return `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<title>PANSA Dashboard</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:2em auto;padding:0 1em;color:#111}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 8px;text-align:left}h2{margin-top:1.5em}.note{color:#555;font-size:.9em}</style>
</head><body>
<h1>PANSA Dashboard</h1>
<p class="note">Read-only · hanya bisa diakses dari mesin ini (127.0.0.1) · halaman ini tidak bisa memindahkan dana.</p>
<h2>Dompet</h2>
<table><tr><th>Nama</th><th>Rantai</th><th>Alamat</th></tr>
${wallets}</table>
<h2>Konfigurasi</h2>
<p>Model: ${escapeHtml(data.models.join(", ") || "(tidak ada)")}</p>
<p>Gateway Telegram: ${data.gatewayEnabled ? "aktif" : "nonaktif"} · pengguna terdaftar: ${data.gatewayAllowedUsers}</p>
<p>Testnet only: ${data.testnetOnly === undefined ? "tidak diketahui" : data.testnetOnly ? "ya" : "tidak"}</p>
<h2>Tugas &amp; Alert</h2>
<p>Tugas terjadwal pending: ${data.scheduledPending} dari ${data.scheduledTotal}</p>
<p>Price alert aktif: ${data.alertsActive} dari ${data.alertsTotal}</p>
<p class="note">Data diperbarui tiap 30 detik (refresh otomatis). Untuk saldo, jalankan <code>pansa portfolio</code>.</p>
</body></html>`;
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
      if (url.pathname === "/") {
        const data = await opts.data();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderDashboardHtml(data));
        return;
      }
      if (url.pathname === "/api/status") {
        const data = await opts.data();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...data, readOnly: true, host: "127.0.0.1" }));
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
