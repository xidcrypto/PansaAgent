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
  statSync,
  fsyncSync,
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

// Default derivation path per chain family. Shared by the CLI
// (pansa <chain> wallet) and the TUI (/wallet new).
export function defaultPath(chain: string): string {
  switch (chain) {
    case "evm": return "m/44'/60'/0'/0/0";
    case "solana": return "m/44'/501'/0'/0'";
    case "sui": return "m/44'/784'/0'/0'/0'";
    case "aptos": return "m/44'/637'/0'/0'/0'";
    default: return "m/44'/60'/0'/0/0";
  }
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
  // A .json file counts as a wallet only if it parses AND matches the
  // keystore shape (name == filename, known family, encrypted blob).
  // Stray .json files in the directory are ignored (D4).
  const families: ChainFamily[] = ["evm", "solana", "sui", "aptos"];
  const out: string[] = [];
  for (const f of readdirSync(KEYSTORE_DIR)) {
    if (!f.endsWith(".json")) continue;
    const name = f.slice(0, -5);
    if (!NAME_RE.test(name)) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(KEYSTORE_DIR, f), "utf8")) as Partial<KeystoreEntry>;
      if (parsed.name !== name) continue;
      if (!parsed.family || !families.includes(parsed.family)) continue;
      const enc = parsed.encrypted;
      if (!enc || typeof enc.ciphertext !== "string" || typeof enc.iv !== "string" ||
          typeof enc.tag !== "string" || typeof enc.salt !== "string") continue;
      out.push(name);
    } catch {
      // Unparseable files are not wallets.
    }
  }
  return out;
}

export function keystoreRemove(name: string): void {
  validateName(name);
  const path = keystorePath(name);
  if (!existsSync(path)) return;
  // Best-effort overwrite of the ENTIRE file (not just the first 256
  // bytes), then unlink. This is not a secure-erase guarantee: on SSDs,
  // journaling filesystems and copy-on-write stores, old blocks may
  // survive. The old code's 256-byte overwrite claimed more than it did.
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r+");
    try {
      const chunk = Buffer.alloc(Math.min(size, 65536), 0);
      let written = 0;
      while (written < size) {
        const n = Math.min(chunk.length, size - written);
        writeSync(fd, chunk, 0, n, written);
        written += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Overwrite is best-effort; unlink still proceeds.
  }
  unlinkSync(path);
  // Drop the public registry record too, so a removed wallet does not
  // linger in listings.
  try {
    const remaining = walletRegistryLoad().filter((w) => w.name !== name);
    walletRegistrySave(remaining);
  } catch {
    // ignore registry cleanup failures
  }
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
  // Dedupe by name OR by family+address: the same wallet must not appear
  // twice under two names, and a name must not be reused for another wallet.
  if (existing.find((w) => w.name === record.name || (w.family === record.family && w.address === record.address))) return;
  existing.push(record);
  walletRegistrySave(existing);
}
