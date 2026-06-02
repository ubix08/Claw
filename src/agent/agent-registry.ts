// src/agent/agent-registry.ts — Agent lifecycle manager and message router
//
// The AgentRegistry is the heart of the AI-OS runtime. It:
//   1. Loads system.json (or discovers agent folders)
//   2. Creates Agent instances + AgentMailbox for every agent at startup
//   3. Starts agents (init → idle)
//   4. Provides the Admin OS routing primitive: send a message to any agent's
//      mailbox and let the registry wake the agent to process it
//
// Agents are not spawned on-demand. They are instantiated at app start, sit
// idle, and wake when a message arrives in their mailbox or a scheduled
// heartbeat fires.

import * as fs   from "fs";
import * as path from "path";
import { Agent }           from "./agent.js";
import { AgentMailbox }    from "./mailbox.js";
import { AgentWorkspace }  from "./workspace.js";
import { findSystemDef, loadSystemDef, resolveAgentFolder } from "./system-def.js";
import { logger }          from "../core/logger.js";
import { getDefaultBus }   from "../core/event-bus.js";
import { loadConfig }      from "../config.js";
import type { AgentEnvelope } from "./mailbox.js";
import type { AgentConfig }   from "./types.js";
import type { EventBus }      from "../core/event-bus.js";
import type { GlobalConfig }  from "../config.js";

export type AgentStatus = "starting" | "idle" | "busy" | "stopped" | "error";

export interface ManagedAgent {
  agent:      Agent;
  mailbox:    AgentMailbox;
  status:     AgentStatus;
}

/**
 * AgentRegistry — load, start, message, and stop every agent in the system.
 */
export class AgentRegistry {
  private _managed     = new Map<string, ManagedAgent>();
  private _bus:         EventBus;
  private _globalConfig: GlobalConfig;
  private _systemDir:   string;
  private _adminId:     string | null = null;

  constructor(bus?: EventBus, globalConfig?: GlobalConfig) {
    this._bus           = bus          ?? getDefaultBus();
    this._globalConfig  = globalConfig ?? loadConfig();
    this._systemDir     = "";
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Load system.json and start all agents.
   * If no system.json is found, starts a single default agent.
   */
  async start(systemDir?: string): Promise<void> {
    const dir = systemDir ?? process.cwd();
    this._systemDir = dir;

    const sysPath = findSystemDef(dir);
    if (sysPath) {
      const def = loadSystemDef(sysPath);
      await this._startFromDef(def, path.dirname(sysPath));
    } else {
      logger.info("[Registry] No system.json found — starting default agent");
      await this._startDefault(dir);
    }

    this._logStatus();
  }

  /** Stop and dispose every managed agent. */
  async stop(): Promise<void> {
    for (const [id, managed] of this._managed) {
      managed.status = "stopped";
      managed.agent.dispose();
      logger.info(`[Registry] Stopped agent "${id}"`);
    }
    this._managed.clear();
    this._adminId = null;
  }

  /** Check whether the registry has any agents loaded. */
  get hasAgents(): boolean { return this._managed.size > 0; }

  /** Number of managed agents. */
  get size(): number { return this._managed.size; }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /** Get a managed agent by ID. */
  get(id: string): ManagedAgent | undefined {
    return this._managed.get(id);
  }

  /** Get the Admin OS agent (the sole orchestrator). */
  get admin(): ManagedAgent | undefined {
    return this._adminId ? this._managed.get(this._adminId) : undefined;
  }

  /** Get all managed agents. */
  getAll(): ManagedAgent[] {
    return [...this._managed.values()];
  }

  /** Get agents by role. */
  byRole(role: string): ManagedAgent[] {
    return this.getAll().filter(m => {
      // We determine role from the agent's tags or by checking if it's the admin
      if (role === "orchestrator") return m.agent.id === this._adminId;
      return m.agent.id !== this._adminId;
    });
  }

  /** Register an agent that was created externally (e.g. from a CLI command). */
  register(agent: Agent, mailbox: AgentMailbox): ManagedAgent {
    const managed: ManagedAgent = { agent, mailbox, status: "starting" };
    this._managed.set(agent.id, managed);
    return managed;
  }

  // ── Message routing (Admin OS primitives) ────────────────────────────────

  /**
   * Send an envelope to an agent's mailbox.
   * If the agent is idle, the registry wakes it immediately.
   * Returns false if the target agent is unknown.
   */
  async send(envelope: AgentEnvelope): Promise<boolean> {
    const managed = this._managed.get(envelope.to);
    if (!managed) {
      logger.warn(`[Registry] Cannot send to unknown agent "${envelope.to}"`);
      return false;
    }

    managed.mailbox.push(envelope);
    logger.info(`[Registry] ${envelope.from} → ${envelope.to} [${envelope.type}]`);

    // If the agent is idle, wake it to process messages
    if (managed.status === "idle") {
      this._processMailbox(managed).catch(e =>
        logger.error(`[Registry] Mailbox processing failed for "${envelope.to}": ${e.message}`),
      );
    }

    return true;
  }

  /**
   * Admin OS: send a task to a worker agent and await the result.
   * This is a convenience wrapper around send() that creates the envelope,
   * sends it, and waits for the worker to post a result back.
   */
  async assign(
    fromId:    string,
    toId:      string,
    task:      string,
    sessionId: string,
  ): Promise<AgentEnvelope | null> {
    const envelope: AgentEnvelope = {
      id:             `${fromId}->${toId}-${Date.now()}`,
      from:           fromId,
      to:             toId,
      type:           "task",
      payload:        { message: task, sessionId },
      timestamp:      new Date().toISOString(),
      correlationId:  sessionId,
    };

    await this.send(envelope);

    // Wait for the worker to complete and post a result back
    // Poll the admin's own mailbox for a matching correlationId
    const adminManaged = this.admin;
    if (!adminManaged) return null;

    const deadline = Date.now() + 300_000; // 5 min timeout
    while (Date.now() < deadline) {
      // The worker's result arrives in the admin's mailbox
      const reply = adminManaged.mailbox.pop();
      if (reply && reply.correlationId === sessionId) {
        return reply;
      }
      await this._sleep(500);
    }

    logger.warn(`[Registry] Task ${sessionId} timed out waiting for reply from "${toId}"`);
    return null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _startFromDef(def: { agents: Record<string, any>; defaultTools?: any }, sysDir: string): Promise<void> {
    const entries = Object.entries(def.agents);

    // First pass: create every agent + mailbox
    for (const [id, agentDef] of entries) {
      const folder = path.resolve(sysDir, agentDef.folder);
      if (!fs.existsSync(folder)) {
        logger.warn(`[Registry] Agent "${id}" folder not found at ${folder} — skipping`);
        continue;
      }

      const config = this._loadAgentConfig(id, folder, def.defaultTools);
      const workspace = new AgentWorkspace(id, folder);
      const agent = new Agent(id, workspace, config, this._bus, this._globalConfig);
      const mailbox = new AgentMailbox(folder);
      mailbox.replay(); // recover in-flight messages

      const managed: ManagedAgent = { agent, mailbox, status: "starting" };
      this._managed.set(id, managed);

      if (agentDef.role === "orchestrator") {
        if (this._adminId) {
          logger.warn(`[Registry] Multiple orchestrators found — "${id}" overrides "${this._adminId}"`);
        }
        this._adminId = id;
        logger.info(`[Registry] Admin OS agent: "${id}"`);
      }
    }

    // Second pass: init every agent (load skills, build tools, start heartbeats)
    for (const [id, managed] of this._managed) {
      try {
        await managed.agent.init();
        managed.status = "idle";
        logger.info(`[Registry] Agent "${id}" → idle`);
      } catch (e: any) {
        managed.status = "error";
        logger.error(`[Registry] Agent "${id}" init failed: ${e.message}`);
      }
    }

    // Third pass: process any replayed messages for idle agents
    for (const [id, managed] of this._managed) {
      if (managed.status === "idle" && managed.mailbox.length > 0) {
        logger.info(`[Registry] "${id}" has ${managed.mailbox.length} pending message(s) — waking`);
        this._processMailbox(managed).catch(e =>
          logger.error(`[Registry] Mailbox processing failed for "${id}": ${e.message}`),
        );
      }
    }
  }

  private async _startDefault(startDir: string): Promise<void> {
    const defaultId = "admin";
    const folder = path.join(startDir, "agents", defaultId);

    // If the default folder doesn't exist, scaffold it
    if (!fs.existsSync(folder)) {
      logger.info(`[Registry] Scaffolding default agent at ${folder}`);
      const { scaffoldAgentAt } = await import("./loader.js");
      scaffoldAgentAt(defaultId, folder, {
        name:           "Admin OS",
        description:    "System orchestrator — coordinates all agents",
        model:          this._globalConfig.defaults.model,
        provider:       this._globalConfig.defaults.provider,
        tools:          "full",
        persistent:     true,
        maxTurns:       this._globalConfig.defaults.maxTurns,
        timeoutSeconds: this._globalConfig.defaults.timeoutSeconds,
      });
    }

    const config = this._loadAgentConfig(defaultId, folder);
    const workspace = new AgentWorkspace(defaultId, folder);
    const agent = new Agent(defaultId, workspace, config, this._bus, this._globalConfig);
    const mailbox = new AgentMailbox(folder);
    mailbox.replay();

    const managed: ManagedAgent = { agent, mailbox, status: "starting" };
    this._managed.set(defaultId, managed);
    this._adminId = defaultId;

    try {
      await agent.init();
      managed.status = "idle";
      logger.info(`[Registry] Default agent "${defaultId}" → idle`);
    } catch (e: any) {
      managed.status = "error";
      logger.error(`[Registry] Default agent init failed: ${e.message}`);
    }
  }

  /**
   * Drain one agent's mailbox: for each pending envelope, call agent.prompt()
   * and post the result back to the sender's mailbox.
   */
  private async _processMailbox(managed: ManagedAgent): Promise<void> {
    managed.status = "busy";
    try {
      while (managed.mailbox.length > 0) {
        const envelope = managed.mailbox.pop();
        if (!envelope) break;

        const payload = envelope.payload as any;
        const message = typeof payload === "string"
          ? payload
          : payload?.message ?? JSON.stringify(payload);

        logger.info(`[Registry] "${managed.agent.id}" processing message ${envelope.id}`);

        try {
          const result = await managed.agent.prompt(message, envelope.id);

          // Send result back to the sender
          if (envelope.from && envelope.from !== managed.agent.id) {
            const reply: AgentEnvelope = {
              id:            `${managed.agent.id}->${envelope.from}-${Date.now()}`,
              from:          managed.agent.id,
              to:            envelope.from,
              type:          "result",
              payload:       { output: result.output, status: result.status },
              timestamp:     new Date().toISOString(),
              correlationId: envelope.correlationId ?? envelope.id,
            };
            const senderManaged = this._managed.get(envelope.from);
            if (senderManaged) {
              senderManaged.mailbox.push(reply);
            }
          }
        } catch (e: any) {
          logger.error(`[Registry] "${managed.agent.id}" message ${envelope.id} failed: ${e.message}`);
          // Send error back to sender
          if (envelope.from && envelope.from !== managed.agent.id) {
            const errReply: AgentEnvelope = {
              id:            `${managed.agent.id}->${envelope.from}-${Date.now()}`,
              from:          managed.agent.id,
              to:            envelope.from,
              type:          "status",
              payload:       { error: e.message },
              timestamp:     new Date().toISOString(),
              correlationId: envelope.correlationId ?? envelope.id,
            };
            const senderManaged = this._managed.get(envelope.from);
            if (senderManaged) {
              senderManaged.mailbox.push(errReply);
            }
          }
        }
      }
    } finally {
      managed.status = this._managed.has(managed.agent.id) ? "idle" : "stopped";
    }
  }

  private _loadAgentConfig(
    id: string,
    folder: string,
    defaultTools?: string,
  ): AgentConfig {
    const configPath = path.join(folder, "config.json");
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as AgentConfig;
        // Apply system-level defaults for missing fields
        if (!config.tools && defaultTools) {
          (config as any).tools = defaultTools;
        }
        return config;
      } catch (e: any) {
        logger.warn(`[Registry] Failed to parse ${configPath}: ${e.message}`);
      }
    }

    // Fallback default config
    return {
      name:           id,
      description:    `AI-OS agent: ${id}`,
      model:          this._globalConfig.defaults.model,
      provider:       this._globalConfig.defaults.provider,
      tools:          defaultTools as any ?? "standard",
      persistent:     true,
      maxTurns:       this._globalConfig.defaults.maxTurns,
      timeoutSeconds: this._globalConfig.defaults.timeoutSeconds,
    };
  }

  private _logStatus(): void {
    const idle  = this.getAll().filter(m => m.status === "idle").length;
    const busy  = this.getAll().filter(m => m.status === "busy").length;
    const err   = this.getAll().filter(m => m.status === "error").length;
    logger.info(`[Registry] ${this._managed.size} agent(s) — ${idle} idle, ${busy} busy, ${err} error`);
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
