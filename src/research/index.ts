export interface ScamCheckResult {
  ok: boolean;
  // Labels, not booleans: the caller needs to know WHICH signals fired.
  signs: string[];
  risks: string[];
  // Positive signals (e.g. renounced ownership) that argue against a scam.
  positives: string[];
  // The matched text for each fired signal, for auditability.
  evidence: string[];
  severity: "low" | "medium" | "high";
}

// Word-boundary patterns only: the old bare /dump/ matched "dumped" and
// "dumpster", and "connect wallet" / "free tokens" flagged every legit
// dApp and airdrop. "Renounced ownership" is a POSITIVE signal (the owner
// gave up control), not a rug-pull indicator.
const PATTERNS: Array<{ label: string; re: RegExp; severity: "medium" | "high" }> = [
  { label: "phishing", re: /\bseed phrase\b|\brecovery phrase\b|\bprivate key\b|\bmnemonic\b.{0,30}\b(share|send|enter|give|reveal)\b/i, severity: "high" },
  { label: "rug-pull", re: /\bliquidity removed\b|\brug.?pull\b|\bhoneypot\b/i, severity: "high" },
  { label: "token-dump", re: /\bwhale dump\b|\bexit liquidity\b|\bsell all\b|\bdump\b/i, severity: "medium" },
  { label: "sybil", re: /\bmultiple accounts\b|\bfake wallets\b|\bbot network\b|\bsybil\b/i, severity: "medium" },
  { label: "airdrop-scam", re: /\bclick here\b|\blimited time\b|\bact now\b/i, severity: "medium" },
];

const POSITIVES: Array<{ label: string; re: RegExp }> = [
  { label: "renounced ownership", re: /\brenounced ownership\b|\bownership renounced\b/i },
  { label: "liquidity locked", re: /\bliquidity locked\b/i },
  { label: "contract verified", re: /\bcontract verified\b/i },
];

export function scamCheck(text: string): ScamCheckResult {
  const signs: string[] = [];
  const evidence: string[] = [];
  let severity: "low" | "medium" | "high" = "low";

  for (const { label, re, severity: sev } of PATTERNS) {
    const m = re.exec(text);
    if (m) {
      signs.push(label);
      evidence.push(`${label}: "${m[0]}"`);
      if (sev === "high") severity = "high";
      else if (severity === "low") severity = "medium";
    }
  }

  const positives: string[] = [];
  for (const { label, re } of POSITIVES) {
    if (re.test(text)) positives.push(label);
  }

  const scamLikely = signs.length > 0;
  const risks: string[] = [];
  if (scamLikely) {
    risks.push("Treat as DANGER — do not connect wallet or sign transactions");
  }

  return { ok: !scamLikely, signs, risks, positives, evidence, severity };
}

export function researchTopic(query: string): string {
  return `Research topic: ${query}. Use available skills to gather information.`;
}

export function researchAirdrop(campaign: string): string {
  return `Researching airdrop campaign: ${campaign}. Verify legitimacy before interacting.`;
}

// Adapter exposing scamCheck as an agent Tool (single wiring: the agent
// uses Tools, not the SkillsManager registry).
export function createScamCheckTool(): import("../agent.js").Tool {
  return {
    name: "scam_check",
    description: "Check text or transaction for scam patterns",
    parameters: {
      text: { type: "string", description: "Content to analyze" },
      strict: { type: "boolean", description: "Strict mode (currently advisory only)" },
    },
    signs: false,
    async execute(args: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; error?: string; signs?: boolean }> {
      const { text } = args as { text?: string };
      if (!text) return { ok: false, data: null, error: "text required" };
      return { ok: true, data: scamCheck(String(text)), signs: false };
    },
  };
}
