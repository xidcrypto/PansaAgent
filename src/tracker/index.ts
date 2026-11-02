import Database from "better-sqlite3";
import { DB_FILE, PANSA_DIR } from "../config.js";
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

const TASK_STATUSES: TaskStatus[] = ["pending", "in_progress", "completed", "failed", "cancelled"];
const TASK_PRIORITIES = ["low", "medium", "high"] as const;

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
  // Lazy init (M8): importing this module must not touch the disk, so
  // --help and other early paths stay side-effect free. The DB opens on
  // first use, at the single shared path DB_FILE.
  private db: Database | null = null;

  private ensureDb(): Database {
    if (this.db) return this.db;
    if (!existsSync(PANSA_DIR)) {
      mkdirSync(PANSA_DIR, { recursive: true, mode: 0o700 });
    }
    const db = new Database(DB_FILE);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
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
    this.db = db;
    return db;
  }

  createTask(task: Omit<Task, "id" | "created_at" | "updated_at">): Task {
    const db = this.ensureDb();
    const id = `task_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, chain, campaign, deadline, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, task.title, task.description, task.status, task.priority, task.chain, task.campaign, task.deadline, now, now);
    return { ...task, id, created_at: now, updated_at: now };
  }

  getTask(id: string): Task | undefined {
    const stmt = this.ensureDb().prepare(`SELECT * FROM tasks WHERE id = ?`);
    return stmt.get(id) as Task | undefined;
  }

  updateTask(id: string, updates: Partial<Task>): Task | undefined {
    const existing = this.getTask(id);
    if (!existing) return undefined;

    // Whitelist + enum validation: unknown keys and invalid enum values
    // are ignored, never interpolated into SQL (M-group hardening).
    const allowed = new Set(["title", "description", "status", "priority", "chain", "campaign", "deadline"]);
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || !allowed.has(key)) continue;
      if (key === "status" && !TASK_STATUSES.includes(value as TaskStatus)) continue;
      if (key === "priority" && !(TASK_PRIORITIES as readonly string[]).includes(value as string)) continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return existing;

    fields.push(`updated_at = ?`);
    values.push(new Date().toISOString());

    if (updates.status === "completed" && existing.status !== "completed") {
      fields.push(`completed_at = ?`);
      values.push(new Date().toISOString());
    }

    values.push(id);
    const stmt = this.ensureDb().prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
    return this.getTask(id);
  }

  removeTask(id: string): boolean {
    const stmt = this.ensureDb().prepare(`DELETE FROM tasks WHERE id = ?`);
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

    query += ` ORDER BY (deadline IS NULL), deadline ASC, priority DESC, created_at DESC`;
    const stmt = this.ensureDb().prepare(query);
    return stmt.all(...params) as Task[];
  }

  getSummary(): { total: number; pending: number; in_progress: number; completed: number; failed: number; overdue: number } {
    const now = new Date().toISOString();
    // COALESCE: SUM over zero rows is NULL, and callers expect numbers.
    const stmt = this.ensureDb().prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) as in_progress,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN deadline < ? AND status NOT IN ('completed', 'cancelled') THEN 1 ELSE 0 END), 0) as overdue
      FROM tasks
    `);
    return stmt.get(now) as { total: number; pending: number; in_progress: number; completed: number; failed: number; overdue: number };
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const tracker = new Tracker();
