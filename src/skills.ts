// src/skills.ts — Load and gate-check skills for an agent
//
// Pure OpenClaw-compatible skill loader with Claude Code plugin bridge.
//
// Changes:
//   - _parseMeta() now reads ONLY the `openclaw` namespace from SKILL.md frontmatter.
//     Legacy `clawdbot` and `clawd` namespace fallbacks are removed entirely.
//     Any skill from the official OpenClaw ecosystem (badlogic/pi-mono) uses
//     the `openclaw` namespace in its SKILL.md frontmatter — no fallback needed.
//
//   - `systemPromptSection` added as alias for `prompt` on SkillsSnapshot so
//     callers can use the canonical OpenClaw property name.
//
//   - `version` added as optional field on Skill so API callers (api.ts
//     _routeSkills) can surface it without a TypeScript error. The field is
//     populated from frontmatter `version:` if present.
//
//   - [PLUGIN-BRIDGE] Claude Code plugin discovery and integration. When enabled,
//     automatically discovers installed Claude Code plugins from ~/.claude/plugins/
//     and wraps them as skills. MCP-based plugins are registered via mcpClient.
//
// Fix log:
//   [SKILLS-FIX-1] Removed duplicate `const mcpManager` variable declarations.
//                  The isHttpMcpPlugin branch was shadowing the outer mcpManager
//                  constant with an identical const in the same scope. TypeScript
//                  emits TS2454 / TS2451 (block-scoped variable declared twice).
//                  Fix: hoist one shared `const mcpManager = getMcpManager()` before
//                  the transport-type branches and remove the redundant inner const.
//
// OpenClaw SKILL.md frontmatter reference:
//
//   ---
//   name: web-search
//   description: Search the web using DuckDuckGo or Brave
//   version: 1.0.0
//   metadata:
//     openclaw:
//       skillKey: web-search       # config.skills.entries key (default: name)
//       always: false              # skip all gate checks if true
//       os: [linux, darwin, win32] # platform restriction (optional)
//       primaryEnv: SERPER_API_KEY # env var that config.skills.entries.apiKey maps to
//       requires:
//         bins: [curl]             # all must be present
//         anyBins: [node, python3] # at least one must be present
//         env: [SERPER_API_KEY]    # all must be set (process.env or config.skills.entries)
//   ---

import * as fs   from "fs";
import * as path from "path";
import * as os   from "os";
import which     from "which";
import matter    from "gray-matter";
import { logger } from "./core/logger.js";
import { CLAWD_SKILLS_DIR } from "./config.js";
import type { GlobalConfig } from "./config.js";
import { getMcpManager } from "./mcp/client.js";

// [PLUGIN-BRIDGE] Import plugin bridge modules
import {
  discoverClaudePlugins,
  loadPluginManifest,
  isMcpPlugin,
  isHttpMcpPlugin,
  isStdioMcpPlugin,
  getLatestInstallation
} from "./skills/claude-plugin-bridge.js";
import {
  pluginToMcpConfig,
  pluginToHttpMcpConfig,
  getPluginServerName,
  validateMcpConfig,
  validateHttpMcpConfig
} from "./skills/mcp-plugin-adapter.js";
import { wrapPluginAsSkill } from "./skills/plugin-skill-wrapper.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillMeta {
  skillKey?:   string;
  always?:     boolean;
  os?:         string[];
  primaryEnv?: string;
  requires?:   { bins?: string[]; anyBins?: string[]; env?: string[]; config?: string[] };
}

export interface Skill {
  name:          string;
  description:   string;
  /** Optional version string from SKILL.md frontmatter `version:` field. */
  version?:      string;
  location:      string;
  skillDir:      string;
  modelVisible:  boolean;
  userInvocable: boolean;
  skillMeta:     SkillMeta;
  raw:           string;
  body:          string;
  configKey:     string;
}

export interface GateFailure { kind: string; detail: string; }

export interface SkillsSnapshot {
  all:                  Array<{ skill: Skill; eligible: boolean; failures: GateFailure[] }>;
  skills:               Skill[];
  loadedAt:             Date;
  /** XML block injected into the system prompt. */
  prompt:               string;
  /** Alias for `prompt` — canonical property name used by agent.ts */
  systemPromptSection:  string;
}

export function emptySkillsSnapshot(): SkillsSnapshot {
  return {
    all: [], skills: [], loadedAt: new Date(),
    prompt: "", systemPromptSection: "",
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function loadSkills(
  agentDir:       string,
  config:         GlobalConfig,
  setupSkillsDir?: string,
): Promise<SkillsSnapshot> {
  const dirs: string[] = [];

  if (fs.existsSync(CLAWD_SKILLS_DIR)) dirs.push(CLAWD_SKILLS_DIR);
  if (setupSkillsDir && fs.existsSync(setupSkillsDir)) dirs.push(setupSkillsDir);

  const agentSkillsDir = path.join(agentDir, "skills");
  if (fs.existsSync(agentSkillsDir)) dirs.push(agentSkillsDir);

  for (const d of config.skills.extraDirs ?? []) {
    const resolved = d.startsWith("~/")
      ? path.join(os.homedir(), d.slice(2))
      : path.resolve(d);
    if (fs.existsSync(resolved)) dirs.push(resolved);
  }

  // Scan all directories for skills, deduplicating by name (last-wins).
  const byName = new Map<string, Skill>();
  for (const dir of dirs) {
    for (const skill of _scan(dir)) {
      byName.set(skill.name, skill);
    }
  }

  // [PLUGIN-BRIDGE] Discover and integrate Claude Code plugins.
  // [SKILLS-FIX-1] Hoist mcpManager before the transport-type if-branches so
  // it is not declared twice in the same block scope.
  if (config.skills?.bridgeClaudePlugins !== false) {
    try {
      const pluginsPath = config.skills?.claudePluginsPath;
      const plugins = discoverClaudePlugins(pluginsPath);

      logger.debug(`[PluginBridge] Processing ${plugins.length} plugins`);

      for (const plugin of plugins) {
        const installation = getLatestInstallation(plugin);
        const manifest = loadPluginManifest(installation.installPath);

        if (!manifest) {
          logger.warn(`[PluginBridge] Skipping ${plugin.name}: no valid manifest`);
          continue;
        }

        const validManifest = manifest as NonNullable<typeof manifest>;

        // Wrap plugin as skill
        const skill = wrapPluginAsSkill(plugin, validManifest);
        byName.set(skill.name, skill);

        logger.info(`[PluginBridge] Loaded plugin skill: ${skill.name} (${validManifest.version})`);

        // If MCP plugin, register as MCP server via getMcpManager().
        if (isMcpPlugin(validManifest)) {
          const serverName = getPluginServerName(plugin);
          // [SKILLS-FIX-1] Single mcpManager declaration, shared across both branches.
          const mcpManager = getMcpManager();

          if (isHttpMcpPlugin(validManifest)) {
            const mcpConfig = pluginToHttpMcpConfig(plugin, validManifest);

            if (!mcpConfig) {
              logger.warn(`[PluginBridge] Could not generate HTTP MCP config for ${plugin.name}`);
              continue;
            }

            const validConfig = mcpConfig as NonNullable<typeof mcpConfig>;

            if (validateHttpMcpConfig(validConfig)) {
              try {
                await mcpManager.connectHttp(serverName, validConfig);
                logger.info(`[PluginBridge] Registered HTTP MCP server: ${serverName}`);
              } catch (error: any) {
                logger.error(`[PluginBridge] Failed to connect HTTP MCP server ${serverName}: ${error.message}`);
              }
            } else {
              logger.warn(`[PluginBridge] Invalid HTTP MCP config for ${plugin.name}`);
            }
          } else if (isStdioMcpPlugin(validManifest)) {
            const mcpConfig = pluginToMcpConfig(plugin, validManifest);

            if (!mcpConfig) {
              logger.warn(`[PluginBridge] Could not generate stdio MCP config for ${plugin.name}`);
              continue;
            }

            const validConfig = mcpConfig as NonNullable<typeof mcpConfig>;

            if (validateMcpConfig(validConfig)) {
              try {
                await mcpManager.connect(serverName, validConfig);
                logger.info(`[PluginBridge] Registered stdio MCP server: ${serverName}`);
              } catch (error: any) {
                logger.error(`[PluginBridge] Failed to connect stdio MCP server ${serverName}: ${error.message}`);
              }
            } else {
              logger.warn(`[PluginBridge] Invalid stdio MCP config for ${plugin.name}`);
            }
          }
        }
      }

      if (plugins.length > 0) {
        logger.info(`[PluginBridge] Successfully loaded ${plugins.length} Claude Code plugins`);
      }

    } catch (error: any) {
      logger.error(`[PluginBridge] Plugin discovery failed: ${error.message}`);
    }
  }

  const all: SkillsSnapshot["all"] = [];
  for (const skill of byName.values()) {
    _injectEnv(skill, config);
    const failures = await _checkGates(skill, config);
    all.push({ skill, eligible: failures.length === 0, failures });
  }

  const skills = all.filter(e => e.eligible).map(e => e.skill);

  const promptXml = _buildPrompt(skills);
  return {
    all,
    skills,
    loadedAt:            new Date(),
    prompt:              promptXml,
    systemPromptSection: promptXml,
  };
}

/**
 * Watch skill directories for changes and invoke the callback.
 * Returns a stop function.
 */
export function watchSkills(
  agentDir:       string,
  config:         GlobalConfig,
  onChange:       () => void,
  setupSkillsDir?: string,
): () => void {
  const dirs: string[] = [];

  if (fs.existsSync(CLAWD_SKILLS_DIR)) dirs.push(CLAWD_SKILLS_DIR);
  if (setupSkillsDir && fs.existsSync(setupSkillsDir)) dirs.push(setupSkillsDir);

  const agentSkillsDir = path.join(agentDir, "skills");
  if (fs.existsSync(agentSkillsDir)) dirs.push(agentSkillsDir);

  const watchers: fs.FSWatcher[] = [];
  const debounceMs = config.skills.watchDebounceMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };

  for (const dir of dirs) {
    try {
      const w = fs.watch(dir, { recursive: true }, trigger);
      watchers.push(w);
    } catch (e: any) {
      logger.warn(`[Skills] Cannot watch ${dir}: ${e.message}`);
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) { try { w.close(); } catch {} }
  };
}

// ── Private ───────────────────────────────────────────────────────────────────

function _buildPrompt(skills: Skill[]): string {
  if (!skills.length) return "";
  const items = skills
    .filter(s => s.modelVisible)
    .map(s => `<skill name="${_esc(s.name)}">\n${s.body}\n</skill>`)
    .join("\n\n");
  return items ? `<skills>\n${items}\n</skills>` : "";
}

function _scan(dir: string): Skill[] {
  const skills: Skill[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return skills; }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillDir = path.join(dir, e.name);
    const mdPath   = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(mdPath)) continue;

    try {
      const raw    = fs.readFileSync(mdPath, "utf-8");
      const parsed = matter(raw);
      const fm     = parsed.data as any;

      if (!fm.name || !fm.description) {
        logger.warn(`[Skills] Missing name/description frontmatter: ${mdPath}`);
        continue;
      }

      const meta = _parseMeta(fm.metadata);
      const body = parsed.content.replace(/\{baseDir\}/g, skillDir);

      skills.push({
        name:          fm.name,
        description:   fm.description,
        version:       fm.version ?? undefined,
        location:      mdPath,
        skillDir,
        modelVisible:  fm["disable-model-invocation"] !== true,
        userInvocable: fm["user-invocable"] !== false,
        skillMeta:     meta,
        raw,
        body,
        configKey:     meta.skillKey ?? fm.name,
      });
    } catch (e: any) {
      logger.warn(`[Skills] Parse error at ${mdPath}: ${e.message}`);
    }
  }

  return skills;
}

/**
 * Parse the `metadata` frontmatter field.
 *
 * Pure OpenClaw: reads ONLY the `openclaw` namespace.
 * Legacy `clawdbot` and `clawd` fallbacks are intentionally removed.
 * Any skill from badlogic/pi-mono (or any OpenClaw-compatible source)
 * uses `openclaw` as the namespace per the OpenClaw specification.
 */
function _parseMeta(raw: any): SkillMeta {
  if (!raw) return {};

  let m: any = raw;
  if (typeof m === "string") {
    try { m = JSON.parse(m); } catch { return {}; }
  }
  if (typeof m !== "object" || Array.isArray(m)) return {};

  // Pure OpenClaw: only the `openclaw` namespace is recognised.
  const ns = m.openclaw;
  if (!ns) return {};

  if (typeof ns === "string") {
    try { return JSON.parse(ns); } catch { return {}; }
  }

  return typeof ns === "object" && !Array.isArray(ns) ? ns : {};
}

async function _checkGates(s: Skill, config: GlobalConfig): Promise<GateFailure[]> {
  const failures: GateFailure[] = [];
  const oc    = s.skillMeta;
  const entry = config.skills.entries?.[s.configKey];

  if (oc.always) return [];

  if (entry?.enabled === false) {
    failures.push({ kind: "disabled", detail: `"${s.configKey}" is disabled in config` });
    return failures;
  }

  if (oc.os?.length && !oc.os.includes(process.platform)) {
    failures.push({
      kind:   "os",
      detail: `needs [${oc.os.join(", ")}], running on ${process.platform}`,
    });
  }

  if (oc.requires?.bins) {
    for (const b of oc.requires.bins) {
      if (!await _bin(b)) failures.push({ kind: "bin", detail: `missing binary "${b}"` });
    }
  }

  if (oc.requires?.anyBins?.length) {
    const results = await Promise.all(oc.requires.anyBins.map(_bin));
    if (!results.some(Boolean)) {
      failures.push({
        kind:   "anyBin",
        detail: `needs one of [${oc.requires.anyBins.join(", ")}]`,
      });
    }
  }

  if (oc.requires?.env) {
    for (const e of oc.requires.env) {
      const inProcess  = !!process.env[e];
      const inApiKey   = !!entry?.apiKey && e === oc.primaryEnv;
      const inEntryEnv = !!entry?.env?.[e];
      if (!inProcess && !inApiKey && !inEntryEnv) {
        failures.push({ kind: "env", detail: `missing env var "${e}"` });
      }
    }
  }

  return failures;
}

function _injectEnv(s: Skill, config: GlobalConfig): void {
  const e = config.skills.entries?.[s.configKey];
  if (!e) return;
  if (e.apiKey && s.skillMeta.primaryEnv && !process.env[s.skillMeta.primaryEnv]) {
    process.env[s.skillMeta.primaryEnv] = e.apiKey;
  }
  if (e.env) {
    for (const [k, v] of Object.entries(e.env)) {
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

async function _bin(b: string): Promise<boolean> {
  try { await which(b); return true; } catch { return false; }
}

function _esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
