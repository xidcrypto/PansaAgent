// Session wiring shared by the headless runner and the TUI (U4).
// Sessions were previously created but never attached to a run; these
// helpers create/restore a session around one agent run and persist its
// turns (already redacted by SessionManager.addMessage).
import { sessionManager } from "./session-manager.js";
import type { ContextManager } from "./context.js";
import { chat } from "./llm.js";

export interface RunSession {
  id: string;
  restored: boolean;
}

export interface RestoreRequest {
  resumeId?: string;
  continueLast?: boolean;
}

// Resolve a restore request to a session id, or null when nothing
// restorable was asked for. Never throws: session failures must never
// break a run.
export async function resolveRestore(req: RestoreRequest): Promise<string | null> {
  try {
    if (req.resumeId) {
      const ok = await sessionManager.setCurrentSession(req.resumeId);
      return ok ? req.resumeId : null;
    }
    if (req.continueLast) {
      const sessions = await sessionManager.listSessions();
      if (sessions.length > 0) {
        await sessionManager.setCurrentSession(sessions[0].id);
        return sessions[0].id;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Start a run session: restore prior turns into ctx when a session id
// is given, otherwise create a fresh session titled with the first
// user text (retitled by the cheap model in finishRunSession).
export async function startRunSession(
  ctx: ContextManager,
  firstText: string,
  restoreId: string | null,
): Promise<RunSession | null> {
  try {
    if (restoreId) {
      const messages = await sessionManager.getMessages(restoreId);
      ctx.restoreTurns(messages.map((m) => ({ role: m.role, content: m.content })));
      return { id: restoreId, restored: true };
    }
    const title = firstText.trim().slice(0, 60) || `Session ${Date.now()}`;
    const id = await sessionManager.createSession(title);
    return { id, restored: false };
  } catch {
    return null;
  }
}

// Best-effort retitle with the cheap model (U4). Any failure (no cheap
// model live, daemon down, bad output) keeps the first-text title.
export async function retitleWithCheapModel(
  sessionId: string,
  firstText: string,
  liveModels: string[],
  cfg: { preferReasoning?: string[]; preferCheap?: string[]; models?: string[] },
): Promise<void> {
  try {
    const res = await chat(
      {
        messages: [
          {
            role: "user",
            content: `Title this conversation in 6 words or fewer, no quotes, no punctuation at the end: ${firstText.slice(0, 200)}`,
          },
        ],
        tools: [],
        toolChoice: "none",
        kind: "cheap",
      },
      liveModels,
      cfg,
    );
    const title = (res.message.content ?? "").split("\n")[0].trim().replace(/^["']|["']$/g, "").slice(0, 60);
    if (title.length >= 3) {
      await sessionManager.renameSession(sessionId, title);
    }
  } catch {
    // keep the first-text title
  }
}

// Persist one run's turns. Awaits only the fast SQLite writes; the
// cheap-model retitle runs floating (its result is never needed before
// the next prompt, and a CLI exit must not wait on a daemon round-trip).
export async function finishRunSession(
  session: RunSession | null,
  prompt: string,
  answer: string,
  liveModels: string[],
  cfg: { preferReasoning?: string[]; preferCheap?: string[]; models?: string[] },
): Promise<void> {
  if (!session) return;
  try {
    await sessionManager.addMessage(session.id, "user", prompt);
    await sessionManager.addMessage(session.id, "assistant", answer);
    if (!session.restored) {
      void retitleWithCheapModel(session.id, prompt, liveModels, cfg);
    }
  } catch {
    // session persistence must never fail a run
  }
}
