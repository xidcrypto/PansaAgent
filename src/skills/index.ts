import { SkillsManager, Skill } from "./manager.js";
import { scamCheck } from "../research/index.js";
import { createTrackerTool, createReportTool } from "../tracker/tools.js";
import { createSignTool } from "../signer/tools.js";
import { analyzeContract } from "../analyst/index.js";
import type { AnalystRpc } from "../analyst/index.js";
import { resolveScoutTarget } from "../scout/index.js";
import { resolveEvmRpc, evmPublicClient } from "../evm-rpc.js";

// Scout Skill - NOT IMPLEMENTED. There is no on-chain scanning in this
// codebase, so scout honestly reports that instead of returning a stub
// "low risk" verdict (B13).
class ScoutSkill implements Skill {
	name = "scout";
	description = "Scan blockchain for opportunities and analyze risk (not implemented)";
	parameters = {
		chain: { type: "string" },
		min_value: { type: "number" },
		only_testnet: { type: "boolean" },
	};

	async execute(_args: Record<string, unknown>) {
		return { ok: false, data: null, error: "Scout is not implemented: no on-chain scanning exists yet. Use scam_check for text/transaction screening." };
	}
}

// ScamCheck Skill - delegates to the real heuristic checker.
class ScamCheckSkill implements Skill {
	name = "scam_check";
	description = "Check text or transaction for scam patterns";
	parameters = {
		text: { type: "string" },
		strict: { type: "boolean" },
	};

	async execute(args: Record<string, unknown>) {
		const { text, strict: _strict = false } = args;
		const result = scamCheck(String(text));
		return { ok: true, data: result };
	}
}

// Tracker Skill - delegates to the real tracker tool (SQLite-backed).
class TrackerSkill implements Skill {
	name = "tracker";
	description = "Track tasks, progress, and status";
	parameters = {
		action: { type: "string" }, // 'create', 'update', 'list', 'get', 'remove', 'summary'
		task_id: { type: "string" },
		title: { type: "string" },
		description: { type: "string" },
		status: { type: "string" },
	};

	async execute(args: Record<string, unknown>) {
		return createTrackerTool().execute(args);
	}
}

// Report Skill - delegates to the real report tool (SQLite-backed).
class ReportSkill implements Skill {
	name = "report";
	description = "Generate reports and summaries";
	parameters = {
		type: { type: "string" },
		period: { type: "string" },
		include_data: { type: "boolean" },
	};

	async execute(args: Record<string, unknown>) {
		return createReportTool().execute(args);
	}
}

// Testnet Skill - creates a REAL pending confirmation through the sign
// flow (human confirmation + broadcast required). Never fabricates a hash.
class TestnetSkill implements Skill {
	name = "testnet";
	description = "Perform operations on testnets via the human-confirmed sign flow";
	parameters = {
		chain: { type: "string" },
		action: { type: "string" }, // informational only; the call is a plain transfer/call
		from_wallet: { type: "string" },
		to: { type: "string" },
		amount: { type: "string" },
		data: { type: "string" },
	};

	async execute(args: Record<string, unknown>) {
		const { chain, from_wallet, to, amount, data } = args as {
			chain?: string; from_wallet?: string; to?: string; amount?: string; data?: string;
		};
		if (!chain || !from_wallet || !to) {
			return { ok: false, data: null, error: "testnet requires chain, from_wallet and to" };
		}
		return createSignTool().execute({
			chain,
			from_wallet,
			to,
			value: amount,
			data,
		});
	}
}

// Mint Skill - a mint is a contract call. It goes through the same
// human-confirmed sign flow and requires explicit calldata; without it
// there is nothing honest to broadcast, so it errors instead of faking
// a token URI or a minted flag (B13).
class MintSkill implements Skill {
	name = "mint";
	description = "Mint via an explicit contract call through the human-confirmed sign flow";
	parameters = {
		contract_address: { type: "string" },
		from_wallet: { type: "string" },
		to: { type: "string" },
		token_id: { type: "string" },
		amount: { type: "string" },
		data: { type: "string" },
	};

	async execute(args: Record<string, unknown>) {
		const { contract_address, from_wallet, data } = args as {
			contract_address?: string; from_wallet?: string; data?: string;
		};
		if (!contract_address) {
			return { ok: false, data: null, error: "mint requires contract_address" };
		}
		if (!from_wallet) {
			return { ok: false, data: null, error: "mint requires from_wallet (the signing wallet name)" };
		}
		if (!data) {
			return { ok: false, data: null, error: "mint requires data (the encoded mint calldata). PANSA does not guess mint ABIs; pass the exact calldata for the mint call." };
		}
		return createSignTool().execute({
			chain: "evm",
			from_wallet,
			to: contract_address,
			data,
		});
	}
}

// Analyst Skill - delegates to the real on-chain analyst module. Read-only:
// it never signs or moves funds. It needs a configured EVM RPC and fails
// closed without one, instead of returning a guessed verdict.
class AnalystSkill implements Skill {
	name = "analyst";
	description = "Audit a token or contract from on-chain evidence (proxy, owner, blacklist, pause, verification, liquidity) and return a CLEAR, CAUTION, TRAP, or UNVERIFIED verdict";
	parameters = {
		address: { type: "string" },
		wallet: { type: "string" },
	};

	async execute(args: Record<string, unknown>) {
		const target = String(args.address ?? args.target ?? "");
		if (!target) return { ok: false, data: null, error: "Butuh address kontrak (atau URL proyek)." };
		const resolved = await resolveScoutTarget(target).catch(() => null);
		if (!resolved) return { ok: false, data: null, error: "Target tidak dapat diurai: butuh alamat kontrak 0x… atau URL proyek." };
		const rpcUrl = resolveEvmRpc();
		if (!rpcUrl) return { ok: false, data: null, error: "RPC EVM tidak terkonfigurasi (set PANSA_EVM_RPC atau config)." };
		const client = await evmPublicClient(rpcUrl);
		const rpc: AnalystRpc = {
			getCode: (address: string) => client.getCode({ address: address as `0x${string}` }),
			call: async (to: string, data: string) => {
				const res = await client.call({ to: to as `0x${string}`, data: data as `0x${string}` });
				return res.data ?? "0x";
			},
			getStorageAt: async (address: string, slot: string) =>
				(await client.getStorageAt({ address: address as `0x${string}`, slot: slot as `0x${string}` })) ?? "0x",
		};
		const chainId = await client.getChainId().catch(() => undefined);
		const wallet = typeof args.wallet === "string" && args.wallet ? args.wallet : undefined;
		const report = await analyzeContract(resolved.address, rpc, { wallet, chainId });
		return { ok: true, data: report };
	}
}

// Export skills manager instance
const skillsManager = new SkillsManager();

// Register built-in skills
skillsManager.register(new ScoutSkill());
skillsManager.register(new AnalystSkill());
skillsManager.register(new ScamCheckSkill());
skillsManager.register(new TrackerSkill());
skillsManager.register(new ReportSkill());
skillsManager.register(new TestnetSkill());
skillsManager.register(new MintSkill());

export default skillsManager;
export { SkillsManager };
