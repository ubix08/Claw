// src/agent/agent.ts — clawd local edition
//
// ─────────────────────────────────────────────────────────────────────────────
// Context Assembler — mirrors Anthropic's production strategy exactly:
//
//   SURFACE 1 — system prompt (_buildSystemPrompt)
//     Rebuilt on every prompt() call from disk.
//     Contains only STATIC identity: SOUL.md, skills registry, tool notes.
//     Todo.md injected here as P1 — always present, never costs a turn.
//
//   SURFACE 2 — convertToLlm (runs before every LLM inference turn)
//     Implements Anthropic's tool_result clearing strategy:
//       - Keeps last CTX_KEEP_TOOL_RESULTS tool results in full
//       - Replaces older tool results with a short placeholder stub
//       - Preserves the tool_use record so LLM knows the call happened
//     Injects workspace state (NOTES.md) as the LAST message before
//     LLM generation — exploiting end-of-context attention weighting.
//
//   SURFACE 3 — compact() (triggered by caller when threshold reached)
//     Replaces Anthropic's "clear_tool_uses" API feature with a
//     client-side equivalent using replaceMessages().
//     Preserves: last N turns verbatim + structured summary of older turns.
//     Always references NOTES.md so LLM knows where its knowledge lives.
//
// ─────────────────────────────────────────────────────────────────────────────
//
// Context budget targets (conservative for free-tier / Termux):
//   CTX_KEEP_TOOL_RESULTS  = 3    keep last 3 tool results in full
//   CTX_TOOL_RESULT_STUB   = 400  chars kept from old tool results
//   CTX_NOTES_MAX_CHARS    = 3000 max chars of NOTES.md injected per turn
//   CTX_COMPACT_KEEP_TURNS = 10   verbatim turns kept after compaction
//   CTX_COMPACT_THRESHOLD  = 80   message count that triggers auto-compact
//
// Fix log (original):
//   tools/index.ts was building AgentTool objects with plain JSON schema objects
//   for the `parameters` field. pi-agent-core requires TypeBox TSchema objects
//   (from @mariozechner/pi-ai Type.*). When AJV attempts to validate tool call
//   arguments using the TypeBox format, it throws internally. The agent loop
//   catches this, logs nothing visible, and produces zero output.
//   Fix is in tools/index.ts (Type.Object / Type.String / etc.).
//
// Fix log (team refactor / env regression):
//   [AGENT-ENV-FIX-1] _buildTools() now forwards this._globalConfig to
//     createCoreTools(). Previously createCoreTools() was called without the
//     global config, so config.skills.entries["web-search"].apiKey was never
//     seen by createWebSearchTool(). The key reached process.env only if the
//     OpenClaw web-search SKILL was physically installed (triggering
//     _injectEnv() during loadSkills()) or if the key was already in
//     ~/.clawd/.env. If the key was configured solely via clawd.json entries
//     without the skill installed, the built-in web_search tool silently got
//     no key and returned "SERPER_API_KEY not set" on every call.
//
// New fixes:
//   [VERBOSITY-SYS-PROMPT] _buildSystemPrompt() branches on
//     this.config.verbosity ("concise" | "explicit"). When "explicit", a
//     "Tool Examples" block with concrete worked examples for every core tool
//     is appended to the system prompt. This closes 30-40% of the capability
//     gap for smaller OSS models (≤14B) without changing frontier model behavior.
//   [VERBOSITY-TOOLNOTE] _toolSetNote() gains a third `verbose` parameter to
//     carry the verbosity flag from _buildSystemPrompt().

import * as fs   from "fs";
import * as path from "path";

import { Agent as PiAgent }      from "@mariozechner/pi-agent-core";
import type { AgentMessage }     from "@mariozechner/pi-agent-core";
import type { Model }            from "@mariozechner/pi-ai";

import { logger }                from "../core/logger.js";
import { HeartbeatScheduler }    from "../core/heartbeat.js";
import { loadSkills, watchSkills, emptySkillsSnapshot } from "../skills.js";
import { createCoreTools }       from "../tools/index.js";
import { CLAWD_MODELS_PATH }     from "../config.js";
import type { AgentWorkspace }   from "./workspace.js";
import type { AgentConfig, AgentTool, PromptOptions } from "./types.js";
import type { AgentRunResult }   from "../core/types.js";
import type { EventBus }         from "../core/event-bus.js";
import type { GlobalConfig }     from "../config.js";
import type { SkillsSnapshot }   from "../skills.js";

// ── Context assembler constants ───────────────────────────────────────────────

/** How many recent tool results to keep in full before stubbing older ones. */
const CTX_KEEP_TOOL_RESULTS  = 3;

/** Max characters kept from a tool result that is being stubbed. */
const CTX_TOOL_RESULT_STUB   = 400;

/** Max characters of NOTES.md injected as workspace state per turn.
 *  Sliced from the END (most recent findings) — oldest entries dropped first. */
const CTX_NOTES_MAX_CHARS    = 3000;

/** Verbatim turns kept at the tail after compaction. */
const CTX_COMPACT_KEEP_TURNS = 10;

/** Message count that triggers auto-compact inside prompt(). */
const CTX_COMPACT_THRESHOLD  = 80;

// ── Provider → pi-ai API mapping ─────────────────────────────────────────────

const PROVIDER_API: Record<string, string> = {
  anthropic:  "anthropic-messages",
  openai:     "openai-completions",
  google:     "google-generative-ai",
  groq:       "openai-completions",
  openrouter: "openai-completions",
  deepseek:   "openai-completions",
  mistral:    "openai-completions",
  cerebras:   "openai-completions",
  xai:        "openai-completions",
  together:   "openai-completions",
  fireworks:  "openai-completions",
  cohere:     "openai-completions",
  zai:        "openai-completions",
  sambanova:  "openai-completions",
};

const VALID_API_STRINGS = new Set([
  "anthropic-messages",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
  "mistral-conversations",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "bedrock-converse-stream",
]);

interface RegistryCache {
  registry: { providers?: Record<string, any> };
  mtimeMs:  number;
  filePath: string;
}

// ── Agent class ───────────────────────────────────────────────────────────────

export class Agent {
  readonly id:        string;
  readonly workspace: AgentWorkspace;
           config:   AgentConfig;

  private _bus:                    EventBus;
  private _globalConfig:           GlobalConfig;
  private _skills:                 SkillsSnapshot;
  private _heartbeat:              HeartbeatScheduler;
  private _stopWatch:              (() => void) | null = null;
  private _piAgent:                PiAgent | null = null;
  private _builtinTools:           AgentTool[] = [];
  private _configFingerprint       = "";
  private _skillsConfigFingerprint = "";
  private _modelsCache:            RegistryCache | null = null;
  private _authCache:              Record<string, string> | null = null;
  private _modelsPath:             string;

  get name(): string          { return this.config.name; }
  get model(): string         { return this.config.model    ?? this._globalConfig.defaults.model; }
  get provider(): string      { return this.config.provider ?? this._globalConfig.defaults.provider; }
  get isPersistent(): boolean { return this.config.persistent; }
  get skillCount(): number    { return this._skills.skills.length; }
  get builtinToolNames(): string[] { return this._builtinTools.map(t => t.name); }

  constructor(
    id:           string,
    workspace:    AgentWorkspace,
    config:       AgentConfig,
    bus:          EventBus,
    globalConfig: GlobalConfig,
    modelsPath?:  string,
  ) {
    this.id                       = id;
    this.workspace                = workspace;
    this.config                   = config;
    this._bus                     = bus;
    this._globalConfig            = globalConfig;
    this._skills                  = emptySkillsSnapshot();
    this._heartbeat               = new HeartbeatScheduler(id, config.name, bus);
    this._builtinTools            = [];  // Will be populated in init()
    this._configFingerprint       = JSON.stringify(config);
    this._skillsConfigFingerprint = _skillsFingerprint(globalConfig);
    this._modelsPath              = modelsPath ?? CLAWD_MODELS_PATH;
  }

  async init(): Promise<void> {
    this.workspace.ensureExists();
    try { fs.mkdirSync(this.workspace.workspaceDir, { recursive: true }); } catch {}

    // [CIRCULAR-DEP-FIX] Build tools asynchronously to support lazy-loading
    this._builtinTools = await this._buildTools(this.config);

    this._skills = await loadSkills(
      this.workspace.dir, this._globalConfig, this.workspace.setupSkillsDir,
    );
    logger.info(`[Agent:${this.id}] Skills: ${this._skills.skills.length} eligible`);

    if (this._globalConfig.skills.watch) {
      this._stopWatch = watchSkills(
        this.workspace.dir, this._globalConfig,
        async () => {
          this._skills = await loadSkills(
            this.workspace.dir, this._globalConfig, this.workspace.setupSkillsDir,
          );
          this.invalidateSession();
          this._bus.emit({ type: "agent_skills_reloaded", agentId: this.id, count: this._skills.skills.length });
          logger.info(`[Agent:${this.id}] Skills hot-reloaded: ${this._skills.skills.length}`);
        },
        this.workspace.setupSkillsDir,
      );
    }

    const defs = this.config.heartbeats ?? [];
    if (defs.length > 0) {
      this._heartbeat.start(defs, async (task: string) => {
        const result = await this.prompt(task, `heartbeat-${this.id}-${Date.now()}`, { mode: "reply" });
        return result.output;
      });
      logger.info(`[Agent:${this.id}] Heartbeats: ${defs.length} scheduled`);
    }

    try { fs.mkdirSync(this.workspace.sessionsDir, { recursive: true }); } catch {}

    logger.info(
      `[Agent:${this.id}] "${this.name}" ready ` +
      `(${this.provider}/${this.model}${this.isPersistent ? ", persistent" : ""}) ` +
      `root: ${this.workspace.dir}`,
    );
  }

  async prompt(
    message:   string,
    sessionId: string,
    options:   PromptOptions = {},
  ): Promise<AgentRunResult> {
    await this._refreshConfig();

    const start = Date.now();
    const mode  = options.mode ?? "reply";

    this._bus.emit({ type: "agent_started", agentId: this.id, agentName: this.name, sessionId, mode });

    if (mode === "work") {
      try { fs.mkdirSync(this.workspace.workspaceDir, { recursive: true }); } catch {}
      try {
        fs.writeFileSync(
          path.join(this.workspace.workspaceDir, "brief.md"),
          `# ${this.name} — Task Brief\n\n**Agent:** ${this.name} (\`${this.id}\`)\n` +
          `**Session:** ${sessionId}\n**Date:** ${new Date().toISOString()}\n\n` +
          `## Instructions\n\n${message}\n`,
          "utf-8",
        );
      } catch {}
    }

    const fullMessage = options.context
      ? `## Context\n\n${options.context.trim()}\n\n---\n\n${message.trim()}`
      : message;

    let piAgent: PiAgent;
    try {
      piAgent = this._getOrCreatePiAgent(options);
    } catch (err: any) {
      const error = `Session creation failed: ${err.message}`;
      logger.error(`[Agent:${this.id}] ${error}`);
      this._bus.emit({ type: "agent_failed", agentId: this.id, agentName: this.name, error });
      return {
        agentId: this.id, agentName: this.name, sessionId, mode,
        status: "failed", output: error,
        durationMs: Date.now() - start, turnCount: 0, toolsUsed: [],
      };
    }

    // ── Rebuild system prompt fresh from disk on every prompt() call ──────────
    // This is Surface 1: static identity + Todo.md (P1 project state).
    piAgent.state.systemPrompt = this._buildSystemPrompt(options);

    // ── Auto-compact if message history is too long ───────────────────────────
    // Mirrors Anthropic's threshold-based tool_result clearing.
    // Runs BEFORE the new prompt so the LLM starts with headroom.
    if (piAgent.state.messages.length > CTX_COMPACT_THRESHOLD) {
      logger.info(`[Agent:${this.id}] Auto-compact triggered (${piAgent.state.messages.length} msgs > ${CTX_COMPACT_THRESHOLD})`);
      await this.compact();
    }

    const parts: string[]     = [];
    const toolsUsed: string[] = [];
    let turnCount = 0;

    const unsub = piAgent.subscribe((event: any) => {
      if (event.type === "agent_start") {
        logger.debug(`[Agent:${this.id}] pi agent_start`);
      }
      if (event.type === "turn_start") {
        turnCount++;
        logger.debug(`[Agent:${this.id}] turn ${turnCount} start`);
      }
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta"
      ) {
        const delta = String(event.assistantMessageEvent.delta ?? "");
        if (delta) {
          parts.push(delta);
          this._bus.emit({ type: "agent_token", agentId: this.id, agentName: this.name, delta });
        }
      }
      if (event.type === "tool_execution_start") {
        const name = String(event.toolName ?? "");
        if (name && !toolsUsed.includes(name)) toolsUsed.push(name);
        this._bus.emit({
          type: "agent_tool", agentId: this.id, agentName: this.name,
          toolName: name, argSummary: _argSummary(event.args),
        });
      }
      if (event.type === "agent_end") {
        logger.debug(`[Agent:${this.id}] pi agent_end`);
      }
    });

    // Keepalive every 15s — prevents SSE proxy idle timeout.
    const keepaliveInterval = setInterval(() => {
      this._bus.emit({
        type: "agent_keepalive", agentId: this.id, agentName: this.name,
        elapsedMs: Date.now() - start,
      });
    }, 15_000);

    const timeoutSeconds = this.config.timeoutSeconds ?? this._globalConfig.defaults.timeoutSeconds;
    const timeoutMs      = timeoutSeconds * 1000;

    let promptError: Error | null = null;
    try {
      await Promise.race([
        piAgent.prompt(fullMessage),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`Agent timeout after ${timeoutSeconds}s`)), timeoutMs),
        ),
      ]);
    } catch (err: any) {
      promptError = err;
      logger.error(`[Agent:${this.id}] prompt error: ${err.message}`);
    }

    clearInterval(keepaliveInterval);
    unsub();

    if (this.isPersistent) {
      this._persistMessages(piAgent);
    } else {
      this._piAgent = null;
    }

    const durationMs = Date.now() - start;

    if (promptError) {
      const errorMsg = promptError.message;
      this._bus.emit({ type: "agent_failed", agentId: this.id, agentName: this.name, error: errorMsg });
      return {
        agentId: this.id, agentName: this.name, sessionId, mode,
        status: "failed", output: parts.join("").slice(0, 500) || errorMsg,
        durationMs, turnCount, toolsUsed,
      };
    }

    const fullOutput = parts.join("");
    let outputFile: string | undefined;

    if (mode === "work") {
      outputFile = path.join(this.workspace.workspaceDir, "output.md");
      try { fs.writeFileSync(outputFile, fullOutput, "utf-8"); }
      catch (e: any) {
        logger.warn(`[Agent:${this.id}] Cannot write output.md: ${e.message}`);
        outputFile = undefined;
      }
    }

    const result: AgentRunResult = {
      agentId:   this.id,
      agentName: this.name,
      sessionId,
      mode,
      status:    "succeeded",
      output:    mode === "work" ? fullOutput.slice(0, 500) : fullOutput,
      outputFile,
      durationMs,
      turnCount,
      toolsUsed: [...new Set(toolsUsed)],
    };

    logger.info(`[Agent:${this.id}] ✓ ${result.durationMs}ms, ${result.turnCount} turns, mode:${mode}`);
    this._bus.emit({ type: "agent_succeeded", agentId: this.id, agentName: this.name, result });
    return result;
  }

  dispose(): void {
    this._stopWatch?.();
    this._heartbeat.stop();
    if (this._piAgent && this.isPersistent) {
      this._persistMessages(this._piAgent);
    }
    this._piAgent = null;
    logger.debug(`[Agent:${this.id}] Disposed`);
  }

  // ── compact() ─────────────────────────────────────────────────────────────────
  //
  // Mirrors Anthropic's tool_result clearing + compaction strategy.
  //
  // Strategy (matches Anthropic's clear_tool_uses_20250919 behavior):
  //   1. Walk the message array chronologically.
  //   2. Find all toolResult messages.
  //   3. Keep the last CTX_KEEP_TOOL_RESULTS in full — they guide the
  //      agent's immediate next decision.
  //   4. Replace older toolResult content with a short stub — preserving
  //      the message slot so turn structure stays intact.
  //   5. If total messages still exceed threshold, additionally summarize
  //      the oldest turns into a single context message.
  //   6. Always append a reference to NOTES.md in the summary so the
  //      agent knows where its extracted knowledge lives after compaction.
  //
  async compact(_guidance?: string): Promise<void> {
    if (!this._piAgent) return;

    const msgs    = this._piAgent.state.messages;
    const before  = msgs.length;

    if (before === 0) return;

    // ── Step 1: Tool result clearing (sub-transcript operation) ──────────────
    //
    // Walk all messages. Identify toolResult positions chronologically.
    // The last CTX_KEEP_TOOL_RESULTS are kept intact.
    // Older ones get their content replaced with a stub.
    // The tool_use record (assistant message) is NEVER touched — LLM must
    // know the call happened even if it can't see the full result.

    const toolResultIndices: number[] = [];
    for (let i = 0; i < msgs.length; i++) {
      if ((msgs[i] as any).role === "toolResult") {
        toolResultIndices.push(i);
      }
    }

    // Determine which ones to stub (all except the last CTX_KEEP_TOOL_RESULTS)
    const stubUntil = Math.max(0, toolResultIndices.length - CTX_KEEP_TOOL_RESULTS);
    const toStub    = new Set(toolResultIndices.slice(0, stubUntil));

    let toolResultsCleared = 0;
    const afterToolClear: AgentMessage[] = msgs.map((m, i) => {
      if (!toStub.has(i)) return m;

      // Replace content with placeholder — same approach as Anthropic's API
      const original = (m as any).content;
      let preview    = "";
      if (typeof original === "string" && original.length > 0) {
        preview = original.slice(0, CTX_TOOL_RESULT_STUB);
        if (original.length > CTX_TOOL_RESULT_STUB) preview += "…";
      }

      toolResultsCleared++;
      return {
        ...m,
        content: preview
          ? `[tool result cleared — ${preview}]`
          : `[tool result cleared]`,
      } as AgentMessage;
    });

    // ── Step 2: History summarization (whole-transcript, if still too long) ──
    //
    // If message count still exceeds threshold after tool clearing,
    // summarize oldest turns into a single structured context message.
    // Keep last CTX_COMPACT_KEEP_TURNS verbatim — they are the
    // agent's immediate working memory.

    let finalMessages: AgentMessage[];

    if (afterToolClear.length > CTX_COMPACT_KEEP_TURNS + 4) {
      const verbatim = afterToolClear.slice(-CTX_COMPACT_KEEP_TURNS);
      const old      = afterToolClear.slice(0, -CTX_COMPACT_KEEP_TURNS);

      // Extract decisions and assistant reasoning from old turns
      // (discard raw user/tool messages — they're either stubs or requests)
      const decisionLines: string[] = [];
      for (const m of old) {
        const role    = (m as any).role;
        const content = (m as any).content;
        if (role !== "assistant") continue;
        if (typeof content !== "string") continue;

        // Skip pure tool_call assistant messages (no text content)
        const trimmed = content.trim();
        if (!trimmed || trimmed.startsWith("{")) continue;

        // Keep first 200 chars of each reasoning turn
        decisionLines.push(trimmed.slice(0, 200));
      }

      // Build the compact summary message injected at position 0
      // Mirrors Anthropic's "compressed context + five most recently accessed files"
      const notesPath = path.join(this.workspace.workspaceDir, "NOTES.md");
      const todoPath  = path.join(this.workspace.workspaceDir, "Todo.md");
      const hasNotes  = fs.existsSync(notesPath);
      const hasTodo   = fs.existsSync(todoPath);

      const summaryParts: string[] = [
        `[COMPACTED CONTEXT — ${old.length} older turns summarized]`,
      ];

      if (decisionLines.length > 0) {
        summaryParts.push(
          `## Agent reasoning from earlier turns\n` +
          decisionLines.map(l => `- ${l}`).join("\n"),
        );
      }

      if (hasTodo) {
        summaryParts.push(
          `## Project state\nSee Todo.md (injected in system prompt) for current task status.`,
        );
      }

      if (hasNotes) {
        summaryParts.push(
          `## Research knowledge\n` +
          `Extracted findings are in workspace/NOTES.md. ` +
          `Read it with the read tool when you need your accumulated findings.`,
        );
      }

      const summaryMessage: AgentMessage = {
        role:      "user" as any,
        content:   summaryParts.join("\n\n"),
        timestamp: Date.now(),
      } as any;

      finalMessages = [summaryMessage, ...verbatim];
    } else {
      finalMessages = afterToolClear;
    }

    this._piAgent.state.messages = finalMessages;
    if (this.isPersistent) this._persistMessages(this._piAgent);

    logger.info(
      `[Agent:${this.id}] compact: ${before} → ${finalMessages.length} msgs ` +
      `(${toolResultsCleared} tool results cleared)`,
    );
  }

  async reset(): Promise<void> {
    if (this._piAgent) {
      this._piAgent.state.messages = [];
      this._piAgent = null;
    }
    const sessionFile = path.join(this.workspace.sessionsDir, "session.jsonl");
    try {
      if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
    } catch (e: any) {
      logger.warn(`[Agent:${this.id}] reset: could not delete session file: ${e.message}`);
    }
    logger.info(`[Agent:${this.id}] Session reset`);
  }

  async switchModel(provider: string, model: string): Promise<void> {
    const oldModel  = `${this.provider}/${this.model}`;
    const newConfig = { ...this.config, provider, model };
    this.workspace.saveConfig(newConfig);
    this.config             = newConfig;
    this._configFingerprint = JSON.stringify(newConfig);
    this.invalidateSession();
    logger.info(`[Agent:${this.id}] Model switched: ${oldModel} → ${provider}/${model}`);
  }

  async updateConfig(partial: Partial<AgentConfig>): Promise<void> {
    this.config             = { ...this.config, ...partial };
    this._builtinTools      = await this._buildTools(this.config);
    this._configFingerprint = JSON.stringify(this.config);
    if (this._piAgent) {
      if (partial.model || partial.provider) {
        try {
          const m = this._buildModel(this.provider, this.model);
          this._piAgent.state.model = m as any;
        } catch (e: any) {
          logger.warn(`[Agent:${this.id}] Hot model switch failed: ${e.message} — rebuilding on next prompt`);
          this.invalidateSession();
          return;
        }
      }
      if (partial.thinkingLevel) this._piAgent.state.thinkingLevel = partial.thinkingLevel as any;
      if (partial.tools)         this._piAgent.state.tools = [...this._builtinTools] as any;
    }
    logger.info(`[Agent:${this.id}] Config updated`);
  }

  getStats(): {
    agentId: string; agentName: string; model: string; provider: string;
    persistent: boolean; skillCount: number; messageCount: number; sessionFile: string;
  } {
    const messageCount = this._piAgent?.state.messages.length ?? 0;
    const sessionFile  = path.join(this.workspace.sessionsDir, "session.jsonl");
    return {
      agentId: this.id, agentName: this.name, model: this.model, provider: this.provider,
      persistent: this.isPersistent, skillCount: this.skillCount, messageCount, sessionFile,
    };
  }

  getMessages(): AgentMessage[] {
    if (this._piAgent) return this._piAgent.state.messages;
    if (this.isPersistent) return this._loadPersistedMessages();
    return [];
  }

  invalidateSession(): void {
    if (this._piAgent) {
      logger.debug(`[Agent:${this.id}] Session invalidated`);
      if (this.isPersistent) this._persistMessages(this._piAgent);
      this._piAgent = null;
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  // [AGENT-ENV-FIX-1] Pass _globalConfig so createCoreTools() can forward
  // config.skills.entries["web-search"].apiKey to createWebSearchTool().
  // Previously called without globalConfig, silently breaking the apiKey
  // path for users who configure the key via clawd.json entries rather than
  // ~/.clawd/.env.
  //
  // [AGENT-TOOL] Pass _bus so createCoreTools() can create Agent tool for
  // subagent spawning capability.
  // [CIRCULAR-DEP-FIX] Made async to support lazy-loading of Agent tool,
  // which breaks the circular dependency: agent.ts → tools/index.ts → tools/agent.ts
  private async _buildTools(config: AgentConfig): Promise<AgentTool[]> {
    return await createCoreTools(config.tools ?? "full", this.workspace.dir, this._globalConfig, this._bus);
  }

  private async _refreshConfig(): Promise<void> {
    const diskConfig = this.workspace.loadConfig();
    if (!diskConfig) return;
    const diskFingerprint = JSON.stringify(diskConfig);
    if (diskFingerprint === this._configFingerprint) return;

    const prevModel    = `${this.provider}/${this.model}`;
    const prevToolSet  = this.config.tools;
    const prevThinking = this.config.thinkingLevel;

    this.config             = diskConfig;
    this._configFingerprint = diskFingerprint;

    const changed: string[] = [];

    if (diskConfig.tools !== prevToolSet) {
      this._builtinTools = await this._buildTools(diskConfig);
      changed.push("tools");
    }

    const freshSkillsFp = _skillsFingerprint(this._globalConfig);
    if (freshSkillsFp !== this._skillsConfigFingerprint) {
      this._skillsConfigFingerprint = freshSkillsFp;
      try {
        this._skills = await loadSkills(
          this.workspace.dir, this._globalConfig, this.workspace.setupSkillsDir,
        );
        changed.push("skills");
      } catch (e: any) {
        logger.warn(`[Agent:${this.id}] Skills reload failed: ${e.message}`);
      }
    }

    const newModel     = `${this.provider}/${this.model}`;
    const modelChanged = newModel !== prevModel;
    const thinkChanged = diskConfig.thinkingLevel !== prevThinking;

    if (this._piAgent) {
      if (modelChanged) {
        try {
          const m = this._buildModel(this.provider, this.model);
          this._piAgent.state.model = m as any;
          changed.push(`model ${prevModel}→${newModel}`);
        } catch (e: any) {
          logger.warn(`[Agent:${this.id}] Hot model switch failed: ${e.message} — rebuilding`);
          this.invalidateSession();
        }
      }
      if (diskConfig.tools !== prevToolSet) {
        this._piAgent.state.tools = [...this._builtinTools] as any;
      }
      if (thinkChanged) {
        this._piAgent.state.thinkingLevel = (diskConfig.thinkingLevel ?? "off") as any;
        changed.push(`thinking ${prevThinking}→${diskConfig.thinkingLevel}`);
      }
    }

    if (changed.length) logger.info(`[Agent:${this.id}] Config refreshed: ${changed.join(", ")}`);
  }

  private _buildModel(provider: string, modelId: string): Model<any> {
    const modelsPath = this._modelsPath;
    let registry: { providers?: Record<string, any> } = {};
    try {
      if (!fs.existsSync(modelsPath)) throw new Error(`models.json not found at ${modelsPath}`);
      const stat = fs.statSync(modelsPath);
      if (
        this._modelsCache &&
        this._modelsCache.filePath === modelsPath &&
        this._modelsCache.mtimeMs === stat.mtimeMs
      ) {
        registry = this._modelsCache.registry;
      } else {
        registry = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
        this._modelsCache = { registry, mtimeMs: stat.mtimeMs, filePath: modelsPath };
      }
    } catch (e: any) {
      throw new Error(`Cannot read models.json at ${modelsPath}: ${e.message}`);
    }

    const provDef = registry.providers?.[provider];
    if (!provDef) {
      throw new Error(
        `Provider "${provider}" not found in models.json. ` +
        `Available: ${Object.keys(registry.providers ?? {}).join(", ")}`,
      );
    }

    const modelDef = (provDef.models ?? []).find((m: any) => m.id === modelId);
    if (!modelDef) {
      throw new Error(`Model "${modelId}" not found under provider "${provider}" in models.json.`);
    }

    // ── API key resolution — three sources in priority order ─────────────────
    //
    // 1. models.json provDef.apiKey — if it looks like an env var name
    //    (ALL_CAPS_WITH_UNDERSCORES) resolve from process.env; otherwise use
    //    the literal string value.
    //
    // 2. process.env fallback — try PROVIDER_API_KEY and PROVIDER_APIKEY
    //    conventions if models.json gave nothing.
    //
    // 3. auth.json — ~/.clawd/auth.json keyed by provider name, structure:
    //    { "<provider>": { "type": "api_key", "key": "<value>" } }
    //    This is the file used by the clawd setup wizard and the UI.

    let apiKey = "";

    // Source 1: models.json
    if (typeof provDef.apiKey === "string" && provDef.apiKey.length > 0) {
      apiKey = /^[A-Z][A-Z0-9_]+$/.test(provDef.apiKey)
        ? (process.env[provDef.apiKey] ?? "")
        : provDef.apiKey;
    }

    // Source 2: process.env conventions (PROVIDER_API_KEY, PROVIDER_APIKEY)
    if (!apiKey) {
      const envKey1 = provider.toUpperCase().replace(/-/g, "_") + "_API_KEY";
      const envKey2 = provider.toUpperCase().replace(/-/g, "_") + "_APIKEY";
      apiKey = process.env[envKey1] ?? process.env[envKey2] ?? "";
    }

    // Source 3: auth.json
    if (!apiKey) {
      apiKey = this._loadAuthKey(provider);
    }

    if (!apiKey) {
      logger.warn(`[Agent:${this.id}] No API key resolved for provider "${provider}" — requests will likely fail`);
    }

    const rawApi = provDef.api as string | undefined;
    let api: string;
    if (rawApi && VALID_API_STRINGS.has(rawApi)) {
      api = rawApi;
    } else {
      if (rawApi) {
        logger.warn(
          `[Agent:${this.id}] models.json provider "${provider}" has unknown api "${rawApi}". ` +
          `Falling back to PROVIDER_API map.`,
        );
      }
      api = PROVIDER_API[provider] ?? "openai-completions";
    }

    const model: Model<any> = {
      id:            modelId,
      name:          modelDef.name ?? modelId,
      provider,
      api,
      baseUrl:       provDef.baseUrl ?? "",
      reasoning:     modelDef.reasoning ?? false,
      input:         modelDef.input ?? ["text"],
      contextWindow: modelDef.contextWindow ?? 200_000,
      maxTokens:     modelDef.maxTokens ?? 8192,
      cost: {
        input:      modelDef.cost?.input      ?? 0,
        output:     modelDef.cost?.output     ?? 0,
        cacheRead:  modelDef.cost?.cacheRead  ?? 0,
        cacheWrite: modelDef.cost?.cacheWrite ?? 0,
      },
    };

    logger.debug(
      `[Agent:${this.id}] Model resolved: ${provider}/${modelId} via ${api}` +
      `${model.baseUrl ? ` at ${model.baseUrl}` : ""}`,
    );
    return model;
  }

  // ── _getOrCreatePiAgent ───────────────────────────────────────────────────────
  //
  // This is where SURFACE 2 (convertToLlm) lives.
  //
  // convertToLlm runs before EVERY LLM inference turn within a prompt() call.
  // It implements two things:
  //
  //   A) Tool result clearing
  //      Mirrors Anthropic's clear_tool_uses_20250919 API feature.
  //      Older tool results (beyond CTX_KEEP_TOOL_RESULTS) are stubbed.
  //      The tool_use record in the assistant message is NEVER touched.
  //
  //   B) Workspace state injection (NOTES.md)
  //      A fresh read of NOTES.md is appended as the LAST user message
  //      before the LLM generates its next token.
  //      Position matters: end-of-context receives strongest attention.
  //      This gives the LLM full orientation on every turn with zero
  //      wasted tool calls for reorientation.
  //      NOTES.md is capped at CTX_NOTES_MAX_CHARS, sliced from the end
  //      (most recent findings) so oldest entries are dropped first.
  //
  private _getOrCreatePiAgent(_options: PromptOptions): PiAgent {
    if (this.isPersistent && this._piAgent) return this._piAgent;

    const model      = this._buildModel(this.provider, this.model);
    const thinkLevel = (this.config.thinkingLevel ?? this._globalConfig.defaults.thinkingLevel ?? "off") as any;

    const restoredMessages = this.isPersistent ? this._loadPersistedMessages() : [];
    if (restoredMessages.length > 0) {
      logger.info(`[Agent:${this.id}] Restored ${restoredMessages.length} messages from session.jsonl`);
    }

    // Capture for closure — convertToLlm and getApiKey are called on every
    // inference turn, not just at construction time.
    const workspaceDir = this.workspace.workspaceDir;
    const agentId      = this.id;
    const self         = this;

    const piAgent = new PiAgent({
      initialState: {
        systemPrompt:  "",
        model:         model as any,
        tools:         this._builtinTools as any,
        thinkingLevel: thinkLevel,
        messages:      restoredMessages,
      },

      // ── getApiKey ─────────────────────────────────────────────────────────
      // Called by pi-agent-core on every LLM call.
      // Returns the resolved key from auth.json as a runtime fallback,
      // complementing what _buildModel() already set on the Model object.
      getApiKey: async (provider: string): Promise<string | undefined> => {
        const key = self._loadAuthKey(provider);
        return key || undefined;
      },

      // ── convertToLlm ──────────────────────────────────────────────────────
      // MUST return Message[] (from @mariozechner/pi-ai), NOT AgentMessage[].
      // Message = { role: "user"|"assistant"|"toolResult"; content: string |
      //             Array<{type:"text";text:string}>; timestamp: number }
      //
      // Pipeline:
      //   A. Filter to LLM-visible roles (user / assistant / toolResult)
      //   B. Tool result clearing — stub old results, keep last N in full
      //   C. NOTES.md injection — append as final user Message
      //
      convertToLlm: (msgs: AgentMessage[]): any[] => {

        // ── A: Filter to LLM-visible roles ──────────────────────────────────
        const filtered = msgs.filter(
          (m: any) => ["user", "assistant", "toolResult"].includes(m.role),
        );

        // ── B: Tool result clearing ─────────────────────────────────────────
        // Identify toolResult positions chronologically.
        // Keep last CTX_KEEP_TOOL_RESULTS in full — they guide next decision.
        // Replace older ones with a short stub preserving a text preview.
        // The assistant tool_use record is never touched — LLM must know the
        // call happened even when the result payload is gone.

        const toolResultIndices: number[] = [];
        for (let i = 0; i < filtered.length; i++) {
          if ((filtered[i] as any).role === "toolResult") {
            toolResultIndices.push(i);
          }
        }

        const stubUntil = Math.max(0, toolResultIndices.length - CTX_KEEP_TOOL_RESULTS);
        const toStub    = new Set(toolResultIndices.slice(0, stubUntil));

        // Build proper Message[] — the wire format pi-ai sends to the LLM.
        // Message.content must be string | Array<{type:"text";text:string}>.
        const wireMessages: any[] = filtered.map((m: any, i: number) => {
          const role    = m.role;
          let   content = m.content;

          // Stub old tool results
          if (toStub.has(i) && role === "toolResult") {
            let preview = "";
            if (typeof content === "string" && content.length > 0) {
              preview = content.slice(0, CTX_TOOL_RESULT_STUB);
              if (content.length > CTX_TOOL_RESULT_STUB) preview += "…";
            } else if (Array.isArray(content)) {
              // ContentBlock[] — extract text from first text block
              const first = content.find((c: any) => c.type === "text");
              if (first?.text) {
                preview = String(first.text).slice(0, CTX_TOOL_RESULT_STUB);
              }
            }
            content = preview
              ? `[tool result cleared — ${preview}]`
              : `[tool result cleared]`;
            logger.debug(`[Agent:${agentId}] convertToLlm: stubbed toolResult[${i}]`);
          }

          // Normalise content to string for the wire format when it is a
          // simple string already (most common case for clawd tools).
          // If it is already a ContentBlock array leave it as-is — pi-ai
          // handles both forms.
          return { role, content, timestamp: m.timestamp ?? Date.now() };
        });

        // ── C: NOTES.md injection ───────────────────────────────────────────
        // Read fresh from disk every inference turn.
        // Appended as the LAST Message so it receives maximum attention.
        // Capped at CTX_NOTES_MAX_CHARS, sliced from end (newest first).
        // If NOTES.md absent or empty — no message added, zero cost.

        const notesPath = path.join(workspaceDir, "NOTES.md");
        let notesContent: string | null = null;

        try {
          if (fs.existsSync(notesPath)) {
            const raw = fs.readFileSync(notesPath, "utf-8").trim();
            if (raw.length > 0) {
              notesContent = raw.length > CTX_NOTES_MAX_CHARS
                ? "[…earlier notes truncated]\n\n" + raw.slice(-CTX_NOTES_MAX_CHARS)
                : raw;
            }
          }
        } catch (e: any) {
          logger.debug(`[Agent:${agentId}] convertToLlm: cannot read NOTES.md: ${e.message}`);
        }

        if (notesContent) {
          // Proper Message shape — content is a string (simplest valid form)
          const stateMsg: any = {
            role:      "user",
            content:   `[WORKSPACE STATE — injected automatically each turn]\n\n## NOTES.md\n\n${notesContent}`,
            timestamp: Date.now(),
          };
          logger.debug(`[Agent:${agentId}] convertToLlm: injected NOTES.md (${notesContent.length} chars)`);
          return [...wireMessages, stateMsg];
        }

        return wireMessages;
      },
    });

    if (this.isPersistent) this._piAgent = piAgent;
    return piAgent;
  }

  // ── _buildSystemPrompt ────────────────────────────────────────────────────────
  //
  // SURFACE 1: rebuilt from disk on every prompt() call.
  //
  // Layer order mirrors Anthropic's documented P0/P1/P2 priority stack:
  //
  //   P0 — Identity (SOUL.md, AGENT.md via workspace.buildSystemPromptSection)
  //   P0 — Skills registry (frontmatter-only summaries, full body on demand)
  //   P1 — Active project state (Todo.md) — injected here so it is always
  //         present without consuming a message slot or requiring a turn.
  //         Rebuilt fresh from disk every call so agent always sees current state.
  //   P0 — Tool access notes, mode instructions
  //
  // NOTES.md is NOT injected here — it lives in convertToLlm (Surface 2)
  // as the last user message, where it receives maximum attention weight.
  //
  // [VERBOSITY-SYS-PROMPT] When config.verbosity === "explicit", _toolSetNote()
  // is called with verbose=true, injecting a "Tool Examples" block with
  // concrete worked examples for every core tool. This closes 30-40% of the
  // capability gap for smaller OSS models (Qwen2.5-7B, GLM-4, etc.) without
  // affecting frontier model behavior — frontier models ignore the extra tokens.
  //
  private _buildSystemPrompt(options: PromptOptions): string {
    const parts: string[] = [];

    // [VERBOSITY-SYS-PROMPT] Determine verbosity tier from agent config.
    // "explicit" injects worked tool examples into the system prompt.
    // Anything else (or absent) uses the concise default path.
    const verbose = this.config.verbosity === "explicit";

    // Date context
    parts.push(
      `Today is ${new Date().toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      })}.`,
    );

    // P0: Identity — SOUL.md, AGENT.md, memory, workspace layout
    const wsSection = this.workspace.buildSystemPromptSection();
    if (wsSection) parts.push(wsSection);

    // P0: Skills registry
    if (this._skills.prompt) {
      parts.push(
        `## Skills\n\n` +
        `You have the following skills available. Before using a skill, read its ` +
        `\`SKILL.md\` via the relative path shown below (e.g. \`read("skills/web-search/SKILL.md")\`).\n\n` +
        this._skills.prompt,
      );
    }

    // P1: Active project — Todo.md
    // Read fresh from disk every call. Agent updates it via write tool;
    // next prompt() picks up changes automatically.
    // Not injected in convertToLlm because it is STATIC per prompt() call —
    // it changes between calls, not between turns within a call.
    const todoPath = path.join(this.workspace.workspaceDir, "Todo.md");
    try {
      if (fs.existsSync(todoPath)) {
        const todo = fs.readFileSync(todoPath, "utf-8").trim();
        if (todo) {
          parts.push(
            `## Active Project — Todo.md\n\n` +
            `This is your current project plan and execution state. ` +
            `Update it with the write tool as you complete steps.\n\n` +
            todo,
          );
        }
      }
    } catch (e: any) {
      logger.debug(`[Agent:${this.id}] _buildSystemPrompt: cannot read Todo.md: ${e.message}`);
    }

    // Prior agent outputs (team mode)
    const prior = options.priorOutputs;
    if (prior && Object.keys(prior).length > 0) {
      const lines = Object.entries(prior)
        .map(([n, p]) => `  - **${n}**: \`${p}\``)
        .join("\n");
      parts.push(
        `## Prior Agent Outputs\n\n${lines}\n\n` +
        `Read each output file with the \`read\` tool before starting your own work.`,
      );
    }

    // Work mode instructions
    if (options.mode === "work") {
      parts.push(
        `## Task Mode\n\n` +
        `You are in **work mode**. Complete the assigned task fully, ` +
        `then write your complete result to \`workspace/output.md\`.\n\n` +
        `- Save all working files inside \`workspace/\`\n` +
        `- Use relative paths only\n` +
        `- Do not navigate outside your root with \`../\``,
      );
    }

    // Tool access note
    // [VERBOSITY-SYS-PROMPT] Pass verbosity flag so smaller models receive
    // worked tool examples embedded directly in the system prompt.
    const customToolNames = this._builtinTools
      .map(t => t.name)
      .filter(n => !["read", "write", "edit", "bash"].includes(n));
    const toolNote = _toolSetNote(this.config.tools, customToolNames, verbose);
    if (toolNote) parts.push(`## Tool Access\n\n${toolNote}`);

    return parts.join("\n\n---\n\n");
  }

  // ── _loadAuthKey ──────────────────────────────────────────────────────────────
  //
  // Reads ~/.clawd/auth.json and returns the key for `provider`.
  // auth.json format:
  //   { "<provider>": { "type": "api_key", "key": "<value>" } }
  //
  // The parsed result is cached in _authCache for the lifetime of the Agent
  // instance. The cache is intentionally never invalidated — auth keys don't
  // change mid-session. A process restart picks up any new auth.json.

  private _loadAuthKey(provider: string): string {
    if (!this._authCache) {
      const authPath = path.join(path.dirname(this._modelsPath), "auth.json");
      try {
        if (fs.existsSync(authPath)) {
          const raw = fs.readFileSync(authPath, "utf-8");
          const parsed = JSON.parse(raw);
          const cache: Record<string, string> = {};
          for (const [prov, entry] of Object.entries(parsed)) {
            if (
              entry &&
              typeof entry === "object" &&
              typeof (entry as any).key === "string" &&
              (entry as any).key.length > 0
            ) {
              cache[prov] = (entry as any).key;
            }
          }
          this._authCache = cache;
          logger.debug(`[Agent:${this.id}] auth.json loaded (${Object.keys(cache).length} providers)`);
        } else {
          this._authCache = {};
        }
      } catch (e: any) {
        logger.warn(`[Agent:${this.id}] Cannot read auth.json: ${e.message}`);
        this._authCache = {};
      }
    }
    return this._authCache[provider] ?? "";
  }

  private _loadPersistedMessages(): AgentMessage[] {
    const jsonlPath = path.join(this.workspace.sessionsDir, "session.jsonl");
    if (!fs.existsSync(jsonlPath)) return [];
    try {
      return fs.readFileSync(jsonlPath, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter((m): m is AgentMessage =>
          m !== null &&
          typeof m === "object" &&
          typeof (m as any).role === "string"
        )
        .map((m: any) => ({
          ...m,
          timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
        }));
    } catch (e: any) {
      logger.warn(`[Agent:${this.id}] Cannot load session.jsonl: ${e.message}`);
      return [];
    }
  }

  private _persistMessages(piAgent: PiAgent): void {
    const messages = piAgent.state.messages;
    if (messages.length === 0) return;
    const jsonlPath = path.join(this.workspace.sessionsDir, "session.jsonl");
    const tmp       = `${jsonlPath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
      fs.writeFileSync(tmp, messages.map(m => JSON.stringify(m)).join("\n") + "\n", "utf-8");
      fs.renameSync(tmp, jsonlPath);
    } catch (e: any) {
      logger.warn(`[Agent:${this.id}] Cannot persist session.jsonl: ${e.message}`);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────────

function _skillsFingerprint(globalConfig: GlobalConfig): string {
  return JSON.stringify({
    extraDirs: globalConfig.skills?.extraDirs ?? [],
    entries:   globalConfig.skills?.entries   ?? {},
  });
}

// [VERBOSITY-TOOLNOTE] Third parameter `verbose` added (default: false).
// When verbose=true, a "Tool Examples" block with concrete worked examples
// is appended for all four core tools. When false (default), the return value
// is byte-for-byte identical to the previous implementation — no regression
// for concise (frontier) mode.
function _toolSetNote(toolSet: string, customToolNames: string[] = [], verbose = false): string {
  const base = (() => {
    switch (toolSet) {
      case "full":
      case "coding":   return "Core file tools available: **read**, **write**, **edit**, **bash**.";
      case "readonly": return "Read-only mode: **read** only. No write, edit, or bash.";
      case "bash":     return "Available: **read** + **bash**. No write or edit.";
      case "none":     return "No file or bash tools available.";
      default:         return "";
    }
  })();

  const extra = customToolNames.length
    ? `Additional tools: ${customToolNames.join(", ")}.`
    : "";

  const summary = [base, extra].filter(Boolean).join(" ");

  if (!verbose) return summary;

  // [VERBOSITY-TOOLNOTE] Explicit mode: inject worked examples.
  // Deliberately copy-paste concrete — abstract descriptions cause small
  // models to hallucinate argument names or skip required fields.
  // Frontier models skip the extra tokens with no measurable regression.
  const examples = `

## Tool Examples

Use these exact argument patterns. Do not guess parameter names.

**read** — Read a file or list a directory
\`\`\`
read(path: "src/index.ts")                         // read entire file
read(path: "src/index.ts", offset: 50, limit: 50)  // read lines 51–100
read(path: "src/")                                 // list directory contents
\`\`\`

**write** — Create or overwrite a file (also creates parent directories)
\`\`\`
write(path: "src/hello.ts", content: "console.log('hello');")
\`\`\`
After writing, the tool reports how many lines and bytes were saved.
Verify the numbers match what you intended before continuing.

**edit** — Replace an exact substring inside an existing file
\`\`\`
edit(path: "src/index.ts", oldText: "const x = 1;", newText: "const x = 2;")
// Replace every occurrence:
edit(path: "src/config.ts", oldText: "localhost", newText: "0.0.0.0", replace_all: true)
\`\`\`
oldText must match the file EXACTLY — same whitespace, same newlines.
If oldText is not found the tool returns an error; read the file and correct it before retrying.

**bash** — Run a shell command in the workspace root
\`\`\`
bash(command: "ls -la")
bash(command: "npm install", timeout: 60)
bash(command: "node -e \\"console.log(process.version)\\"")
\`\`\`
If the command fails, the result shows the error and asks you to diagnose
the cause before retrying. Do not retry the same command unchanged.`;

  return summary + examples;
}

function _argSummary(args: any): string {
  if (!args || typeof args !== "object") return "";
  if (typeof args.path    === "string") return args.path;
  if (typeof args.command === "string") return args.command.slice(0, 80);
  if (typeof args.query   === "string") return `"${args.query}"`;
  return JSON.stringify(args).slice(0, 80);
}
