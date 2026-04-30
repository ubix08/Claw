// ============================================================
// worker-pool.ts — Manages worker agent lifecycle per step
// ============================================================
//
// Each step in the plan is executed by a worker agent running
// in a scoped context.  The WorkerPool:
//
//   1. Builds a minimal system prompt for the worker's role
//   2. Calls the LLM in a CodeAct-style bash-first loop
//   3. Injects recovery prompts on contract failure
//   4. Returns a StepResult for the orchestrator to record
//
// Workers never share context across steps — each invocation
// starts from the step brief + prior artifacts only.
//
// The "bash-first" principle from the spec is enforced via the
// worker system prompt which de-emphasises structured tool calls.
// ============================================================

import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import {
  PlanStep,
  StepResult,
  WorkerConfig,
  VerificationResult,
} from "./types.js";
import { ContractVerifier } from "./contract-verifier.js";
import { callLLM, Message } from "./llm-client.js";

const execAsync = promisify(exec);

// ─── Worker system prompts per role ──────────────────────────

const ROLE_PROMPTS: Record<PlanStep["worker"], string> = {
  explorer: `\
You are a code explorer agent. Your job is to read and understand the codebase within your scope, then write findings to EXPLORATION.md (or a filename specified in your brief).

RULES:
- ALWAYS prefer bash for reading files: use cat, grep, find, tree.
- Do NOT write any source code. You are a reader only.
- Write your NOTES.md scratchpad BEFORE writing the final output file.
- Be exhaustive: document every relevant function signature, route, type, and dependency you find.
- Finish by writing a structured markdown file as your artifact.`,

  coder: `\
You are a coder agent. Your job is to implement the code change described in your brief.

RULES:
- Read NOTES.md (if it exists) and any files referenced in your brief FIRST.
- Write to NOTES.md before touching source files — plan before acting.
- ALWAYS prefer bash for file operations: cat, mkdir, mv, cp.
- After every file write, run the relevant compiler/linter (tsc --noEmit, eslint, etc.) and fix errors immediately.
- Do NOT refactor code outside your declared scope.
- Do NOT declare success if the compiler reports errors.

ANTI-PATTERNS (never do these):
- Do NOT rewrite an entire file when you need to change one function.
- Do NOT ignore type errors and move on.
- Do NOT use structured tool calls for things bash can do.`,

  tester: `\
You are a test-writing agent. Your job is to write tests for the code change described in your brief.

RULES:
- Read the implementation files in your scope FIRST via bash (cat, grep).
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

// ─── WorkerPool ──────────────────────────────────────────────

export class WorkerPool {
  private readonly verifier: ContractVerifier;

  constructor(
    private readonly config: WorkerConfig,
    private readonly roleModels: Partial<Record<PlanStep["worker"], string>> = {}
  ) {
    this.verifier = new ContractVerifier(
      // Verifier uses the cheapest available model
      this.roleModels.verifier ?? config.model,
      config.workspaceRoot
    );
  }

  async executeStep(step: PlanStep): Promise<StepResult> {
    const model = step.model ?? this.roleModels[step.worker] ?? this.config.model;
    const workerWorkspace = await this.prepareWorkerWorkspace(step);

    let lastVerification: VerificationResult | null = null;
    let attempt = 0;
    const messages: Message[] = [this.buildInitialUserMessage(step, workerWorkspace)];

    while (attempt < this.config.maxRetries) {
      attempt++;
      console.log(`[WorkerPool] Step ${step.id} attempt ${attempt}/${this.config.maxRetries}`);

      // ── Run the worker ─────────────────────────────────────
      const agentResponse = await this.runWorkerTurns(
        model,
        step.worker,
        messages,
        workerWorkspace,
        step
      );

      // Append agent response to history for context in retries
      messages.push({ role: "assistant", content: agentResponse });

      // ── Verify the contract ────────────────────────────────
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

      // ── Inject recovery prompt ─────────────────────────────
      if (attempt < this.config.maxRetries) {
        messages.push({
          role: "user",
          content: buildRecoveryPrompt(
            step.output_contract.description,
            lastVerification.reason,
            lastVerification.evidence,
            attempt + 1
          ),
        });
      }
    }

    // All retries exhausted
    const failResult: StepResult = {
      stepId: step.id,
      status: "fail",
      attempts: attempt,
      evidence: lastVerification?.evidence ?? "",
      artifacts: [],
      failureReason: lastVerification?.reason ?? "Max retries exceeded",
    };
    await this.writeStepResult(
      step.id,
      "fail",
      attempt,
      lastVerification?.evidence ?? "",
      [],
      lastVerification?.reason
    );
    return failResult;
  }

  // ─── Worker turn loop ─────────────────────────────────────────

  private async runWorkerTurns(
    model: string,
    role: PlanStep["worker"],
    messages: Message[],
    workerWorkspace: string,
    step: PlanStep
  ): Promise<string> {
    const system = ROLE_PROMPTS[role] + NOTES_REMINDER;
    let turnMessages = [...messages];
    let lastResponse = "";

    for (let turn = 0; turn < this.config.maxTurns; turn++) {
      const response = await callLLM({
        model,
        system,
        messages: turnMessages,
        maxTokens: 4096,
      });

      lastResponse = response;

      // Extract and execute any bash blocks
      const bashBlocks = this.extractBashBlocks(response);
      if (bashBlocks.length === 0) {
        // No more actions — worker is done
        break;
      }

      // Execute bash blocks and collect output
      const execResults = await this.executeBashBlocks(bashBlocks, workerWorkspace);
      const outputMessage = this.formatExecResults(execResults);

      turnMessages = [...turnMessages, { role: "assistant", content: response }, { role: "user", content: outputMessage }];
    }

    return lastResponse;
  }

  // ─── Bash execution ───────────────────────────────────────────

  private extractBashBlocks(text: string): string[] {
    const blocks: string[] = [];
    const regex = /```(?:bash|sh)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      blocks.push(match[1].trim());
    }
    return blocks;
  }

  private async executeBashBlocks(
    blocks: string[],
    cwd: string
  ): Promise<Array<{ command: string; stdout: string; stderr: string; exitCode: number }>> {
    const results = [];
    for (const command of blocks) {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout: 30_000,
          env: { ...process.env, NO_COLOR: "1" },
        });
        results.push({ command, stdout, stderr, exitCode: 0 });
      } catch (err: any) {
        results.push({
          command,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? "",
          exitCode: err.code ?? 1,
        });
      }
    }
    return results;
  }

  private formatExecResults(
    results: Array<{ command: string; stdout: string; stderr: string; exitCode: number }>
  ): string {
    return results
      .map((r) =>
        [
          `$ ${r.command}`,
          r.stdout.trim() ? r.stdout.trim() : "",
          r.stderr.trim() ? `STDERR: ${r.stderr.trim()}` : "",
          r.exitCode !== 0 ? `Exit code: ${r.exitCode}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      )
      .join("\n\n");
  }

  // ─── Workspace helpers ────────────────────────────────────────

  private buildInitialUserMessage(step: PlanStep, workerWorkspace: string): Message {
    const artifactsDir = this.config.artifactsDir;
    const dependencyNote =
      step.depends_on.length > 0
        ? `\nPRIOR ARTIFACTS (read-only): ${artifactsDir}\nCheck ${artifactsDir} for outputs from steps: ${step.depends_on.join(", ")}`
        : "";

    const content = `\
STEP: ${step.id} (${step.type})
BRIEF: ${step.brief}
SCOPE (your writable directories): ${step.scope.join(", ")}
${dependencyNote}
YOUR WORKSPACE: ${workerWorkspace}

CONTRACT (what "done" means):
${step.output_contract.description}
${step.output_contract.fileExists ? `Required file: ${step.output_contract.fileExists}` : ""}
${step.output_contract.command ? `Verification command: ${step.output_contract.command}` : ""}

Begin by writing NOTES.md with your plan, then execute.`;

    return { role: "user", content };
  }

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
