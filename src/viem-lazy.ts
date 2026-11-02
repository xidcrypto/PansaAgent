// Lazy viem loader. Importing viem statically costs ~2s on cold start
// (large ESM graph), which would blow the <250ms --help budget for a
// command that never touches a chain. No module may import viem
// statically: anything needing it awaits loadViem()/loadViemAccounts()
// once, and the --help path never pays that cost.
let viemMod: typeof import("viem") | null = null;
let accountsMod: typeof import("viem/accounts") | null = null;

export async function loadViem(): Promise<typeof import("viem")> {
  if (!viemMod) viemMod = await import("viem");
  return viemMod;
}

export async function loadViemAccounts(): Promise<typeof import("viem/accounts")> {
  if (!accountsMod) accountsMod = await import("viem/accounts");
  return accountsMod;
}
