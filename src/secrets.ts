import Database from "better-sqlite3";
import { mkdirSync, readFileSync, existsSync, unlinkSync, chmodSync } from "node:fs";
import { encrypt, decrypt, EncryptedPayload } from "./crypto.js";
import { zeroize } from "./zeroize.js";
import { DB_FILE, SECRETS_FILE, PANSA_DIR } from "./config.js";

export interface SecretsStore {
  [key: string]: string;
}

// Semua kredensial — token bot Telegram, callback key, kunci API provider
// custom, dan secret lain — tinggal di SQLite (tabel `secrets` di DB_FILE),
// BUKAN lagi di secrets.json. Nilai di tabel tetap terenkripsi per-nilai
// (AES-256-GCM + scrypt, format yang sama dengan file lama), jadi file DB
// saja tidak membocorkan secret. Yang TIDAK pindah, sesuai permintaan:
// registry provider (nama/baseUrl/model/enabled) dan daftar model tetap di
// config.json; hanya kredensial yang pindah ke SQLite. (Keystore dompet
// adalah subsistem terpisah dan tidak diubah.)

function withDb<T>(fn: (db: Database) => T): T {
  if (!existsSync(PANSA_DIR)) mkdirSync(PANSA_DIR, { recursive: true, mode: 0o700 });
  const db = new Database(DB_FILE);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`);
    return fn(db);
  } finally {
    db.close();
  }
}

export function ensureSecretsDb(): void {
  withDb(() => {});
  try {
    chmodSync(DB_FILE, 0o600);
  } catch {
    // Bila file dipakai proses lain / FS read-only, biarkan pemanggil yang gagal.
  }
}

function looksEncrypted(value: string): boolean {
  try {
    const p = JSON.parse(value) as Partial<EncryptedPayload>;
    return typeof p === "object" && p !== null &&
      typeof p.ciphertext === "string" &&
      typeof p.iv === "string" &&
      typeof p.tag === "string" &&
      typeof p.salt === "string";
  } catch {
    return false;
  }
}

function decryptStore(rows: Array<{ key: string; value: string }>, passphrase: string): SecretsStore {
  const out: SecretsStore = {};
  for (const { key, value } of rows) {
    if (looksEncrypted(value)) {
      // Fail hard: decrypt throws on a wrong passphrase instead of
      // silently returning ciphertext as the "value".
      const payload = JSON.parse(value) as EncryptedPayload;
      const plain = decrypt(payload, passphrase);
      out[key] = plain.toString("utf8");
      zeroize(plain);
    } else {
      // Plaintext legacy value, kept as-is.
      out[key] = value;
    }
  }
  return out;
}

// Migrasi satu kali dari secrets.json lama. Urutan sengaja: baca + dekripsi
// semua nilai dulu (gagal keras bila passphrase salah — file lama TIDAK
// dihapus), tulis ke SQLite, verifikasi baca-ulang, baru hapus file lama.
// Idempotent: bila proses mati di tengah, migrasi berikutnya mengulang
// dengan aman (nilai SQLite yang sudah ada dipertahankan).
function migrateLegacyFile(passphrase: string): void {
  if (!existsSync(SECRETS_FILE)) return;
  const raw = JSON.parse(readFileSync(SECRETS_FILE, "utf8")) as { [key: string]: unknown };
  const plain: SecretsStore = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      plain[key] = String(value);
      continue;
    }
    if (looksEncrypted(value)) {
      const payload = JSON.parse(value) as EncryptedPayload;
      const buf = decrypt(payload, passphrase);
      plain[key] = buf.toString("utf8");
      zeroize(buf);
    } else {
      plain[key] = value;
    }
  }
  withDb((db) => {
    const upsert = db.prepare(
      "INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
    );
    for (const [key, value] of Object.entries(plain)) {
      upsert.run(key, JSON.stringify(encrypt(Buffer.from(value, "utf8"), passphrase)));
    }
  });
  const back = withDb((db) =>
    decryptStore(db.prepare("SELECT key, value FROM secrets").all() as Array<{ key: string; value: string }>, passphrase),
  );
  for (const [key, value] of Object.entries(plain)) {
    if (back[key] !== value) throw new Error(`Migrasi secrets gagal verifikasi untuk kunci "${key}"`);
  }
  unlinkSync(SECRETS_FILE);
}

export function secretsLoad(passphrase: string): SecretsStore {
  ensureSecretsDb();
  migrateLegacyFile(passphrase);
  return withDb((db) =>
    decryptStore(db.prepare("SELECT key, value FROM secrets").all() as Array<{ key: string; value: string }>, passphrase),
  );
}

export function secretsSave(store: SecretsStore, passphrase: string): void {
  ensureSecretsDb();
  withDb((db) => {
    const upsert = db.prepare(
      "INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const del = db.prepare("DELETE FROM secrets WHERE key = ?");
    const existing = (db.prepare("SELECT key FROM secrets").all() as Array<{ key: string }>).map((r) => r.key);
    for (const key of existing) {
      if (!(key in store)) del.run(key);
    }
    for (const [key, value] of Object.entries(store)) {
      upsert.run(key, JSON.stringify(encrypt(Buffer.from(value, "utf8"), passphrase)));
    }
  });
  // Store di SQLite kini otoritatif; semua pemanggil load dulu sebelum
  // save, jadi tidak ada kredensial yang hilang dari file lama.
  if (existsSync(SECRETS_FILE)) unlinkSync(SECRETS_FILE);
}

export function secretsGet(store: SecretsStore, key: string): string | undefined {
  return store[key];
}

export function secretsSet(store: SecretsStore, key: string, value: string): void {
  store[key] = value;
}
