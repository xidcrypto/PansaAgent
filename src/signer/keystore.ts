import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { encrypt, decrypt } from "../crypto.js";
import { zeroize } from "../zeroize.js";
import { KEYSTORE_DIR, WALLETS_FILE } from "../config.js";

export type ChainFamily = "evm" | "solana" | "sui" | "aptos";

const NAME_RE = /^[a-z0-9_-]{1,32}$/;

export interface KeystoreEntry {
  name: string;
  family: ChainFamily;
  path: string;
  createdAt: string;
  encrypted: ReturnType<typeof encrypt>;
}

export interface WalletRecord {
  name: string;
  family: ChainFamily;
  address: string;
  path: string;
  createdAt: string;
}

export function ensureKeystoreDir(): void {
  mkdirSync(KEYSTORE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(KEYSTORE_DIR, 0o700);
}

export function keystorePath(name: string): string {
  return join(KEYSTORE_DIR, `${name}.json`);
}

export function validateName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid wallet name: ${name} (use ^[a-z0-9_-]{1,32}$)`);
  }
}

export function keystoreCreate(
  name: string,
  family: ChainFamily,
  mnemonic: string,
  path: string,
  passphrase: string,
): void {
  validateName(name);
  ensureKeystoreDir();
  if (existsSync(keystorePath(name))) {
    throw new Error(`wallet already exists: ${name}`);
  }
  const payload = Buffer.from(JSON.stringify({ family, mnemonic, path }), "utf8");
  const encrypted = encrypt(payload, passphrase);
  zeroize(payload);
  const entry: KeystoreEntry = {
    name,
    family,
    path,
    createdAt: new Date().toISOString(),
    encrypted,
  };
  const tmp = keystorePath(name) + ".tmp";
  writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
  renameSync(tmp, keystorePath(name));
  chmodSync(keystorePath(name), 0o600);
}

export function keystoreRead(name: string): KeystoreEntry {
  validateName(name);
  if (!existsSync(keystorePath(name))) {
    throw new Error(`wallet not found: ${name}`);
  }
  return JSON.parse(readFileSync(keystorePath(name), "utf8")) as KeystoreEntry;
}

export function keystoreUnlock(name: string, passphrase: string): {
  family: ChainFamily;
  mnemonic: string;
  path: string;
} {
  const entry = keystoreRead(name);
  const plaintext = decrypt(entry.encrypted, passphrase);
  const parsed = JSON.parse(plaintext.toString("utf8")) as {
    family: ChainFamily;
    mnemonic: string;
    path: string;
  };
  zeroize(plaintext);
  return parsed;
}

export function keystoreList(): string[] {
  ensureKeystoreDir();
  return readdirSync(KEYSTORE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
}

export function keystoreRemove(name: string): void {
  validateName(name);
  if (!existsSync(keystorePath(name))) return;
  const fd = openSync(keystorePath(name), "r+");
  const buf = Buffer.alloc(256, 0);
  try {
    writeSync(fd, buf, 0, buf.length, 0);
  } catch {
    // ignore
  } finally {
    closeSync(fd);
  }
  unlinkSync(keystorePath(name));
}

export function walletRegistryLoad(): WalletRecord[] {
  if (!existsSync(WALLETS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(WALLETS_FILE, "utf8")) as { wallets?: WalletRecord[] };
    return data.wallets ?? [];
  } catch {
    return [];
  }
}

export function walletRegistrySave(wallets: WalletRecord[]): void {
  const d = dirname(WALLETS_FILE);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(WALLETS_FILE, JSON.stringify({ wallets }, null, 2), { mode: 0o600 });
  chmodSync(WALLETS_FILE, 0o600);
}

export function walletRegistryAdd(record: WalletRecord): void {
  const existing = walletRegistryLoad();
  if (existing.find((w) => w.name === record.name)) return;
  existing.push(record);
  walletRegistrySave(existing);
}
