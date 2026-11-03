import Database from "better-sqlite3";
import { createHmac, timingSafeEqual } from "node:crypto";
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
  async setBotCommands(): Promise<void> {
    await this.api("setMyCommands", {
      commands: [
        { command: "start", description: "Mulai dan info koneksi" },
        { command: "help", description: "Daftar perintah PANSA" },
        { command: "status", description: "Ringkasan doctor" },
        { command: "schedule", description: "Tugas terjadwal yang pending" },
        { command: "alerts", description: "Price alert yang aktif" },
        { command: "provider", description: "Provider & model dari daemon" },
      ],
    });
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
  doctorText: () => Promise<string>;
  scheduleText: () => string;
  alertText: () => string;
  providerText: () => Promise<string>;
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

// Deterministic gateway commands: answered without an LLM call (fast,
// no model cost). Anything else falls through to the agent (null).
// /balance and /portfolio are intentionally NOT deterministic here: the
// gateway agent has no wallet tool (baw never reaches the gateway), so
// the agent answers honestly that it cannot read balances via the bot.
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
      "Pesan lain diteruskan ke agen PANSA. Konfirmasi transaksi hanya di TUI/CLI.",
    ].join("\n");
  }
  if (cmd === "/pair") {
    return "Pairing sudah tidak dipakai. Bot ini hanya untuk pemilik — akses diatur lewat CLI (`pansa gateway allow <id>`).";
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
