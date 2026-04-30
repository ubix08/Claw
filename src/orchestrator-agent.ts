// ============================================================
// orchestrator-agent.ts — Central orchestration loop
// ============================================================
//
// The OrchestratorAgent:
//   1. Calls TaskPlanner to produce PLAN.json (or resumes one)
//   2. Iterates through steps in dependency order
//   3. Dispatches each step to WorkerPool
//   4. Verifies the contract via ContractVerifier
//   5. On failure: retries (handled by WorkerPool), then escalates
//   6. On escalation: re-plans the failed step with new information
//   7. Writes PROGRESS.md after every step (compact-safe state)
//   8. Emits an EventEmitter stream for gateway consumption
//
// Design notes:
//   - The orchestrator NEVER writes code.  Its model calls are
//     limited to planning and escalation re-planning.
//   - PROGRESS.md is written before any compaction would occur,
//     giving weak models reliable state reconstruction via file read.
//   - The escalation path re-plans only the failed subtree, not
//     the whole task, preserving completed work.
// ============================================================

import * as fs from "fs/promises";
import * as path from "path";
import { EventEmitter } from "events";
import {
  Plan,
  PlanStep,
  StepResult,
  StepStatus,
  OrchestratorConfig,
} from "./types.js";
import { TaskPlanner } from "./task-planner.js";
import { WorkerPool } from "./worker-pool.js";
import { callLLM } from "./llm-client.js";

// ─── Event types emitted by OrchestratorAgent ────────────────

export type OrchestratorEvent =
  | { type: "plan_created"; plan: Plan }
  | { type: "plan_resumed"; plan: Plan; completedSteps: string[] }
  | { type: "step_start"; step: PlanStep; attempt: number }
  | { type: "step_complete"; step: PlanStep; result: StepResult }
  | { type: "step_failed"; step: PlanStep; result: StepResult }
  | { type: "step_escalated"; step: PlanStep; reason: string }
  | { type: "task_complete"; summary: string }
  | { type: "task_failed"; reason: string };

// ─── Re-planner system prompt ─────────────────────────────────

const REPLANNER_SYSTEM = `\
You are a task re-planner. A step in an agent execution plan has failed after multiple retries.
Your job is to produce an alternative plan for ONLY the failed step and any steps that depend on it.

You will be given:
- The original step definition
- The failure reason and evidence
- Completed steps and their results

Output ONLY a JSON array of replacement steps (not a full plan object).
Follow the same schema as the original plan steps.
Re-plan conservatively: change the approach, not the goal.`;

// ─── OrchestratorAgent ───────────────────────────────────────

export class OrchestratorAgent extends EventEmitter {
  private readonly planner: TaskPlanner;
  private readonly pool: WorkerPool;
  private stepStatuses: Map<string, StepStatus> = new Map();
  private stepResults: Map<string, StepResult> = new Map();

  constructor(private readonly config: OrchestratorConfig) {
    super();
    this.planner = new TaskPlanner(config);
    this.pool = new WorkerPool(
      {
        model: config.workerDefaults.model ?? config.model,
        maxTurns: config.workerDefaults.maxTurns,
        maxRetries: config.workerDefaults.maxRetries,
        workspaceRoot: config.workspaceRoot,
        artifactsDir: path.join(config.workspaceRoot, "artifacts"),
      },
      config.roleModels ?? {}
    );
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Run the full plan/execute/verify cycle for `task`.
   * If a PLAN.json already exists (resume case), picks up where
   * it left off rather than re-planning.
   */
  async run(task: string): Promise<void> {
    // ── Step 1: Plan or resume ──────────────────────────────
    const existing = await this.planner.loadExistingPlan();
    let plan: Plan;

    if (existing && existing.task === task) {
      const completed = await this.loadCompletedSteps();
      plan = existing;
      this.emit("event", {
        type: "plan_resumed",
        plan,
        completedSteps: completed,
      } satisfies OrchestratorEvent);

      for (const id of completed) {
        this.stepStatuses.set(id, "completed");
      }
    } else {
      plan = await this.planner.planTask(task);
      this.emit("event", { type: "plan_created", plan } satisfies OrchestratorEvent);
    }

    // ── Step 2: Execute steps in dependency order ───────────
    await this.executePlan(plan, 0);
  }

  // ─── Plan execution ──────────────────────────────────────────

  private async executePlan(plan: Plan, escalations: number): Promise<void> {
    for (const step of plan.steps) {
      // Skip already-completed steps (resume path)
      if (this.stepStatuses.get(step.id) === "completed") {
        continue;
      }

      // Wait for dependencies
      await this.awaitDependencies(step, plan);

      this.stepStatuses.set(step.id, "dispatched");
      this.emit("event", {
        type: "step_start",
        step,
        attempt: 1,
      } satisfies OrchestratorEvent);

      const result = await this.pool.executeStep(step);
      this.stepResults.set(step.id, result);

      if (result.status === "pass") {
        this.stepStatuses.set(step.id, "completed");
        await this.copyArtifacts(result.artifacts);
        await this.writeProgressMd(plan);
        this.emit("event", {
          type: "step_complete",
          step,
          result,
        } satisfies OrchestratorEvent);
      } else {
        this.stepStatuses.set(step.id, "failed");
        this.emit("event", {
          type: "step_failed",
          step,
          result,
        } satisfies OrchestratorEvent);

        // ── Escalation path ────────────────────────────────
        if (escalations >= this.config.maxEscalations) {
          const reason = `Step ${step.id} failed after ${result.attempts} retries and max escalations (${this.config.maxEscalations}) reached.`;
          this.emit("event", { type: "task_failed", reason } satisfies OrchestratorEvent);
          throw new Error(reason);
        }

        const replanResult = await this.escalate(step, result, plan, escalations);
        if (!replanResult) {
          const reason = `Escalation for step ${step.id} produced no viable re-plan.`;
          this.emit("event", { type: "task_failed", reason } satisfies OrchestratorEvent);
          throw new Error(reason);
        }

        // Restart execution with the updated plan
        return this.executePlan(replanResult, escalations + 1);
      }
    }

    // ── All steps completed ─────────────────────────────────
    const summary = await this.buildSummary(plan);
    this.emit("event", { type: "task_complete", summary } satisfies OrchestratorEvent);
  }

  // ─── Dependency management ────────────────────────────────────

  private async awaitDependencies(step: PlanStep, plan: Plan): Promise<void> {
    for (const depId of step.depends_on) {
      const status = this.stepStatuses.get(depId);
      if (status !== "completed") {
        throw new Error(
          `Step ${step.id} depends on ${depId} which has status "${status ?? "pending"}". ` +
            "Dependency must complete before dispatch."
        );
      }
    }
  }

  // ─── Escalation / re-planning ─────────────────────────────────

  private async escalate(
    failedStep: PlanStep,
    result: StepResult,
    plan: Plan,
    escalationCount: number
  ): Promise<Plan | null> {
    this.emit("event", {
      type: "step_escalated",
      step: failedStep,
      reason: result.failureReason ?? result.evidence,
    } satisfies OrchestratorEvent);

    const completedSummary = Array.from(this.stepResults.entries())
      .filter(([, r]) => r.status === "pass")
      .map(([id, r]) => `Step ${id}: PASS (${r.evidence.slice(0, 200)})`)
      .join("\n");

    const userMessage = [
      `FAILED STEP: ${JSON.stringify(failedStep, null, 2)}`,
      ``,
      `FAILURE REASON: ${result.failureReason}`,
      `EVIDENCE: ${result.evidence.slice(0, 1000)}`,
      ``,
      `COMPLETED STEPS:`,
      completedSummary || "(none)",
      ``,
      `Produce replacement step(s) for the failed step and any that depended on it.`,
      `Affected steps: ${this.findAffectedSteps(failedStep.id, plan).join(", ")}`,
    ].join("\n");

    const raw = await callLLM({
      model: this.config.model,
      system: REPLANNER_SYSTEM,
      messages: [{ role: "user", content: userMessage }],
      maxTokens: 2048,
    });

    let replacementSteps: PlanStep[];
    try {
      const cleaned = raw.replace(/^```json\s*/m, "").replace(/```\s*$/m, "").trim();
      replacementSteps = JSON.parse(cleaned);
      if (!Array.isArray(replacementSteps)) throw new Error("Not an array");
    } catch {
      console.error("[Orchestrator] Re-planner returned unparseable JSON:", raw);
      return null;
    }

    // Build new plan: completed steps + replacement steps
    const affectedIds = new Set(this.findAffectedSteps(failedStep.id, plan));
    const survivingSteps = plan.steps.filter(
      (s) => !affectedIds.has(s.id) && this.stepStatuses.get(s.id) === "completed"
    );
    const newPlan: Plan = {
      ...plan,
      steps: [...survivingSteps, ...replacementSteps],
    };

    await fs.writeFile(
      path.join(this.config.workspaceRoot, "PLAN.json"),
      JSON.stringify(newPlan, null, 2),
      "utf-8"
    );

    return newPlan;
  }

  private findAffectedSteps(failedId: string, plan: Plan): string[] {
    const affected = new Set<string>([failedId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of plan.steps) {
        if (!affected.has(step.id) && step.depends_on.some((d) => affected.has(d))) {
          affected.add(step.id);
          changed = true;
        }
      }
    }
    return Array.from(affected);
  }

  // ─── Progress & state persistence ────────────────────────────

  /**
   * Write PROGRESS.md — the compact-safe state file.
   * Agents can read this instead of relying on in-context summaries.
   */
  private async writeProgressMd(plan: Plan): Promise<void> {
    const lines = [
      `# Task Progress`,
      ``,
      `**Task**: ${plan.task}`,
      `**Plan ID**: ${plan.id}`,
      `**Updated**: ${new Date().toISOString()}`,
      ``,
      `## Steps`,
      ``,
    ];

    for (const step of plan.steps) {
      const status = this.stepStatuses.get(step.id) ?? "pending";
      const result = this.stepResults.get(step.id);
      const icon = status === "completed" ? "✅" : status === "failed" ? "❌" : "⏳";
      lines.push(`### ${icon} ${step.id} — ${step.type}: ${step.brief.slice(0, 80)}`);
      lines.push(`**Status**: ${status}`);
      if (result) {
        lines.push(`**Attempts**: ${result.attempts}`);
        if (result.failureReason) lines.push(`**Failure**: ${result.failureReason}`);
        if (result.artifacts.length > 0) {
          lines.push(`**Artifacts**:`);
          for (const a of result.artifacts.slice(0, 10)) {
            lines.push(`  - ${a}`);
          }
        }
      }
      lines.push(``);
    }

    const nextPending = plan.steps.find(
      (s) => (this.stepStatuses.get(s.id) ?? "pending") === "pending"
    );
    if (nextPending) {
      lines.push(`## Current Task`);
      lines.push(``);
      lines.push(`**Step**: ${nextPending.id}`);
      lines.push(`**Brief**: ${nextPending.brief}`);
      lines.push(`**Contract**: ${nextPending.output_contract.description}`);
    }

    await fs.writeFile(
      path.join(this.config.workspaceRoot, "PROGRESS.md"),
      lines.join("\n"),
      "utf-8"
    );
  }

  private async loadCompletedSteps(): Promise<string[]> {
    const resultsPath = path.join(this.config.workspaceRoot, "RESULTS.json");
    try {
      const text = await fs.readFile(resultsPath, "utf-8");
      const results = JSON.parse(text) as Record<string, StepResult>;
      return Object.entries(results)
        .filter(([, r]) => r.status === "pass")
        .map(([id]) => id);
    } catch {
      return [];
    }
  }

  private async copyArtifacts(artifacts: string[]): Promise<void> {
    const artifactsDir = path.join(this.config.workspaceRoot, "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true });
    for (const src of artifacts) {
      try {
        const dest = path.join(artifactsDir, path.basename(src));
        await fs.copyFile(src, dest);
      } catch {
        // Best-effort
      }
    }
  }

  // ─── Summary ────────────────────────────────────────────────

  private async buildSummary(plan: Plan): Promise<string> {
    const completedCount = Array.from(this.stepStatuses.values()).filter(
      (s) => s === "completed"
    ).length;

    return [
      `Task completed: "${plan.task}"`,
      `Steps executed: ${completedCount}/${plan.steps.length}`,
      `Artifacts: ${path.join(this.config.workspaceRoot, "artifacts")}`,
      `Progress log: ${path.join(this.config.workspaceRoot, "PROGRESS.md")}`,
    ].join("\n");
  }
}
