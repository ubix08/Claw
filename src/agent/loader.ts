// src/agent/loader.ts — Pure OpenClaw-compatible agent loader.
//
// Removed:
//   - SOLO_TOOLS, TEAM_SPECIALIST_TOOLS constants
//   - defaultCustomTools() helper
//   - customTools backfilling in loadAgentFromPath()
//   - customTools filter/injection in scaffoldAgentAt()
//   - remote_send/remote_poll references in TOOLS.md scaffold
//   - browser-tools reference in TOOLS.md scaffold
//
// Agent templates and config.json from any standard OpenClaw template
// are now loaded as-is. Tools are purely the core file/bash toolset
// controlled by config.tools (full/coding/readonly/bash/none) + skills.
//
// Fix log:
//   [LOADER-FIX-1] loadAgent / loadAgentFromPath contract documented: the
//                  returned Agent is UNINITIALIZED. Callers MUST call
//                  agent.init() before passing the agent to any prompt()
//                  or wire() call.
//
//   [LOADER-FIX-2] scaffoldAgentAt() now explicitly creates the workspace/
//                  subdirectory alongside memory/, sessions/, and skills/.
//
//   [LOADER-FIX-3] Removed dead isTeamAgent / isOrchestrator parameters from
//                  loadAgentFromPath() and scaffoldAgentAt(). These were
//                  remnants of the team refactor. They added noise, implied
//                  dead branches, and the sharedNote injection that depended
//                  on isTeamAgent was the only downstream use — also removed.
//                  Public call sites loadAgent() and scaffoldAgent() already
//                  passed false for both, so the external contract is unchanged.

import * as fs   from "fs";
import * as path from "path";
import { getAgentsDir, agentDir, DEFAULT_AGENT_ID } from "../config.js";
import { AgentWorkspace }  from "./workspace.js";
import { Agent }           from "./agent.js";
import { getDefaultBus }   from "../core/event-bus.js";
import { loadConfig }      from "../config.js";
import { logger }          from "../core/logger.js";
import { hasOptimizedTemplates, getOptimizedScaffoldFiles } from "./scaffold-optimizer.js";
import type { AgentConfig } from "./types.js";
import type { EventBus }    from "../core/event-bus.js";
import type { GlobalConfig } from "../config.js";

function defaultAgentConfig(globalConfig: GlobalConfig): AgentConfig {
  return {
    name:           "Clawd",
    description:    "Personal AI assistant",
    model:          globalConfig.defaults.model,
    provider:       globalConfig.defaults.provider,
    tools:          "full",
    persistent:     true,
    maxTurns:       globalConfig.defaults.maxTurns,
    timeoutSeconds: globalConfig.defaults.timeoutSeconds,
    thinkingLevel:  globalConfig.defaults.thinkingLevel,
  };
}

/**
 * Load an Agent from an explicit filesystem path.
 *
 * [LOADER-FIX-1] The returned Agent is UNINITIALIZED. You MUST call
 * `await agent.init()` before invoking `agent.prompt()`, `agent.wire()`, or
 * any other method that requires the skills snapshot or sessions directory to
 * be ready.
 *
 * [LOADER-FIX-3] isTeamAgent and isOrchestrator parameters removed — team
 * mode has been fully removed. They had no effect on the agent returned and
 * the only downstream use (sharedNote injection in scaffoldAgentAt) is gone.
 *
 * @param agentId        The agent's logical identifier (used in logs).
 * @param agentPath      Absolute path to the agent's root directory.
 * @param bus            EventBus instance (defaults to the process-global bus).
 * @param globalConfig   GlobalConfig (defaults to the process-global config).
 * @param extraSkillsDir Optional additional skills directory to scan.
 */
export function loadAgentFromPath(
  agentId:        string,
  agentPath:      string,
  bus:            EventBus      = getDefaultBus(),
  globalConfig:   GlobalConfig  = loadConfig(),
  extraSkillsDir?: string,
): Agent {
  const workspace = new AgentWorkspace(agentId, agentPath, extraSkillsDir);
  let config: AgentConfig;
  const loaded = workspace.loadConfig();

  if (loaded) {
    // Load config as-is from disk — no clawd-specific backfilling.
    config = loaded;
  } else {
    if (agentId === DEFAULT_AGENT_ID) {
      config = defaultAgentConfig(globalConfig);
    } else {
      throw new Error(
        `Agent "${agentId}" not found at ${agentPath}.\n` +
        `Run: clawd agents create ${agentId}`,
      );
    }
  }

  logger.debug(`[Loader] "${agentId}" tools: ${config.tools}`);
  return new Agent(agentId, workspace, config, bus, globalConfig);
}

/**
 * Load an Agent from the standard global agents directory.
 *
 * [LOADER-FIX-1] The returned Agent is UNINITIALIZED. You MUST call
 * `await agent.init()` before using the agent.
 */
export function loadAgent(
  agentId:      string,
  bus:          EventBus      = getDefaultBus(),
  globalConfig: GlobalConfig  = loadConfig(),
): Agent {
  return loadAgentFromPath(agentId, agentDir(agentId), bus, globalConfig);
}

export function listAgentIds(): string[] {
  const dir = getAgentsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

/**
 * Scaffold a new agent directory with OpenClaw-standard files.
 *
 * [LOADER-FIX-3] isTeamAgent and isOrchestrator parameters removed.
 * The sharedNote string they generated has also been removed — it was
 * the only code that branched on these values.
 *
 * Scaffold files written:
 *   config.json   — agent configuration
 *   AGENT.md      — primary identity file (OpenClaw standard)
 *   SOUL.md       — personality / mission (also read by workspace)
 *   IDENTITY.md   — name and role
 *   USER.md       — user context
 *   TOOLS.md      — tool usage guidelines
 *   memory/       — created empty
 *   sessions/     — created empty
 *   skills/       — created empty
 *   workspace/    — created empty [LOADER-FIX-2]
 */
export function scaffoldAgentAt(
  agentId:  string,
  dir:      string,
  config:   AgentConfig,
  overwrite = false,
): void {
  const workspace = new AgentWorkspace(agentId, dir);
  workspace.ensureExists();

  // [LOADER-FIX-2] Explicitly create all standard subdirectories so callers
  // that inspect or write to workspace/ before the first prompt() call do not
  // have to create it themselves.
  for (const sub of ["memory", "sessions", "skills", "workspace"]) {
    try { fs.mkdirSync(path.join(dir, sub), { recursive: true }); } catch {}
  }

  if (!fs.existsSync(path.join(dir, "config.json")) || overwrite) {
    workspace.saveConfig(config);
    logger.info(`[Scaffold] ${agentId}/config.json → ${dir}`);
  }

  // Try to use optimized templates if available
  let scaffoldFiles: [string, string][] = [];

  if (hasOptimizedTemplates()) {
    logger.info(`[Scaffold] Using optimized behavioral intelligence templates`);
    scaffoldFiles = getOptimizedScaffoldFiles(
      config.name || agentId,
      config.description || "A capable AI assistant."
    );
  }

  // Fallback to basic templates if optimized not available
  if (scaffoldFiles.length === 0) {
    logger.info(`[Scaffold] Using basic templates (optimized templates not found)`);
    scaffoldFiles = [
      [
        "AGENT.md",
        `# ${config.name}\n\n${config.description ?? "A helpful AI assistant."}\n\n## Identity\n\n- Name: ${config.name}\n- Role: AI Assistant\n- Provider: ${config.provider ?? "anthropic"}\n- Model: ${config.model}\n`,
      ],
      [
        "SOUL.md",
        `# ${config.name}\n\nEdit this file to define your identity, personality, and working style.\n\n## Personality\n\n- Helpful, accurate, and concise\n- Admits uncertainty\n- Asks for clarification when needed\n`,
      ],
      [
        "TOOLS.md",
        `# Tool Guidelines\n\n- Read files before editing them\n- Prefer targeted edits over full rewrites\n- Use skills installed in skills/ for extended capabilities\n- Run: clawd skills hub to browse available skills\n`,
      ],
    ];
  }

  for (const [file, content] of scaffoldFiles) {
    if (!fs.existsSync(path.join(dir, file)) || overwrite) {
      fs.writeFileSync(path.join(dir, file), content, "utf-8");
    }
  }

  logger.info(`[Scaffold] Agent "${agentId}" ready at ${dir}`);
}

export function scaffoldAgent(agentId: string, config: AgentConfig, overwrite = false): void {
  scaffoldAgentAt(agentId, agentDir(agentId), config, overwrite);
}
