// src/tools/lsp.ts — LSP code intelligence tool
//
// Fix log:
//   [LSP-FIX-1] `action` field changed from Type.String (freeform) to
//               Type.Union([Type.Literal(...)]) so that invalid action strings
//               are caught by schema validation before reaching the switch
//               statement, rather than producing a confusing runtime error.
//               Mirrors the pattern correctly used in web_search's `type` field.

import * as path from "path";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "../agent/types.js";
import { getLspManager } from "../lsp/client.js";

// ── Schema ────────────────────────────────────────────────────────────────────

const lspQuerySchema = Type.Object({
  // [LSP-FIX-1] Use a discriminated union of literals instead of a freeform
  // string so AJV rejects hallucinated values before they reach execute().
  action: Type.Union(
    [
      Type.Literal("definition"),
      Type.Literal("references"),
      Type.Literal("hover"),
      Type.Literal("diagnostics"),
    ],
    { description: "Action to perform: 'definition', 'references', 'hover', or 'diagnostics'" }
  ),
  path: Type.String({
    description: "Relative path to the file"
  }),
  line: Type.Optional(Type.Number({
    description: "Line number (0-based, required for definition/references/hover)"
  })),
  column: Type.Optional(Type.Number({
    description: "Column number (0-based, required for definition/references/hover)"
  })),
});

// ── Helper Functions ──────────────────────────────────────────────────────────

function ok(text: string, details?: any) {
  return { content: [{ type: "text" as const, text }], details: details || {} };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: {} };
}

function _isSafe(abs: string, workspaceDir: string): boolean {
  const root = path.resolve(workspaceDir);
  return abs === root || abs.startsWith(root + path.sep);
}

// ── Tool Factory ──────────────────────────────────────────────────────────────

export function createLspTool(workspaceDir: string): AgentTool {
  return {
    name: "lsp_query",
    label: "LSP Code Intelligence",
    description:
      "Query language server for code intelligence: " +
      "'definition' - go to definition, " +
      "'references' - find all references, " +
      "'hover' - get type information, " +
      "'diagnostics' - get errors/warnings for a file. " +
      "Line and column are 0-based.",
    parameters: lspQuerySchema,
    execute: async (_id, params: {
      action: "definition" | "references" | "hover" | "diagnostics";
      path: string;
      line?: number;
      column?: number;
    }) => {
      try {
        const abs = path.resolve(workspaceDir, params.path);
        if (!_isSafe(abs, workspaceDir)) {
          return err(`Path traversal rejected: "${params.path}"`);
        }

        const manager = getLspManager();

        switch (params.action) {
          case "definition": {
            if (params.line === undefined || params.column === undefined) {
              return err("'definition' action requires 'line' and 'column' parameters");
            }

            const locations = await manager.getDefinition(abs, params.line, params.column);

            if (locations.length === 0) {
              return ok(`No definition found for position ${params.line}:${params.column} in ${params.path}`);
            }

            const lines: string[] = [];
            lines.push(`# Definitions for ${params.path}:${params.line}:${params.column}\n`);

            for (const loc of locations) {
              const relPath = loc.uri.replace(`file://${workspaceDir}/`, "");
              lines.push(`- **${relPath}**`);
              lines.push(`  Line: ${loc.range.start.line}, Column: ${loc.range.start.character}`);
            }

            return ok(lines.join("\n"), { count: locations.length, locations });
          }

          case "references": {
            if (params.line === undefined || params.column === undefined) {
              return err("'references' action requires 'line' and 'column' parameters");
            }

            const locations = await manager.getReferences(abs, params.line, params.column);

            if (locations.length === 0) {
              return ok(`No references found for position ${params.line}:${params.column} in ${params.path}`);
            }

            const lines: string[] = [];
            lines.push(`# References for ${params.path}:${params.line}:${params.column}\n`);
            lines.push(`Found ${locations.length} reference(s):\n`);

            // Group by file
            const byFile = new Map<string, typeof locations>();
            for (const loc of locations) {
              const relPath = loc.uri.replace(`file://${workspaceDir}/`, "");
              if (!byFile.has(relPath)) {
                byFile.set(relPath, []);
              }
              byFile.get(relPath)!.push(loc);
            }

            for (const [filePath, locs] of byFile.entries()) {
              lines.push(`## ${filePath} (${locs.length})`);
              for (const loc of locs) {
                lines.push(`  - Line ${loc.range.start.line}, Column ${loc.range.start.character}`);
              }
              lines.push("");
            }

            return ok(lines.join("\n"), { count: locations.length, files: byFile.size });
          }

          case "hover": {
            if (params.line === undefined || params.column === undefined) {
              return err("'hover' action requires 'line' and 'column' parameters");
            }

            const hover = await manager.getHover(abs, params.line, params.column);

            if (!hover) {
              return ok(`No hover information at position ${params.line}:${params.column} in ${params.path}`);
            }

            const lines: string[] = [];
            lines.push(`# Hover Info for ${params.path}:${params.line}:${params.column}\n`);

            if (hover.contents) {
              if (typeof hover.contents === "string") {
                lines.push(hover.contents);
              } else if ("value" in hover.contents) {
                lines.push(hover.contents.value);
              } else if (Array.isArray(hover.contents)) {
                for (const content of hover.contents) {
                  if (typeof content === "string") {
                    lines.push(content);
                  } else if ("value" in content) {
                    lines.push(content.value);
                  }
                }
              }
            }

            return ok(lines.join("\n"), { hover });
          }

          case "diagnostics": {
            const diagnostics = manager.getDiagnostics(abs);

            if (diagnostics.length === 0) {
              return ok(`No diagnostics for ${params.path}`, { count: 0 });
            }

            const lines: string[] = [];
            lines.push(`# Diagnostics for ${params.path}\n`);
            lines.push(`Found ${diagnostics.length} issue(s):\n`);

            const errors   = diagnostics.filter(d => d.severity === "error");
            const warnings = diagnostics.filter(d => d.severity === "warning");
            const info     = diagnostics.filter(d => d.severity === "info");

            if (errors.length > 0) {
              lines.push(`## Errors (${errors.length})\n`);
              for (const d of errors) {
                lines.push(`- **Line ${d.line}:${d.column}** - ${d.message}`);
                if (d.source) lines.push(`  Source: ${d.source}`);
                lines.push("");
              }
            }

            if (warnings.length > 0) {
              lines.push(`## Warnings (${warnings.length})\n`);
              for (const d of warnings) {
                lines.push(`- **Line ${d.line}:${d.column}** - ${d.message}`);
                if (d.source) lines.push(`  Source: ${d.source}`);
                lines.push("");
              }
            }

            if (info.length > 0) {
              lines.push(`## Info (${info.length})\n`);
              for (const d of info) {
                lines.push(`- **Line ${d.line}:${d.column}** - ${d.message}`);
                if (d.source) lines.push(`  Source: ${d.source}`);
                lines.push("");
              }
            }

            return ok(lines.join("\n"), {
              count: diagnostics.length,
              errors: errors.length,
              warnings: warnings.length,
              info: info.length,
            });
          }
        }
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}
