// ============================================================
// contract-verifier.ts — Checks whether a step's output
//                        satisfies its OutputContract.
// ============================================================
//
// Verification runs in three phases:
//
//  Phase 1 — Structural checks (no LLM, instant)
//    fileExists  → fs.access()
//    command     → child_process exec, check exit code
//    commandContains → same exec, check stdout substring
//
//  Phase 2 — Soft semantic check (cheap LLM, only if Phase 1 passes
//             AND semanticCheck is present)
//    The verifier reads the relevant files in scope and asks the
//    LLM whether the semantic condition is satisfied.
//
//  Phase 3 — Result
//    Returns { pass, reason, evidence } where evidence is the
//    raw output of the check that determined the result.
//
// This ordering means 80-90% of checks never touch an LLM.
// ============================================================

import { exec } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import { OutputContract, VerificationResult } from "./types.js";
import { callLLM } from "./llm-client.js";

const execAsync = promisify(exec);

const VERIFIER_SYSTEM = `\
You are a code review verifier. You will be given:
1. A verification condition (the "contract")
2. File contents from the workspace

Your job: answer ONLY "PASS" or "FAIL" on the first line, then a one-sentence reason.
Do not explain what would make it pass. Only evaluate the evidence provided.

Example output:
PASS
The OAuth strategy is correctly registered with the passport middleware.

Example output:
FAIL
The function signature does not match the required interface — it returns void instead of Promise<User>.`;

export class ContractVerifier {
  constructor(
    private readonly verifierModel: string,
    private readonly workspaceRoot: string
  ) {}

  async verify(
    contract: OutputContract,
    stepScope: string[]
  ): Promise<VerificationResult> {
    // ── Phase 1: file existence ──────────────────────────────
    if (contract.fileExists) {
      const result = await this.checkFileExists(contract.fileExists);
      if (!result.pass) return result;
    }

    // ── Phase 1: command exit code ───────────────────────────
    if (contract.command) {
      const result = await this.checkCommand(
        contract.command,
        contract.commandContains
      );
      if (!result.pass) return result;
    }

    // ── Phase 2: semantic LLM check ──────────────────────────
    if (contract.semanticCheck) {
      return this.checkSemantic(contract.semanticCheck, stepScope);
    }

    // All programmatic checks passed, no semantic check needed
    return {
      pass: true,
      reason: "All programmatic checks passed.",
      evidence: [
        contract.fileExists ? `File exists: ${contract.fileExists}` : "",
        contract.command ? `Command succeeded: ${contract.command}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  // ─── Programmatic checks ─────────────────────────────────────

  private async checkFileExists(filePath: string): Promise<VerificationResult> {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workspaceRoot, filePath);
    try {
      await fs.access(resolved);
      return {
        pass: true,
        reason: `Required file exists: ${resolved}`,
        evidence: `fs.access("${resolved}") succeeded`,
      };
    } catch {
      return {
        pass: false,
        reason: `Required file does not exist: ${resolved}`,
        evidence: `fs.access("${resolved}") threw ENOENT`,
      };
    }
  }

  private async checkCommand(
    command: string,
    mustContain?: string
  ): Promise<VerificationResult> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workspaceRoot,
        timeout: 60_000,
      });

      if (mustContain && !stdout.includes(mustContain)) {
        return {
          pass: false,
          reason: `Command stdout does not contain required string: "${mustContain}"`,
          evidence: `stdout:\n${stdout}\nstderr:\n${stderr}`,
        };
      }

      return {
        pass: true,
        reason: `Command exited 0: ${command}`,
        evidence: `stdout:\n${stdout}`,
      };
    } catch (err: any) {
      const evidence = [
        `exit code: ${err.code ?? "?"}`,
        `stdout:\n${err.stdout ?? ""}`,
        `stderr:\n${err.stderr ?? ""}`,
      ].join("\n");

      return {
        pass: false,
        reason: `Command failed (exit ${err.code ?? "nonzero"}): ${command}`,
        evidence,
      };
    }
  }

  // ─── Semantic check ──────────────────────────────────────────

  private async checkSemantic(
    condition: string,
    scope: string[]
  ): Promise<VerificationResult> {
    // Read up to 20 files in scope (skip binaries / large files)
    const fileContents = await this.readScopeFiles(scope);

    const userMessage = [
      `CONTRACT: ${condition}`,
      "",
      "WORKSPACE FILES:",
      fileContents,
    ].join("\n");

    const response = await callLLM({
      model: this.verifierModel,
      system: VERIFIER_SYSTEM,
      messages: [{ role: "user", content: userMessage }],
      maxTokens: 256,
    });

    const firstLine = response.trim().split("\n")[0].trim().toUpperCase();
    const reason = response.trim().split("\n").slice(1).join(" ").trim();
    const pass = firstLine === "PASS";

    return {
      pass,
      reason: reason || (pass ? "Semantic check passed." : "Semantic check failed."),
      evidence: response.trim(),
    };
  }

  private async readScopeFiles(scope: string[]): Promise<string> {
    const MAX_FILES = 20;
    const MAX_FILE_BYTES = 8_000;
    const segments: string[] = [];
    let count = 0;

    for (const dir of scope) {
      if (count >= MAX_FILES) break;
      const resolved = path.isAbsolute(dir) ? dir : path.join(this.workspaceRoot, dir);
      let entries: string[];
      try {
        entries = await fs.readdir(resolved, { recursive: true } as any);
      } catch {
        continue;
      }

      for (const entry of entries as string[]) {
        if (count >= MAX_FILES) break;
        if (!this.isTextFile(entry)) continue;
        const fullPath = path.join(resolved, entry);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > MAX_FILE_BYTES * 2) continue; // Skip very large files
          const content = await fs.readFile(fullPath, "utf-8");
          const truncated =
            content.length > MAX_FILE_BYTES
              ? content.slice(0, MAX_FILE_BYTES) + "\n...[truncated]"
              : content;
          segments.push(`--- ${path.relative(this.workspaceRoot, fullPath)} ---\n${truncated}`);
          count++;
        } catch {
          // Skip unreadable files
        }
      }
    }

    return segments.join("\n\n") || "(no readable files in scope)";
  }

  private isTextFile(name: string): boolean {
    const ext = path.extname(name).toLowerCase();
    return [
      ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts",
      ".json", ".md", ".txt", ".yaml", ".yml", ".toml",
      ".sh", ".py", ".go", ".rs", ".java", ".cs",
      ".html", ".css", ".scss", ".sql",
    ].includes(ext);
  }
}
