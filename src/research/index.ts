export function scamCheck(text: string): { ok: boolean; signs: boolean[]; risks: string[] } {
  const signs: string[] = [];
  const lower = text.toLowerCase();

  const patterns: Array<[string, RegExp]> = [
    ["phishing", /connect\s+wallet|seed phrase|recovery phrase|private key|claim reward/i],
    ["rug-pull", /renounced ownership|dev wallet|liquidity removed|dumped/i],
    ["token-dump", /dump|sell all|exit liquidity|whale dump/i],
    ["sybil", /multiple accounts|fake wallets|bot network|sybil/i],
    ["airdrop-scam", /click here|limited time|act now|free tokens|airdrop link/i],
  ];

  let scamLikely = false;
  for (const [label, re] of patterns) {
    if (re.test(lower)) {
      signs.push(label);
      scamLikely = true;
    }
  }

  const risks: string[] = [];
  if (scamLikely) {
    risks.push("Treat as DANGER — do not connect wallet or sign transactions");
  }

  return { ok: !scamLikely, signs: signs.map(() => true), risks };
}

export function researchTopic(query: string): string {
  return `Research topic: ${query}. Use available skills to gather information.`;
}

export function researchAirdrop(campaign: string): string {
  return `Researching airdrop campaign: ${campaign}. Verify legitimacy before interacting.`;
}
