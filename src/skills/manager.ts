import { ContextManager } from "../context.js";

export interface Skill {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; error?: string; signs?: boolean }>;
}

export interface SkillResult {
  skill: string;
  ok: boolean;
  data: unknown;
  error?: string;
}

export class SkillsManager {
  private skills: Map<string, Skill> = new Map();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  unregister(skillName: string): void {
    this.skills.delete(skillName);
  }

  listSkills(): string[] {
    return Array.from(this.skills.keys());
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  async execute(skillName: string, args: Record<string, unknown>, _context: ContextManager): Promise<SkillResult> {
    const skill = this.skills.get(skillName);
    if (!skill) {
      return { skill: skillName, ok: false, data: null, error: `Skill ${skillName} not found` };
    }

    try {
      const result = await skill.execute(args);
      return { skill: skillName, ...result };
    } catch (err) {
      return {
        skill: skillName,
        ok: false,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Execute multiple skills in parallel
  async executeMultiple(skillNames: string[], argsList: Record<string, unknown>[], _context: ContextManager): Promise<SkillResult[]> {
    const results: SkillResult[] = [];

    for (let i = 0; i < skillNames.length; i++) {
      const skillName = skillNames[i];
      const args = argsList[i] || {};
      const result = await this.execute(skillName, args, _context);
      results.push(result);
    }

    return results;
  }
}