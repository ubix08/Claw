// src/tools/grep.ts — Powerful code search tool using ripgrep
//
// Mirrors Claude Code's Grep tool exactly:
// - Uses ripgrep (rg) for fast regex search
// - Supports full ripgrep flags (-i, -A, -B, -C, -n, multiline)
// - Output modes: content, files_with_matches, count
// - Type filtering (js, py, rust, etc.)
// - Glob filtering
// - Pagination (head_limit, offset)

import { spawn } from "child_process";
import * as path from "path";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "../agent/types.js";

const grepSchema = Type.Object({
  pattern: Type.String({
    description: "Regular expression pattern to search for"
  }),
  path: Type.Optional(Type.String({
    description: "File or directory to search in. Defaults to workspace root."
  })),
  glob: Type.Optional(Type.String({
    description: "Glob pattern to filter files (e.g., *.js, *.{ts,tsx})"
  })),
  type: Type.Optional(Type.String({
    description: "File type to search (e.g., js, py, rust, go, java)"
  })),
  output_mode: Type.Optional(Type.Union([
    Type.Literal("content"),
    Type.Literal("files_with_matches"),
    Type.Literal("count"),
  ], {
    description: "Output format: content (matching lines), files_with_matches (file paths only), count (match counts)"
  })),
  i: Type.Optional(Type.Boolean({
    description: "Case insensitive search"
  })),
  n: Type.Optional(Type.Boolean({
    description: "Show line numbers in output (default: true)"
  })),
  A: Type.Optional(Type.Number({
    description: "Number of lines to show after each match"
  })),
  B: Type.Optional(Type.Number({
    description: "Number of lines to show before each match"
  })),
  C: Type.Optional(Type.Number({
    description: "Number of lines to show before and after each match (context)"
  })),
  context: Type.Optional(Type.Number({
    description: "Alias for C (context lines)"
  })),
  multiline: Type.Optional(Type.Boolean({
    description: "Enable multiline mode where . matches newlines (default: false)"
  })),
  head_limit: Type.Optional(Type.Number({
    description: "Limit output to first N lines/entries (default: 250, use 0 for unlimited)"
  })),
  offset: Type.Optional(Type.Number({
    description: "Skip first N lines/entries before applying head_limit"
  })),
});

interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  i?: boolean;
  n?: boolean;
  A?: number;
  B?: number;
  C?: number;
  context?: number;
  multiline?: boolean;
  head_limit?: number;
  offset?: number;
}

/**
 * Claude Code Grep tool implementation using ripgrep.
 *
 * Fast regex-based code search with full ripgrep feature set.
 * Supports context, filtering, multiline search, and multiple output formats.
 */
export function createGrepTool(workspaceDir: string): AgentTool {
  return {
    name:        "grep",
    label:       "Search Code",
    description:
      "Search file contents using ripgrep. Supports full regex syntax, context lines, " +
      "type/glob filtering, and multiple output modes. " +
      "Pattern uses ripgrep syntax - literal braces need escaping (e.g., \\{\\}).",
    parameters: grepSchema,
    execute: async (_id, params: GrepParams) => {
      try {
        // Check if ripgrep is available
        const rgPath = await findRipgrep();
        if (!rgPath) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: ripgrep (rg) not found on PATH. Install with: pkg install ripgrep"
            }],
            details: {},
          };
        }

        const args: string[] = [];
        const outputMode = params.output_mode || "files_with_matches";

        // Output mode flags
        if (outputMode === "files_with_matches") {
          args.push("-l");  // --files-with-matches
        } else if (outputMode === "count") {
          args.push("-c");  // --count
        }
        // "content" mode is default (no flag needed)

        // Search flags
        if (params.i) args.push("-i");  // case insensitive

        // Line numbers (default true for content mode)
        if (outputMode === "content") {
          if (params.n !== false) args.push("-n");
        }

        // Context flags
        const contextLines = params.C ?? params.context;
        if (contextLines !== undefined) {
          args.push(`-C${contextLines}`);
        } else {
          if (params.A !== undefined) args.push(`-A${params.A}`);
          if (params.B !== undefined) args.push(`-B${params.B}`);
        }

        // Multiline mode
        if (params.multiline) {
          args.push("-U");  // --multiline
          args.push("--multiline-dotall");  // . matches newlines
        }

        // File filtering
        if (params.glob) {
          args.push("--glob", params.glob);
        }
        if (params.type) {
          args.push("--type", params.type);
        }

        // Always use --color=never for clean output
        args.push("--color=never");

        // Pattern and path
        args.push(params.pattern);

        const searchPath = params.path
          ? path.resolve(workspaceDir, params.path)
          : workspaceDir;
        args.push(searchPath);

        // Execute ripgrep
        const output = await execRipgrep(rgPath, args, workspaceDir);

        if (output.exitCode === 1) {
          // Exit code 1 means no matches found (not an error)
          return {
            content: [{ type: "text" as const, text: "No matches found" }],
            details: { matches: 0 },
          };
        }

        if (output.exitCode > 1) {
          // Exit code >1 means actual error
          return {
            content: [{
              type: "text" as const,
              text: `Error: ${output.stderr || "ripgrep failed"}`
            }],
            details: {},
          };
        }

        // Apply pagination (head_limit and offset)
        let lines = output.stdout.split("\n").filter(Boolean);
        const totalLines = lines.length;

        if (params.offset) {
          lines = lines.slice(params.offset);
        }

        const headLimit = params.head_limit !== undefined ? params.head_limit : 250;
        if (headLimit > 0 && lines.length > headLimit) {
          lines = lines.slice(0, headLimit);
        }

        const result = lines.join("\n");
        const truncated = totalLines > lines.length;

        let text = result || "No matches found";
        if (truncated) {
          const remaining = totalLines - lines.length;
          text += `\n\n[... ${remaining} more line(s) - use offset/head_limit to see more]`;
        }

        return {
          content: [{ type: "text" as const, text }],
          details: {
            matches: outputMode === "count" ? parseInt(result) || 0 : totalLines,
            truncated,
          },
        };
      } catch (e: any) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${e.message}`
          }],
          details: {},
        };
      }
    },
  };
}

// Helper: Find ripgrep binary
async function findRipgrep(): Promise<string | null> {
  return new Promise((resolve) => {
    const which = spawn("which", ["rg"]);
    let output = "";

    which.stdout.on("data", (chunk) => output += chunk);
    which.on("close", (code) => {
      if (code === 0 && output.trim()) {
        resolve(output.trim());
      } else {
        resolve(null);
      }
    });
  });
}

// Helper: Execute ripgrep and capture output
interface RipgrepResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function execRipgrep(
  rgPath: string,
  args: string[],
  cwd: string,
): Promise<RipgrepResult> {
  return new Promise((resolve) => {
    const rg = spawn(rgPath, args, { cwd });

    let stdout = "";
    let stderr = "";

    rg.stdout.on("data", (chunk) => stdout += chunk);
    rg.stderr.on("data", (chunk) => stderr += chunk);

    rg.on("close", (code) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: code || 0,
      });
    });

    rg.on("error", (err) => {
      resolve({
        stdout: "",
        stderr: err.message,
        exitCode: 127,
      });
    });
  });
}
