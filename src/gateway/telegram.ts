import Database from "better-sqlite3";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_FILE } from "../config.js";
import { encrypt as encryptMarker, verifyPassphrase, type EncryptedPayload } from "../crypto.js";

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
  }
  return db;
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

// Diagnostic summary of an initData string for server logs: field names
// and value LENGTHS only — never values, never the hash, never the
// token. Lets us see the shape of a real client initData (e.g. an
// unexpected field) without touching anything sensitive.
export function initDataDiag(initData: string, nowMs: number = Date.now()): string | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }
  const keys = [...new Set(params.keys())].sort();
  const authDate = Number(params.get("auth_date"));
  const authAge = Number.isFinite(authDate) ? Math.round(nowMs / 1000 - authDate) : null;
  const lens = keys.map((k) => `${k}:${(params.get(k) ?? "").length}`).join(",");
  let userKeys = "";
  try {
    const user = JSON.parse(params.get("user") ?? "") as Record<string, unknown>;
    userKeys = `|userKeys=${Object.keys(user).sort().join(",")}`;
  } catch {
    userKeys = "|userKeys=unparsable";
  }
  return `keys=${keys.join(",")}|sig=${params.has("signature") ? 1 : 0}|authAge=${authAge}|lens=${lens}${userKeys}`;
}

// Telegram Web App auth: validate initData, then gate on the
// owner-managed allowedUsers list. initData is a URL query string. The
// documented check string is all fields except "hash" AND "signature"
// (newer clients send signature for Ed25519 validation; it is NOT part
// of the HMAC input), sorted by key, joined with "\n" as key=value
// (decoded values). The HMAC key is HMAC-SHA256(key="WebAppData",
// message=botToken), and the check is HMAC-SHA256 of the check string
// with that key, in hex. (An earlier version used SHA256(botToken) and
// every real login failed with bad_hash; the unit test missed it
// because it computed the hash the same wrong way.)
//
// Live reality (2026-11-03): a real iOS client initData still failed
// bad_hash with the documented construction, even though its field set
// was exactly auth_date/hash/query_id/signature/user and the data was
// 4 seconds old. The documented construction therefore cannot be the
// only one in the wild — different clients encode values differently
// (notably: URLSearchParams turns a literal "+" into a space, and some
// clients may hash the still-encoded values). So verification tries
// several constructions and accepts the one that matches. This is
// sound: every variant still requires the HMAC with the bot token,
// which only Telegram holds, so a match proves that construction is
// what Telegram used for this initData. The matched variant is
// returned for server logs. Data older than 24h (or from the future
// beyond clock skew) is rejected, so a captured initData cannot work
// forever. The reason code is for server logs only — never log initData
// itself.
type InitDataEntries = Array<[string, string]>;

function parseInitDataEntries(initData: string, mode: "decoded" | "raw" | "plus"): InitDataEntries | null {
  try {
    if (mode === "decoded") {
      const params = new URLSearchParams(initData);
      return [...params.entries()];
    }
    const out: InitDataEntries = [];
    for (const part of initData.split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const rawKey = eq === -1 ? part : part.slice(0, eq);
      const rawVal = eq === -1 ? "" : part.slice(eq + 1);
      // "plus" decodes %XX but keeps a literal "+" as "+" (URLSearchParams
      // would turn it into a space); "raw" keeps values still-encoded.
      out.push([decodeURIComponent(rawKey), mode === "plus" ? decodeURIComponent(rawVal) : rawVal]);
    }
    return out;
  } catch {
    return null;
  }
}

function hashMatches(entries: InitDataEntries, excludeSignature: boolean, secret: Buffer, hash: string): boolean {
  const keys = [...new Set(entries.map(([k]) => k))].sort();
  const first = new Map<string, string>();
  for (const [k, v] of entries) if (!first.has(k)) first.set(k, v);
  const pairs = keys
    .filter((k) => k !== "hash" && (!excludeSignature || k !== "signature"))
    .map((k) => `${k}=${first.get(k) ?? ""}`);
  const check = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  const a = Buffer.from(check, "utf8");
  const b = Buffer.from(hash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  allowedUsers: number[],
  nowMs: number = Date.now(),
): { ok: boolean; userId?: number; reason?: string; variant?: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (!initData || !botToken) return fail("bad_request");
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return fail("bad_request");
  }
  const hash = params.get("hash");
  if (!hash || hash.length !== 64) return fail("bad_hash");
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) return fail("stale");
  const nowSec = nowMs / 1000;
  if (authDate > nowSec + 300 || nowSec - authDate > 24 * 60 * 60) return fail("stale");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const variants: Array<{ name: string; mode: "decoded" | "raw" | "plus"; excludeSignature: boolean }> = [
    { name: "decoded", mode: "decoded", excludeSignature: true },
    { name: "decoded+sig", mode: "decoded", excludeSignature: false },
    { name: "plus", mode: "plus", excludeSignature: true },
    { name: "plus+sig", mode: "plus", excludeSignature: false },
    { name: "raw", mode: "raw", excludeSignature: true },
    { name: "raw+sig", mode: "raw", excludeSignature: false },
  ];
  let matched: string | null = null;
  for (const v of variants) {
    const entries = parseInitDataEntries(initData, v.mode);
    if (entries && hashMatches(entries, v.excludeSignature, secret, hash)) {
      matched = v.name;
      break;
    }
  }
  if (!matched) return fail("bad_hash");
  let userId: number | undefined;
  try {
    const user = JSON.parse(params.get("user") ?? "") as { id?: unknown };
    if (typeof user.id === "number") userId = user.id;
  } catch {
    return fail("bad_request");
  }
  if (userId === undefined) return fail("bad_request");
  if (!allowedUsers.includes(userId)) return fail("user_not_allowed");
  return { ok: true, userId, variant: matched };
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
    // Telegram flood control (429) is a normal multi-user condition, not
    // a fatal error: retry once after the server's retry_after (capped
    // at 60s) instead of dropping the user's reply.
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // A stalled socket must never wedge the polling loop forever:
        // abort well past Telegram's own 5s long-poll window so the loop
        // retries instead of sleeping on a dead connection.
        signal: AbortSignal.timeout(30000),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        result?: T;
        description?: string;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      if (data.ok) return data.result as T;
      if (data.error_code === 429 && attempt === 0) {
        const waitMs = Math.min(Math.max(0, data.parameters?.retry_after ?? 0), 60) * 1000;
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(`Telegram ${method} gagal: ${data.description ?? res.status}`);
    }
    throw new Error(`Telegram ${method} gagal: 429 berulang`);
  }

  async getUpdates(offset?: number, timeout = 5): Promise<TelegramUpdate[]> {
    // api() already unwraps data.result; do NOT unwrap twice (an early
    // version read .result off the returned array and got [] forever —
    // the loop polled empty batches and never answered anyone).
    const result = await this.api<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message", "callback_query"],
    });
    return result ?? [];
  }

  // Menu button bot (tombol Menu di aplikasi Telegram, BUKAN tombol
  // inline di dalam chat): mengisi daftar perintah yang muncul saat
  // pengguna mengetuk Menu. Tanpa ini tombol Menu kosong.
  async setBotCommands(): Promise<void> {    await this.api("setMyCommands", {
      commands: [
        { command: "start", description: "Mulai dan info koneksi" },
        { command: "help", description: "Daftar perintah PANSA" },
        { command: "status", description: "Ringkasan doctor" },
        { command: "schedule", description: "Tugas terjadwal yang pending" },
        { command: "alerts", description: "Price alert yang aktif" },
        { command: "provider", description: "Provider & model dari daemon" },
        { command: "wallet", description: "Buat & daftar dompet" },
      ],
    });
  }

  // Menu button Web App (tombol aplikasi di kiri bawah kolom chat, yang
  // dilingkari di screenshot: ikon + teks, mis. "PANSA"). Mengetuknya
  // membuka URL sebagai Web App di dalam Telegram — bukan daftar
  // perintah. Scope default (tanpa chat_id) sehingga berlaku untuk
  // semua chat dengan bot. Daftar perintah dari setBotCommands tetap
  // tersedia lewat autocomplete "/" meski tombol ini aktif.
  async setChatMenuButton(webAppUrl: string, text = "PANSA"): Promise<void> {
    await this.api("setChatMenuButton", {
      menu_button: { type: "web_app", text, web_app: { url: webAppUrl } },
    });
  }

  async getChatMenuButton(): Promise<unknown> {
    return this.api("getChatMenuButton", {});
  }

  async sendMessage(chatId: number, text: string, replyMarkup?: InlineKeyboardMarkup | ReplyKeyboardMarkup): Promise<void> {
    const chunks = splitMessage(text);
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = { chat_id: chatId, text: chunks[i] };
      if (replyMarkup && i === chunks.length - 1) body.reply_markup = replyMarkup;
      await this.api("sendMessage", body);
    }
  }

  // Typing indicator: Telegram shows it ~5s, so the loop re-sends it
  // every 4s while the agent is working.
  async sendChatAction(chatId: number, action = "typing"): Promise<void> {
    await this.api("sendChatAction", { chat_id: chatId, action });
  }

  // Agent status message (a visible stand-in for the header typing
  // indicator, whose text Telegram does NOT let a bot customize): one
  // message sent at the start of an agent run, edited as the agent's
  // current tool changes, deleted when the run finishes. These throw
  // like the other methods; the tracker below swallows failures so a
  // status problem can never break the answer itself.
  async sendStatus(chatId: number, text: string): Promise<number> {
    const res = await this.api<{ message_id: number }>("sendMessage", { chat_id: chatId, text });
    return res.message_id;
  }

  async editStatus(chatId: number, messageId: number, text: string): Promise<void> {
    await this.api("editMessageText", { chat_id: chatId, message_id: messageId, text });
  }

  async deleteStatus(chatId: number, messageId: number): Promise<void> {
    await this.api("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  // Send a file (e.g. an encrypted keystore) as a document. Multipart,
  // unlike api() which is JSON-only; same 429 retry discipline.
  async sendDocument(chatId: number, filename: string, content: Buffer, caption?: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("document", new Blob([content], { type: "application/json" }), filename);
      if (caption) form.append("caption", caption);
      const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/sendDocument`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        description?: string;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      if (data.ok) return;
      if (data.error_code === 429 && attempt === 0) {
        const waitMs = Math.min(Math.max(0, data.parameters?.retry_after ?? 0), 60) * 1000;
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(`Telegram sendDocument gagal: ${data.description ?? res.status}`);
    }
    throw new Error("Telegram sendDocument gagal: 429 berulang");
  }

  // Dismiss the button spinner. Must be called for every handled
  // callback, or the button looks stuck.
  async answerCallbackQuery(callbackId: string): Promise<void> {
    await this.api("answerCallbackQuery", { callback_query_id: callbackId });
  }
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

// Persistent reply keyboard: the panel that opens from the grid icon
// next to the message field (NOT buttons inside a chat bubble). Once a
// bot sends one, Telegram keeps the panel until another keyboard
// replaces it, so every bot reply re-attaches the main panel. Tapping a
// button sends its text as an ordinary message, which the gateway
// routes in handleReplyKeyboardText. Unlike inline callback_data, reply
// button text has no 64-byte cap, so every model id is tappable.
export interface ReplyKeyboardButton {
  text: string;
}

export interface ReplyKeyboardMarkup {
  keyboard: ReplyKeyboardButton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  is_persistent?: boolean;
}

export type ReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup;

export function mainReplyKeyboard(): ReplyKeyboardMarkup {
  const b = (text: string): ReplyKeyboardButton => ({ text });
  return {
    keyboard: [
      [b("🤖 Model"), b("➕ Provider")],
      [b("📊 Status"), b("📋 Schedule")],
      [b("🔔 Alerts"), b("❓ Help")],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    is_persistent: true,
  };
}

// Model picker as a reply keyboard: one model per row (button text is
// the raw model id, so a tap sends exactly that id back), plus page
// navigation and a back-to-menu row. The pinned model is marked in the
// accompanying message text, not in the button, so the text stays an
// exact model id.
export function modelReplyKeyboard(models: string[], page = 0): ReplyKeyboardMarkup {
  const maxPage = Math.max(0, Math.ceil(models.length / MODEL_PAGE_SIZE) - 1);
  const safePage = Math.min(Math.max(0, page), maxPage);
  const slice = models.slice(safePage * MODEL_PAGE_SIZE, safePage * MODEL_PAGE_SIZE + MODEL_PAGE_SIZE);
  const rows: ReplyKeyboardButton[][] = slice.map((m) => [{ text: m }]);
  const nav: ReplyKeyboardButton[] = [];
  if (safePage > 0) nav.push({ text: "⬅️ Sebelumnya" });
  if (safePage < maxPage) nav.push({ text: "➡️ Lagi" });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "⬅️ Kembali" }]);
  return { keyboard: rows, resize_keyboard: true, one_time_keyboard: false, is_persistent: true };
}

// Choice panel before the picker: Default = daemon live models,
// Custom = enabled custom-provider models. Tapping one opens that
// source's picker; picking a model there pins it immediately.
export function modelSourceKeyboard(): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: "Default" }, { text: "Custom" }],
      [{ text: "⬅️ Kembali ke menu" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    is_persistent: true,
  };
}

// Per-chat picker state: which panel the user currently sees, and for
// the model picker, which source (default/custom) and page. Only needed
// to tell a model-id tap apart from an ordinary chat message that
// happens to equal a model id. Memory-only: a gateway restart clears
// it, and a tap then falls through to the agent (harmless).
type KeyboardPanelState = { kind: "menu" | "model-source" | "models"; source?: "default" | "custom"; page: number };
const keyboardPanelState = new Map<number, KeyboardPanelState>();

export function resetGatewayKeyboardPanelState(): void {
  keyboardPanelState.clear();
}

export interface GatewayKeyboardDeps {
  doctorText: () => Promise<string>;
  scheduleText: () => string;
  alertText: () => string;
  providerText: () => Promise<string>;
  listDefaultModels: () => Promise<string[]>;
  listCustomModels: () => Promise<string[]>;
  pinnedModel: () => string | undefined;
  setModel: (id: string, source?: "default" | "custom") => void;
}

function sourceLabel(source: "default" | "custom"): string {
  return source === "default" ? "Default (daemon)" : "Custom (provider)";
}

// Route a reply-keyboard tap (arrives as plain message text). Returns
// null for anything that is not a panel button, so it falls through to
// deterministic commands and then the agent. Flow: Model -> choose
// Default/Custom -> pick a model -> pinned immediately, and the next
// agent answer uses it (config is re-read per message).
export async function handleReplyKeyboardText(
  text: string,
  chatId: number,
  deps: GatewayKeyboardDeps,
): Promise<{ text: string; keyboard: ReplyKeyboardMarkup } | null> {
  const state = keyboardPanelState.get(chatId) ?? { kind: "menu", page: 0 };
  const t = text.trim();
  if (t === "🤖 Model") {
    keyboardPanelState.set(chatId, { kind: "model-source", page: 0 });
    return {
      text: [
        "🤖 Pilih sumber model:",
        "Default — model dari daemon.",
        "Custom — model dari provider custom yang aktif (mis. beat-4).",
        "Ketuk salah satu, lalu ketuk modelnya — model itu langsung dipakai untuk chat berikutnya.",
      ].join("\n"),
      keyboard: modelSourceKeyboard(),
    };
  }
  if (t === "⬅️ Kembali ke menu") {
    keyboardPanelState.set(chatId, { kind: "menu", page: 0 });
    return { text: "Menu PANSA — pilih:", keyboard: mainReplyKeyboard() };
  }
  if (t === "Default" || t === "Custom") {
    const source = t === "Default" ? "default" : "custom";
    const models = await (source === "default" ? deps.listDefaultModels() : deps.listCustomModels()).catch((): string[] => []);
    if (!models.length) {
      keyboardPanelState.set(chatId, { kind: "model-source", page: 0 });
      return {
        text:
          source === "custom"
            ? "Belum ada model provider custom yang aktif. Tambah provider lewat dashboard PANSA, lalu kembali ke sini."
            : "Tidak ada model default dari daemon. Pastikan daemon berjalan, lalu coba lagi.",
        keyboard: modelSourceKeyboard(),
      };
    }
    keyboardPanelState.set(chatId, { kind: "models", source, page: 0 });
    return { text: modelPageText(models, deps.pinnedModel(), 0, true, sourceLabel(source)), keyboard: modelReplyKeyboard(models, 0) };
  }
  if (t === "⬅️ Kembali" && state.kind === "models") {
    keyboardPanelState.set(chatId, { kind: "model-source", page: 0 });
    return {
      text: [
        "🤖 Pilih sumber model:",
        "Default — model dari daemon.",
        "Custom — model dari provider custom yang aktif (mis. beat-4).",
      ].join("\n"),
      keyboard: modelSourceKeyboard(),
    };
  }
  if (state.kind === "models" && state.source) {
    const models = await (state.source === "default" ? deps.listDefaultModels() : deps.listCustomModels()).catch((): string[] => []);
    if (t === "➡️ Lagi" || t === "⬅️ Sebelumnya") {
      const maxPage = Math.max(0, Math.ceil(models.length / MODEL_PAGE_SIZE) - 1);
      const page = Math.min(Math.max(0, state.page + (t === "➡️ Lagi" ? 1 : -1)), maxPage);
      keyboardPanelState.set(chatId, { kind: "models", source: state.source, page });
      return { text: modelPageText(models, deps.pinnedModel(), page, true, sourceLabel(state.source)), keyboard: modelReplyKeyboard(models, page) };
    }
    if (models.includes(t)) {
      deps.setModel(t, state.source);
      keyboardPanelState.set(chatId, { kind: "menu", page: 0 });
      return { text: `Model untuk chat ini dikunci ke: ${t}\nJawaban agen berikutnya memakai model ini.`, keyboard: mainReplyKeyboard() };
    }
  }
  if (t === "➕ Provider") return { text: await deps.providerText(), keyboard: mainReplyKeyboard() };
  if (t === "📊 Status") return { text: await deps.doctorText(), keyboard: mainReplyKeyboard() };
  if (t === "📋 Schedule") return { text: deps.scheduleText(), keyboard: mainReplyKeyboard() };
  if (t === "🔔 Alerts") return { text: deps.alertText(), keyboard: mainReplyKeyboard() };
  if (t === "❓ Help") {
    return {
      text: [
        "Perintah PANSA:",
        "/status — ringkasan doctor (node, config, daemon, scheduler, gateway)",
        "/schedule — tugas terjadwal yang masih pending",
        "/alerts — price alert yang masih aktif",
        "/provider — provider & model dari daemon (tanpa kirim API key)",
        "Pesan lain diteruskan ke agen PANSA. Konfirmasi transaksi hanya di TUI/CLI.",
      ].join("\n"),
      keyboard: mainReplyKeyboard(),
    };
  }
  if (t === "⚙️ Settings") {
    return {
      text: [
        "⚙️ Settings gateway:",
        `Model terkunci: ${deps.pinnedModel() ?? "(tidak ada — daemon memilih)"}`,
        "Tanda tangan tidak pernah lewat bot; konfirmasi tetap di TUI/CLI.",
      ].join("\n"),
      keyboard: mainReplyKeyboard(),
    };
  }
  return null;
}

export function mainMenuKeyboard(): InlineKeyboardMarkup {
  const b = (text: string, data: string): InlineKeyboardButton => ({ text, callback_data: data });
  return {
    inline_keyboard: [
      [b("⚙️ Settings", "settings"), b("🤖 Model", "model")],
      [b("➕ Provider", "provider"), b("📊 Status", "status")],
      [b("📋 Schedule", "schedule"), b("🔔 Alerts", "alerts")],
      [b("❓ Help", "help")],
    ],
  };
}

export function settingsKeyboard(): InlineKeyboardMarkup {
  const b = (text: string, data: string): InlineKeyboardButton => ({ text, callback_data: data });
  return {
    inline_keyboard: [
      [b("🤖 Model", "model"), b("➕ Provider", "provider")],
      [b("⬅️ Kembali ke menu", "menu")],
    ],
  };
}

// Model buttons: callback_data is capped at 64 bytes by Telegram, so
// over-long model ids are listed as text only, never as buttons.
// Ten buttons per page; page buttons recompute the list on tap, so no
// server-side page state is needed.
export const MODEL_PAGE_SIZE = 10;

export function modelKeyboard(models: string[], pinned?: string, page = 0): InlineKeyboardMarkup {
  const buttonable = models.filter((m) => `model:${m}`.length <= 64);
  const maxPage = Math.max(0, Math.ceil(buttonable.length / MODEL_PAGE_SIZE) - 1);
  const safePage = Math.min(Math.max(0, page), maxPage);
  const slice = buttonable.slice(safePage * MODEL_PAGE_SIZE, safePage * MODEL_PAGE_SIZE + MODEL_PAGE_SIZE);
  const rows: InlineKeyboardButton[][] = [];
  for (const m of slice) {
    const label = (pinned === m ? "✓ " : "") + (m.length > 40 ? m.slice(0, 37) + "…" : m);
    rows.push([{ text: label, callback_data: `model:${m}` }]);
  }
  const nav: InlineKeyboardButton[] = [];
  if (safePage > 0) nav.push({ text: "⬅️ Sebelumnya", callback_data: `modelpage:${safePage - 1}` });
  if (safePage < maxPage) nav.push({ text: "➡️ Lagi", callback_data: `modelpage:${safePage + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "⬅️ Kembali ke menu", callback_data: "menu" }]);
  return { inline_keyboard: rows };
}

function modelPageText(models: string[], pinned: string | undefined, page: number, forReply = false, sourceLabel?: string): string {
  // Reply-keyboard buttons have no 64-byte cap, so the inline filter
  // must not apply there: every model is tappable from the panel.
  const buttonable = forReply ? models : models.filter((m) => `model:${m}`.length <= 64);
  const skipped = forReply ? [] : models.filter((m) => `model:${m}`.length > 64);
  const maxPage = Math.max(0, Math.ceil(buttonable.length / MODEL_PAGE_SIZE) - 1);
  const safePage = Math.min(Math.max(0, page), maxPage);
  const slice = buttonable.slice(safePage * MODEL_PAGE_SIZE, safePage * MODEL_PAGE_SIZE + MODEL_PAGE_SIZE);
  return [
    "🤖 Pilih model untuk agen gateway (klik untuk mengunci):",
    ...(sourceLabel ? [`Sumber: ${sourceLabel}`] : []),
    ...(slice.length ? slice.map((m) => (pinned === m ? `✓ ${m}` : m)) : ["(tidak ada model yang bisa dipilih)"]),
    ...(maxPage > 0 ? [`Halaman ${safePage + 1} dari ${maxPage + 1} (${buttonable.length} model)`] : []),
    ...(skipped.length ? [`(${skipped.length} model lain tidak bisa jadi tombol — id melebihi 64 byte)`] : []),
  ].join("\n");
}

export type GatewayAction =
  | { kind: "ignore" }
  | { kind: "reply"; chatId: number; text: string; keyboard?: ReplyMarkup }
  | { kind: "agent"; userId: number; chatId: number; text: string }
  | { kind: "callback"; callbackId: string; userId: number; chatId: number; data: string };

// Connect template: the notification a user gets when they connect.
// Sent on /start, on the first served message from a user, and by
// `pansa gateway notify <user-id>`. Kept plain-text (no Markdown
// parsing surprises) and honest: signing never happens via the bot.
export function connectTemplate(nowMs: number = Date.now()): string {
  const when = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(nowMs));
  return [
    "✅ PANSA Terhubung",
    "",
    "Bot PANSA kamu sudah aktif dan siap dipakai.",
    "",
    "Perintah cepat:",
    "/status — ringkasan kesehatan PANSA",
    "/schedule — tugas terjadwal yang masih pending",
    "/alerts — price alert yang masih aktif",
    "/provider — provider & model dari daemon",
    "/help — daftar perintah lengkap",
    "",
    "Atau kirim pesan bebas — agen PANSA akan menjawabnya.",
    "",
    "🔒 Keamanan: tanda tangan transaksi TIDAK PERNAH lewat bot. Konfirmasi hanya dilakukan manusia di TUI/CLI.",
    "",
    `Terhubung: ${when} WIB`,
  ].join("\n");
}

// Per-user model pins (multi-user correctness): one user's Model tap
// must not re-pin the model for everyone else. Pins live in the gateway
// DB, keyed by Telegram user id; the global config pin stays as the
// fallback for users who never picked one.
export interface UserModelPin {
  model: string;
  source?: "default" | "custom";
}

function userModelTable(): void {
  gatewayDb().exec(`
    CREATE TABLE IF NOT EXISTS gateway_user_models (
      user_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      source TEXT
    );
  `);
}

export function getUserModel(userId: number): UserModelPin | undefined {
  userModelTable();
  const row = gatewayDb().prepare(`SELECT model, source FROM gateway_user_models WHERE user_id = ?`).get(String(userId)) as
    | { model: string; source: string | null }
    | undefined;
  if (!row) return undefined;
  return {
    model: row.model,
    source: row.source === "custom" ? "custom" : row.source === "default" ? "default" : undefined,
  };
}

export function setUserModel(userId: number, model: string, source?: "default" | "custom"): void {
  userModelTable();
  gatewayDb()
    .prepare(
      `INSERT INTO gateway_user_models (user_id, model, source) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET model = excluded.model, source = excluded.source`,
    )
    .run(String(userId), model, source ?? null);
}

// Per-chat conversation memory. Without it the gateway agent is
// stateless per message: a follow-up answer ("Jhody" after "what name?")
// arrives context-free, and the crypto-only scope instruction refuses
// it as unrelated. History fixes that class of bug — the last few
// exchanges ride along with each new agent run. Bounded (last 20 rows
// kept, 16 sent, 1000 chars each) so tokens stay predictable; stored
// in the gateway DB next to the pins, owner-only via the allowedUsers
// gate. History is best-effort: callers swallow DB failures.
export interface ChatHistoryEntry {
  role: "user" | "assistant";
  text: string;
}

const CHAT_HISTORY_KEEP = 20;
const CHAT_HISTORY_TEXT_MAX = 1000;

function chatHistoryTable(): void {
  gatewayDb().exec(`
    CREATE TABLE IF NOT EXISTS gateway_chat_history (
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL
    );
  `);
}

export function appendChatHistory(chatId: number, role: "user" | "assistant", text: string): void {
  chatHistoryTable();
  const db = gatewayDb();
  db.prepare(`INSERT INTO gateway_chat_history (chat_id, role, text) VALUES (?, ?, ?)`).run(
    String(chatId),
    role,
    text.slice(0, CHAT_HISTORY_TEXT_MAX),
  );
  db.prepare(
    `DELETE FROM gateway_chat_history WHERE chat_id = ? AND rowid NOT IN (
      SELECT rowid FROM gateway_chat_history WHERE chat_id = ? ORDER BY rowid DESC LIMIT ?
    )`,
  ).run(String(chatId), String(chatId), CHAT_HISTORY_KEEP);
}

export function getChatHistory(chatId: number, limit = 16): ChatHistoryEntry[] {
  chatHistoryTable();
  const rows = gatewayDb()
    .prepare(`SELECT role, text FROM gateway_chat_history WHERE chat_id = ? ORDER BY rowid DESC LIMIT ?`)
    .all(String(chatId), limit) as Array<{ role: string; text: string }>;
  return rows.reverse().map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", text: r.text }));
}

// Shared wallet password: created once (before the first wallet can be
// made), used for every wallet, required for every export. Only a
// scrypt hash of a fixed marker is stored — the password itself is
// never persisted, never logged, and never handed to the agent. The
// password the user types in chat stays in their own Telegram history
// until they delete it (the bot cannot delete user messages: onAgentText
// never receives a message id), so the reply always tells them to
// delete it, and the password must not be reused anywhere else.
const WALLET_PASSWORD_MARKER = "pansa-wallet-password-v1";

function walletPasswordTable(): void {
  gatewayDb().exec(`
    CREATE TABLE IF NOT EXISTS wallet_password (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL
    );
  `);
}

export function hasWalletPassword(): boolean {
  walletPasswordTable();
  const row = gatewayDb().prepare(`SELECT COUNT(*) AS n FROM wallet_password WHERE id = 1`).get() as { n: number };
  return row.n > 0;
}

export function setWalletPassword(password: string): void {
  walletPasswordTable();
  const payload = encryptMarker(Buffer.from(WALLET_PASSWORD_MARKER, "utf8"), password);
  gatewayDb()
    .prepare(`INSERT INTO wallet_password (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`)
    .run(JSON.stringify(payload));
}

export function verifyWalletPassword(password: string): boolean {
  walletPasswordTable();
  const row = gatewayDb().prepare(`SELECT payload FROM wallet_password WHERE id = 1`).get() as
    | { payload: string }
    | undefined;
  if (!row) return false;
  try {
    return verifyPassphrase(JSON.parse(row.payload) as EncryptedPayload, password);
  } catch {
    return false;
  }
}

// Pending password flows: a multi-step exchange the agent must never
// see. /wallet set-password and /wallet export arm a pending state;
// the next FREE-TEXT message from that chat is consumed as the password
// (never forwarded to the agent, never recorded in history). Commands
// and reply-keyboard buttons keep routing normally and leave the
// pending state untouched, so tapping a button never burns an attempt.
export const WALLET_PENDING_TTL_MS = 5 * 60 * 1000;
export const WALLET_PASSWORD_MIN_LEN = 8;
export const WALLET_EXPORT_MAX_ATTEMPTS = 3;

export type WalletPendingKind = "set-password" | "export";

export interface WalletPending {
  kind: WalletPendingKind;
  step: "old" | "new" | "password";
  walletName?: string;
  attempts: number;
  expiresAt: number;
}

function walletPendingTable(): void {
  gatewayDb().exec(`
    CREATE TABLE IF NOT EXISTS wallet_pending (
      chat_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      step TEXT NOT NULL,
      wallet_name TEXT,
      attempts INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
}

export function getWalletPending(chatId: number): WalletPending | null {
  walletPendingTable();
  const row = gatewayDb().prepare(`SELECT kind, step, wallet_name, attempts, expires_at FROM wallet_pending WHERE chat_id = ?`).get(String(chatId)) as
    | { kind: string; step: string; wallet_name: string | null; attempts: number; expires_at: number }
    | undefined;
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    clearWalletPending(chatId);
    return null;
  }
  return {
    kind: row.kind as WalletPendingKind,
    step: row.step as WalletPending["step"],
    walletName: row.wallet_name ?? undefined,
    attempts: row.attempts,
    expiresAt: row.expires_at,
  };
}

export function setWalletPending(chatId: number, pending: WalletPending): void {
  walletPendingTable();
  gatewayDb()
    .prepare(`INSERT INTO wallet_pending (chat_id, kind, step, wallet_name, attempts, expires_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET kind = excluded.kind, step = excluded.step, wallet_name = excluded.wallet_name, attempts = excluded.attempts, expires_at = excluded.expires_at`)
    .run(String(chatId), pending.kind, pending.step, pending.walletName ?? null, pending.attempts, pending.expiresAt);
}

export function clearWalletPending(chatId: number): void {
  walletPendingTable();
  gatewayDb().prepare(`DELETE FROM wallet_pending WHERE chat_id = ?`).run(String(chatId));
}

export function isPasswordAttemptCandidate(text: string): boolean {
  const t = text.trim();
  if (!t || t.startsWith("/")) return false;
  const buttons = mainReplyKeyboard().keyboard.flat().map((b) => b.text);
  if (buttons.includes(t)) return false;
  return true;
}

// Effective pin for one user: their own pin wins, otherwise the global
// config pin (exactly one configured model), otherwise no pin.
export function resolveGatewayPin(
  userPin: UserModelPin | undefined,
  globalModels?: string[],
  globalSource?: "default" | "custom",
): { onlyModel?: string; onlySource?: "default" | "custom" } {
  if (userPin) return { onlyModel: userPin.model, onlySource: userPin.source };
  const onlyModel = globalModels?.length === 1 ? globalModels[0] : undefined;
  return { onlyModel, onlySource: globalSource };
}

// First-seen tracking: the connect template is sent once, before the
// first served answer to a user — not on every message.
export function markUserSeen(userId: number): boolean {
  gatewayDb().exec(`
    CREATE TABLE IF NOT EXISTS gateway_seen_users (
      user_id TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const info = gatewayDb().prepare(`INSERT OR IGNORE INTO gateway_seen_users (user_id) VALUES (?)`).run(String(userId)) as { changes: number };
  return info.changes > 0;
}
// This is a personal agent: there is no pairing. Access rule, in order:
//   1. a user ID in allowedUsers (owner-managed via CLI: `pansa
//      gateway allow <id>`) is served, any private chat from that user
//      works;
//   2. everyone else is ignored silently (no info leak — not even the
//      confirm refusal, which would confirm the bot is listening).
// /confirm and /reject are always refused via the gateway (human-only,
// TUI/CLI).
export function handleTelegramUpdate(update: TelegramUpdate, allowedUsers: number[] = []): GatewayAction {
  // Button taps arrive as callback_query, not messages. Gate them with
  // the same rule as messages; the loop answers the callback (dismisses
  // the spinner) and routes the button data.
  const cb = update.callback_query;
  if (cb) {
    const userId = cb.from?.id;
    const chatId = cb.message?.chat.id ?? userId;
    const data = cb.data ?? "";
    if (userId === undefined || chatId === undefined || !data) return { kind: "ignore" };
    if (cb.message?.chat.type && cb.message.chat.type !== "private") return { kind: "ignore" };
    if (!allowedUsers.includes(userId)) return { kind: "ignore" };
    return { kind: "callback", callbackId: cb.id, userId, chatId, data };
  }
  const msg = update.message;
  if (!msg || typeof msg.text !== "string") return { kind: "ignore" };
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  if (userId === undefined || chatId === undefined) return { kind: "ignore" };
  if (msg.chat.type !== "private") return { kind: "ignore" };
  const text = msg.text.trim();
  if (!allowedUsers.includes(userId)) return { kind: "ignore" };
  if (text.startsWith("/confirm") || text.startsWith("/reject") || /^CONFIRM\s+\S+$/i.test(text) || /^REJECT\s+\S+$/i.test(text)) {
    return { kind: "reply", chatId, text: "Konfirmasi hanya bisa dilakukan manusia di TUI/CLI, bukan lewat gateway." };
  }
  if (text === "/start") {
    return { kind: "reply", chatId, text: connectTemplate(), keyboard: mainReplyKeyboard() };
  }
  return { kind: "agent", userId, chatId, text };
}

export interface GatewayCommandDeps {
  chatId: number;
  doctorText: () => Promise<string>;
  scheduleText: () => string;
  alertText: () => string;
  providerText: () => Promise<string>;
  // Owner-only wallet commands (deterministic, no LLM): list reads the
  // public registry (addresses are not secrets); create goes through
  // the signer and returns name/family/address ONLY — the mnemonic
  // never leaves the gateway process, let alone the chat.
  walletList: () => Promise<Array<{ name: string; family: string; address: string }>>;
  walletCreate: (chain: string, name: string) => Promise<{ name: string; family: string; address: string }>;
}

// Sapaan ringan dijawab deterministik (tanpa LLM) untuk kecepatan.
// Dulu agen memakai toolChoice "required" sehingga tidak bisa menjawab
// sapaan dalam teks biasa (dipaksa memanggil tool sampai batas langkah);
// sejak perbaikan toolChoice "auto", agen juga bisa menjawab teks biasa,
// tapi sapaan persis tetap deterministik. Hanya sapaan persis (bukan
// "halo, tolong ...") yang masuk sini.
export function isGreeting(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!?.]+$/, "");
  return [
    "halo", "hai", "hi", "hello", "hey", "helo",
    "selamat pagi", "selamat siang", "selamat sore", "selamat malam",
    "assalamualaikum", "assalamu'alaikum", "salam",
  ].includes(t);
}

// Human labels for the agent status message, keyed by tool name.
// Unknown tools (e.g. MCP tools) fall back to their raw name so the
// status never goes blank mid-run.
export const AGENT_STATUS_LABELS: Record<string, string> = {
  wallet_create: "👛 Membuat dompet…",
  wallet_list: "👛 Memeriksa daftar dompet…",
  analyst: "🔍 Menginvestigasi…",
  scam_check: "🛡️ Memeriksa keamanan…",
  tracker: "📊 Memeriksa portofolio…",
  report: "📝 Menyusun laporan…",
  sign_transaction: "✍️ Menyiapkan transaksi (perlu konfirmasi)…",
  reject_transaction: "🚫 Menolak transaksi…",
  list_confirmations: "📋 Memeriksa konfirmasi…",
  skill_load: "📚 Memuat panduan…",
  browser_open: "🌐 Membuka halaman…",
};

export function agentStatusLabel(toolName: string): string {
  return AGENT_STATUS_LABELS[toolName] ?? `⚙️ Menjalankan ${toolName}…`;
}

export interface AgentStatusTracker {
  update: (toolName: string) => Promise<void>;
  finish: () => Promise<void>;
}

// Best-effort status lifecycle: send once, edit only when the label
// actually changes (Telegram errors on identical edits, and rapid
// re-edits risk flood control), delete on finish. If the initial send
// fails the tracker silently no-ops; if delete fails it falls back to
// editing the message to "Selesai" so no stale phase lingers.
export async function startAgentStatus(bot: TelegramBot, chatId: number): Promise<AgentStatusTracker> {
  let messageId: number | null = null;
  let current = "";
  try {
    messageId = await bot.sendStatus(chatId, "⏳ Memproses…");
    current = "⏳ Memproses…";
  } catch {
    messageId = null;
  }
  return {
    update: async (toolName: string) => {
      const label = agentStatusLabel(toolName);
      if (messageId === null || label === current) return;
      current = label;
      try {
        await bot.editStatus(chatId, messageId, label);
      } catch {
        // Status is cosmetic; never break the agent run for it.
      }
    },
    finish: async () => {
      if (messageId === null) return;
      const id = messageId;
      messageId = null;
      try {
        await bot.deleteStatus(chatId, id);
      } catch {
        try {
          await bot.editStatus(chatId, id, "✅ Selesai.");
        } catch {
          // Nothing left to do; the final answer still goes out.
        }
      }
    },
  };
}

// Deterministic gateway commands: answered without an LLM call (fast,
// no model cost). Anything else falls through to the agent (null).
// /balance and /portfolio are intentionally NOT deterministic here: the
// gateway agent has no wallet tool (baw never reaches the gateway), so
// the agent answers honestly that it cannot read balances via the bot.
// /wallet list/create ARE deterministic, but they are not agent tools:
// list reads the public registry and create goes through the signer,
// both owner-only via the allowedUsers gate, and neither ever returns
// key material to the chat.
export async function handleGatewayCommand(text: string, deps: GatewayCommandDeps): Promise<string | null> {
  if (isGreeting(text)) {
    return "Halo! Ada yang bisa PANSA bantu? Pakai tombol di bawah, atau kirim /status untuk ringkasan dan /help untuk daftar perintah.";
  }
  const cmd = text.trim().split(/\s+/)[0];
  if (cmd === "/help") {
    return [
      "Perintah PANSA:",
      "/status — ringkasan doctor (node, config, daemon, scheduler, gateway)",
      "/schedule — tugas terjadwal yang masih pending",
      "/alerts — price alert yang masih aktif",
      "/provider — provider & model dari daemon (tanpa kirim API key)",
      "/wallet — daftar & buat dompet (hanya pemilik; kunci tidak pernah dikirim lewat chat)",
      "/wallet set-password — atur password dompet (dipakai semua dompet, wajib sebelum export)",
      "/wallet export <nama> — kirim file keystore terenkripsi (perlu password dompet)",
      "Pesan lain diteruskan ke agen PANSA. Konfirmasi transaksi hanya di TUI/CLI.",
    ].join("\n");
  }
  if (cmd === "/pair") {
    return "Pairing sudah tidak dipakai. Bot ini hanya untuk pemilik — akses diatur lewat CLI (`pansa gateway allow <id>`).";
  }
  if (cmd === "/wallet") {
    const usage = [
      "Dompet — perintah:",
      "/wallet list — daftar dompet",
      "/wallet create <rantai> <nama> — buat dompet baru (evm, solana, sui, aptos)",
      "/wallet set-password — atur password dompet (dipakai semua dompet)",
      "/wallet export <nama> — kirim file keystore terenkripsi (EVM; perlu password dompet)",
      "Nama: huruf kecil, angka, - dan _, maks 32 karakter. Private key/mnemonic tidak pernah dikirim lewat chat.",
    ].join("\n");
    try {
      const args = text.trim().split(/\s+/).slice(1);
      if (args[0] === "list" && args.length === 1) {
        const wallets = await deps.walletList();
        if (!wallets.length) return "Dompet: (kosong)";
        return ["Dompet:", ...wallets.map((w) => `${w.name} | ${w.family} | ${w.address}`)].join("\n");
      }
      if (args[0] === "set-password" && args.length === 1) {
        // The password itself arrives as the NEXT free-text message and
        // is consumed by onAgentText — never by the agent, never into
        // history. If a password already exists, the old one is asked
        // first (so a chat compromise alone cannot silently reset it).
        const step = hasWalletPassword() ? "old" : "new";
        setWalletPending(deps.chatId, {
          kind: "set-password",
          step,
          attempts: 0,
          expiresAt: Date.now() + WALLET_PENDING_TTL_MS,
        });
        return step === "old"
          ? "Kirim password dompet LAMA dulu (5 menit). Pesan ini tidak diteruskan ke agent dan tidak disimpan di riwayat."
          : "Kirim password dompet BARU (min 8 karakter, dipakai semua dompet). Pesan ini tidak diteruskan ke agent dan tidak disimpan di riwayat.";
      }
      if (args[0] === "export" && args.length === 2) {
        const name = args[1];
        if (!hasWalletPassword()) {
          return "Belum ada password dompet. Atur dulu: /wallet set-password";
        }
        const wallets = await deps.walletList();
        if (!wallets.some((w) => w.name === name)) {
          return `Dompet tidak ditemukan: ${name}`;
        }
        setWalletPending(deps.chatId, {
          kind: "export",
          step: "password",
          walletName: name,
          attempts: 0,
          expiresAt: Date.now() + WALLET_PENDING_TTL_MS,
        });
        return `Kirim password dompet untuk export ${name} (5 menit, maks 3 percobaan). Pesan ini tidak diteruskan ke agent dan tidak disimpan di riwayat.`;
      }
      if (args[0] === "create" && args.length === 3) {
        const chain = args[1];
        const name = args[2];
        if (!["evm", "solana", "sui", "aptos"].includes(chain)) return usage;
        // First-creation rule, enforced for both paths: no wallet can be
        // made before the shared wallet password exists.
        if (!hasWalletPassword()) {
          return "Belum ada password dompet. Atur dulu: /wallet set-password — password ini dipakai semua dompet dan wajib dimasukkan setiap export.";
        }
        const w = await deps.walletCreate(chain, name);
        return [
          "Dompet dibuat:",
          `Nama: ${w.name}`,
          `Rantai: ${w.family}`,
          `Alamat: ${w.address}`,
          "Private key/mnemonic tidak dikirim lewat chat — tersimpan terenkripsi di keystore.",
          "Untuk file keystore-nya: /wallet export " + w.name,
        ].join("\n");
      }
      return usage;
    } catch (err) {
      return `Perintah wallet gagal: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (cmd === "/status") return deps.doctorText();
  if (cmd === "/schedule") return deps.scheduleText();
  if (cmd === "/alerts") return deps.alertText();
  if (cmd === "/provider") return deps.providerText();
  return null;
}

export interface GatewayCallbackDeps {
  doctorText: () => Promise<string>;
  scheduleText: () => string;
  alertText: () => string;
  listModels: () => Promise<string[]>;
  pinnedModel: () => string | undefined;
  setModel: (id: string) => void;
  confirmText: string;
  allowedCount: number;
}

// Button taps route through the same deterministic handlers as the
// text commands (plus model pinning, which only writes the owner's own
// config). Unknown button data returns null (ignored).
export async function handleGatewayCallback(
  data: string,
  deps: GatewayCallbackDeps,
): Promise<{ text: string; keyboard?: InlineKeyboardMarkup } | null> {
  if (data === "menu") return { text: "Menu PANSA — pilih:", keyboard: mainMenuKeyboard() };
  if (data === "settings") {
    return {
      text: [
        "⚙️ Settings gateway:",
        `Model terkunci: ${deps.pinnedModel() ?? "(tidak ada — daemon memilih)"}`,
        `Konfirmasi via gateway: ${deps.confirmText}`,
        `User ID terdaftar: ${deps.allowedCount}`,
        "Tanda tangan tidak pernah lewat bot; konfirmasi tetap di TUI/CLI.",
      ].join("\n"),
      keyboard: settingsKeyboard(),
    };
  }
  if (data === "model") {
    const models = await deps.listModels().catch((): string[] => []);
    return {
      text: modelPageText(models, deps.pinnedModel(), 0),
      keyboard: modelKeyboard(models, deps.pinnedModel(), 0),
    };
  }
  if (data.startsWith("modelpage:")) {
    const page = Number(data.slice("modelpage:".length));
    const models = await deps.listModels().catch((): string[] => []);
    return {
      text: modelPageText(models, deps.pinnedModel(), Number.isFinite(page) ? page : 0),
      keyboard: modelKeyboard(models, deps.pinnedModel(), Number.isFinite(page) ? page : 0),
    };
  }
  if (data.startsWith("model:")) {
    const id = data.slice("model:".length);
    if (!id) return null;
    // Never pin a model that is not on the current switchable list: a
    // crafted callback must not lock the agent to a dead model.
    const models = await deps.listModels().catch((): string[] => []);
    if (!models.includes(id)) {
      return { text: `Model tidak ada di daftar yang bisa dipilih. Buka tombol Model lagi untuk daftar terbaru.`, keyboard: mainMenuKeyboard() };
    }
    deps.setModel(id);
    return { text: `Model gateway dikunci ke: ${id}\nJawaban agen berikutnya memakai model ini.`, keyboard: mainMenuKeyboard() };
  }
  if (data === "provider") {
    const models = await deps.listModels().catch((): string[] => []);
    return {
      text: [
        "➕ Provider & model:",
        `Model yang bisa dipilih bot: ${models.length} (daemon + provider custom aktif)`,
        `Model terkunci: ${deps.pinnedModel() ?? "(tidak ada — daemon memilih)"}`,
        "Kelola provider lewat dashboard PANSA (bukan lewat chat).",
        "API key tidak boleh dikirim lewat Telegram — tambah provider lewat dashboard.",
        "Untuk mengganti model yang dipakai bot, pakai tombol Model.",
      ].join("\n"),
      keyboard: mainMenuKeyboard(),
    };
  }
  if (data === "status") return { text: await deps.doctorText(), keyboard: mainMenuKeyboard() };
  if (data === "schedule") return { text: deps.scheduleText(), keyboard: mainMenuKeyboard() };
  if (data === "alerts") return { text: deps.alertText(), keyboard: mainMenuKeyboard() };
  if (data === "help") {
    return {
      text: [
        "Perintah PANSA:",
        "/status — ringkasan doctor (node, config, daemon, scheduler, gateway)",
        "/schedule — tugas terjadwal yang masih pending",
        "/alerts — price alert yang masih aktif",
        "/provider — provider & model dari daemon (tanpa kirim API key)",
        "Pesan lain diteruskan ke agen PANSA. Konfirmasi transaksi hanya di TUI/CLI.",
      ].join("\n"),
      keyboard: mainMenuKeyboard(),
    };
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runGatewayLoop(opts: {
  bot: TelegramBot;
  allowedUsers?: () => number[];
  onAgentText: (userId: number, chatId: number, text: string) => Promise<{ text: string; keyboard?: ReplyMarkup }>;
  onCallback: (userId: number, chatId: number, data: string) => Promise<{ text: string; keyboard?: InlineKeyboardMarkup } | null>;
  signal: AbortSignal;
}): Promise<void> {
  // Concurrency: the poll loop must never block behind one slow agent
  // run (e.g. the owner messaging from two chats at once). Agent actions
  // run concurrently, but with two guards: (1) per-chat chains, so one
  // chat's answers never arrive out of order; (2) a global cap, so a
  // burst cannot pile up unbounded parallel LLM runs. Offset still
  // advances in poll order at dispatch time, so concurrent handling can
  // never replay an update. Non-agent actions (replies, callbacks) stay
  // inline: they are fast, and their order is the poll order.
  const MAX_CONCURRENT_AGENTS = 4;
  const chatChains = new Map<number, Promise<void>>();
  let activeAgents = 0;
  const agentWaiters: Array<() => void> = [];
  async function acquireAgentSlot(): Promise<void> {
    if (activeAgents < MAX_CONCURRENT_AGENTS) {
      activeAgents++;
      return;
    }
    await new Promise<void>((resolve) => agentWaiters.push(resolve));
    activeAgents++;
  }
  function releaseAgentSlot(): void {
    activeAgents--;
    const next = agentWaiters.shift();
    if (next) next();
  }
  async function handleAction(action: GatewayAction): Promise<void> {
    try {
      if (action.kind === "reply") {
        await opts.bot.sendMessage(action.chatId, action.text, action.keyboard);
      } else if (action.kind === "callback") {
        // Dismiss the spinner first, then route the button.
        try {
          await opts.bot.answerCallbackQuery(action.callbackId);
        } catch {
          // A failed dismiss must not block the button's answer.
        }
        const res = await opts.onCallback(action.userId, action.chatId, action.data).catch(() => null);
        if (res) await opts.bot.sendMessage(action.chatId, res.text, res.keyboard);
      } else if (action.kind === "agent") {
        // Typing indicator while the agent works: Telegram shows it
        // ~5s, so refresh every 4s until the answer is sent.
        const typing = setInterval(() => {
          opts.bot.sendChatAction(action.chatId, "typing").catch(() => {});
        }, 4000);
        try {
          await opts.bot.sendChatAction(action.chatId, "typing").catch(() => {});
          // First served message from this user: send the connect
          // template once, then the actual answer.
          try {
            if (markUserSeen(action.userId)) {
              await opts.bot.sendMessage(action.chatId, connectTemplate(), mainReplyKeyboard());
            }
          } catch {
            // A template failure must not block the answer.
          }
          const answer = await opts.onAgentText(action.userId, action.chatId, action.text);
          await opts.bot.sendMessage(action.chatId, answer.text, answer.keyboard);
        } finally {
          clearInterval(typing);
        }
      }
    } catch (err) {
      // A failed send must not kill the loop; the next poll continues.
      // But it must be logged: silent send failures are invisible.
      console.error(`Gateway kirim gagal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let offset: number | undefined;
  while (!opts.signal.aborted) {
    let updates: TelegramUpdate[];
    try {
      updates = await opts.bot.getUpdates(offset, 5);
    } catch (err) {
      if (opts.signal.aborted) break;
      // Never swallow polling errors silently: a wedged loop looks
      // exactly like a dead bot, so the failure must reach the log.
      console.error(`Gateway poll gagal: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(2000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const action = handleTelegramUpdate(u, opts.allowedUsers?.() ?? []);
      if (action.kind === "ignore") continue;
      if (action.kind === "agent") {
        const prev = chatChains.get(action.chatId) ?? Promise.resolve();
        const task = prev.then(async () => {
          await acquireAgentSlot();
          try {
            await handleAction(action);
          } finally {
            releaseAgentSlot();
          }
        });
        // A chain must never break on a task failure: handleAction logs
        // its own errors, and this catch guards the unexpected.
        const guarded = task.catch((err) => {
          console.error(`Gateway tugas agen gagal: ${err instanceof Error ? err.message : String(err)}`);
        });
        chatChains.set(action.chatId, guarded);
        void guarded.then(() => {
          if (chatChains.get(action.chatId) === guarded) chatChains.delete(action.chatId);
        });
        continue;
      }
      await handleAction(action);
    }
  }
  // Graceful shutdown finishes answers already started instead of
  // dropping them; no new tasks can arrive once polling stopped.
  await Promise.allSettled([...chatChains.values()]);
}
