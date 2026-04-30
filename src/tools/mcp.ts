// src/tools/mcp.ts — MCP integration tools
//
// Tools that expose MCP server resources and capabilities to clawd agents:
// - ListMcpResourcesTool: Discover available resources
// - ReadMcpResourceTool: Read resource content

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "../agent/types.js";
import { getMcpManager } from "../mcp/client.js";

// ── Schemas ───────────────────────────────────────────────────────────────────

const listMcpResourcesSchema = Type.Object({
  server: Type.Optional(Type.String({
    description: "Specific MCP server to query (omit to list all)"
  })),
});

const readMcpResourceSchema = Type.Object({
  uri: Type.String({
    description: "MCP resource URI to read (e.g., 'file:///path/to/file')"
  }),
  server: Type.Optional(Type.String({
    description: "Specific MCP server to use (auto-detected if omitted)"
  })),
});

// ── Tool Factories ────────────────────────────────────────────────────────────

export function createListMcpResourcesTool(): AgentTool {
  return {
    name: "list_mcp_resources",
    label: "List MCP Resources",
    description:
      "List resources exposed by connected MCP servers. " +
      "Resources can be files, database tables, API endpoints, or any data source. " +
      "Use this to discover what's available before reading.",
    parameters: listMcpResourcesSchema,
    execute: async (_id, params: { server?: string }) => {
      try {
        const manager = getMcpManager();
        const connectedServers = manager.getConnectedServers();

        if (connectedServers.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No MCP servers connected. Configure MCP servers in clawd.json to enable."
            }],
            details: { count: 0 },
          };
        }

        // List resources from specific server or all servers
        let resourcesMap: Map<string, any[]>;

        if (params.server) {
          if (!manager.isConnected(params.server)) {
            return {
              content: [{
                type: "text" as const,
                text: `MCP server not connected: ${params.server}\nConnected servers: ${connectedServers.join(", ")}`
              }],
              details: {},
            };
          }
          const resources = await manager.listResources(params.server);
          resourcesMap = new Map([[params.server, resources]]);
        } else {
          resourcesMap = await manager.listAllResources();
        }

        // Format output
        const lines: string[] = [];
        let totalCount = 0;

        for (const [serverName, resources] of resourcesMap.entries()) {
          if (resources.length === 0) continue;

          lines.push(`\n## ${serverName} (${resources.length} resources)\n`);

          for (const resource of resources) {
            lines.push(`- **${resource.name}**`);
            lines.push(`  URI: \`${resource.uri}\``);
            if (resource.description) {
              lines.push(`  Description: ${resource.description}`);
            }
            if (resource.mimeType) {
              lines.push(`  Type: ${resource.mimeType}`);
            }
            lines.push("");
          }

          totalCount += resources.length;
        }

        if (totalCount === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No resources available from connected MCP servers."
            }],
            details: { count: 0 },
          };
        }

        const summary = `Total MCP resources: ${totalCount} across ${resourcesMap.size} server(s)\n`;
        const text = summary + lines.join("\n");

        return {
          content: [{ type: "text" as const, text }],
          details: { count: totalCount, servers: Array.from(resourcesMap.keys()) },
        };
      } catch (e: any) {
        return {
          content: [{
            type: "text" as const,
            text: `Error listing MCP resources: ${e.message}`
          }],
          details: { error: e.message },
        };
      }
    },
  };
}

export function createReadMcpResourceTool(): AgentTool {
  return {
    name: "read_mcp_resource",
    label: "Read MCP Resource",
    description:
      "Read content from an MCP resource by URI. " +
      "Resources can be files, database queries, API responses, etc. " +
      "Use list_mcp_resources first to discover available URIs.",
    parameters: readMcpResourceSchema,
    execute: async (_id, params: { uri: string; server?: string }) => {
      try {
        const manager = getMcpManager();
        const connectedServers = manager.getConnectedServers();

        if (connectedServers.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No MCP servers connected. Configure MCP servers in clawd.json to enable."
            }],
            details: {},
          };
        }

        let content: string | undefined;
        let usedServer: string | undefined;

        if (params.server) {
          // Use specified server
          if (!manager.isConnected(params.server)) {
            return {
              content: [{
                type: "text" as const,
                text: `MCP server not connected: ${params.server}\nConnected servers: ${connectedServers.join(", ")}`
              }],
              details: {},
            };
          }

          content = await manager.readResource(params.server, params.uri);
          usedServer = params.server;
        } else {
          // Auto-detect server by trying each one
          for (const serverName of connectedServers) {
            try {
              content = await manager.readResource(serverName, params.uri);
              usedServer = serverName;
              break;
            } catch (e: any) {
              // Try next server
              continue;
            }
          }

          if (!content || !usedServer) {
            return {
              content: [{
                type: "text" as const,
                text: `Resource not found: ${params.uri}\n` +
                      `Tried servers: ${connectedServers.join(", ")}\n` +
                      `Use list_mcp_resources to see available URIs.`
              }],
              details: {},
            };
          }
        }

        // Format response
        const header = `# MCP Resource: ${params.uri}\nServer: ${usedServer}\n\n`;
        const text = header + (content || "");

        return {
          content: [{ type: "text" as const, text }],
          details: { uri: params.uri, server: usedServer },
        };
      } catch (e: any) {
        return {
          content: [{
            type: "text" as const,
            text: `Error reading MCP resource: ${e.message}`
          }],
          details: { error: e.message },
        };
      }
    },
  };
}

// ── Export All MCP Tools ──────────────────────────────────────────────────────

export function createMcpTools(): AgentTool[] {
  return [
    createListMcpResourcesTool(),
    createReadMcpResourceTool(),
  ];
}
