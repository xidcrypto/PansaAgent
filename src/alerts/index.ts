// Price alerts: watch a token's USD price and fire once when it
// crosses a threshold. The alert itself never trades, signs, or spends
// anything — it only records the crossing. Delivery is the caller's job
// (`pansa alert check` prints; `pansa schedule watch` prints each
// cycle). Prices come from DexScreener's public API (no key).
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_FILE } from "../config.js";

export interface PriceAlert {
  id: string;
  token: string;
  op: ">=" | "<=";
  price_usd: number;
  note: string;
  status: "active" | "triggered" | "cancelled";
  created_at: string;
  triggered_at: string | null;
}

let db: InstanceType<typeof Database> | null = null;

export function alertsDb(): InstanceType<typeof Database> {
  if (!db) {
    mkdirSync(dirname(DB_FILE), { recursive: true });
    db = new Database(DB_FILE);
    db.exec(`
      CREATE TABLE IF NOT EXISTS price_alerts (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        op TEXT NOT NULL,
        price_usd REAL NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        triggered_at TEXT
      );
    `);
  }
  return db;
}

export function addAlert(token: string, op: ">=" | "<=", priceUsd: number, note = ""): PriceAlert {
  const id = `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  alertsDb().prepare(`INSERT INTO price_alerts (id, token, op, price_usd, note, status) VALUES (?, ?, ?, ?, ?, 'active')`).run(id, token, op, priceUsd, note);
  return getAlert(id) as PriceAlert;
}

export function getAlert(id: string): PriceAlert | null {
  const row = alertsDb().prepare(`SELECT * FROM price_alerts WHERE id = ?`).get(id) as PriceAlert | undefined;
  return row ?? null;
}

export function listAlerts(status?: string): PriceAlert[] {
  const rows = status
    ? (alertsDb().prepare(`SELECT * FROM price_alerts WHERE status = ? ORDER BY created_at`).all(status) as PriceAlert[])
    : (alertsDb().prepare(`SELECT * FROM price_alerts ORDER BY created_at`).all() as PriceAlert[]);
  return rows;
}

export function cancelAlert(id: string): boolean {
  const info = alertsDb().prepare(`UPDATE price_alerts SET status = 'cancelled' WHERE id = ? AND status = 'active'`).run(id) as { changes: number };
  return info.changes > 0;
}

export type PriceFn = (token: string) => Promise<number | undefined>;

export async function dexscreenerPrice(token: string, fetchFn: typeof fetch = fetch): Promise<number | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { signal: ctrl.signal });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { pairs?: Array<{ priceUsd?: string }> };
    const raw = data.pairs?.[0]?.priceUsd;
    const price = raw === undefined ? NaN : parseFloat(raw);
    return Number.isFinite(price) ? price : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export interface TriggeredAlert {
  alert: PriceAlert;
  price: number;
}

// Evaluate every active alert once. A triggered alert is marked
// triggered (never re-fires) and returned; untriggered alerts stay
// active. Tokens with no known price are skipped, never failed.
export async function checkAlerts(priceFn: PriceFn = dexscreenerPrice): Promise<TriggeredAlert[]> {
  const out: TriggeredAlert[] = [];
  for (const alert of listAlerts("active")) {
    const price = await priceFn(alert.token).catch(() => undefined);
    if (price === undefined) continue;
    const crossed = alert.op === ">=" ? price >= alert.price_usd : price <= alert.price_usd;
    if (!crossed) continue;
    alertsDb().prepare(`UPDATE price_alerts SET status = 'triggered', triggered_at = datetime('now') WHERE id = ?`).run(alert.id);
    out.push({ alert: { ...alert, status: "triggered" }, price });
  }
  return out;
}

export function formatAlert(alert: PriceAlert): string {
  return `${alert.id} | ${alert.token} ${alert.op} $${alert.price_usd} | ${alert.status}${alert.note ? ` | ${alert.note}` : ""}`;
}
