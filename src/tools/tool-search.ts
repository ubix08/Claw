// src/tools/tool-search.ts — ToolSearch for deferred MCP tool loading
//
// Enables on-demand loading of MCP server tools to prevent context bloat.
// Tools are searched by keyword and returned with full JSONSchema definitions.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "../agent/types.js";
import { getMcpManager } from "../mcp/client.js";

// ── Schema ────────────────────────────────────────────────────────────────────

const toolSearchSchema = Type.Object({
  query: Type.String({
    description: "Search query: use 'select:tool1,tool2' for exact selection, or keywords to search tool names/descriptions"
  }),
  max_results: Type.Optional(Type.Number({
    description: "Maximum number of results to return (default: 5)"
  })),
});

// ── Tool Factory ──────────────────────────────────────────────────────────────

export function createToolSearchTool(): AgentTool {
  return {
    name: "tool_search",
    label: "Tool Search",
    description:
      "Search and load tool schemas from connected MCP servers on-demand. " +
      "Use 'select:tool_name' for exact matches or keywords to search. " +
      "Returns full JSONSchema definitions for matched tools so they can be called.",
    parameters: toolSearchSchema,
    execute: async (_id, params: { query: string; max_results?: number }) => {
      try {
        const manager = getMcpManager();
        const connectedServers = manager.getConnectedServers();

        if (connectedServers.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No MCP servers connected. Configure MCP servers in clawd.json to enable tool search."
            }],
            details: {},
          };
        }

        const maxResults = params.max_results ?? 5;
        const query = params.query.toLowerCase();
        const isExactSelect = query.startsWith("select:");

        // Collect all tools from all servers
        const allTools: Array<{
          serverName: string;
          tool: any;
          score: number;
        }> = [];

        for (const serverName of connectedServers) {
          try {
            const tools = await manager.listTools(serverName);

            for (const tool of tools) {
              let score = 0;

              if (isExactSelect) {
                // Exact selection mode: select:tool1,tool2,tool3
                const selectedNames = query
                  .replace("select:", "")
                  .split(",")
                  .map(s => s.trim());

                if (selectedNames.includes(tool.name)) {
                  score = 1000; // High score for exact matches
                }
              } else {
                // Keyword search mode
                const searchTerms = query.split(/\s+/);
                const toolText = `${tool.name} ${tool.description || ""}`.toLowerCase();

                for (const term of searchTerms) {
                  if (term.startsWith("+")) {
                    // Required term (must match)
                    const requiredTerm = term.slice(1);
                    if (!toolText.includes(requiredTerm)) {
                      score = -1000; // Disqualify if required term missing
                      break;
                    }
                  } else if (toolText.includes(term)) {
                    // Optional term (boosts score)
                    score += term.length; // Longer matches = higher score
                    if (tool.name.toLowerCase().includes(term)) {
                      score += 10; // Bonus for name matches
                    }
                  }
                }
              }

              if (score > 0) {
                allTools.push({ serverName, tool, score });
              }
            }
          } catch (e: any) {
            // Skip servers that fail to list tools
            continue;
          }
        }

        // Sort by score (descending) and limit results
        allTools.sort((a, b) => b.score - a.score);
        const topTools = allTools.slice(0, maxResults);

        if (topTools.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No tools found matching: "${params.query}"\n\n` +
                    `Try broader search terms or use list_mcp_resources to see available resources.`
            }],
            details: { count: 0 },
          };
        }

        // Format output as tool definitions
        const lines: string[] = [];
        lines.push(`# MCP Tool Search Results`);
        lines.push(`Query: "${params.query}"`);
        lines.push(`Found: ${topTools.length} tool(s)\n`);

        for (const { serverName, tool } of topTools) {
          lines.push(`## ${tool.name} (${serverName})`);
          if (tool.description) {
            lines.push(`**Description:** ${tool.description}\n`);
          }

          // Format input schema
          lines.push(`**Input Schema:**`);
          lines.push("```json");
          lines.push(JSON.stringify(tool.inputSchema, null, 2));
          lines.push("```\n");

          // Usage example
          lines.push(`**Usage:**`);
          lines.push("```typescript");
          lines.push(`// Call via read_mcp_resource if it returns data:`);
          lines.push(`read_mcp_resource({ uri: "mcp://${serverName}/${tool.name}", server: "${serverName}" })`);
          lines.push("```\n");
        }

        const text = lines.join("\n");

        return {
          content: [{ type: "text" as const, text }],
          details: {
            count: topTools.length,
            tools: topTools.map(t => ({
              name: t.tool.name,
              server: t.serverName,
              score: t.score,
            })),
          },
        };
      } catch (e: any) {
        return {
          content: [{
            type: "text" as const,
            text: `Error searching MCP tools: ${e.message}`
          }],
          details: { error: e.message },
        };
      }
    },
  };
}
