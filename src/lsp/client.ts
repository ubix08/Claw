// src/lsp/client.ts — LSP (Language Server Protocol) client
//
// Manages connections to language servers for code intelligence features:
// - Type checking, definitions, references, hover info
// - Diagnostics (errors, warnings)
// - Code completion (future)
//
// Fix log:
//   [LSP-FIX-1] Added initialize() to LspClientManager so gateway.ts can call
//     getLspManager().initialize() directly. Previously only LspServerConnection
//     had initialize(), causing TS2339 in gateway.ts:71. The new method auto-starts
//     the TypeScript/JavaScript language server using safe defaults (tsserver via
//     typescript-language-server --stdio) with the process CWD as rootUri.
//     No changes to GlobalConfig required — LSP config remains implicit/default.

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import { logger } from "../core/logger.js";
import {
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DefinitionRequest,
  ReferencesRequest,
  HoverRequest,
  PublishDiagnosticsNotification,
  type InitializeParams,
  type TextDocumentIdentifier,
  type Position,
  type Location,
  type Hover,
  type Diagnostic,
} from "vscode-languageserver-protocol";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LspServerConfig {
  command: string;
  args?: string[];
  rootUri: string;
  languages: string[]; // File extensions this server handles (e.g., [".ts", ".tsx"])
}

export interface LspDiagnostic {
  uri: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}

// ── LSP Client Manager ────────────────────────────────────────────────────────

export class LspClientManager {
  private servers: Map<string, LspServerConnection> = new Map();
  private diagnosticsCache: Map<string, LspDiagnostic[]> = new Map();

  /**
   * [LSP-FIX-1] Gateway entry-point: start the default TypeScript/JavaScript
   * language server (typescript-language-server --stdio) using the current
   * working directory as the project root.
   *
   * Called by gateway.ts inside a Promise.race() with a 10 s timeout so a
   * slow or missing tsserver never blocks startup.
   *
   * Design notes:
   *  - We do NOT read GlobalConfig here because LSP settings are not part of
   *    the config schema and adding them is out of scope for this fix.
   *  - rootUri is derived from process.cwd() — the same convention used by
   *    Claude Code and most LSP clients when no workspace config is present.
   *  - The server name "tsserver" is stable; callers that already have a
   *    running "tsserver" entry (e.g. from a manual startServer() call) will
   *    get the existing connection re-used via the guard below.
   */
  async initialize(): Promise<void> {
    const SERVER_NAME = "tsserver";

    // Idempotent — if startServer() was already called externally, skip.
    if (this.servers.has(SERVER_NAME)) {
      logger.debug("[LSP] initialize() called but tsserver already running — skipping");
      return;
    }

    const rootUri = `file://${process.cwd().replace(/\\/g, "/")}`;

    const config: LspServerConfig = {
      command:   "typescript-language-server",
      args:      ["--stdio"],
      rootUri,
      languages: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    };

    await this.startServer(SERVER_NAME, config);
  }

  /**
   * Start an LSP server
   */
  async startServer(name: string, config: LspServerConfig): Promise<void> {
    try {
      logger.info(`[LSP] Starting server: ${name}`);

      const connection = new LspServerConnection(name, config);
      await connection.initialize();

      this.servers.set(name, connection);

      // Subscribe to diagnostics
      connection.onDiagnostics((uri, diagnostics) => {
        this.diagnosticsCache.set(uri, diagnostics);
      });

      logger.info(`[LSP] Started ${name} for languages: ${config.languages.join(", ")}`);
    } catch (e: any) {
      logger.error(`[LSP] Failed to start ${name}: ${e.message}`);
      throw e;
    }
  }

  /**
   * Stop an LSP server
   */
  async stopServer(name: string): Promise<void> {
    const connection = this.servers.get(name);
    if (connection) {
      await connection.shutdown();
      this.servers.delete(name);
      logger.info(`[LSP] Stopped server: ${name}`);
    }
  }

  /**
   * Stop all servers
   */
  async stopAll(): Promise<void> {
    const names = Array.from(this.servers.keys());
    for (const name of names) {
      await this.stopServer(name);
    }
  }

  /**
   * Get server for a file path
   */
  private getServerForFile(filePath: string): LspServerConnection | undefined {
    const ext = filePath.substring(filePath.lastIndexOf("."));
    for (const connection of this.servers.values()) {
      if (connection.config.languages.includes(ext)) {
        return connection;
      }
    }
    return undefined;
  }

  /**
   * Go to definition
   */
  async getDefinition(filePath: string, line: number, column: number): Promise<Location[]> {
    const server = this.getServerForFile(filePath);
    if (!server) {
      throw new Error(`No LSP server available for: ${filePath}`);
    }
    return await server.getDefinition(filePath, line, column);
  }

  /**
   * Find references
   */
  async getReferences(filePath: string, line: number, column: number): Promise<Location[]> {
    const server = this.getServerForFile(filePath);
    if (!server) {
      throw new Error(`No LSP server available for: ${filePath}`);
    }
    return await server.getReferences(filePath, line, column);
  }

  /**
   * Get hover info
   */
  async getHover(filePath: string, line: number, column: number): Promise<Hover | null> {
    const server = this.getServerForFile(filePath);
    if (!server) {
      throw new Error(`No LSP server available for: ${filePath}`);
    }
    return await server.getHover(filePath, line, column);
  }

  /**
   * Get diagnostics for a file
   */
  getDiagnostics(filePath: string): LspDiagnostic[] {
    const uri = `file://${filePath}`;
    return this.diagnosticsCache.get(uri) || [];
  }

  /**
   * Get all diagnostics
   */
  getAllDiagnostics(): Map<string, LspDiagnostic[]> {
    return new Map(this.diagnosticsCache);
  }
}

// ── LSP Server Connection ─────────────────────────────────────────────────────

class LspServerConnection {
  private process: ChildProcess;
  private requestId = 0;
  private pendingRequests: Map<number, (result: any) => void> = new Map();
  private buffer = "";
  private diagnosticsCallback?: (uri: string, diagnostics: LspDiagnostic[]) => void;
  private spawnError?: Error;

  constructor(
    public name: string,
    public config: LspServerConfig
  ) {
    // Spawn LSP server process
    this.process = spawn(config.command, config.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Handle stdout (LSP messages)
    this.process.stdout?.on("data", (data: Buffer) => {
      this.handleData(data);
    });

    // Handle stderr (logs)
    this.process.stderr?.on("data", (data: Buffer) => {
      logger.debug(`[LSP ${name}] ${data.toString()}`);
    });

    // Handle exit
    this.process.on("exit", (code) => {
      logger.warn(`[LSP ${name}] Process exited with code ${code}`);
    });

    // Handle spawn errors (e.g., command not found)
    this.process.on("error", (err: Error) => {
      this.spawnError = err;
      logger.debug(`[LSP ${name}] Process error: ${err.message}`);
    });
  }

  /**
   * Initialize the LSP server
   */
  async initialize(): Promise<void> {
    // Wait a tick for spawn errors to surface
    await new Promise(resolve => setImmediate(resolve));

    // If spawn failed, throw error
    if (this.spawnError) {
      throw this.spawnError;
    }

    // If process exited immediately, throw error
    if (this.process.exitCode !== null) {
      throw new Error(`LSP server ${this.name} exited immediately with code ${this.process.exitCode}`);
    }

    const params: InitializeParams = {
      processId: process.pid,
      rootUri: this.config.rootUri,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false },
        },
      },
    };

    const result = await this.sendRequest(InitializeRequest.type.method, params);

    // Send initialized notification
    this.sendNotification(InitializedNotification.type.method, {});

    return result;
  }

  /**
   * Shutdown the server
   */
  async shutdown(): Promise<void> {
    await this.sendRequest("shutdown", {});
    this.sendNotification("exit", {});
    this.process.kill();
  }

  /**
   * Subscribe to diagnostics
   */
  onDiagnostics(callback: (uri: string, diagnostics: LspDiagnostic[]) => void): void {
    this.diagnosticsCallback = callback;
  }

  /**
   * Get definition at position
   */
  async getDefinition(filePath: string, line: number, column: number): Promise<Location[]> {
    const uri = `file://${filePath}`;
    const params = {
      textDocument: { uri },
      position: { line, character: column },
    };

    const result = await this.sendRequest(DefinitionRequest.type.method, params);

    if (!result) return [];
    if (Array.isArray(result)) return result;
    return [result];
  }

  /**
   * Get references at position
   */
  async getReferences(filePath: string, line: number, column: number): Promise<Location[]> {
    const uri = `file://${filePath}`;
    const params = {
      textDocument: { uri },
      position: { line, character: column },
      context: { includeDeclaration: true },
    };

    const result = await this.sendRequest(ReferencesRequest.type.method, params);
    return result || [];
  }

  /**
   * Get hover info at position
   */
  async getHover(filePath: string, line: number, column: number): Promise<Hover | null> {
    const uri = `file://${filePath}`;
    const params = {
      textDocument: { uri },
      position: { line, character: column },
    };

    const result = await this.sendRequest(HoverRequest.type.method, params);
    return result || null;
  }

  /**
   * Send LSP request
   */
  private sendRequest(method: string, params: any): Promise<any> {
    const id = ++this.requestId;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    this.sendMessage(message);

    return new Promise((resolve) => {
      this.pendingRequests.set(id, resolve);
    });
  }

  /**
   * Send LSP notification (no response expected)
   */
  private sendNotification(method: string, params: any): void {
    const message = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.sendMessage(message);
  }

  /**
   * Send message to LSP server
   */
  private sendMessage(message: any): void {
    const content = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n`;
    this.process.stdin?.write(header + content);
  }

  /**
   * Handle incoming data from LSP server
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    // Parse complete messages
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.substring(0, headerEnd);
      const match = header.match(/Content-Length: (\d+)/);
      if (!match) break;

      const contentLength = parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) break;

      const messageText = this.buffer.substring(messageStart, messageEnd);
      this.buffer = this.buffer.substring(messageEnd);

      try {
        const message = JSON.parse(messageText);
        this.handleMessage(message);
      } catch (e: any) {
        logger.error(`[LSP ${this.name}] Failed to parse message: ${e.message}`);
      }
    }
  }

  /**
   * Handle LSP message
   */
  private handleMessage(message: any): void {
    if ("id" in message && "result" in message) {
      // Response to a request
      const callback = this.pendingRequests.get(message.id);
      if (callback) {
        callback(message.result);
        this.pendingRequests.delete(message.id);
      }
    } else if ("method" in message) {
      // Notification from server
      if (message.method === PublishDiagnosticsNotification.type.method) {
        this.handleDiagnostics(message.params);
      }
    }
  }

  /**
   * Handle diagnostics notification
   */
  private handleDiagnostics(params: any): void {
    if (!this.diagnosticsCallback) return;

    const diagnostics: LspDiagnostic[] = (params.diagnostics || []).map((d: Diagnostic) => ({
      uri: params.uri,
      line: d.range.start.line,
      column: d.range.start.character,
      severity: ["error", "warning", "info", "hint"][d.severity! - 1] as any,
      message: d.message,
      source: d.source,
    }));

    this.diagnosticsCallback(params.uri, diagnostics);
  }
}

// ── Singleton instance ────────────────────────────────────────────────────────

let lspManager: LspClientManager | null = null;

export function getLspManager(): LspClientManager {
  if (!lspManager) {
    lspManager = new LspClientManager();
  }
  return lspManager;
}

export async function shutdownLsp(): Promise<void> {
  if (lspManager) {
    await lspManager.stopAll();
    lspManager = null;
  }
}
