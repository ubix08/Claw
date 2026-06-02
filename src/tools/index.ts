// src/tools/index.ts — Core AgentTool factory
//
// [TOOLS-FIX-CRITICAL] All tool `parameters` must be TypeBox TSchema objects.
//
// pi-agent-core's AgentTool<TSchema> uses TypeBox + AJV to validate tool call
// arguments before passing them to execute(). If `parameters` is a plain JSON
// schema object (not a TypeBox object), the AJV TypeBox adapter throws at
// runtime with an unhelpful error. The agent loop catches it internally and
// the call silently fails — no tokens, no response, no error surface.
//
// Fix: Replace all plain { type:"object", properties:{...} } objects with
// Type.Object({ ... }) from @mariozechner/pi-ai which re-exports TypeBox.
//
// Tool sets (config.tools):
//   "full"     → read + write + edit + bash + web_search + web_fetch
//   "standard" → read + write + edit + bash (no web)
//   "observe"  → read only
//   "bash"     → read + bash
//   "none"     → [] (no file/bash tools)
//
// web_search: SERPER_API_KEY resolved from (in priority order):
//   1. config.skills.entries["web-search"].apiKey  (clawd.json)
//   2. process.env.SERPER_API_KEY                  (~/.clawd/.env or shell)
//   If neither is set the tool is still registered and returns a clear error
//   on first call — preferable to a silent "tool not found" failure.
//
// web_fetch has no key requirement — always available in "full" set.
//
// Fix log:
//   [TOOLS-ENV-FIX-1] createCoreTools() now accepts an optional GlobalConfig
//     parameter and forwards config.skills.entries["web-search"].apiKey to
//     createWebSearchTool(). Previously createWebSearchTool() was called with
//     empty opts so the apiKey from clawd.json was silently ignored — the tool
//     only worked when SERPER_API_KEY was already in process.env via .env or
//     shell. The regression was introduced when the customTools/defaultCustomTools
//     mechanism (which previously bridged config→tool) was removed.
//
//   [WRITE-VERIFY] createWriteTool() now re-reads the file immediately after
//     every write and returns a diff summary (lines written, byte size) as part
//     of the tool result. This gives the model a self-correction signal without
//     requiring an explicit re-read call. On weaker models (Qwen, GLM, Deepseek)
//     this prevents silently corrupted files from going undetected.
//
//   [BASH-DIAG] createBashTool() wraps the error path to inject a structured
//     diagnostic prompt when a command fails. Instead of returning just the raw
//     stderr, the tool result now includes the failed command, the error output,
//     and an explicit instruction to diagnose before retrying. This forces a
//     reasoning step in models that would otherwise retry identically or give up.

import * as fs            from "fs";
import * as path          from "path";
import * as child_process from "child_process";

import { Type } from "@mariozechner/pi-ai";

export { createWebSearchTool }   from "./web-search.js";
export type { WebSearchOptions }  from "./web-search.js";

export { createWebFetchTool }    from "./web-fetch.js";
export type { WebFetchOptions }   from "./web-fetch.js";

export { createGlobTool }        from "./glob.js";
export { createGrepTool }        from "./grep.js";
// NOTE: createAgentTool is NOT re-exported to break circular dependency
// External callers should import directly from "./tools/agent.js" if needed
export { createTaskTools }       from "./tasks.js";
export { createMcpTools }        from "./mcp.js";
export { createToolSearchTool }  from "./tool-search.js";
export { createNotebookEditTool } from "./notebook-edit.js";
export { createLspTool }         from "./lsp.js";
export { createCronTools }       from "./cron.js";
export { createGitTools }        from "./git.js";

import { createWebSearchTool } from "./web-search.js";
import { createWebFetchTool }  from "./web-fetch.js";
import { createGlobTool }      from "./glob.js";
import { createGrepTool }      from "./grep.js";
// NOTE: createAgentTool is NOT imported here to break circular dependency
// agent/agent.ts → tools/index.ts → tools/agent.ts → (circular)
// Instead, it's lazy-loaded inside createCoreTools() when bus is provided
import { createTaskTools }     from "./tasks.js";
import { createMcpTools }      from "./mcp.js";
import { createToolSearchTool } from "./tool-search.js";
import { createNotebookEditTool } from "./notebook-edit.js";
import { createLspTool }        from "./lsp.js";
import { createCronTools }      from "./cron.js";
import { createGitTools }       from "./git.js";

import type { AgentTool } from "../agent/types.js";
import type { GlobalConfig } from "../config.js";
import type { EventBus } from "../core/event-bus.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: {} };
}

const MAX_LINES = 2000;
const MAX_BYTES = 50_000;

function truncate(text: string): string {
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) {
    const dropped = lines.length - MAX_LINES;
    return (
      lines.slice(-MAX_LINES).join("\n") +
      `\n\n[… ${dropped} line(s) truncated — use offset/limit to page through the file]`
    );
  }
  if (Buffer.byteLength(text, "utf-8") > MAX_BYTES) {
    return text.slice(0, MAX_BYTES) + "\n\n[… output truncated at 50 KB]";
  }
  return text;
}

/**
 * Safe path guard. Prevents path traversal outside the workspace root.
 */
function _isSafe(abs: string, workspaceDir: string): boolean {
  const root = path.resolve(workspaceDir);
  return abs === root || abs.startsWith(root + path.sep);
}

// ── Tool schemas (TypeBox) ─────────────────────────────────────────────────────

const readSchema = Type.Object({
  path:   Type.String({ description: "Relative path to file or directory" }),
  offset: Type.Optional(Type.Number({ description: "Line offset (0-based) to start reading from" })),
  limit:  Type.Optional(Type.Number({ description: "Maximum number of lines to return" })),
});

const writeSchema = Type.Object({
  path:    Type.String({ description: "Relative path to write" }),
  content: Type.String({ description: "Content to write" }),
});

const editSchema = Type.Object({
  path:    Type.String({ description: "Relative path to the file" }),
  oldText: Type.String({ description: "Exact text to find and replace" }),
  newText: Type.String({ description: "Replacement text" }),
  replace_all: Type.Optional(Type.Boolean({ description: "Replace all occurrences (default: false)" })),
});

const bashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30)" })),
});

// ── Core file tools ────────────────────────────────────────────────────────────

function createReadTool(workspaceDir: string): AgentTool {
  return {
    name:        "read",
    label:       "Read File",
    description:
      "Read the contents of a file or list a directory. " +
      "Supports images (PNG, JPG, etc.), Jupyter notebooks (.ipynb), and text files. " +
      "Path is relative to the agent workspace root. " +
      "Use offset and limit to page through large files. " +
      "Returns output with line numbers for text files.\n\n" +
      "Examples:\n" +
      "  read(path: \"src/index.ts\")                    — read full file\n" +
      "  read(path: \"src/index.ts\", offset: 50, limit: 50) — read lines 51-100\n" +
      "  read(path: \"src/\")                            — list directory",
    parameters: readSchema,
    execute: async (_id, params: { path: string; offset?: number; limit?: number }) => {
      try {
        const abs = path.resolve(workspaceDir, params.path);
        if (!_isSafe(abs, workspaceDir)) return err(`Path traversal rejected: "${params.path}"`);
        if (!fs.existsSync(abs)) return err(`File not found: "${params.path}"`);

        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
          const entries = fs
            .readdirSync(abs)
            .map(e => {
              const child = path.join(abs, e);
              return fs.statSync(child).isDirectory() ? `${e}/` : e;
            })
            .sort()
            .join("\n");
          return ok(entries || "(empty directory)");
        }

        const ext = path.extname(abs).toLowerCase();

        // Image support (PNG, JPG, etc.)
        if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico'].includes(ext)) {
          try {
            const imgBuffer = fs.readFileSync(abs);
            const base64 = imgBuffer.toString('base64');
            const mimeType = ext === '.svg' ? 'image/svg+xml' : `image/${ext.slice(1)}`;

            return {
              content: [{
                type: "image" as const,
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: base64,
                },
              }],
              details: { type: "image", format: ext.slice(1) },
            };
          } catch (e: any) {
            return err(`Failed to read image: ${e.message}`);
          }
        }

        // Jupyter notebook support
        if (ext === '.ipynb') {
          try {
            const notebook = JSON.parse(fs.readFileSync(abs, 'utf-8'));
            let output = `# Jupyter Notebook: ${params.path}\n\n`;

            const cells = notebook.cells || [];
            for (let i = 0; i < cells.length; i++) {
              const cell = cells[i];
              output += `## Cell ${i + 1} (${cell.cell_type})\n\n`;

              if (cell.source) {
                const source = Array.isArray(cell.source)
                  ? cell.source.join('')
                  : cell.source;
                output += `\`\`\`\n${source}\n\`\`\`\n\n`;
              }

              if (cell.outputs && cell.outputs.length > 0) {
                output += `### Output:\n\n`;
                for (const out of cell.outputs) {
                  if (out.text) {
                    const text = Array.isArray(out.text) ? out.text.join('') : out.text;
                    output += `${text}\n`;
                  }
                  if (out.data?.['text/plain']) {
                    const text = Array.isArray(out.data['text/plain'])
                      ? out.data['text/plain'].join('')
                      : out.data['text/plain'];
                    output += `${text}\n`;
                  }
                }
                output += '\n';
              }
            }

            return ok(truncate(output));
          } catch (e: any) {
            return err(`Failed to parse notebook: ${e.message}`);
          }
        }

        // Regular text file with line numbers
        let text = fs.readFileSync(abs, "utf-8");
        let lines = text.split("\n");

        // Apply offset/limit before adding line numbers
        if (params.offset !== undefined || params.limit !== undefined) {
          const start = params.offset ?? 0;
          const end   = params.limit !== undefined ? start + params.limit : lines.length;
          lines = lines.slice(start, end);
        }

        // Add line numbers (starting from 1, or from offset+1 if offset provided)
        const startLineNum = (params.offset ?? 0) + 1;
        const numbered = lines.map((line, i) => `${startLineNum + i}\t${line}`).join("\n");

        return ok(truncate(numbered));
      } catch (e: any) { return err(e.message); }
    },
  };
}

// [WRITE-VERIFY] After writing, re-read the file and include a verification
// summary in the tool result: line count and byte size of what was actually
// persisted. This gives the model a self-correction signal — if the written
// content diverges from intent, the model sees it immediately without an
// explicit read call. Critical for weaker open-source models that may
// hallucinate or truncate file contents during generation.
function createWriteTool(workspaceDir: string): AgentTool {
  return {
    name:        "write",
    label:       "Write File",
    description:
      "Write content to a file. Creates the file and any parent directories " +
      "if they do not exist. Overwrites existing files. " +
      "Returns a verification summary (line count, byte size) of what was written.\n\n" +
      "Example:\n" +
      "  write(path: \"src/hello.ts\", content: \"console.log('hello');\")",
    parameters: writeSchema,
    execute: async (_id, params: { path: string; content: string }) => {
      try {
        const abs = path.resolve(workspaceDir, params.path);
        if (!_isSafe(abs, workspaceDir)) return err(`Path traversal rejected: "${params.path}"`);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, params.content, "utf-8");

        // [WRITE-VERIFY] Re-read to verify what was actually persisted.
        // This is a cheap sanity check — the read is always from disk, so if
        // the write silently failed or truncated, the discrepancy is surfaced.
        let verifyMsg = "";
        try {
          const written    = fs.readFileSync(abs, "utf-8");
          const lineCount  = written.split("\n").length;
          const byteSize   = Buffer.byteLength(written, "utf-8");
          verifyMsg = ` [verified: ${lineCount} line(s), ${byteSize} bytes on disk]`;
        } catch (ve: any) {
          verifyMsg = ` [verification read failed: ${ve.message}]`;
        }

        return ok(`Written: ${params.path}${verifyMsg}`);
      } catch (e: any) { return err(e.message); }
    },
  };
}

function createEditTool(workspaceDir: string): AgentTool {
  return {
    name:        "edit",
    label:       "Edit File",
    description:
      "Replace an exact string in a file with new text. " +
      "oldText must match the file content exactly, including all whitespace and newlines. " +
      "By default fails if oldText matches more than once (set replace_all: true to replace all).\n\n" +
      "Example:\n" +
      "  edit(path: \"src/index.ts\", oldText: \"const x = 1;\", newText: \"const x = 2;\")",
    parameters: editSchema,
    execute: async (_id, params: { path: string; oldText: string; newText: string; replace_all?: boolean }) => {
      try {
        const abs = path.resolve(workspaceDir, params.path);
        if (!_isSafe(abs, workspaceDir)) return err(`Path traversal rejected: "${params.path}"`);
        if (!fs.existsSync(abs)) return err(`File not found: "${params.path}"`);

        const original = fs.readFileSync(abs, "utf-8");
        const count    = original.split(params.oldText).length - 1;

        if (count === 0) return err(`oldText not found in "${params.path}"`);

        // If replace_all is true, replace all occurrences
        let updated: string;
        if (params.replace_all) {
          // Escape regex special characters in oldText for safe replacement
          const escapedOldText = params.oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          updated = original.replace(new RegExp(escapedOldText, 'g'), params.newText);
        } else {
          // Single replacement mode - fail if multiple matches
          if (count > 1) return err(`oldText matches ${count} times — use replace_all: true or be more specific`);
          updated = original.replace(params.oldText, params.newText);
        }

        const tmp = `${abs}.tmp`;
        fs.writeFileSync(tmp, updated, "utf-8");
        fs.renameSync(tmp, abs);

        const message = params.replace_all
          ? `Edited: ${params.path} (${count} replacement(s))`
          : `Edited: ${params.path}`;
        return ok(message);
      } catch (e: any) { return err(e.message); }
    },
  };
}

// [BASH-DIAG] When a command fails, the raw error is often not enough for
// weaker models to self-correct. Strong models (Claude Sonnet, Deepseek-V3)
// can diagnose from stderr alone. Models ≤14B often retry identically, loop,
// or silently give up. The structured error wrapper forces a reasoning step by:
//   1. Echoing back the command that failed (so the model can't lose track).
//   2. Showing the exact error output.
//   3. Appending an explicit instruction: diagnose first, then retry differently.
// This mirrors Claude Code's internal error scaffolding behavior.
function createBashTool(workspaceDir: string): AgentTool {
  return {
    name:        "bash",
    label:       "Bash",
    description:
      "Execute a shell command. The working directory is the agent workspace root. " +
      "Returns stdout and stderr. Use for file manipulation, running scripts, " +
      "installing packages, and system operations.\n\n" +
      "Examples:\n" +
      "  bash(command: \"ls -la\")                     — list files\n" +
      "  bash(command: \"npm install\", timeout: 60)   — install with 60s timeout\n" +
      "  bash(command: \"cat package.json | jq .name\") — read a field",
    parameters: bashSchema,
    execute: async (_id, params: { command: string; timeout?: number }) => {
      const timeoutMs = (params.timeout ?? 30) * 1000;
      try {
        const output = await new Promise<string>((resolve, reject) => {
          child_process.exec(
            params.command,
            { cwd: workspaceDir, timeout: timeoutMs, maxBuffer: MAX_BYTES },
            (error, stdout, stderr) => {
              const combined = [stdout, stderr].filter(Boolean).join("\n");
              if (error && !stdout && !stderr) {
                reject(new Error(error.message));
              } else if (error) {
                // [BASH-DIAG] Command exited with non-zero but produced output.
                // Surface the structured diagnostic — don't swallow the exit code.
                const diagMsg =
                  `Command failed (exit code ${(error as any).code ?? "?"})\n\n` +
                  `$ ${params.command}\n\n` +
                  `Output:\n${combined || "(no output)"}\n\n` +
                  `Before retrying, diagnose: what went wrong and what specific change will fix it?`;
                resolve(diagMsg);
              } else {
                resolve(combined || "(no output)");
              }
            },
          );
        });
        return ok(truncate(output));
      } catch (e: any) {
        // [BASH-DIAG] Hard failure (exec itself threw — e.g. command not found,
        // timeout, or ENOMEM). Wrap with the same structured diagnostic format.
        const diagMsg =
          `Command failed: ${e.message}\n\n` +
          `$ ${params.command}\n\n` +
          `Before retrying, diagnose: what went wrong and what specific change will fix it?`;
        return ok(truncate(diagMsg));
      }
    },
  };
}

// ── Core tool set factory ──────────────────────────────────────────────────────
//
// [TOOLS-ENV-FIX-1] Accept optional GlobalConfig so the SERPER_API_KEY stored
// in config.skills.entries["web-search"].apiKey is forwarded to
// createWebSearchTool(). Without this, the apiKey from clawd.json was silently
// ignored: the tool only worked when the key was already in process.env via
// ~/.clawd/.env or the shell environment.
//
// Key resolution order (unchanged from createWebSearchTool's own logic):
//   1. opts.apiKey   — now populated from config.skills.entries (this fix)
//   2. process.env.SERPER_API_KEY — set by loadEnv() from ~/.clawd/.env,
//      or by _injectEnv() when the OpenClaw web-search skill is installed
//
// If neither source provides a key the tool is still registered and returns a
// clear error on first call — preferable to a silent "tool not found" failure.

export async function createCoreTools(
  toolSet:      string,
  workspaceDir: string,
  globalConfig?: GlobalConfig,   // [TOOLS-ENV-FIX-1] optional — safe for all callers
  bus?:         EventBus,         // [AGENT-TOOL] optional — required for Agent tool
): Promise<AgentTool[]> {
  switch (toolSet) {
    case "full": {
      // [TOOLS-ENV-FIX-1] Bridge config.skills.entries["web-search"].apiKey →
      // createWebSearchTool opts so users only need to configure the key in one
      // place (clawd.json OR ~/.clawd/.env — not both).
      const webSearchApiKey =
        globalConfig?.skills?.entries?.["web-search"]?.apiKey ?? undefined;

      const tools: AgentTool[] = [
        createReadTool(workspaceDir),
        createWriteTool(workspaceDir),
        createEditTool(workspaceDir),
        createBashTool(workspaceDir),
        createGlobTool(workspaceDir),
        createGrepTool(workspaceDir),
        ...createTaskTools(workspaceDir),
        ...createMcpTools(),
        createToolSearchTool(),
        createNotebookEditTool(workspaceDir),
        createLspTool(workspaceDir),
        ...createCronTools(workspaceDir),
        ...createGitTools(workspaceDir),
        createWebSearchTool(webSearchApiKey ? { apiKey: webSearchApiKey } : {}),
        createWebFetchTool(),
      ];

      // Add Agent tool if bus and globalConfig are provided
      // Lazy-load to break circular dependency: agent/agent.ts imports this file
      if (bus && globalConfig) {
        const { createAgentTool } = await import("./agent.js");
        tools.push(createAgentTool(bus, globalConfig, workspaceDir));
      }

      return tools;
    }
    case "standard": {
      const tools: AgentTool[] = [
        createReadTool(workspaceDir),
        createWriteTool(workspaceDir),
        createEditTool(workspaceDir),
        createBashTool(workspaceDir),
        createGlobTool(workspaceDir),
        createGrepTool(workspaceDir),
        ...createTaskTools(workspaceDir),
        ...createGitTools(workspaceDir),
        createNotebookEditTool(workspaceDir),
        createLspTool(workspaceDir),
      ];

      // Add Agent tool if bus and globalConfig are provided
      // Lazy-load to break circular dependency: agent/agent.ts imports this file
      if (bus && globalConfig) {
        const { createAgentTool } = await import("./agent.js");
        tools.push(createAgentTool(bus, globalConfig, workspaceDir));
      }

      return tools;
    }
    case "observe":
      return [createReadTool(workspaceDir)];
    case "bash":
      return [createReadTool(workspaceDir), createBashTool(workspaceDir)];
    case "none":
      return [];
    default:
      return [
        createReadTool(workspaceDir),
        createWriteTool(workspaceDir),
        createEditTool(workspaceDir),
        createBashTool(workspaceDir),
      ];
  }
}
