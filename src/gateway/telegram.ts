import Database from "better-sqlite3";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_FILE } from "../config.js";

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number; type: string };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: { id: string; data?: string; from?: { id: number }; message?: TelegramMessage };
}

let db: InstanceType<typeof Database> | null = null;

export function gatewayDb(): InstanceType<typeof Database> {
  if (!db) {
    mkdirSync(dirname(DB_FILE), { recursive: true });
    db = new Database(DB_FILE);
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_pairings (
        code_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  return db;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Pairing: `pansa gateway pair` prints a 6-digit code; the user sends
// `/pair <code>` from a private chat. Codes are stored hashed, expire
// after 5 minutes, and are single-use.
export function createPairing(nowMs: number = Date.now()): string {
  const code = String(100000 + Math.floor(Math.random() * 900000));
  const expires = new Date(nowMs + 5 * 60 * 1000).toISOString();
  gatewayDb().prepare(`INSERT INTO gateway_pairings (code_hash, expires_at, used) VALUES (?, ?, 0)`).run(sha256Hex(code), expires);
  return code;
}

export function verifyPairing(code: string, nowMs: number = Date.now()): boolean {
  const row = gatewayDb().prepare(`SELECT expires_at, used FROM gateway_pairings WHERE code_hash = ?`).get(sha256Hex(code)) as
    | { expires_at: string; used: number }
    | undefined;
  if (!row || row.used) return false;
  if (new Date(row.expires_at).getTime() <= nowMs) return false;
  gatewayDb().prepare(`UPDATE gateway_pairings SET used = 1 WHERE code_hash = ?`).run(sha256Hex(code));
  return true;
}

// Allowlist entries are "userId:chatId" strings (config gateways.telegram.allowlist).
export function isAllowlisted(allowlist: string[], userId: number, chatId: number): boolean {
  return allowlist.includes(`${userId}:${chatId}`);
}

// Callback data is HMAC-SHA256 signed with a key kept in the encrypted
// secrets store (never in config, never in logs).
export function signCallback(data: string, key: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

export function verifyCallback(data: string, sig: string, key: string): boolean {
  const expected = Buffer.from(signCallback(data, key), "utf8");
  const given = Buffer.from(sig, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// Gateway confirmation policy. Mainnet confirmations via the gateway are
// NEVER allowed (there is no flag to enable them); the testnet confirm
// path exists only when explicitly enabled in config. The gateway
// additionally never executes a confirmation itself: the sign tool only
// creates a pending confirmation, and execution stays human-only
// (TUI/CLI CONFIRM), which is the codebase's core invariant.
export function gatewayConfirmAllowed(isTestnet: boolean, confirmTestnetEnabled: boolean): boolean {
  return isTestnet && confirmTestnetEnabled;
}

export function splitMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

export class TelegramBot {
  constructor(
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async api<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok?: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method} gagal: ${data.description ?? res.status}`);
    return data.result as T;
  }

  async getUpdates(offset?: number, timeout = 5): Promise<TelegramUpdate[]> {
    const res = await this.api<{ result: TelegramUpdate[] }>("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message", "callback_query"],
    });
    return res.result ?? [];
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    for (const chunk of splitMessage(text)) {
      await this.api("sendMessage", { chat_id: chatId, text: chunk });
    }
  }
}

export type GatewayAction =
  | { kind: "ignore" }
  | { kind: "reply"; chatId: number; text: string }
  | { kind: "paired"; userId: number; chatId: number; text: string }
  | { kind: "agent"; userId: number; chatId: number; text: string };

// Pure routing for one update. Private chats only; non-allowlisted users
// are ignored silently (no info leak); /pair links a chat; /confirm and
// /reject are always refused via the gateway (human-only, TUI/CLI).
export function handleTelegramUpdate(update: TelegramUpdate, allowlist: string[]): GatewayAction {
  const msg = update.message;
  if (!msg || typeof msg.text !== "string") return { kind: "ignore" };
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  if (userId === undefined || chatId === undefined) return { kind: "ignore" };
  if (msg.chat.type !== "private") return { kind: "ignore" };
  const text = msg.text.trim();
  if (text.startsWith("/pair")) {
    const code = text.split(/\s+/)[1] ?? "";
    if (verifyPairing(code)) {
      return { kind: "paired", userId, chatId, text: "Perangkat terhubung. Kirim perintah apa pun untuk menjalankan PANSA." };
    }
    return { kind: "reply", chatId, text: "Kode pairing tidak valid atau kedaluwarsa. Jalankan `pansa gateway pair` untuk kode baru." };
  }
  if (text.startsWith("/confirm") || text.startsWith("/reject") || /^CONFIRM\s+\S+$/i.test(text) || /^REJECT\s+\S+$/i.test(text)) {
    return { kind: "reply", chatId, text: "Konfirmasi hanya bisa dilakukan manusia di TUI/CLI, bukan lewat gateway." };
  }
  if (!isAllowlisted(allowlist, userId, chatId)) return { kind: "ignore" };
  if (text === "/start") {
    return { kind: "reply", chatId, text: "PANSA terhubung. Kirim perintah apa pun; tanda tangan tetap butuh konfirmasi manusia di TUI/CLI." };
  }
  return { kind: "agent", userId, chatId, text };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runGatewayLoop(opts: {
  bot: TelegramBot;
  allowlist: () => string[];
  onPaired: (userId: number, chatId: number) => Promise<void> | void;
  onAgentText: (userId: number, chatId: number, text: string) => Promise<string>;
  signal: AbortSignal;
}): Promise<void> {
  let offset: number | undefined;
  while (!opts.signal.aborted) {
    let updates: TelegramUpdate[];
    try {
      updates = await opts.bot.getUpdates(offset, 5);
    } catch {
      if (opts.signal.aborted) break;
      await sleep(2000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const action = handleTelegramUpdate(u, opts.allowlist());
      if (action.kind === "ignore") continue;
      try {
        if (action.kind === "reply") {
          await opts.bot.sendMessage(action.chatId, action.text);
        } else if (action.kind === "paired") {
          await opts.onPaired(action.userId, action.chatId);
          await opts.bot.sendMessage(action.chatId, action.text);
        } else if (action.kind === "agent") {
          const answer = await opts.onAgentText(action.userId, action.chatId, action.text);
          await opts.bot.sendMessage(action.chatId, answer);
        }
      } catch {
        // A failed send must not kill the loop; the next poll continues.
      }
    }
  }
}
