// src/tools/glob.ts — Fast file pattern matching tool
//
// Mirrors Claude Code's Glob tool exactly:
// - Supports glob patterns (**/*.js, src/**/*.ts)
// - Returns paths sorted by modification time (newest first)
// - Works with any codebase size
// - Returns file paths only (no content)

import * as path from "path";
import fg from "fast-glob";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "../agent/types.js";

const globSchema = Type.Object({
  pattern: Type.String({
    description: "Glob pattern to match files against (e.g., **/*.js, src/**/*.ts)"
  }),
  path: Type.Optional(Type.String({
    description: "Directory to search in. Defaults to workspace root."
  })),
});

/**
 * Claude Code Glob tool implementation.
 *
 * Fast file pattern matching using glob syntax.
 * Returns matching file paths sorted by modification time (newest first).
 */
export function createGlobTool(workspaceDir: string): AgentTool {
  return {
    name:        "glob",
    label:       "Find Files",
    description:
      "Fast file pattern matching. Returns file paths matching glob patterns, " +
      "sorted by modification time (newest first). " +
      "Supports wildcards: * (any chars), ** (any depth), ? (single char), [abc] (character set).",
    parameters: globSchema,
    execute: async (_id, params: { pattern: string; path?: string }) => {
      try {
        const searchDir = params.path
          ? path.resolve(workspaceDir, params.path)
          : workspaceDir;

        // Use fast-glob with stat info for mtime sorting
        const entries = await fg(params.pattern, {
          cwd:       searchDir,
          absolute:  false,
          stats:     true,
          onlyFiles: true,
          dot:       false,  // Exclude hidden files by default (matches Claude Code)
        });

        if (entries.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No files matched pattern" }],
            details: {},
          };
        }

        // Sort by modification time (newest first)
        entries.sort((a, b) => {
          const aTime = (a.stats?.mtimeMs ?? 0);
          const bTime = (b.stats?.mtimeMs ?? 0);
          return bTime - aTime;
        });

        // Return paths only
        const paths = entries.map(e => e.path).join("\n");

        return {
          content: [{ type: "text" as const, text: paths }],
          details: { count: entries.length },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e.message}` }],
          details: {},
        };
      }
    },
  };
}