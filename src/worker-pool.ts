// ============================================================
// worker-pool.ts — Manages worker agent lifecycle per step
// ============================================================
//
// REFACTORED: Uses pi-agent-core Agent with full tool schemas
// instead of primitive bash-block regex extraction.
//
// Each step executes a pi-agent-core Agent instance with:
//   - Role-specific system prompt
//   - Coding tool set (read, write, edit, bash, glob, grep, LSP, etc.)
//   - TypeBox-validated tool_use/tool_result cycle
//   - Surface 2 context injection (NOTES.md on every turn)
//   - Contract verification after the worker completes
//   - Recovery prompt + retry on contract failure
//
// Workers never share context across steps — each invocation
// starts from the step brief + prior artifacts only.
// ============================================================

import * as fs from "fs/promises";
import * as path from "path";

import { Agent as PiAgent } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentTool } from "./agent/types.js";

import {
  PlanStep,
  StepResult,
  WorkerConfig,
  VerificationResult,
} from "./types.js";
import { ContractVerifier } from "./contract-verifier.js";
import { resolveModel } from "./core/model-resolver.js";
import { createCoreTools } from "./tools/index.js";
import { logger } from "./core/logger.js";
import { PermissionManager } from "./core/permissions.js";

// ─── Worker system prompts per role ──────────────────────────

const ROLE_PROMPTS: Record<PlanStep["worker"], string> = {
  explorer: `\
You are a code explorer agent. Your job is to read and understand the codebase within your scope, then write findings to EXPLORATION.md (or a filename specified in your brief).

RULES:
- Use the read tool to examine files. Use glob and grep for search.
- Do NOT write any source code. You are a reader only.
- Write your NOTES.md scratchpad BEFORE writing the final output file.
- Be exhaustive: document every relevant function signature, route, type, and dependency you find.
- Finish by writing a structured markdown file as your artifact.`,

  coder: `\
You are a coder agent. Your job is to implement the code change described in your brief.

RULES:
- Read NOTES.md (if it exists) and any files referenced in your brief FIRST.
- Write to NOTES.md before touching source files — plan before acting.
- Use the read, write, edit, and bash tools as needed.
- After every file write, run the relevant compiler/linter (tsc --noEmit, eslint, etc.) and fix errors immediately.
- Do NOT refactor code outside your declared scope.
- Do NOT declare success if the compiler reports errors.

ANTI-PATTERNS (never do these):
- Do NOT rewrite an entire file when you need to change one function.
- Do NOT ignore type errors and move on.
- Do NOT use bash for what write/edit tools can do.`,

  tester: `\
You are a test-writing agent. Your job is to write tests for the code change described in your brief.

RULES:
- Read the implementation files in your scope FIRST via the read tool.
- Write to NOTES.md your test plan before writing tests.
- After writing tests, run them (npm test, pytest, go test, etc.) and fix failures.
- Tests must be deterministic — no random data, no network calls without mocking.
- Do NOT modify source code to make tests pass — only fix the tests themselves.`,

  verifier: `\
You are a verification agent. Your job is to check that the implementation satisfies its contract.

RULES:
- Run the programmatic checks specified in your brief (tsc, test suite, etc.).
- Read the output carefully. Report PASS or FAIL with evidence.
- Do NOT write or modify any code.
- Be precise: quote the exact error message or passing assertion in your evidence.`,
};

const NOTES_REMINDER = `\n\nIMPORTANT: Write to NOTES.md in your workspace before taking any action. Think before you act.`;

// ─── Recovery prompt template ─────────────────────────────────

function buildRecoveryPrompt(
  contract: string,
  failureReason: string,
  evidence: string,
  attempt: number
): string {
  return `\
Your previous attempt did not satisfy the output contract.

CONTRACT: ${contract}
FAILURE REASON: ${failureReason}
EVIDENCE:
${evidence}

ATTEMPT ${attempt} INSTRUCTIONS:
- Do NOT rewrite everything. Fix the specific issue described above.
- Re-read the failing output carefully before changing anything.
- After your fix, re-run the verification command to confirm it passes.`;
}

// ─── Helper: split "provider/model" string ─────────────────────

function splitModelString(s: string, defaultProvider: string): { provider: string; model: string } {
  const i = s.indexOf("/");
  if (i > 0) return { provider: s.slice(0, i), model: s.slice(i + 1) };
  return { provider: defaultProvider, model: s };
}

// ─── WorkerPool ──────────────────────────────────────────────

export class WorkerPool {
  private readonly verifier: ContractVerifier;
  private readonly permissions: PermissionManager;
  private _toolCache: AgentTool[] | null = null;

  constructor(
    private readonly config: WorkerConfig,
    private readonly roleModels: Partial<Record<PlanStep["worker"], string>> = {}
  ) {
    this.permissions = new PermissionManager(); // headless — auto-allow all
    this.verifier = new ContractVerifier(
      this.roleModels.verifier ?? config.model,
      config.workspaceRoot
    );
  }

  async executeStep(step: PlanStep): Promise<StepResult> {
    const modelStr = step.model ?? this.roleModels[step.worker] ?? this.config.model;
    const { provider, model } = splitModelString(modelStr, this.config.provider);
    const workerWorkspace = await this.prepareWorkerWorkspace(step);

    let lastVerification: VerificationResult | null = null;
    let attempt = 0;
    let lastOutput = "";

    while (attempt < this.config.maxRetries) {
      attempt++;
      logger.info(`[WorkerPool] Step ${step.id} attempt ${attempt}/${this.config.maxRetries}`);

      // ── Run the worker via pi-agent-core Agent ────────────────
      const agentOutput = await this.runWorkerAgent(
        provider,
        model,
        step,
        workerWorkspace,
        attempt > 1 ? lastVerification : null
      );
      lastOutput = agentOutput;

      // ── Verify the contract ──────────────────────────────────
      lastVerification = await this.verifier.verify(
        step.output_contract,
        step.scope
      );

      if (lastVerification.pass) {
        const artifacts = await this.listArtifacts(step.scope);
        await this.writeStepResult(step.id, "pass", attempt, lastVerification.evidence, artifacts);
        return {
          stepId: step.id,
          status: "pass",
          attempts: attempt,
          evidence: lastVerification.evidence,
          artifacts,
        };
      }

      logger.info(`[WorkerPool] Step ${step.id} contract not met: ${lastVerification.reason}`);
    }

    // All retries exhausted
    const failResult: StepResult = {
      stepId: step.id,
      status: "fail",
      attempts: attempt,
      evidence: lastVerification?.evidence ?? lastOutput.slice(0, 2000),
      artifacts: [],
      failureReason: lastVerification?.reason ?? "Max retries exceeded",
    };
    await this.writeStepResult(
      step.id, "fail", attempt,
      lastVerification?.evidence ?? "", [],
      lastVerification?.reason
    );
    return failResult;
  }

  // ─── Worker Agent (pi-agent-core) ────────────────────────────

  private async runWorkerAgent(
    provider: string,
    modelId: string,
    step: PlanStep,
    workerWorkspace: string,
    previousFailure: VerificationResult | null,
  ): Promise<string> {
    const { model, apiKey } = resolveModel(provider, modelId);

    // Build the coding tool set (shared cache across steps)
    const tools = await this.getWorkerTools(workerWorkspace);

    const system = ROLE_PROMPTS[step.worker] + NOTES_REMINDER;
    const initialMessage = this.buildInitialMessage(step, workerWorkspace, previousFailure);

    // Track output parts
    const outputParts: string[] = [];

    const permMgr = this.permissions;

    const agent = new PiAgent({
      initialState: {
        systemPrompt: system,
        model: model as any,
        tools: tools as any,
        thinkingLevel: "off",
        messages: [],
      },
      beforeToolCall: async (ctx: any) => {
        const toolName = ctx.toolCall?.toolName ?? ctx.toolName ?? "";
        const args     = ctx.args ?? {};
        const allowed  = await permMgr.check(toolName, args);
        if (!allowed) {
          return { block: true, reason: `Tool "${toolName}" was denied` };
        }
      },
      getApiKey: async () => apiKey || undefined,
      convertToLlm: (msgs: AgentMessage[]): Message[] => {
        // Filter to LLM-visible roles and pass through
        return msgs.filter(
          (m: any) => ["user", "assistant", "toolResult"].includes(m.role)
        ) as any as Message[];
      },
    });

    // Collect text output from assistant messages
    const unsub = agent.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        const delta = String(event.assistantMessageEvent.delta ?? "");
        if (delta) outputParts.push(delta);
      }
    });

    try {
      // Set up the timeout
      const timeoutMs = 120_000; // 2 minutes per worker step

      await Promise.race([
        agent.prompt(initialMessage),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`Worker step timeout after 120s`)), timeoutMs)
        ),
      ]);
    } catch (err: any) {
      logger.warn(`[WorkerPool] Agent error for step ${step.id}: ${err.message}`);
      // Return whatever output we collected (partial work may be salvageable)
    } finally {
      unsub();
    }

    const fullOutput = outputParts.join("");
    logger.info(`[WorkerPool] Step ${step.id} complete (${fullOutput.length} chars output)`);
    return fullOutput;
  }

  // ─── Worker tool factory ──────────────────────────────────────

  private async getWorkerTools(workspaceDir: string): Promise<AgentTool[]> {
    if (this._toolCache) return this._toolCache;
    // Use "standard" toolset: read, write, edit, bash, glob, grep, LSP, task, notebook
    const tools = await createCoreTools("standard", workspaceDir);
    this._toolCache = tools;
    return tools;
  }

  // ─── Message builders ─────────────────────────────────────────

  private buildInitialMessage(
    step: PlanStep,
    workerWorkspace: string,
    previousFailure: VerificationResult | null,
  ): string {
    const artifactsDir = this.config.artifactsDir;
    const dependencyNote =
      step.depends_on.length > 0
        ? `\nPRIOR ARTIFACTS (read-only): ${artifactsDir}\nCheck ${artifactsDir} for outputs from steps: ${step.depends_on.join(", ")}`
        : "";

    const recoveryNote = previousFailure
      ? `\n\nPREVIOUS ATTEMPT FAILED:\nReason: ${previousFailure.reason}\nEvidence:\n${previousFailure.evidence.slice(0, 1000)}\n\nFix the specific issue described above. Do NOT rewrite everything.`
      : "";

    return `\
STEP: ${step.id} (${step.type})
BRIEF: ${step.brief}
SCOPE (your writable directories): ${step.scope.join(", ")}
${dependencyNote}
YOUR WORKSPACE: ${workerWorkspace}

CONTRACT (what "done" means):
${step.output_contract.description}
${step.output_contract.fileExists ? `Required file: ${step.output_contract.fileExists}` : ""}
${step.output_contract.command ? `Verification command: ${step.output_contract.command}` : ""}
${recoveryNote}

Begin by writing NOTES.md with your plan, then execute.`;
  }

  // ─── Workspace helpers ────────────────────────────────────────

  private async prepareWorkerWorkspace(step: PlanStep): Promise<string> {
    const workerDir = path.join(this.config.workspaceRoot, "workers", step.id);
    await fs.mkdir(workerDir, { recursive: true });
    return workerDir;
  }

  private async listArtifacts(scope: string[]): Promise<string[]> {
    const artifacts: string[] = [];
    for (const dir of scope) {
      const resolved = path.isAbsolute(dir)
        ? dir
        : path.join(this.config.workspaceRoot, dir);
      try {
        const entries = await fs.readdir(resolved, { recursive: true } as any);
        for (const entry of entries as string[]) {
          artifacts.push(path.join(resolved, entry));
        }
      } catch {
        // Directory may not exist yet
      }
    }
    return artifacts;
  }

  private async writeStepResult(
    stepId: string,
    status: "pass" | "fail",
    attempts: number,
    evidence: string,
    artifacts: string[],
    failureReason?: string
  ): Promise<void> {
    const resultsPath = path.join(this.config.workspaceRoot, "RESULTS.json");
    let results: Record<string, any> = {};

    try {
      const text = await fs.readFile(resultsPath, "utf-8");
      results = JSON.parse(text);
    } catch {
      // First result
    }

    results[stepId] = { status, attempts, evidence, artifacts, failureReason };
    await fs.writeFile(resultsPath, JSON.stringify(results, null, 2), "utf-8");
  }
}
