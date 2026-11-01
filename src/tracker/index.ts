import Database from "better-sqlite3";
import { PANSA_DIR } from "../config.js";
import { existsSync, mkdirSync } from "node:fs";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: "low" | "medium" | "high";
  chain?: string;
  campaign?: string;
  deadline?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export class Tracker {
  private db: Database;

  constructor() {
    const dbPath = `${PANSA_DIR}/tracker.db`;
    if (!existsSync(PANSA_DIR)) {
      mkdirSync(PANSA_DIR, { recursive: true, mode: 0o700 });
    }
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'pending',
        priority TEXT DEFAULT 'medium',
        chain TEXT,
        campaign TEXT,
        deadline TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
      CREATE INDEX IF NOT EXISTS idx_tasks_campaign ON tasks(campaign);
    `);
  }

  createTask(task: Omit<Task, "id" | "created_at" | "updated_at">): Task {
    const id = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, chain, campaign, deadline, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, task.title, task.description, task.status, task.priority, task.chain, task.campaign, task.deadline, now, now);
    return { ...task, id, created_at: now, updated_at: now };
  }

  getTask(id: string): Task | undefined {
    const stmt = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    return stmt.get(id) as Task | undefined;
  }

  updateTask(id: string, updates: Partial<Task>): Task | undefined {
    const existing = this.getTask(id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && key !== "id" && key !== "created_at") {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }
    if (fields.length === 0) return existing;

    fields.push(`updated_at = ?`);
    values.push(new Date().toISOString());

    if (updates.status === "completed" && existing.status !== "completed") {
      fields.push(`completed_at = ?`);
      values.push(new Date().toISOString());
    }

    values.push(id);
    const stmt = this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
    return this.getTask(id);
  }

  removeTask(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM tasks WHERE id = ?`);
    const result = stmt.run(id) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  listTasks(filter?: { status?: TaskStatus; campaign?: string; chain?: string; pending?: boolean }): Task[] {
    let query = `SELECT * FROM tasks WHERE 1=1`;
    const params: string[] = [];

    if (filter?.status) {
      query += ` AND status = ?`;
      params.push(filter.status);
    }
    if (filter?.campaign) {
      query += ` AND campaign = ?`;
      params.push(filter.campaign);
    }
    if (filter?.chain) {
      query += ` AND chain = ?`;
      params.push(filter.chain);
    }
    if (filter?.pending) {
      query += ` AND status IN ('pending', 'in_progress')`;
    }

    query += ` ORDER BY deadline ASC, priority DESC, created_at DESC`;
    const stmt = this.db.prepare(query);
    return stmt.all(...params) as Task[];
  }

  getSummary(): { total: number; pending: number; in_progress: number; completed: number; failed: number; overdue: number } {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN deadline < ? AND status NOT IN ('completed', 'cancelled') THEN 1 ELSE 0 END) as overdue
      FROM tasks
    `);
    return stmt.get(now) as { total: number; pending: number; in_progress: number; completed: number; failed: number; overdue: number };
  }

  close(): void {
    this.db.close();
  }
}

export const tracker = new Tracker();
