// ============================================================
// task-planner.ts — Converts a user task into a PLAN.json
// ============================================================
//
// The orchestrator uses this module ONCE per task.  It calls a
// high-quality model (Kimi2 / MiniMax / GLM5) with a
// planning-specific system prompt and expects a JSON response
// that strictly conforms to the Plan schema.
//
// Design notes:
//  - The planner prompt uses negative examples per the spec
//    recommendation for weak-model reliability.
//  - output_contract fields are designed to be machine-checkable
//    wherever possible (fileExists, command) so that the
//    ContractVerifier can avoid LLM calls.
//  - The returned Plan is written to <workspaceRoot>/PLAN.json
//    immediately so resume logic can pick it up on restart.
// ============================================================

import * as fs from "fs/promises";
import * as path from "path";
import { Plan, PlanStep, OrchestratorConfig } from "./types.js";
import { callLLM } from "./llm-client.js";

// ─── Planner system prompt ───────────────────────────────────

const PLANNER_SYSTEM = `\
You are a senior software architect acting as a task planner for an AI coding agent system.
Your ONLY job is to decompose a coding task into an ordered list of discrete, machine-executable steps.

RULES:
- Respond with ONLY a valid JSON object. No markdown, no backticks, no preamble.
- Each step must have an output_contract that is verifiable without reading the code:
  - Prefer fileExists + command (tsc, npm test, grep) over semantic descriptions.
  - Only use semanticCheck when the correctness cannot be verified programmatically.
- Steps must be ordered by dependency. A step's depends_on list must only reference earlier step IDs.
- Scope must be concrete directory paths, not globs.
- Worker roles: "explorer" reads code, "coder" writes code, "tester" writes/runs tests, "verifier" checks correctness.
- Do NOT include implementation details in the brief — keep it what, not how.
- Do NOT create more than 8 steps. Merge small steps.

ANTI-PATTERNS (never do these):
- Do NOT make a step's brief contain multiple independent actions.
- Do NOT use output_contract.description alone — it is not machine-checkable.
- Do NOT make steps that depend on steps that haven't produced a file artifact yet.
- Do NOT assign "verifier" role to a step that produces code — that is a "coder" step.

OUTPUT FORMAT:
{
  "task": "<original task string>",
  "steps": [
    {
      "id": "s1",
      "type": "explore" | "implement" | "test" | "verify",
      "brief": "<one concrete action this worker must complete>",
      "scope": ["<dir1>", "<dir2>"],
      "output_contract": {
        "description": "<human readable>",
        "fileExists": "<path or omit>",
        "command": "<shell command whose exit 0 = pass, or omit>",
        "commandContains": "<required substring in stdout, or omit>",
        "semanticCheck": "<LLM check prompt, or omit>"
      },
      "depends_on": ["<step id> or empty array"],
      "worker": "explorer" | "coder" | "tester" | "verifier",
      "model": "<optional model override>"
    }
  ]
}`;

// ─── Public API ──────────────────────────────────────────────

export class TaskPlanner {
  constructor(private readonly config: OrchestratorConfig) {}

  /**
   * Decompose `task` into a Plan and persist it to PLAN.json.
   * Throws if the LLM returns unparseable JSON or a plan that
   * fails basic structural validation.
   */
  async planTask(task: string): Promise<Plan> {
    const raw = await callLLM({
      model: this.config.model,
      system: PLANNER_SYSTEM,
      messages: [{ role: "user", content: task }],
      maxTokens: 4096,
    });

    const plan = this.parseAndValidate(raw, task);
    await this.persist(plan);
    return plan;
  }

  /**
   * Load an existing PLAN.json from the workspace.
   * Returns null if none exists.
   */
  async loadExistingPlan(): Promise<Plan | null> {
    const planPath = this.planPath();
    try {
      const text = await fs.readFile(planPath, "utf-8");
      return JSON.parse(text) as Plan;
    } catch {
      return null;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────

  private parseAndValidate(raw: string, task: string): Plan {
    let parsed: any;
    try {
      // Strip accidental markdown fences
      const cleaned = raw.replace(/^```json\s*/m, "").replace(/```\s*$/m, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new Error(`TaskPlanner: LLM returned non-JSON response.\n---\n${raw}\n---`);
    }

    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new Error("TaskPlanner: Plan has no steps.");
    }

    const knownIds = new Set<string>();
    for (const step of parsed.steps as any[]) {
      if (!step.id || !step.type || !step.brief || !step.worker) {
        throw new Error(`TaskPlanner: Step missing required fields: ${JSON.stringify(step)}`);
      }
      if (!step.output_contract || !step.output_contract.description) {
        throw new Error(`TaskPlanner: Step ${step.id} has no output_contract.`);
      }
      for (const dep of (step.depends_on ?? []) as string[]) {
        if (!knownIds.has(dep)) {
          throw new Error(
            `TaskPlanner: Step ${step.id} depends on unknown step "${dep}".`
          );
        }
      }
      knownIds.add(step.id);
    }

    const plan: Plan = {
      id: crypto.randomUUID(),
      task,
      created_at: new Date().toISOString(),
      steps: parsed.steps as PlanStep[],
    };
    return plan;
  }

  private async persist(plan: Plan): Promise<void> {
    await fs.mkdir(this.config.workspaceRoot, { recursive: true });
    await fs.writeFile(this.planPath(), JSON.stringify(plan, null, 2), "utf-8");
  }

  private planPath(): string {
    return path.join(this.config.workspaceRoot, "PLAN.json");
  }
}
