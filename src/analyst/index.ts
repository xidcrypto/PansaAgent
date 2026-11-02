// Analyst: read-only on-chain audit of a token or contract, packaged as a
// skill and a CLI command. It answers the question the manual audits used
// to answer by hand: can this trap funds, and can the user still exit.
//
// Read-only by construction: the adapter only exposes eth_call, getCode
// and getStorageAt, plus public Sourcify and Dexscreener reads. No signing,
// no approvals, no transactions. Every check that cannot be answered is
// reported as unknown, never filled with a guess. A verdict of CLEAR still
// does not promise a price outcome; it only means no trap was found.

export interface AnalystRpc {
  getCode(address: string): Promise<string | undefined>;
  call(to: string, data: string): Promise<string>;
  getStorageAt(address: string, slot: string): Promise<string>;
}

export type CheckStatus = "ok" | "warn" | "bad" | "unknown";

export interface AnalystCheck {
  check: string;
  status: CheckStatus;
  detail: string;
}

export type AnalystVerdict = "CLEAR" | "CAUTION" | "TRAP" | "UNVERIFIED";

export interface AnalystReport {
  address: string;
  implementation?: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
  owner?: string;
  ownerIsContract?: boolean;
  renounced?: boolean;
  blacklisted?: boolean;
  paused?: boolean;
  tradingEnabled?: boolean;
  verification?: "full" | "partial" | "unverified" | "unknown";
  priceUsd?: number;
  liquidityUsd?: number;
  volumeH24?: number;
  pairCount?: number;
  verdict: AnalystVerdict;
  checks: AnalystCheck[];
  notes: string[];
}

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// View selectors, verified against keccak256 of the signature.
const SEL_NAME = "0x06fdde03";
const SEL_SYMBOL = "0x95d89b41";
const SEL_DECIMALS = "0x313ce567";
const SEL_SUPPLY = "0x18160ddd";
const SEL_OWNER = "0x8da5cb5b";
const SEL_PAUSED = "0x5c975abb";
const SEL_TRADING = "0x4ada218b";
// Blacklist view names seen in the wild, tried in order. The first one
// that answers with a 32-byte word wins; reverts mean "no such function".
const SEL_BLACKLIST = ["0xfe575a87", "0xdbac26e9", "0x333e99db"];

function padAddress(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return "0x" + clean.padStart(64, "0");
}

function decodeUint(data: string): string | undefined {
  try {
    const hex = data.startsWith("0x") ? data.slice(2) : data;
    if (hex.length < 64) return undefined;
    return BigInt(`0x${hex.slice(0, 64)}`).toString();
  } catch {
    return undefined;
  }
}

function decodeBool(data: string): boolean | undefined {
  const raw = decodeUint(data);
  if (raw === undefined) return undefined;
  return raw !== "0";
}

function decodeAddress(data: string): string | undefined {
  try {
    const hex = data.startsWith("0x") ? data.slice(2) : data;
    if (hex.length < 64) return undefined;
    return "0x" + hex.slice(24, 64);
  } catch {
    return undefined;
  }
}

function decodeAbiString(data: string): string | undefined {
  try {
    const hex = data.startsWith("0x") ? data.slice(2) : data;
    if (hex.length < 128) return undefined;
    const len = parseInt(hex.slice(64, 128), 16);
    if (!Number.isFinite(len) || len <= 0 || hex.length < 128 + len * 2) return undefined;
    return Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8");
  } catch {
    return undefined;
  }
}

async function tryCall(rpc: AnalystRpc, to: string, data: string): Promise<string | undefined> {
  try {
    const res = await rpc.call(to, data);
    if (res === "0x" || res === "") return undefined;
    return res;
  } catch {
    return undefined;
  }
}

async function sourcifyStatus(
  address: string,
  chainId: number | undefined,
  fetchFn: typeof fetch,
): Promise<AnalystReport["verification"]> {
  if (chainId === undefined) return "unknown";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    // Sourcify v2 (singular /contract/): 200 with match fields when
    // verified, 404 with null matches when not. The v1 check-by-addresses
    // path was removed and returns 404 for every address, which must not
    // be mistaken for "unverified" evidence either way.
    const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=creationMatch,runtimeMatch`;
    const res = await fetchFn(url, { signal: ctrl.signal });
    if (res.status === 404) return "unverified";
    if (!res.ok) return "unknown";
    const data = (await res.json()) as { match?: unknown; creationMatch?: unknown; runtimeMatch?: unknown };
    if (data.match === "match" || (data.creationMatch === "match" && data.runtimeMatch === "match")) return "full";
    if (data.match === "partial" || data.creationMatch === "partial" || data.runtimeMatch === "partial") return "partial";
    return "unverified";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

interface DexRow {
  priceUsd?: number;
  liquidityUsd?: number;
  volumeH24?: number;
  pairCount?: number;
}

async function dexscreenerRow(address: string, fetchFn: typeof fetch): Promise<DexRow> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { signal: ctrl.signal });
    if (!res.ok) return {};
    const data = (await res.json()) as {
      pairs?: Array<{ priceUsd?: string; liquidity?: { usd?: number }; volume?: { h24?: number } }>;
    };
    const pairs = data.pairs ?? [];
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
    };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

export async function analyzeContract(
  address: string,
  rpc: AnalystRpc,
  opts: { wallet?: string; chainId?: number; fetchFn?: typeof fetch } = {},
): Promise<AnalystReport> {
  const fetchFn = opts.fetchFn ?? fetch;
  const checks: AnalystCheck[] = [];
  const notes: string[] = [];
  const report: AnalystReport = { address, verdict: "UNVERIFIED", checks, notes };

  const code = await rpc.getCode(address).catch(() => undefined);
  if (!code || code === "0x") {
    checks.push({ check: "bytecode", status: "bad", detail: "Alamat ini bukan kontrak (tidak ada bytecode)." });
    report.verdict = "UNVERIFIED";
    notes.push("Bukan kontrak: tidak ada yang bisa diaudit di alamat ini.");
    return report;
  }
  checks.push({ check: "bytecode", status: "ok", detail: "Kontrak ada (bytecode ditemukan)." });

  // Proxy resolution: judge the implementation, not the shell.
  try {
    const slot = await rpc.getStorageAt(address, EIP1967_IMPL_SLOT);
    const impl = decodeAddress(slot);
    if (impl && impl !== ZERO_ADDRESS) {
      report.implementation = impl;
      checks.push({ check: "proxy", status: "warn", detail: `Proxy EIP-1967 ke implementasi ${impl}. Penilaian owner/trap berlaku untuk implementasi.` });
    }
  } catch {
    // Storage unreadable: proxy state stays unknown, not assumed absent.
    checks.push({ check: "proxy", status: "unknown", detail: "Slot implementasi tidak bisa dibaca; status proxy tidak diketahui." });
  }

  // Identity views, read through the proxy (delegatecall serves them).
  const nameRaw = await tryCall(rpc, address, SEL_NAME);
  if (nameRaw) report.name = decodeAbiString(nameRaw);
  const symbolRaw = await tryCall(rpc, address, SEL_SYMBOL);
  if (symbolRaw) report.symbol = decodeAbiString(symbolRaw);
  const decimalsRaw = await tryCall(rpc, address, SEL_DECIMALS);
  if (decimalsRaw) {
    const d = decodeUint(decimalsRaw);
    if (d !== undefined) report.decimals = Number(d);
  }
  const supplyRaw = await tryCall(rpc, address, SEL_SUPPLY);
  if (supplyRaw) report.totalSupply = decodeUint(supplyRaw);

  // Owner power: the single most important trap signal.
  const ownerRaw = await tryCall(rpc, address, SEL_OWNER);
  const owner = ownerRaw ? decodeAddress(ownerRaw) : undefined;
  if (owner === undefined) {
    checks.push({ check: "owner", status: "unknown", detail: "Fungsi owner() tidak menjawab; kekuasaan owner tidak bisa dinilai." });
  } else if (owner === ZERO_ADDRESS) {
    report.owner = owner;
    report.renounced = true;
    checks.push({ check: "owner", status: "ok", detail: "Ownership renounced (owner = alamat nol)." });
  } else {
    report.owner = owner;
    report.renounced = false;
    const ownerCode = await rpc.getCode(owner).catch(() => undefined);
    report.ownerIsContract = !!ownerCode && ownerCode !== "0x";
    checks.push({
      check: "owner",
      status: "warn",
      detail: `Owner aktif: ${owner} (${report.ownerIsContract ? "kontrak, mungkin multisig/timelock" : "akun eksternal, kendali penuh"}).`,
    });
  }

  // Transfer switches.
  const pausedRaw = await tryCall(rpc, address, SEL_PAUSED);
  const paused = pausedRaw ? decodeBool(pausedRaw) : undefined;
  if (paused !== undefined) {
    report.paused = paused;
    checks.push({
      check: "paused",
      status: paused ? "bad" : "ok",
      detail: paused ? "Kontrak sedang paused: transfer dibekukan." : "Kontrak tidak paused.",
    });
  } else {
    checks.push({ check: "paused", status: "unknown", detail: "Fungsi paused() tidak ada atau tidak menjawab." });
  }
  const tradingRaw = await tryCall(rpc, address, SEL_TRADING);
  const trading = tradingRaw ? decodeBool(tradingRaw) : undefined;
  if (trading !== undefined) {
    report.tradingEnabled = trading;
    checks.push({
      check: "trading",
      status: trading ? "ok" : "bad",
      detail: trading ? "Trading aktif." : "Trading belum aktif: token belum bisa berpindah.",
    });
  }

  // Blacklist for the user's wallet, when one is given.
  if (opts.wallet) {
    let blacklisted: boolean | undefined;
    for (const sel of SEL_BLACKLIST) {
      const raw = await tryCall(rpc, address, sel + padAddress(opts.wallet).slice(2));
      if (raw) {
        blacklisted = decodeBool(raw);
        break;
      }
    }
    if (blacklisted !== undefined) {
      report.blacklisted = blacklisted;
      checks.push({
        check: "blacklist",
        status: blacklisted ? "bad" : "ok",
        detail: blacklisted
          ? `Wallet ${opts.wallet} TERBLACKLIST: tidak bisa transfer/jual sama sekali.`
          : `Wallet ${opts.wallet} tidak terblacklist.`,
      });
    } else {
      checks.push({ check: "blacklist", status: "unknown", detail: "Tidak ada fungsi blacklist yang menjawab; status blacklist wallet tidak diketahui." });
    }
  } else {
    checks.push({ check: "blacklist", status: "unknown", detail: "Tidak ada wallet yang diberikan; blacklist tidak dicek." });
  }

  // Verification and market, best-effort and always labeled.
  report.verification = await sourcifyStatus(address, opts.chainId, fetchFn);
  checks.push({
    check: "verification",
    status: report.verification === "full" ? "ok" : report.verification === "partial" ? "warn" : report.verification === "unverified" ? "warn" : "unknown",
    detail:
      report.verification === "full"
        ? "Sourcify: exact match."
        : report.verification === "partial"
          ? "Sourcify: partial match."
          : report.verification === "unverified"
            ? "Sourcify: source tidak terverifikasi; perilaku kode tidak bisa dipastikan."
            : "Verifikasi Sourcify tidak bisa dicek.",
  });
  const dex = await dexscreenerRow(address, fetchFn);
  report.priceUsd = dex.priceUsd;
  report.liquidityUsd = dex.liquidityUsd;
  report.volumeH24 = dex.volumeH24;
  report.pairCount = dex.pairCount;
  if (dex.liquidityUsd !== undefined) {
    checks.push({
      check: "liquidity",
      status: dex.liquidityUsd > 0 ? "ok" : "bad",
      detail: `Likuiditas pool terbesar: $${dex.liquidityUsd.toLocaleString("en-US")} (${dex.pairCount ?? 0} pair).`,
    });
  } else {
    checks.push({ check: "liquidity", status: "unknown", detail: "Tidak ada data likuiditas dari Dexscreener." });
  }
  notes.push("Tax, limit maxTx/maxWallet, dan fungsi privileged lain tidak bisa dibaca secara generik (nama fungsi bervariasi per kontrak); bila source terverifikasi, baca source untuk melengkapi. Quote harga bukan bukti sell berhasil.");

  // Verdict: traps override everything; unknowns cap the verdict at CAUTION.
  if (report.blacklisted === true || report.paused === true || report.tradingEnabled === false) {
    report.verdict = "TRAP";
  } else if (
    report.renounced === true &&
    report.verification === "full" &&
    report.paused === false &&
    (report.blacklisted === false || opts.wallet === undefined) &&
    (report.liquidityUsd ?? 0) > 0
  ) {
    report.verdict = "CLEAR";
  } else if (report.owner === undefined && report.verification === "unknown") {
    report.verdict = "UNVERIFIED";
  } else {
    report.verdict = "CAUTION";
  }
  return report;
}

export function formatAnalystReport(report: AnalystReport): string {
  const lines: string[] = [
    `Analyst: ${report.address}`,
    report.implementation ? `Implementasi (proxy): ${report.implementation}` : "Proxy: tidak terdeteksi sebagai EIP-1967 (atau tidak bisa dibaca).",
    report.name !== undefined || report.symbol !== undefined
      ? `Token: ${report.name ?? "?"} (${report.symbol ?? "?"})`
      : "Token: identitas tidak terbaca.",
    report.decimals !== undefined ? `Desimal: ${report.decimals}` : "Desimal: tidak terbaca.",
    report.totalSupply !== undefined ? `Total supply (raw): ${report.totalSupply}` : "Total supply: tidak terbaca.",
    report.owner !== undefined
      ? `Owner: ${report.owner}${report.renounced ? " (renounced)" : report.ownerIsContract ? " (kontrak)" : " (akun eksternal)"}`
      : "Owner: tidak terbaca.",
    report.verification !== undefined ? `Verifikasi Sourcify: ${report.verification}` : "Verifikasi Sourcify: tidak dicek.",
    report.priceUsd !== undefined ? `Harga (Dexscreener): $${report.priceUsd}` : "Harga: tidak ada data.",
    report.liquidityUsd !== undefined ? `Likuiditas: $${report.liquidityUsd.toLocaleString("en-US")}` : "Likuiditas: tidak ada data.",
    `Verdict: ${report.verdict}`,
  ];
  for (const c of report.checks) {
    const mark = c.status === "ok" ? "✓" : c.status === "bad" ? "✗" : c.status === "warn" ? "!" : "?";
    lines.push(`  ${mark} ${c.check} — ${c.detail}`);
  }
  for (const n of report.notes) lines.push(`Catatan: ${n}`);
  return lines.join("\n");
}
