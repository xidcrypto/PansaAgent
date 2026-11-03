// Solana audit: read-only, mirrors the EVM analyst verdicts.
// No @solana/web3.js dependency: raw Solana JSON-RPC plus a hand-rolled
// base58 codec (zero new dependencies). It answers the same question as
// the EVM analyst — can this trap funds, and can the user still exit —
// for SPL Token mints: freeze authority is the Solana equivalent of an
// EVM blacklist (any holder can be frozen), mint authority is the
// inflation switch. Every check that cannot be answered is reported as
// unknown, never filled with a guess.

import type { AnalystCheck, AnalystVerdict } from "./index.js";
import { resolveRpc } from "../rpc/index.js";

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array | undefined {
  let zeroes = 0;
  while (zeroes < s.length && s[zeroes] === "1") zeroes++;
  let num = 0n;
  for (const ch of s) {
    const digit = B58_ALPHABET.indexOf(ch);
    if (digit < 0) return undefined;
    num = num * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  return new Uint8Array([...new Array(zeroes).fill(0), ...bytes]);
}

export function base58Encode(bytes: Uint8Array): string {
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = "";
  while (num > 0n) {
    out = B58_ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  return "1".repeat(zeroes) + out;
}

// A Solana address is a 32-byte public key in base58 (32–44 chars).
export function isSolanaAddress(s: string): boolean {
  if (!s || s.length < 32 || s.length > 44) return false;
  const decoded = base58Decode(s);
  return decoded !== undefined && decoded.length === 32;
}

export interface SolanaMintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supplyRaw: string;
  decimals: number;
}

// SPL Token mint layout (base part, shared with Token-2022):
// mintAuthorityOption u32 @0, mintAuthority 32B @4, supply u64 @36,
// decimals u8 @44, isInitialized u8 @45, freezeAuthorityOption u32 @46,
// freezeAuthority 32B @50. Returns null when the data is too short.
export function parseMintAccount(data: Uint8Array): SolanaMintInfo | null {
  if (data.length < 82) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u32 = (off: number) => view.getUint32(off, true);
  const pubkey = (off: number) => base58Encode(data.slice(off, off + 32));
  return {
    mintAuthority: u32(0) === 1 ? pubkey(4) : null,
    supplyRaw: view.getBigUint64(36, true).toString(),
    decimals: data[44],
    freezeAuthority: u32(46) === 1 ? pubkey(50) : null,
  };
}

export interface SolanaAccountInfo {
  owner: string;
  data: Uint8Array;
}

export interface SolanaRpc {
  getAccountInfo(pubkey: string): Promise<SolanaAccountInfo | null>;
  getTokenSupply(mint: string): Promise<{ amount: string; decimals: number } | null>;
  getTokenLargestAccounts(mint: string): Promise<{ address: string; amount: string }[]>;
}

export function createSolanaRpc(rpcUrl: string, fetchFn: typeof fetch = fetch): SolanaRpc {
  async function request(method: string, params: unknown[]): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetchFn(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
      const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (json.error) throw new Error(`Solana RPC: ${json.error.message ?? "unknown error"}`);
      return json.result ?? null;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async getAccountInfo(pubkey: string) {
      const result = (await request("getAccountInfo", [pubkey, { encoding: "base64" }])) as {
        value: { owner: string; data: [string, string] } | null;
      } | null;
      const value = result?.value;
      if (!value || typeof value.data?.[0] !== "string") return null;
      return { owner: value.owner, data: new Uint8Array(Buffer.from(value.data[0], "base64")) };
    },
    async getTokenSupply(mint: string) {
      const result = (await request("getTokenSupply", [mint])) as {
        value: { amount: string; decimals: number };
      } | null;
      return result?.value ?? null;
    },
    async getTokenLargestAccounts(mint: string) {
      const result = (await request("getTokenLargestAccounts", [mint])) as {
        value: { address: string; amount: string }[];
      } | null;
      return result?.value ?? [];
    },
  };
}

// Solana has one mainnet, so a public default is pragmatic (rate-limited
// under heavy use; override with PANSA_SOLANA_RPC or config solanaRpc).
// Default is api.mainnet-beta.solana.com: publicnode blocks the indexed
// token methods (getTokenSupply/getTokenLargestAccounts) without a
// personal token, which would make every mint read UNVERIFIED.
export function resolveSolanaRpc(explicit?: string): string {
  return resolveRpc("solana", explicit) ?? "https://api.mainnet-beta.solana.com";
}

interface SolanaDexRow {
  priceUsd?: number;
  liquidityUsd?: number;
  volumeH24?: number;
  pairCount?: number;
  dexId?: string;
}

async function dexscreenerSolana(mint: string, fetchFn: typeof fetch): Promise<SolanaDexRow> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: ctrl.signal });
    if (!res.ok) return {};
    const data = (await res.json()) as {
      pairs?: Array<{
        chainId?: string;
        dexId?: string;
        priceUsd?: string;
        liquidity?: { usd?: number };
        volume?: { h24?: number };
      }>;
    };
    const all = data.pairs ?? [];
    const solana = all.filter((p) => p.chainId === "solana");
    const pairs = solana.length ? solana : all;
    if (!pairs.length) return { pairCount: 0 };
    let best = pairs[0];
    for (const p of pairs) {
      if ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
    }
    const price = best.priceUsd === undefined ? NaN : parseFloat(best.priceUsd);
    return {
      priceUsd: Number.isFinite(price) ? price : undefined,
      liquidityUsd: best.liquidity?.usd,
      volumeH24: best.volume?.h24,
      pairCount: pairs.length,
      dexId: best.dexId,
    };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

export interface SolanaReport {
  chain: "solana";
  address: string;
  program: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: string;
  decimals: number;
  topHolders: { address: string; sharePct: number }[];
  top1Pct?: number;
  top10Pct?: number;
  priceUsd?: number;
  liquidityUsd?: number;
  volumeH24?: number;
  pairCount?: number;
  dexId?: string;
  verdict: AnalystVerdict;
  checks: AnalystCheck[];
  notes: string[];
}

export async function analyzeSolanaMint(
  address: string,
  rpc: SolanaRpc,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<SolanaReport> {
  const fetchFn = opts.fetchFn ?? fetch;
  const checks: AnalystCheck[] = [];
  const notes: string[] = [];
  const report: SolanaReport = {
    chain: "solana",
    address,
    program: "",
    mintAuthority: null,
    freezeAuthority: null,
    supply: "",
    decimals: 0,
    topHolders: [],
    verdict: "UNVERIFIED",
    checks,
    notes,
  };

  const account = await rpc.getAccountInfo(address).catch(() => null);
  if (!account) {
    checks.push({ check: "mint", status: "bad", detail: "Akun tidak ditemukan di Solana mainnet." });
    notes.push("Bukan mint: tidak ada akun di alamat ini.");
    return report;
  }
  const parsed = parseMintAccount(account.data);
  if (!parsed) {
    checks.push({ check: "mint", status: "bad", detail: "Data akun kurang dari 82 byte — bukan mint SPL Token." });
    notes.push("Bukan mint: layout akun tidak cocok dengan mint SPL.");
    return report;
  }
  const supply = await rpc.getTokenSupply(address).catch(() => null);
  if (!supply) {
    checks.push({ check: "mint", status: "bad", detail: "getTokenSupply gagal — alamat ini bukan mint token." });
    notes.push("Bukan mint: getTokenSupply menolak alamat ini.");
    return report;
  }
  checks.push({ check: "mint", status: "ok", detail: "Mint SPL ditemukan." });
  report.program = account.owner;
  report.mintAuthority = parsed.mintAuthority;
  report.freezeAuthority = parsed.freezeAuthority;
  report.supply = supply.amount;
  report.decimals = supply.decimals;
  if (account.data.length > 82) {
    notes.push("Akun lebih dari 82 byte: ekstensi Token-2022 (bila ada, mis. transfer hook/fee) tidak diparse — di luar layout dasar ini.");
  }
  notes.push("Metadata (nama/simbol, update authority) tidak dibaca — audit ini fokus ke otoritas mint/freeze, holder, dan likuiditas.");
  notes.push("Likuiditas Dexscreener membuktikan ada pasar, bukan bukti LP terkunci/dibakar.");

  // Freeze authority: the Solana trap. Any holder can be frozen.
  if (parsed.freezeAuthority) {
    checks.push({
      check: "freeze",
      status: "bad",
      detail: `Freeze authority AKTIF: ${parsed.freezeAuthority} — saldo pemegang mana pun bisa dibekukan (setara blacklist EVM).`,
    });
  } else {
    checks.push({ check: "freeze", status: "ok", detail: "Tidak ada freeze authority: saldo tidak bisa dibekukan." });
  }

  // Mint authority: the inflation switch.
  if (parsed.mintAuthority) {
    checks.push({
      check: "mint-authority",
      status: "warn",
      detail: `Mint authority AKTIF: ${parsed.mintAuthority} — supply bisa ditambah sewaktu-waktu.`,
    });
  } else {
    checks.push({ check: "mint-authority", status: "ok", detail: "Mint authority dicabut: supply tidak bisa ditambah." });
  }

  // Holder concentration.
  const largest = await rpc.getTokenLargestAccounts(address).catch(() => []);
  let concentrated = false;
  if (largest.length) {
    try {
      const total = BigInt(supply.amount);
      if (total > 0n) {
        const pct = (amount: string) => Number((BigInt(amount) * 10000n) / total) / 100;
        const ranked = largest
          .map((h) => ({ address: h.address, sharePct: pct(h.amount) }))
          .sort((a, b) => b.sharePct - a.sharePct);
        report.topHolders = ranked.slice(0, 5);
        report.top1Pct = ranked[0]?.sharePct;
        report.top10Pct = ranked.slice(0, 10).reduce((sum, h) => sum + h.sharePct, 0);
        concentrated = (report.top1Pct ?? 0) > 50 || (report.top10Pct ?? 0) > 80;
        checks.push({
          check: "holders",
          status: concentrated ? "warn" : "ok",
          detail: concentrated
            ? `Konsentrasi tinggi: top 1 memegang ${report.top1Pct?.toFixed(2)}%, top 10 ${report.top10Pct?.toFixed(2)}% dari supply.`
            : `Top 1 memegang ${report.top1Pct?.toFixed(2)}%, top 10 ${report.top10Pct?.toFixed(2)}% dari supply.`,
        });
      }
    } catch {
      checks.push({ check: "holders", status: "unknown", detail: "Jumlah holder tidak bisa dihitung." });
    }
  } else {
    checks.push({ check: "holders", status: "unknown", detail: "Daftar holder tidak bisa dibaca." });
  }

  // Market.
  const dex = await dexscreenerSolana(address, fetchFn);
  report.priceUsd = dex.priceUsd;
  report.liquidityUsd = dex.liquidityUsd;
  report.volumeH24 = dex.volumeH24;
  report.pairCount = dex.pairCount;
  report.dexId = dex.dexId;
  if (dex.liquidityUsd !== undefined && dex.liquidityUsd > 0) {
    checks.push({
      check: "liquidity",
      status: "ok",
      detail: `Likuiditas $${dex.liquidityUsd.toLocaleString("en-US")} di ${dex.dexId ?? "Dexscreener"} (${dex.pairCount ?? 0} pair).`,
    });
  } else {
    checks.push({ check: "liquidity", status: "warn", detail: "Tidak ada likuiditas terdeteksi di Dexscreener." });
  }

  // Verdict: same discipline as the EVM analyst.
  if (parsed.freezeAuthority) {
    report.verdict = "TRAP";
  } else if (parsed.mintAuthority || concentrated || !(dex.liquidityUsd !== undefined && dex.liquidityUsd > 0)) {
    report.verdict = "CAUTION";
  } else {
    report.verdict = "CLEAR";
  }
  return report;
}

export function formatSolanaReport(report: SolanaReport): string {
  const lines: string[] = [
    `Analyst (Solana): ${report.address}`,
    report.program ? `Program: ${report.program}` : "Program: tidak terbaca.",
    report.supply !== "" ? `Supply (raw): ${report.supply} (desimal ${report.decimals})` : "Supply: tidak terbaca.",
    report.mintAuthority ? `Mint authority: ${report.mintAuthority} (AKTIF)` : "Mint authority: dicabut.",
    report.freezeAuthority ? `Freeze authority: ${report.freezeAuthority} (AKTIF)` : "Freeze authority: tidak ada.",
    report.top1Pct !== undefined ? `Holder: top 1 ${report.top1Pct.toFixed(2)}%, top 10 ${report.top10Pct?.toFixed(2)}%` : "Holder: tidak terbaca.",
    report.priceUsd !== undefined ? `Harga (Dexscreener): $${report.priceUsd}` : "Harga: tidak ada data.",
    report.liquidityUsd !== undefined
      ? `Likuiditas: $${report.liquidityUsd.toLocaleString("en-US")} (${report.dexId ?? "?"})`
      : "Likuiditas: tidak ada data.",
    `Verdict: ${report.verdict}`,
  ];
  for (const c of report.checks) {
    const mark = c.status === "ok" ? "✓" : c.status === "bad" ? "✗" : c.status === "warn" ? "!" : "?";
    lines.push(`  ${mark} ${c.check} — ${c.detail}`);
  }
  for (const n of report.notes) lines.push(`Catatan: ${n}`);
  return lines.join("\n");
}
