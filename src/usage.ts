// LLM usage tracking: tokens in/out per provider+model, plus a cost
// estimate when a price is known. Writes never break a chat: every
// failure is swallowed (fail-open). Reads never create tables, so a
// dashboard status read cannot write to disk.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_FILE } from "./config.js";

export interface UsageEntry {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageByModel {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Null when no price is known for the model: cost is unknown, never guessed. */
  costUsd: number | null;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Sum of known costs only; unknown-cost calls contribute 0 here. */
  costUsd: number;
  byModel: UsageByModel[];
}

// Price per 1M tokens, USD. Best-effort snapshot for well-known models;
// anything absent here reports cost as unknown, never as zero (except
// models explicitly marked free by their id suffix).
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-3-5": { input: 0.8, output: 4 },
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
};

export function priceForModel(model: string): { input: number; output: number } | null {
  if (model.endsWith("-free") || model.endsWith(":free")) return { input: 0, output: 0 };
  return MODEL_PRICES[model] ?? null;
}

export function costForUsage(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = priceForModel(model);
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

function openDb(): Database | null {
  try {
    mkdirSync(dirname(DB_FILE), { recursive: true });
    const db = new Database(DB_FILE);
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  } catch {
    return null;
  }
}

export function recordUsage(entry: UsageEntry): void {
  if (entry.inputTokens <= 0 && entry.outputTokens <= 0) return;
  let db: Database | null = null;
  try {
    db = openDb();
    if (!db) return;
    db.exec(
      `CREATE TABLE IF NOT EXISTS llm_usage (
        ts INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL
      )`,
    );
    const cost = costForUsage(entry.model, entry.inputTokens, entry.outputTokens);
    db.prepare(
      "INSERT INTO llm_usage (ts, provider, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(Date.now(), entry.provider, entry.model, entry.inputTokens, entry.outputTokens, cost);
  } catch {
    // Usage tracking never breaks a chat.
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

export function getUsageTotals(limitModels = 50): UsageTotals {
  const empty: UsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, byModel: [] };
  let db: Database | null = null;
  try {
    db = openDb();
    if (!db) return empty;
    const total = db
      .prepare(
        "SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(cost_usd), 0) AS costUsd FROM llm_usage",
      )
      .get() as { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
    const rows = db
      .prepare(
        `SELECT provider, model, COUNT(*) AS calls, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens
         FROM llm_usage GROUP BY provider, model ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC LIMIT ?`,
      )
      .all(limitModels) as Array<{ provider: string; model: string; calls: number; inputTokens: number; outputTokens: number }>;
    const byModel: UsageByModel[] = rows.map((r) => {
      const cost = costForUsage(r.model, r.inputTokens, r.outputTokens);
      return {
        provider: r.provider,
        model: r.model,
        calls: r.calls,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        totalTokens: r.inputTokens + r.outputTokens,
        costUsd: cost,
      };
    });
    return {
      calls: total.calls,
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      totalTokens: total.inputTokens + total.outputTokens,
      costUsd: total.costUsd,
      byModel,
    };
  } catch {
    return empty;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}
