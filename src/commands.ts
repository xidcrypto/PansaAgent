export type Command =
  | { kind: "wallet_create"; chain: string; name?: string }
  | { kind: "wallet_set"; chain: string; name?: string }
  | { kind: "wallet_list" }
  | { kind: "wallet_use"; name: string }
  | { kind: "wallet_unlock"; name: string }
  | { kind: "wallet_lock"; name: string }
  | { kind: "balance"; chain?: string }
  | { kind: "help" }
  | { kind: "unknown"; input: string };

const WALLET_CREATE = /^\s*(evm|solana|sui|aptos)\s+wallet(?:\s+(?:create\s+)?([a-z0-9_-]{1,32}))?\s*$/i;
const WALLET_SET = /^\s*(evm|solana|sui|aptos)\s+wallet(?:\s+([a-z0-9_-]{1,32}))?\s*$/i;
const WALLET_LIST = /^\s*wallet\s+list\s*$/i;
const WALLET_USE = /^\s*wallet\s+use\s+([a-z0-9_-]{1,32})\s*$/i;
const WALLET_UNLOCK = /^\s*wallet\s+unlock\s+([a-z0-9_-]{1,32})\s*$/i;
const WALLET_LOCK = /^\s*wallet\s+lock\s+([a-z0-9_-]{1,32})\s*$/i;
const WALLET_CREATE_EXPLICIT = /^\s*wallet\s+create\s+(evm|solana|sui|aptos)\s+([a-z0-9_-]{1,32})\s*$/i;
const BALANCE = /^\s*balance(?:\s+([a-z]+))?\s*$/i;
const HELP = /^\s*(help|--help|-h)\s*$/i;

export function matchCommand(input: string): Command {
  const m = WALLET_CREATE_EXPLICIT.exec(input);
  if (m) return { kind: "wallet_create", chain: m[1], name: m[2] };
  const m2 = WALLET_CREATE.exec(input);
  if (m2) return { kind: "wallet_create", chain: m2[1], name: m2[2] ?? undefined };
  if (WALLET_LIST.test(input)) return { kind: "wallet_list" };
  const m3 = WALLET_USE.exec(input);
  if (m3) return { kind: "wallet_use", name: m3[1] };
  const mUnlock = WALLET_UNLOCK.exec(input);
  if (mUnlock) return { kind: "wallet_unlock", name: mUnlock[1] };
  const mLock = WALLET_LOCK.exec(input);
  if (mLock) return { kind: "wallet_lock", name: mLock[1] };
  const m4 = WALLET_SET.exec(input);
  if (m4) return { kind: "wallet_set", chain: m4[1], name: m4[2] ?? undefined };
  const m5 = BALANCE.exec(input);
  if (m5) return { kind: "balance", chain: m5[1] ?? undefined };
  if (HELP.test(input)) return { kind: "help" };
  return { kind: "unknown", input };
}

export function formatHelp(): string {
  return `PANSA - crypto airdrop agent

Dompet:
  evm wallet [nama]       pilih/buat dompet EVM
  solana wallet [nama]    pilih/buat dompet Solana
  sui wallet [nama]       pilih/buat dompet Sui
  aptos wallet [nama]     pilih/buat dompet Aptos
  wallet create <rantai> <nama>  buat dompet baru (mnemonik acak)
  wallet list             daftar dompet
  wallet use <nama>       gunakan dompet default
  wallet unlock <nama>    unlock dompet untuk sesi ini (15 menit)
  wallet lock <nama>      lock dompet
  balance [rantai]        lihat saldo

  pansa --help            bantuan ini
`;
}
