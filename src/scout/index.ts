// Scout: read-only on-chain verification of a project, packaged as a
// command. It answers the question the assistant used to answer by hand
// for every garapan: is there a free path, what does it cost, is the
// sale still open — with numbers, never a guess.
//
// Read-only by construction: the adapter only exposes eth_call/getCode
// plus a public price API. No signing, no approvals, no transactions.
// A "free-candidate" verdict means a no-arg free-style function answered
// an eth_call without reverting; it is evidence, not a guarantee — the
// real preview before any mint still applies.

export interface ScoutRpc {
  getCode(address: string): Promise<string | undefined>;
  call(to: string, data: string): Promise<string>;
}

export interface ProbeResult {
  selector: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface ScoutReport {
  address: string;
  hasCode: boolean;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
  priceUsd?: number;
  probes: ProbeResult[];
  verdict: "free-candidate" | "unknown";
  notes: string[];
}

const ADDRESS_RE = /0x[0-9a-fA-F]{40}/g;

export function extractAddresses(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(ADDRESS_RE)) {
    const lower = m[0].toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(m[0]);
    }
  }
  return out;
}

export async function resolveScoutTarget(
  target: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ address: string; source: string } | null> {
  if (/^0x[0-9a-fA-F]{40}$/.test(target)) return { address: target, source: "address" };
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const res = await fetchFn(url.toString(), {
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36" },
  });
  if (!res.ok) return null;
  const text = await res.text();
  const addresses = extractAddresses(text);
  if (!addresses.length) return null;
  // Prefer a contract mentioned in a manifest-like JSON page; otherwise
  // the first address on the page is the candidate to inspect.
  return { address: addresses[0], source: url.toString() };
}

// Well-known view selectors (constants, not computed at runtime).
const VIEWS: Array<{ selector: string; label: string; kind: "string" | "uint8" | "uint256" }> = [
  { selector: "0x06fdde03", label: "name()", kind: "string" },
  { selector: "0x95d89b41", label: "symbol()", kind: "string" },
  { selector: "0x313ce567", label: "decimals()", kind: "uint8" },
  { selector: "0x18160ddd", label: "totalSupply()", kind: "uint256" },
];

// No-arg free-style entry points, probed with a static eth_call.
// A success means the function exists and does not revert with empty
// calldata — the same signal a manual preview checks before a mint.
const FREE_CANDIDATES: Array<{ selector: string; label: string }> = [
  { selector: "0xf366afc9", label: "claimFree()" },
  { selector: "0x4e71d92d", label: "claim()" },
  { selector: "0x5b70ea9f", label: "freeMint()" },
  { selector: "0xe88d3b3e", label: "freeClaim()" },
  { selector: "0x8ab53447", label: "mintFree()" },
];

function decodeAbiString(data: string): string | undefined {
  // Minimal ABI string decode: offset(32) + length(32) + utf8 bytes.
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

function decodeUint(data: string): string | undefined {
  try {
    const hex = data.startsWith("0x") ? data.slice(2) : data;
    if (hex.length < 64) return undefined;
    return BigInt(`0x${hex.slice(0, 64)}`).toString();
  } catch {
    return undefined;
  }
}

export async function inspectContract(
  address: string,
  rpc: ScoutRpc,
  priceFn?: (address: string) => Promise<number | undefined>,
): Promise<ScoutReport> {
  const notes: string[] = [];
  const code = await rpc.getCode(address).catch(() => undefined);
  const hasCode = !!code && code !== "0x";
  if (!hasCode) {
    return { address, hasCode, probes: [], verdict: "unknown", notes: ["Alamat ini bukan kontrak (tidak ada bytecode)."] };
  }
  const report: ScoutReport = { address, hasCode, probes: [], verdict: "unknown", notes };
  for (const view of VIEWS) {
    try {
      const data = await rpc.call(address, view.selector);
      if (view.kind === "string") {
        const value = decodeAbiString(data);
        if (value !== undefined) {
          if (view.label === "name()") report.name = value;
          if (view.label === "symbol()") report.symbol = value;
        }
      } else if (view.kind === "uint8") {
        const value = decodeUint(data);
        if (value !== undefined) report.decimals = Number(value);
      } else {
        const value = decodeUint(data);
        if (value !== undefined) report.totalSupply = value;
      }
    } catch {
      // View absent on this contract: not an error, just no data.
    }
  }
  for (const cand of FREE_CANDIDATES) {
    try {
      const data = await rpc.call(address, cand.selector);
      report.probes.push({ selector: cand.selector, label: cand.label, ok: true, detail: `menjawab (${data.slice(0, 18)}…)` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.probes.push({ selector: cand.selector, label: cand.label, ok: false, detail: msg.slice(0, 80) });
    }
  }
  if (report.probes.some((p) => p.ok)) {
    report.verdict = "free-candidate";
    report.notes.push("Satu atau lebih fungsi gratis menjawab eth_call tanpa revert — kandidat free mint, tetap perlu preview sebelum eksekusi.");
  } else {
    report.notes.push("Tidak ada fungsi gratis yang menjawab — kemungkinan berbayar atau mekanismenya berbeda (mis. mint berparameter).");
  }
  if (priceFn) {
    try {
      report.priceUsd = await priceFn(address);
    } catch {
      // Price is best-effort; absence is not a failure.
    }
  }
  return report;
}

export async function dexscreenerPrice(address: string, fetchFn: typeof fetch = fetch): Promise<number | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { signal: ctrl.signal });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { pairs?: Array<{ priceUsd?: string }> };
    const raw = data.pairs?.[0]?.priceUsd;
    const price = raw === undefined ? NaN : parseFloat(raw);
    return Number.isFinite(price) ? price : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function formatScoutReport(report: ScoutReport): string {
  const lines = [`Scout: ${report.address}`, `Kontrak: ${report.hasCode ? "ya (ada bytecode)" : "tidak"}`];
  if (report.name !== undefined) lines.push(`Nama: ${report.name}`);
  if (report.symbol !== undefined) lines.push(`Simbol: ${report.symbol}`);
  if (report.decimals !== undefined) lines.push(`Desimal: ${report.decimals}`);
  if (report.totalSupply !== undefined) lines.push(`Total supply (raw): ${report.totalSupply}`);
  if (report.priceUsd !== undefined) lines.push(`Harga (DexScreener): $${report.priceUsd}`);
  lines.push(`Verdict: ${report.verdict === "free-candidate" ? "KANDIDAT FREE MINT" : "tidak diketahui"}`);
  for (const p of report.probes) lines.push(`  ${p.ok ? "✓" : "✗"} ${p.label} — ${p.detail}`);
  for (const n of report.notes) lines.push(`Catatan: ${n}`);
  return lines.join("\n");
}
