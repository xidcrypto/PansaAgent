import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_FILE } from "../config.js";
import { redact } from "../redact.js";

export interface ScheduledTask {
  id: string;
  prompt: string;
  run_at: string;
  status: "pending" | "done" | "failed" | "cancelled";
  created_at: string;
  last_run_at: string | null;
  last_result: string | null;
}

let db: InstanceType<typeof Database> | null = null;

export function schedulerDb(): InstanceType<typeof Database> {
  if (!db) {
    mkdirSync(dirname(DB_FILE), { recursive: true });
    db = new Database(DB_FILE);
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        run_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_run_at TEXT,
        last_result TEXT
      );
    `);
  }
  return db;
}

export function scheduleTask(prompt: string, runAt: string): ScheduledTask {
  const id = `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const stmt = schedulerDb().prepare(`INSERT INTO scheduled_tasks (id, prompt, run_at, status) VALUES (?, ?, ?, 'pending')`);
  stmt.run(id, redact(prompt), runAt);
  return getScheduledTask(id) as ScheduledTask;
}

export function getScheduledTask(id: string): ScheduledTask | null {
  const row = schedulerDb().prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as ScheduledTask | undefined;
  return row ?? null;
}

export function listScheduled(status?: string): ScheduledTask[] {
  const rows = status
    ? (schedulerDb().prepare(`SELECT * FROM scheduled_tasks WHERE status = ? ORDER BY run_at`).all(status) as ScheduledTask[])
    : (schedulerDb().prepare(`SELECT * FROM scheduled_tasks ORDER BY run_at`).all() as ScheduledTask[]);
  return rows;
}

export function cancelScheduled(id: string): boolean {
  const info = schedulerDb().prepare(`UPDATE scheduled_tasks SET status = 'cancelled' WHERE id = ? AND status = 'pending'`).run(id) as { changes: number };
  return info.changes > 0;
}

export function dueTasks(nowIso: string): ScheduledTask[] {
  return schedulerDb().prepare(`SELECT * FROM scheduled_tasks WHERE status = 'pending' AND run_at <= ? ORDER BY run_at`).all(nowIso) as ScheduledTask[];
}

// Run every due task through the executor. The executor is injectable:
// production passes a headless Agent run; tests pass a stub. A task that
// throws is marked failed (never retried silently), and its redacted
// error is stored as last_result.
export async function runDue(
  executor: (prompt: string) => Promise<string>,
  nowIso: string = new Date().toISOString(),
): Promise<ScheduledTask[]> {
  const due = dueTasks(nowIso);
  for (const task of due) {
    const stamp = new Date().toISOString();
    try {
      const result = await executor(task.prompt);
      schedulerDb().prepare(`UPDATE scheduled_tasks SET status = 'done', last_run_at = ?, last_result = ? WHERE id = ?`).run(stamp, redact(String(result)).slice(0, 500), task.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      schedulerDb().prepare(`UPDATE scheduled_tasks SET status = 'failed', last_run_at = ?, last_result = ? WHERE id = ?`).run(stamp, redact(msg).slice(0, 500), task.id);
    }
  }
  return due;
}
