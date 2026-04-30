// ============================================================
// types.ts — Shared types for the Clawd Orchestration System
// ============================================================

export type StepType = "explore" | "implement" | "test" | "verify";

export type StepStatus =
  | "pending"
  | "dispatched"
  | "completed"
  | "failed"
  | "escalated";

export interface OutputContract {
  /** Human-readable description of what "done" looks like */
  description: string;
  /** File that must exist on disk */
  fileExists?: string;
  /** Shell command whose exit code must be 0 */
  command?: string;
  /** Substring that must appear in stdout of `command` */
  commandContains?: string;
  /** When programmatic checks pass, do a soft LLM semantic check */
  semanticCheck?: string;
}

export interface PlanStep {
  id: string;
  type: StepType;
  brief: string;
  /** Directories / globs this worker may read/write */
  scope: string[];
  output_contract: OutputContract;
  /** IDs of steps whose artifacts must be available before this runs */
  depends_on: string[];
  /** Logical worker role */
  worker: "explorer" | "coder" | "tester" | "verifier";
  /** Model override for this step (falls back to WorkerPool default) */
  model?: string;
}

export interface Plan {
  id: string;
  task: string;
  created_at: string;
  steps: PlanStep[];
}

export interface StepResult {
  stepId: string;
  status: "pass" | "fail";
  attempts: number;
  evidence: string;
  artifacts: string[];
  failureReason?: string;
}

export interface VerificationResult {
  pass: boolean;
  reason: string;
  evidence: string;
}

export interface WorkerConfig {
  model: string;
  maxTurns: number;
  maxRetries: number;
  workspaceRoot: string;
  /** Shared read-only artifact directory */
  artifactsDir: string;
}

export interface OrchestratorConfig {
  model: string;
  workerDefaults: Omit<WorkerConfig, "model"> & { model?: string };
  /** Per-role model overrides */
  roleModels?: Partial<Record<PlanStep["worker"], string>>;
  workspaceRoot: string;
  maxEscalations: number;
}
