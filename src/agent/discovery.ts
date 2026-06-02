// src/agent/discovery.ts — Agent template & definition discovery
//
// Discovers agent templates and definitions from multiple sources:
//   1. Built-in templates  — project's own agents-templates/ directory
//   2. Global templates    — ~/.clawd/templates/
//   3. Agent definitions   — from global agents dir and project-level agent folders
//
// - Templates define reusable agent personalities
// - Definitions declare runnable agents with config, role, and tools

import * as fs   from "fs";
import * as path from "path";
import * as os   from "os";
import { fileURLToPath } from "url";
import { getClawdDir, getAgentsDir } from "../config.js";
import { discoverProjectConfig } from "../core/project-discovery.js";
import { logger } from "../core/logger.js";
import type { AgentConfig, AgentToolSet } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentTemplate {
  id:           string;
  name:         string;
  description:  string;
  dir:          string;
  source:       "builtin" | "global" | "project" | "imported";
  files:        string[];
}

export interface AgentDefinition {
  id:                string;
  name:              string;
  description:       string;
  config:            Partial<AgentConfig>;
  sourcePath:        string;
  systemPromptPrefix?: string;
  systemPromptSuffix?: string;
  tags?:             string[];
}

export interface AgentDiscoveryResult {
  templates:    AgentTemplate[];
  definitions:  AgentDefinition[];
  errors:       string[];
}

// ── Template resolution paths ─────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function resolveBuiltinTemplatesDir(): string {
  const candidates = [
    // Project source layout: src/agent/ → <project-root>/agents-templates/
    path.resolve(__dirname, "..", "agents-templates"),
    // Compiled output layout: dist/agent/ → <project-root>/agents-templates/
    path.resolve(__dirname, "..", "..", "agents-templates"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

const BUILTIN_TEMPLATES_DIR = resolveBuiltinTemplatesDir();

function globalTemplatesDir(): string {
  return path.join(getClawdDir(), "templates");
}

// ── Public API ────────────────────────────────────────────────────────────────

export function discoverTemplates(): AgentTemplate[] {
  const templates: AgentTemplate[] = [];
  const seen = new Set<string>();

  // 1. Built-in templates from project's agents-templates/
  if (fs.existsSync(BUILTIN_TEMPLATES_DIR)) {
    for (const entry of fs.readdirSync(BUILTIN_TEMPLATES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const templateDir = path.join(BUILTIN_TEMPLATES_DIR, entry.name);
      const files = collectMarkdownFiles(templateDir);
      if (files.length === 0) continue;

      const id = entry.name;
      if (seen.has(id)) continue;
      seen.add(id);

      templates.push({
        id,
        name:      humanizeName(id),
        description: `Built-in ${entry.name} template`,
        dir:       templateDir,
        source:    "builtin",
        files,
      });
    }
  }

  // 2. Global templates from ~/.clawd/templates/
  const globalDir = globalTemplatesDir();
  if (fs.existsSync(globalDir)) {
    for (const entry of fs.readdirSync(globalDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const templateDir = path.join(globalDir, entry.name);
      const files = collectMarkdownFiles(templateDir);
      if (files.length === 0) continue;

      const id = `global-${entry.name}`;
      if (seen.has(id)) continue;
      seen.add(id);

      templates.push({
        id,
        name:      humanizeName(entry.name),
        description: `Global template: ${entry.name}`,
        dir:       templateDir,
        source:    "global",
        files,
      });
    }
  }

  return templates;
}

export function discoverDefinitions(): AgentDefinition[] {
  const definitions: AgentDefinition[] = [];
  const seen = new Set<string>();

  // 1. Agent definitions from ~/.clawd/agents/<id>/config.json (global)
  const agentsDir = getAgentsDir();
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const configPath = path.join(agentsDir, entry.name, "config.json");
      if (!fs.existsSync(configPath)) continue;
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as AgentConfig;
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        definitions.push({
          id:          entry.name,
          name:        config.name || entry.name,
          description: config.description || `Agent: ${entry.name}`,
          config,
          sourcePath:  configPath,
          tags:        config.tags,
        });
      } catch (e: any) {
        logger.warn(`[AgentDiscovery] Bad config at ${configPath}: ${e.message}`);
      }
    }
  }

  // 2. [AGENT-DISCOVERY] Project-level self-contained agent folders
  //    Scans <project>/agents/<name>/, .claude/agents/<name>/, .opencode/agents/<name>/
  //    and .clawd/agents/<name>/ for self-contained agent directories.
  try {
    const projectDiscovery = discoverProjectConfig();
    for (const agentFolder of projectDiscovery.agentFolders) {
      const configPath = path.join(agentFolder, "config.json");
      if (!fs.existsSync(configPath)) continue;
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as AgentConfig;
        const id = path.basename(agentFolder);
        if (seen.has(id)) continue;
        seen.add(id);
        definitions.push({
          id,
          name:        config.name || id,
          description: config.description || `Project agent: ${id}`,
          config,
          sourcePath:  configPath,
          tags:        config.tags ?? ["project"],
        });
      } catch (e: any) {
        logger.warn(`[AgentDiscovery] Bad config at ${configPath}: ${e.message}`);
      }
    }
  } catch (e: any) {
    logger.warn(`[AgentDiscovery] Project-level agent discovery error: ${e.message}`);
  }

  // 2. Agent definition JSON files from workspace/agents/
  // Files define lightweight agents that can be spawned by the orchestrator
  const workspaceAgentsDir = path.join(process.cwd(), "workspace", "agents");
  if (fs.existsSync(workspaceAgentsDir)) {
    for (const entry of fs.readdirSync(workspaceAgentsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(workspaceAgentsDir, entry.name);
      try {
        const def = JSON.parse(fs.readFileSync(filePath, "utf-8")) as AgentDefinition & { workspace?: string };
        const id = def.id || def.name || entry.name.replace(/\.json$/, "");
        if (seen.has(id)) continue;
        seen.add(id);

        const config: Partial<AgentConfig> = {
          name:            def.name || id,
          description:     def.description,
          tools:          (def.config?.tools as AgentToolSet) ?? "standard",
          persistent:     def.config?.persistent ?? false,
          maxTurns:       def.config?.maxTurns ?? 30,
          timeoutSeconds: def.config?.timeoutSeconds ?? 180,
          model:          def.config?.model,
          provider:       def.config?.provider,
          tags:           def.tags,
        };

        definitions.push({
          id,
          name:                def.name || id,
          description:         def.description || `Custom agent role: ${id}`,
          config,
          sourcePath:          filePath,
          systemPromptPrefix:  (def as any).systemPromptPrefix,
          systemPromptSuffix:  (def as any).systemPromptSuffix,
          tags:                def.tags,
        });
      } catch (e: any) {
        logger.warn(`[AgentDiscovery] Bad agent definition at ${filePath}: ${e.message}`);
      }
    }
  }

  return definitions;
}

export function discoverAll(projectDir?: string): AgentDiscoveryResult {
  const errors: string[] = [];

  let templates: AgentTemplate[];
  try { templates = discoverTemplates(); }
  catch (e: any) { errors.push(`Templates: ${e.message}`); templates = []; }

  let definitions: AgentDefinition[];
  try { definitions = discoverDefinitions(); }
  catch (e: any) { errors.push(`Definitions: ${e.message}`); definitions = []; }

  logger.info(
    `[AgentDiscovery] Found ${templates.length} templates, ${definitions.length} definitions`,
  );

  return { templates, definitions, errors };
}

export function findTemplate(id: string): AgentTemplate | undefined {
  return discoverTemplates().find(t => t.id === id || t.name === id);
}

export function findDefinition(id: string): AgentDefinition | undefined {
  return discoverDefinitions().find(d => d.id === id || d.name === id);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectMarkdownFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith(".md"));
  } catch {
    return [];
  }
}

function humanizeName(name: string): string {
  return name
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}
