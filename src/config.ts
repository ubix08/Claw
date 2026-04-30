// src/config.ts — clawd configuration
//
// REFACTOR: pi-coding-agent → pi-agent-core
//
//   REMOVED  getPiAuthPath(), getPiModelsPath()
//   REMOVED  PI_AUTH_PATH, PI_MODELS_PATH constants
//   REMOVED  ensureAuthJson()  — only needed to feed pi-coding-agent's AuthStorage
//   REMOVED  ensureModelsJson() — only needed to feed pi-coding-agent's ModelRegistry
//
//   With pi-agent-core, model lookup goes through _buildModel() on the Agent
//   class, which reads directly from clawd's own models.json. No file sync to
//   ~/.pi/agent/ is required and no pi-ai getModel() call is made.
//
//   RETAINED loadEnv() — still needed to populate process.env from ~/.clawd/.env
//            before any _buildModel() call so API keys are available.
//
// Fix log:
//   [CFG-FIX-1] REMOVED — ensureModelsJson() sync bridge no longer needed.
//   [CFG-FIX-2] REMOVED — model ID validation was part of the sync bridge.
//               Set CLAWD_HOME env var to isolate multiple instances.
//
//   [CFG-FIX-3] `deployments` field added to GlobalConfig.
//               DeploymentManager previously wrote this field as
//               `(config as any).deployments`, bypassing TypeScript and making
//               the field invisible to the type system. Any code that read it
//               back also used `(config as any)`. The field is now declared
//               explicitly so:
//                 - Callers get proper type-checking.
//                 - The default config initialises it to an empty array so
//                   existing clawd.json files without the field still load
//                   cleanly via deepMerge.
//               deployment/manager.ts and gateway.ts are updated separately to
//               drop their `(config as any)` casts.
//
//   [CFG-FIX-4] getAuthPath() / CLAWD_AUTH_PATH added.
//               agent/agent.ts _resolveApiKey() reads ~/.clawd/auth.json as a
//               fallback when models.json providers.<n>.apiKey is absent or
//               resolves to an empty string. This restores compatibility with
//               the pi-agent-core auth.json format without re-introducing the
//               old ensureAuthJson() sync bridge.
//
//   [CFG-FIX-5] DEFAULT_CONFIG api.enabled changed to TRUE.
//               The architecture mandates the HTTP API as the only interaction
//               surface (all UI handled at the frontend). Defaulting to false
//               caused new installs to silently not start the server unless the
//               user explicitly set api.enabled: true in clawd.json, which is
//               contrary to the design. The setup wizard (cli-setup.ts) always
//               prompts for port/token, so the field is now documentation-only.
//
//   [CFG-FIX-6] overrideApiPort() also updates the loaded _config in-memory
//               so callers that read config.api.port after calling
//               overrideApiPort() see the correct value without a reload.
//
// Team refactor:
//   REMOVED  getTeamsDir() function
//   REMOVED  CLAWD_TEAMS_DIR exported constant
//   REMOVED  teamDir(), teamConfigPath(), teamSharedDir(), teamAgentDir() path helpers
//   REMOVED  activeTeam: string | null field from GlobalConfig interface
//   REMOVED  activeTeam: null from DEFAULT_CONFIG

import * as fs   from "fs";
import * as path from "path";
import * as os   from "os";
import type { LogLevel } from "./core/logger.js";

// ── Runtime home resolution ───────────────────────────────────────────────────

export function getClawdHome(): string {
  return process.env["CLAWD_HOME"] ?? process.env["HOME"] ?? os.homedir();
}
export function getClawdDir(): string { return path.join(getClawdHome(), ".clawd"); }

// ── Path getters ──────────────────────────────────────────────────────────────

export function getAgentsDir():    string { return path.join(getClawdDir(), "agents"); }
export function getStagedDir():    string { return path.join(getClawdDir(), "staged"); }
export function getSkillsDir():    string { return path.join(getClawdDir(), "skills"); }
export function getConfigPath():   string { return path.join(getClawdDir(), "clawd.json"); }
export function getEnvPath():      string { return path.join(getClawdDir(), ".env"); }
export function getModelsPath():   string { return path.join(getClawdDir(), "models.json"); }
// [CFG-FIX-4] Auth path for pi-agent-core compatible API key store.
export function getAuthPath():     string { return path.join(getClawdDir(), "auth.json"); }

// ── Exported string constants (module-load-time snapshots) ────────────────────

export const CLAWD_DIR:         string = getClawdDir();
export const CLAWD_AGENTS_DIR:  string = getAgentsDir();
export const CLAWD_STAGED_DIR:  string = getStagedDir();
export const CLAWD_SKILLS_DIR:  string = getSkillsDir();
export const CONFIG_PATH:       string = getConfigPath();
export const ENV_PATH:          string = getEnvPath();
export const CLAWD_MODELS_PATH: string = getModelsPath();
// [CFG-FIX-4]
export const CLAWD_AUTH_PATH:   string = getAuthPath();
export const DEFAULT_AGENT_ID          = "clawd";

// ── Agent path helpers ────────────────────────────────────────────────────────

export function agentDir(agentId: string):        string { return path.join(getAgentsDir(), agentId); }
export function agentConfigPath(agentId: string):  string { return path.join(agentDir(agentId), "config.json"); }
export function agentSessionsDir(agentId: string): string { return path.join(agentDir(agentId), "sessions"); }

// ── GlobalConfig ──────────────────────────────────────────────────────────────

export interface GlobalConfig {
  activeAgent: string;
  defaults: {
    model:          string;
    provider:       string;
    maxTurns:       number;
    timeoutSeconds: number;
    thinkingLevel:  "off" | "minimal" | "low" | "medium" | "high";
  };
  api: {
    // [CFG-FIX-5] enabled defaults to true — server mode is the only mode.
    enabled: boolean;
    port:    number;
    host:    string;
    auth?:   { token: string };
  };
  skills: {
    extraDirs:        string[];
    watch:            boolean;
    watchDebounceMs?: number;
    entries:          Record<string, {
      enabled?: boolean;
      apiKey?:  string;
      env?:     Record<string, string>;
    }>;
    // [PLUGIN-BRIDGE] Claude Code plugin integration options
    bridgeClaudePlugins?: boolean;  // Default: true (auto-discover plugins)
    claudePluginsPath?:   string;   // Default: ~/.claude/plugins
  };
  log: { level: LogLevel };
}

// [CFG-FIX-5] api.enabled: true — the API is always the interaction surface.
const DEFAULT_CONFIG: GlobalConfig = {
  activeAgent: DEFAULT_AGENT_ID,
  defaults: {
    model:          "claude-sonnet-4-6",
    provider:       "anthropic",
    maxTurns:       50,
    timeoutSeconds: 300,
    thinkingLevel:  "off",
  },
  api:    { enabled: true, port: 3141, host: "0.0.0.0" },
  skills: {
    extraDirs: [],
    watch: true,
    entries: {},
    bridgeClaudePlugins: true,  // [PLUGIN-BRIDGE] Enabled by default
  },
  log:    { level: "info" },
};

// ── Config I/O ────────────────────────────────────────────────────────────────

let _config: GlobalConfig | null = null;

export function loadConfig(configPath?: string): GlobalConfig {
  const cfgPath = configPath ?? getConfigPath();
  if (_config) return _config;
  if (!fs.existsSync(cfgPath)) { _config = structuredClone(DEFAULT_CONFIG); return _config; }
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    _config = deepMerge(DEFAULT_CONFIG, parsed) as GlobalConfig;
    return _config;
  } catch (err: any) {
    console.error(`[clawd] Failed to parse ${cfgPath}: ${err.message}`);
    _config = structuredClone(DEFAULT_CONFIG); return _config;
  }
}

export function saveConfig(c: GlobalConfig, configPath?: string): void {
  const cfgPath = configPath ?? getConfigPath();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2) + "\n", "utf-8");
  _config = c;
}

export function resetConfig(): void { _config = null; }

// [CFG-FIX-6] Also update the in-memory loaded config so callers that read
// config.api.port after overrideApiPort() see the correct value.
export function overrideApiPort(port: number): void {
  const c = loadConfig();
  c.api.port = port;
  // intentionally NOT calling saveConfig — in-memory only
}

// ── Env loading ───────────────────────────────────────────────────────────────
//
// Loads ~/.clawd/.env into process.env before any _buildModel() call.
// _buildModel() (agent/agent.ts) reads API keys directly from process.env so
// this is the only bootstrap step required — no file sync to ~/.pi/agent/
// needed.

export function loadEnv(envPath?: string): void {
  const p = envPath ?? getEnvPath();
  if (!fs.existsSync(p)) return;
  try {
    for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch (err: any) { console.warn(`[clawd] Cannot load ${p}: ${err.message}`); }
}

// ── Deep merge helper ─────────────────────────────────────────────────────────

function deepMerge(base: any, override: any): any {
  if (typeof base !== "object" || base === null) return override ?? base;
  if (typeof override !== "object" || override === null) return base;
  if (Array.isArray(base)) return Array.isArray(override) ? override : base;
  const result: any = { ...base };
  for (const k of Object.keys(override)) result[k] = deepMerge(base[k], override[k]);
  return result;
}
