import Database from "better-sqlite3";
import { redact } from "./redact.js";
import { mkdirSync, readFileSync, existsSync } from "node:fs";

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
  private db: Database;
  private currentSessionId: string | null = null;

  constructor() {
    const dbPath = `${process.env.HOME ?? ""}/.pansa`;
    if (!existsSync(dbPath)) {
      mkdirSync(dbPath, { recursive: true, mode: 0o700 });
    }
    const fullPath = `${dbPath}/sessions.db`;
    this.db = new Database(fullPath, { readonly: false });

    // Create tables if they don't exist
    this.db.exec(`
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
  }

  // Session management

  async createSession(title?: string): Promise<string> {
    const id = `session_${Date.now()}`;
    const now = new Date().toISOString();
    const titleText = title || `Session ${Date.now()}`;

    const stmt = this.db.prepare(
      `INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
    );
    stmt.run(id, titleText, now, now);

    this.currentSessionId = id;
    return id;
  }

  async getCurrentSessionId(): Promise<string | null> {
    return this.currentSessionId;
  }

  async listSessions(): Promise<Array<{ id: string; title: string; updated_at: string }>> {
    const stmt = this.db.prepare(
      `SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC`
    );
    return stmt.all() as Array<{ id: string; title: string; updated_at: string }>;
  }

  async setCurrentSession(id: string): Promise<boolean> {
    // Verify session exists
    const stmt = this.db.prepare(`SELECT id FROM sessions WHERE id = ?`);
    const row = stmt.get(id) as { id: string } | undefined;

    if (!row) return false;

    this.currentSessionId = id;
    return true;
  }

  // Message management

  async addMessage(sessionId: string, role: "user" | "assistant" | "tool", content: string): Promise<void> {
    // Redact sensitive content before persisting
    const redactedContent = redact(content);

    const stmt = this.db.prepare(
      `INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, datetime('now'))`
    );
    stmt.run(sessionId, role, redactedContent);
  }

  async getMessages(sessionId: string): Promise<Array<Message>> {
    const stmt = this.db.prepare(
      `SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC`
    );
    return stmt.all(sessionId) as Array<Message>;
  }

  async clearSession(sessionId: string): Promise<void> {
    const stmt = this.db.prepare(`DELETE FROM messages WHERE session_id = ?`);
    stmt.run(sessionId);

    const stmt2 = this.db.prepare(`DELETE FROM sessions WHERE id = ?`);
    stmt2.run(sessionId);
  }

  // Context file loading

  loadContextFiles(): string[] {
    const contexts: string[] = [];

    // Load PANSA.md from current directory
    try {
      const currentDirPansa = "./PANSA.md";
      if (existsSync(currentDirPansa)) {
        const content = readFileSync(currentDirPansa, "utf8");
        if (content.length <= 8000) {
          contexts.push(content);
        }
      }
    } catch {
      // ignore
    }

    // Load PANSA.md from home directory
    try {
      const homePansa = `${process.env.HOME ?? ""}/.pansa/PANSA.md`;
      if (existsSync(homePansa)) {
        const content = readFileSync(homePansa, "utf8");
        if (content.length <= 8000) {
          contexts.push(content);
        }
      }
    } catch {
      // ignore
    }

    return contexts;
  }

  close(): void {
    this.db.close();
  }
}

// Export singleton instance
export const sessionManager = new SessionManager();