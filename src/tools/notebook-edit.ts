// src/tools/notebook-edit.ts — Edit Jupyter notebook cells
//
// Enables editing of Jupyter notebook (.ipynb) cells by cell index.
// Complements the Read tool's notebook visualization support.

import * as fs from "fs";
import * as path from "path";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "../agent/types.js";

// ── Schema ────────────────────────────────────────────────────────────────────

const notebookEditSchema = Type.Object({
  path: Type.String({
    description: "Relative path to the Jupyter notebook file (.ipynb)"
  }),
  cell_index: Type.Number({
    description: "Index of the cell to edit (0-based)"
  }),
  new_source: Type.String({
    description: "New source code/markdown for the cell"
  }),
  cell_type: Type.Optional(Type.String({
    description: "Cell type: 'code' or 'markdown' (optional, preserves existing type if omitted)"
  })),
});

// ── Helper Functions ──────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: {} };
}

function _isSafe(abs: string, workspaceDir: string): boolean {
  const root = path.resolve(workspaceDir);
  return abs === root || abs.startsWith(root + path.sep);
}

// ── Tool Factory ──────────────────────────────────────────────────────────────

export function createNotebookEditTool(workspaceDir: string): AgentTool {
  return {
    name: "notebook_edit",
    label: "Edit Notebook Cell",
    description:
      "Edit a cell in a Jupyter notebook (.ipynb file) by cell index. " +
      "Use the Read tool first to view cell indices, then edit specific cells. " +
      "Preserves cell outputs and metadata.",
    parameters: notebookEditSchema,
    execute: async (_id, params: {
      path: string;
      cell_index: number;
      new_source: string;
      cell_type?: string;
    }) => {
      try {
        const abs = path.resolve(workspaceDir, params.path);
        if (!_isSafe(abs, workspaceDir)) {
          return err(`Path traversal rejected: "${params.path}"`);
        }
        if (!fs.existsSync(abs)) {
          return err(`File not found: "${params.path}"`);
        }

        const ext = path.extname(abs).toLowerCase();
        if (ext !== ".ipynb") {
          return err(`Not a Jupyter notebook: "${params.path}" (expected .ipynb)`);
        }

        // Parse notebook
        let notebook: any;
        try {
          notebook = JSON.parse(fs.readFileSync(abs, "utf-8"));
        } catch (e: any) {
          return err(`Failed to parse notebook: ${e.message}`);
        }

        if (!notebook.cells || !Array.isArray(notebook.cells)) {
          return err("Invalid notebook structure: missing 'cells' array");
        }

        // Validate cell index
        if (params.cell_index < 0 || params.cell_index >= notebook.cells.length) {
          return err(
            `Cell index ${params.cell_index} out of range. ` +
            `Notebook has ${notebook.cells.length} cells (0-${notebook.cells.length - 1})`
          );
        }

        const cell = notebook.cells[params.cell_index];

        // Update cell source
        // Jupyter notebooks store source as array of strings (one per line) or single string
        const newSourceLines = params.new_source.split("\n");
        cell.source = newSourceLines.map(line => line + "\n");

        // Optionally update cell type
        if (params.cell_type) {
          const validTypes = ["code", "markdown", "raw"];
          if (!validTypes.includes(params.cell_type)) {
            return err(`Invalid cell_type: "${params.cell_type}". Must be: ${validTypes.join(", ")}`);
          }
          cell.cell_type = params.cell_type;

          // Clear outputs when changing from code to non-code
          if (params.cell_type !== "code" && cell.outputs) {
            delete cell.outputs;
          }

          // Add outputs array if changing to code type
          if (params.cell_type === "code" && !cell.outputs) {
            cell.outputs = [];
          }
        }

        // Clear outputs for code cells (they'll be regenerated on next run)
        if (cell.cell_type === "code" && cell.outputs) {
          cell.outputs = [];
          cell.execution_count = null;
        }

        // Write back to file (with atomic write via temp file)
        const tmp = `${abs}.tmp`;
        try {
          fs.writeFileSync(tmp, JSON.stringify(notebook, null, 2) + "\n", "utf-8");
          fs.renameSync(tmp, abs);
        } catch (e: any) {
          // Clean up temp file if rename fails
          if (fs.existsSync(tmp)) {
            fs.unlinkSync(tmp);
          }
          return err(`Failed to write notebook: ${e.message}`);
        }

        const summary = [
          `Edited cell ${params.cell_index} in: ${params.path}`,
          `Cell type: ${cell.cell_type}`,
          `New source: ${newSourceLines.length} line(s)`,
        ];

        if (cell.cell_type === "code") {
          summary.push("Note: Cell outputs cleared (will regenerate on next run)");
        }

        return ok(summary.join("\n"));
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}
