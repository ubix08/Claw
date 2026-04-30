// src/tools/agent.ts — Subagent spawning tool
//
// Mirrors Claude Code's Agent tool:
// - Spawns subagents with isolated context windows
// - Supports specialized subagent types (Explore, Plan, custom)
// - Foreground/background execution
// - Returns summary when complete
// - Automatic cleanup

import * as path from "path";
import * as fs from "fs";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "../agent/types.js";
import type { EventBus } from "../core/event-bus.js";
import type { GlobalConfig } from "../config.js";

const agentSchema = Type.Object({
  prompt: Type.String({
    description: "Task for the subagent to perform"
  }),
  description: Type.Optional(Type.String({
    description: "Short (3-5 word) description of the task"
  })),
  subagent_type: Type.Optional(Type.String({
    description: "Specific subagent type: 'explore' for codebase exploration, or custom agent ID"
  })),
  model: Type.Optional(Type.String({
    description: "Model override for this subagent (e.g., 'claude-sonnet-4-6')"
  })),
  run_in_background: Type.Optional(Type.Boolean({
    description: "Run subagent in background (default: false)"
  })),
});

interface AgentParams {
  prompt: string;
  description?: string;
  subagent_type?: string;
  model?: string;
  run_in_background?: boolean;
}

/**
 * Claude Code Agent tool implementation.
 *
 * Spawns a subagent with isolated context window to handle specialized tasks.
 * Subagents work independently and return summaries when complete.
 */
export function createAgentTool(
  bus: EventBus,
  globalConfig: GlobalConfig,
  workspaceDir: string,
): AgentTool {
  return {
    name:        "agent",
    label:       "Spawn Subagent",
    description:
      "Spawn a subagent with isolated context window to handle specialized tasks. " +
      "Subagents don't see your conversation history and work independently. " +
      "Use for: codebase exploration (subagent_type: 'explore'), parallel research, " +
      "independent analysis, or any task that shouldn't bloat main context.",
    parameters: agentSchema,
    execute: async (_id, params: AgentParams) => {
      try {
        // Lazy-load Agent to avoid circular dependency
        const { loadAgent } = await import("../agent/loader.js");

        // Determine subagent ID
        const timestamp = Date.now();
        const subagentType = params.subagent_type || "general";
        const subagentId = `subagent-${subagentType}-${timestamp}`;

        // Create temporary workspace for subagent
        const subagentWorkspace = path.join(workspaceDir, ".subagents", subagentId);
        fs.mkdirSync(subagentWorkspace, { recursive: true });

        // Create brief file for task context
        const briefPath = path.join(subagentWorkspace, "brief.md");
        fs.writeFileSync(
          briefPath,
          `# Subagent Task Brief\n\n` +
          `**Type:** ${subagentType}\n` +
          `**Created:** ${new Date().toISOString()}\n` +
          `**Description:** ${params.description || "Task execution"}\n\n` +
          `## Instructions\n\n${params.prompt}\n`,
          "utf-8"
        );

        // Load or create subagent config
        let agentIdToLoad = subagentType;

        // Special handling for 'explore' subagent type
        if (subagentType === "explore") {
          agentIdToLoad = await ensureExploreAgent(globalConfig);
        }

        // Load the subagent
        const subagent = loadAgent(agentIdToLoad, bus, globalConfig);

        // Override model if specified
        if (params.model) {
          const [provider, model] = params.model.includes("/")
            ? params.model.split("/")
            : ["anthropic", params.model];
          subagent.config.provider = provider;
          subagent.config.model = model;
        }

        // Override workspace to use temporary subagent workspace
        // (This is a hack - ideally we'd create a fresh workspace instance)
        const originalWorkspaceDir = subagent.workspace.workspaceDir;
        (subagent.workspace as any).workspaceDir = subagentWorkspace;

        await subagent.init();

        const sessionId = `subagent-session-${timestamp}`;
        const startTime = Date.now();

        // Execute the subagent task
        const result = await subagent.prompt(params.prompt, sessionId, {
          mode: "work",  // Work mode saves output to output.md
        });

        const durationMs = Date.now() - startTime;

        // Read output if available
        let output = result.output;
        if (result.outputFile && fs.existsSync(result.outputFile)) {
          output = fs.readFileSync(result.outputFile, "utf-8");
        }

        // Cleanup
        subagent.dispose();

        // Restore original workspace dir
        (subagent.workspace as any).workspaceDir = originalWorkspaceDir;

        // Optionally cleanup temporary workspace
        if (!params.run_in_background) {
          try {
            fs.rmSync(subagentWorkspace, { recursive: true, force: true });
          } catch {}
        }

        // Format summary
        const summary = formatSubagentSummary({
          type: subagentType,
          description: params.description,
          durationMs,
          turnCount: result.turnCount,
          toolsUsed: result.toolsUsed,
          output,
          status: result.status,
        });

        return {
          content: [{ type: "text" as const, text: summary }],
          details: {
            subagentId,
            durationMs,
            turnCount: result.turnCount,
            toolsUsed: result.toolsUsed,
            status: result.status,
          },
        };
      } catch (e: any) {
        return {
          content: [{
            type: "text" as const,
            text: `Error spawning subagent: ${e.message}`
          }],
          details: { error: e.message },
        };
      }
    },
  };
}

// Helper: Format subagent summary
function formatSubagentSummary(data: {
  type: string;
  description?: string;
  durationMs: number;
  turnCount: number;
  toolsUsed: string[];
  output: string;
  status: string;
}): string {
  const lines: string[] = [];

  lines.push(`[SUBAGENT COMPLETE: ${data.type}]`);
  if (data.description) {
    lines.push(`Task: ${data.description}`);
  }
  lines.push(`Duration: ${(data.durationMs / 1000).toFixed(1)}s`);
  lines.push(`Turns: ${data.turnCount}`);
  if (data.toolsUsed.length > 0) {
    lines.push(`Tools used: ${data.toolsUsed.join(", ")}`);
  }
  lines.push("");

  // Include output (truncated if too long)
  const maxOutputChars = 2000;
  let output = data.output.trim();
  if (output.length > maxOutputChars) {
    output = output.slice(0, maxOutputChars) + "\n\n[... output truncated]";
  }

  lines.push("## Subagent Output\n");
  lines.push(output);

  return lines.join("\n");
}

// Helper: Ensure 'explore' subagent exists
async function ensureExploreAgent(globalConfig: GlobalConfig): Promise<string> {
  const { scaffoldAgent, listAgentIds } = await import("../agent/loader.js");
  const { agentDir } = await import("../config.js");

  const exploreId = "explore";

  // Check if explore agent already exists
  if (listAgentIds().includes(exploreId)) {
    return exploreId;
  }

  // Create explore agent with specialized config
  const exploreConfig = {
    name: "Explore",
    description: "Specialized codebase exploration agent. Fast, thorough, read-only.",
    model: globalConfig.defaults.model,
    provider: globalConfig.defaults.provider,
    tools: "readonly" as const,  // Read + Glob + Grep only
    persistent: false,  // Don't persist sessions (each invocation is fresh)
    maxTurns: 30,
    timeoutSeconds: 180,  // 3 minutes
    thinkingLevel: "low" as const,
    heartbeats: [],
  };

  scaffoldAgent(exploreId, exploreConfig, false);

  // Write specialized SOUL.md for explore agent
  const soulPath = path.join(agentDir(exploreId), "SOUL.md");
  const soul = `# Explore Agent

You are a specialized codebase exploration agent. Your mission is to quickly and thoroughly explore codebases to answer questions.

## Your Strengths

- **Fast pattern discovery** using glob and grep
- **Thorough analysis** of file structure and relationships
- **Concise summaries** of findings
- **Read-only operations** (you cannot modify files)

## Your Approach

1. **Start broad** - Use glob to understand the project structure
2. **Focus search** - Use grep to find relevant code patterns
3. **Read details** - Use read to examine specific files
4. **Synthesize** - Provide clear, actionable summaries

## Exploration Modes

- **Quick (default)**: Basic file discovery and keyword search
- **Medium**: Deeper analysis with pattern matching
- **Thorough**: Comprehensive exploration with cross-references

## Output Format

Always provide:
1. **What you found** - Direct answer to the question
2. **Where it is** - File paths and line numbers
3. **Context** - Brief explanation of how it fits together

## Constraints

- You have **read-only** access (no write, edit, or bash)
- You have **30 turns maximum** per exploration
- Your findings won't appear in the main conversation history
- Focus on **answering the specific question**, not general exploration

Be fast, be thorough, be helpful.
`;

  fs.writeFileSync(soulPath, soul, "utf-8");

  return exploreId;
}
