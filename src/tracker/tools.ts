import { Tool } from "../agent.js";
import { tracker, Task } from "./index.js";

export function createTrackerTool(): Tool {
  return {
    name: "tracker",
    description: "Manage airdrop tasks (create, update, list, remove)",
    parameters: {
      action: { type: "string", description: "Action: create, get, update, list, remove, summary" },
      task_id: { type: "string", description: "Task ID (for get/update/remove)" },
      title: { type: "string", description: "Task title (for create)" },
      description: { type: "string", description: "Task description" },
      status: { type: "string", description: "Status: pending, in_progress, completed, failed, cancelled" },
      priority: { type: "string", description: "Priority: low, medium, high" },
      chain: { type: "string", description: "Chain (evm, solana, sui, aptos)" },
      campaign: { type: "string", description: "Campaign name" },
      deadline: { type: "string", description: "Deadline (ISO 8601)" },
    },
    async execute(args: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; error?: string; signs?: boolean }> {
      const { action, task_id, title, description, status, priority, chain, campaign, deadline } = args as {
        action: string; task_id?: string; title?: string; description?: string; status?: string; priority?: string; chain?: string; campaign?: string; deadline?: string;
      };

      try {
        switch (action) {
          case "create": {
            if (!title) return { ok: false, data: null, error: "title required for create" };
            const task = tracker.createTask({
              title,
              description,
              status: (status as any) ?? "pending",
              priority: (priority as any) ?? "medium",
              chain,
              campaign,
              deadline,
            });
            return { ok: true, data: task, signs: false };
          }

          case "get": {
            if (!task_id) return { ok: false, data: null, error: "task_id required" };
            const task = tracker.getTask(task_id);
            if (!task) return { ok: false, data: null, error: `Task ${task_id} not found` };
            return { ok: true, data: task, signs: false };
          }

          case "update": {
            if (!task_id) return { ok: false, data: null, error: "task_id required" };
            const updates: Partial<Task> = {};
            if (title) updates.title = title;
            if (description !== undefined) updates.description = description;
            if (status) updates.status = status as any;
            if (priority) updates.priority = priority as any;
            if (chain !== undefined) updates.chain = chain;
            if (campaign !== undefined) updates.campaign = campaign;
            if (deadline !== undefined) updates.deadline = deadline;
            const task = tracker.updateTask(task_id, updates);
            if (!task) return { ok: false, data: null, error: `Task ${task_id} not found` };
            return { ok: true, data: task, signs: false };
          }

          case "remove": {
            if (!task_id) return { ok: false, data: null, error: "task_id required" };
            const removed = tracker.removeTask(task_id);
            if (!removed) return { ok: false, data: null, error: `Task ${task_id} not found` };
            return { ok: true, data: { removed: true, task_id }, signs: false };
          }

          case "list": {
            const filter: any = {};
            if (status) filter.status = status;
            if (campaign) filter.campaign = campaign;
            if (chain) filter.chain = chain;
            const tasks = tracker.listTasks(filter);
            return { ok: true, data: { count: tasks.length, tasks }, signs: false };
          }

          case "summary": {
            const summary = tracker.getSummary();
            return { ok: true, data: summary, signs: false };
          }

          default:
            return { ok: false, data: null, error: `Unknown action: ${action}. Use: create, get, update, list, remove, summary` };
        }
      } catch (err) {
        return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), signs: false };
      }
    },
  };
}

export function createReportTool(): Tool {
  return {
    name: "report",
    description: "Generate airdrop farming reports",
    parameters: {
      type: { type: "string", description: "Report type: summary, earnings, tasks, campaign" },
      period: { type: "string", description: "Time period: 7d, 30d, all" },
      campaign: { type: "string", description: "Specific campaign (optional)" },
    },
    async execute(args: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; error?: string; signs?: boolean }> {
      const { type, period, campaign } = args as { type?: string; period?: string; campaign?: string };

      const summary = tracker.getSummary();
      const tasks = tracker.listTasks(campaign ? { campaign } : undefined);

      const report = {
        generated_at: new Date().toISOString(),
        type: type ?? "summary",
        period: period ?? "all",
        campaign: campaign ?? "all",
        summary,
        tasks_by_status: {
          pending: tasks.filter(t => t.status === "pending").length,
          in_progress: tasks.filter(t => t.status === "in_progress").length,
          completed: tasks.filter(t => t.status === "completed").length,
          failed: tasks.filter(t => t.status === "failed").length,
        },
        upcoming_deadlines: tasks
          .filter(t => t.deadline && t.status !== "completed" && t.status !== "cancelled")
          .sort((a, b) => (a.deadline ?? "").localeCompare(b.deadline ?? ""))
          .slice(0, 5),
      };

      return { ok: true, data: report, signs: false };
    },
  };
}
