// src/mcp/client.ts — MCP (Model Context Protocol) client
//
// Connects to MCP servers and exposes their resources/tools to clawd agents.
// Supports stdio-based and HTTP-based MCP servers.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, ChildProcess } from "child_process";
import { logger } from "../core/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: any;
}

// ── MCP Client Manager ────────────────────────────────────────────────────────

export class McpClientManager {
  private clients: Map<string, Client> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private transports: Map<string, StdioClientTransport | StreamableHTTPClientTransport> = new Map();
  private connected: Map<string, boolean> = new Map();
  private transportTypes: Map<string, 'stdio' | 'http'> = new Map();

  /**
   * Connect to an MCP server (stdio transport)
   */
  async connect(serverName: string, config: McpServerConfig): Promise<void> {
    try {
      logger.info(`[MCP] Connecting to stdio server: ${serverName}`);

      // Spawn the MCP server process
      const serverProcess = spawn(config.command, config.args || [], {
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.processes.set(serverName, serverProcess);

      // Create stdio transport
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });

      // Create MCP client
      const client = new Client(
        {
          name: "clawd",
          version: "1.0.0",
        },
        {
          capabilities: {
            roots: {
              listChanged: true,
            },
            sampling: {},
          },
        }
      );

      await client.connect(transport);

      this.clients.set(serverName, client);
      this.transports.set(serverName, transport);
      this.connected.set(serverName, true);
      this.transportTypes.set(serverName, 'stdio');

      logger.info(`[MCP] Connected to stdio server: ${serverName}`);
    } catch (e: any) {
      logger.error(`[MCP] Failed to connect to ${serverName}: ${e.message}`);
      throw e;
    }
  }

  /**
   * Connect to an HTTP MCP server (streamable HTTP transport)
   */
  async connectHttp(serverName: string, config: McpHttpServerConfig): Promise<void> {
    try {
      logger.info(`[MCP] Connecting to HTTP server: ${serverName} at ${config.url}`);

      // Create HTTP transport with connection timeout
      const url = new URL(config.url);
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: config.headers || {},
        },
        reconnectionOptions: {
          maxRetries: 0,  // Don't retry on initial connection
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 5000,
          reconnectionDelayGrowFactor: 1.5,
        },
      });

      // Create MCP client
      const client = new Client(
        {
          name: "clawd",
          version: "1.0.0",
        },
        {
          capabilities: {
            roots: {
              listChanged: true,
            },
            sampling: {},
          },
        }
      );

      // Connect with explicit error handling
      await client.connect(transport);

      this.clients.set(serverName, client);
      this.transports.set(serverName, transport);
      this.connected.set(serverName, true);
      this.transportTypes.set(serverName, 'http');

      logger.info(`[MCP] Connected to HTTP server: ${serverName}`);
    } catch (e: any) {
      logger.error(`[MCP] Failed to connect to HTTP server ${serverName}: ${e.message}`);
      throw e;
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    const transport = this.transports.get(serverName);
    const process = this.processes.get(serverName);
    const transportType = this.transportTypes.get(serverName);

    if (client) {
      try {
        await client.close();
      } catch (e: any) {
        logger.warn(`[MCP] Error closing client ${serverName}: ${e.message}`);
      }
      this.clients.delete(serverName);
    }

    if (transport) {
      try {
        await transport.close();
      } catch (e: any) {
        logger.warn(`[MCP] Error closing transport ${serverName}: ${e.message}`);
      }
      this.transports.delete(serverName);
    }

    if (process) {
      try {
        process.kill();
      } catch (e: any) {
        logger.warn(`[MCP] Error killing process ${serverName}: ${e.message}`);
      }
      this.processes.delete(serverName);
    }

    this.connected.set(serverName, false);
    this.transportTypes.delete(serverName);

    logger.info(`[MCP] Disconnected from ${transportType || 'unknown'} server: ${serverName}`);
  }

  /**
   * Disconnect all servers
   */
  async disconnectAll(): Promise<void> {
    const serverNames = Array.from(this.clients.keys());
    for (const name of serverNames) {
      await this.disconnect(name);
    }
  }

  /**
   * List resources from an MCP server
   */
  async listResources(serverName: string): Promise<McpResource[]> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

    try {
      const response = await client.listResources();
      return response.resources.map(r => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    } catch (e: any) {
      logger.error(`[MCP] Failed to list resources from ${serverName}: ${e.message}`);
      throw e;
    }
  }

  /**
   * List resources from all connected servers
   */
  async listAllResources(): Promise<Map<string, McpResource[]>> {
    const results = new Map<string, McpResource[]>();

    for (const [serverName, client] of this.clients.entries()) {
      if (!this.connected.get(serverName)) continue;

      try {
        const resources = await this.listResources(serverName);
        results.set(serverName, resources);
      } catch (e: any) {
        logger.warn(`[MCP] Failed to list resources from ${serverName}: ${e.message}`);
        results.set(serverName, []);
      }
    }

    return results;
  }

  /**
   * Read a resource from an MCP server
   */
  async readResource(serverName: string, uri: string): Promise<string> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

    try {
      const response = await client.readResource({ uri });

      // Handle different content types
      if (Array.isArray(response.contents)) {
        return response.contents
          .map((c: any) => {
            if ('text' in c && c.text) return c.text;
            if ('blob' in c && c.blob) return `[Binary data: ${c.mimeType || 'unknown'}]`;
            return '';
          })
          .join('\n');
      }

      return String(response.contents);
    } catch (e: any) {
      logger.error(`[MCP] Failed to read resource ${uri} from ${serverName}: ${e.message}`);
      throw e;
    }
  }

  /**
   * List tools from an MCP server
   */
  async listTools(serverName: string): Promise<McpTool[]> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

    try {
      const response = await client.listTools();
      return response.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    } catch (e: any) {
      logger.error(`[MCP] Failed to list tools from ${serverName}: ${e.message}`);
      throw e;
    }
  }

  /**
   * Call a tool on an MCP server
   */
  async callTool(serverName: string, toolName: string, args: any): Promise<any> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

    try {
      const response = await client.callTool({
        name: toolName,
        arguments: args,
      });

      return response.content;
    } catch (e: any) {
      logger.error(`[MCP] Failed to call tool ${toolName} on ${serverName}: ${e.message}`);
      throw e;
    }
  }

  /**
   * Check if a server is connected
   */
  isConnected(serverName: string): boolean {
    return this.connected.get(serverName) || false;
  }

  /**
   * Get list of connected servers
   */
  getConnectedServers(): string[] {
    return Array.from(this.clients.keys()).filter(name => this.isConnected(name));
  }

  /**
   * Get transport type for a server
   */
  getTransportType(serverName: string): 'stdio' | 'http' | undefined {
    return this.transportTypes.get(serverName);
  }

  /**
   * Get list of connected servers by transport type
   */
  getConnectedServersByType(type: 'stdio' | 'http'): string[] {
    return this.getConnectedServers().filter(name => this.getTransportType(name) === type);
  }
}

// ── Singleton instance ────────────────────────────────────────────────────────

let mcpManager: McpClientManager | null = null;

export function getMcpManager(): McpClientManager {
  if (!mcpManager) {
    mcpManager = new McpClientManager();
  }
  return mcpManager;
}

export async function shutdownMcp(): Promise<void> {
  if (mcpManager) {
    await mcpManager.disconnectAll();
    mcpManager = null;
  }
}
