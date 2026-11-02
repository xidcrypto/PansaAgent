import Database from "better-sqlite3";
import { DB_FILE, PANSA_DIR } from "./config.js";
import { redact } from "./redact.js";
import { loadContextFiles as loadFiles } from "./context.js";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  role: "user" | "assistant" | "tool";
  content: string;
  created_at: string;
}

export class SessionManager {
  // Lazy init (M8): importing this module must not touch the disk. The DB
  // opens on first use, at the single shared path DB_FILE.
  private db: Database | null = null;

  private ensureDb(): Database {
    if (this.db) return this.db;
    if (!existsSync(PANSA_DIR)) {
      mkdirSync(PANSA_DIR, { recursive: true, mode: 0o700 });
    }
    const db = new Database(DB_FILE);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        role TEXT,
        content TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    `);
    this.db = db;
    return db;
  }

  // Session management

  async createSession(title?: string): Promise<string> {
    const id = `session_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const titleText = title || `Session ${Date.now()}`;

    const stmt = this.ensureDb().prepare(
      `INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
    );
    stmt.run(id, titleText, now, now);

    this.currentSessionId = id;
    return id;
  }

  private currentSessionId: string | null = null;

  async getCurrentSessionId(): Promise<string | null> {
    return this.currentSessionId;
  }

  async listSessions(): Promise<Array<{ id: string; title: string; updated_at: string }>> {
    const stmt = this.ensureDb().prepare(
      `SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC`
    );
    return stmt.all() as Array<{ id: string; title: string; updated_at: string }>;
  }

  async setCurrentSession(id: string): Promise<boolean> {
    // Verify session exists
    const stmt = this.ensureDb().prepare(`SELECT id FROM sessions WHERE id = ?`);
    const row = stmt.get(id) as { id: string } | undefined;

    if (!row) return false;

    this.currentSessionId = id;
    return true;
  }

  // Retitle a session (U4: cheap-model titles). Returns false when the
  // session does not exist. Titles are plain text, never secrets.
  async renameSession(id: string, title: string): Promise<boolean> {
    const stmt = this.ensureDb().prepare(
      `UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`,
    );
    const info = stmt.run(title.slice(0, 120), id) as { changes: number };
    return info.changes > 0;
  }

  // Message management

  async addMessage(sessionId: string, role: "user" | "assistant" | "tool", content: string): Promise<void> {
    // Redact sensitive content before persisting
    const redactedContent = redact(content);

    const stmt = this.ensureDb().prepare(
      `INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, datetime('now'))`
    );
    stmt.run(sessionId, role, redactedContent);
  }

  async getMessages(sessionId: string): Promise<Array<Message>> {
    const stmt = this.ensureDb().prepare(
      `SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC`
    );
    return stmt.all(sessionId) as Array<Message>;
  }

  async clearSession(sessionId: string): Promise<void> {
    const db = this.ensureDb();
    const stmt = db.prepare(`DELETE FROM messages WHERE session_id = ?`);
    stmt.run(sessionId);

    const stmt2 = db.prepare(`DELETE FROM sessions WHERE id = ?`);
    stmt2.run(sessionId);
  }

  // Context file loading: delegates to the single loader in context.ts
  // (M18). Returns file contents; the ContextManager wraps them as data.
  loadContextFiles(): string[] {
    return loadFiles().map((f) => f.content);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Export singleton instance (lazy: safe to import without side effects)
export const sessionManager = new SessionManager();