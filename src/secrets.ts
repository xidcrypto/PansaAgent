import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { encrypt, decrypt, EncryptedPayload } from "./crypto.js";
import { zeroize } from "./zeroize.js";
import { SECRETS_FILE } from "./config.js";

export interface SecretsStore {
  [key: string]: string;
}

export function ensureSecretsFile(): void {
  const d = dirname(SECRETS_FILE);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  if (!existsSync(SECRETS_FILE)) {
    writeFileSync(SECRETS_FILE, JSON.stringify({}, null, 2), { mode: 0o600 });
    chmodSync(SECRETS_FILE, 0o600);
  }
}

export function secretsLoad(passphrase: string): SecretsStore {
  ensureSecretsFile();
  const raw = JSON.parse(readFileSync(SECRETS_FILE, "utf8")) as { [key: string]: unknown };
  const out: SecretsStore = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      try {
        const payload = JSON.parse(value) as EncryptedPayload;
        const plain = decrypt(payload, passphrase);
        out[key] = plain.toString("utf8");
        zeroize(plain);
      } catch {
        // not encrypted or wrong passphrase -> keep as-is? No, skip
        out[key] = String(value);
      }
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

export function secretsSave(store: SecretsStore, passphrase: string): void {
  ensureSecretsFile();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(store)) {
    const payload = encrypt(Buffer.from(value, "utf8"), passphrase);
    out[key] = JSON.stringify(payload);
  }
  writeFileSync(SECRETS_FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
  chmodSync(SECRETS_FILE, 0o600);
}

export function secretsGet(store: SecretsStore, key: string): string | undefined {
  return store[key];
}

export function secretsSet(store: SecretsStore, key: string, value: string): void {
  store[key] = value;
}
