// src/agent/system-def.ts — system.json schema and loader

import * as fs   from "fs";
import * as path from "path";
import { logger } from "../core/logger.js";
import type { AgentToolSet } from "./types.js";

/**
 * Role an agent plays within the system.
 *   orchestrator — the hub (Admin OS); routes tasks, receives user input
 *   worker       — performs domain work; responds only to orchestrator
 *   observer     — read-only; may monitor but never act
 */
export type AgentRole = "orchestrator" | "worker" | "observer";

/** Per-agent declaration inside system.json. */
export interface SystemAgentDef {
  folder:      string;          // relative or absolute path to agent folder
  role:        AgentRole;
  respondsTo:  string[];        // agent IDs whose messages this agent processes
  tags?:       string[];
  startup?:    boolean;         // pre-load at system start (default true)
}

/** Route permission between two agents (hub-and-spoke via orchestrator). */
export interface SystemRoute {
  from:    string;
  to:      string;
  allow:   boolean;
}

/**
 * Top-level system definition.
 *
 * A system.json lives at the project root or in the AI-OS data directory.
 * It declares every agent in the running system, how they connect, and
 * the default tool set for agents that don't specify one in their own
 * config.json.
 */
export interface SystemDefinition {
  /** Version of the system-def format (currently 1). */
  version?:      number;

  /** Named agent entries keyed by agent ID. */
  agents:        Record<string, SystemAgentDef>;

  /** Routing rules. If omitted, all orchestrator→worker routes are allowed. */
  routes?:       SystemRoute[];

  /** Default tool set injected into agents that omit `tools` in their config.json. */
  defaultTools?: AgentToolSet;

  /** Optional metadata labels for the system. */
  tags?:         string[];
}

const SYSTEM_FILE_NAMES = ["system.json", "aios.json"];

/**
 * Search for system.json in the given directory and its parents.
 * Returns null if not found.
 */
export function findSystemDef(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    for (const name of SYSTEM_FILE_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load and validate system.json from a file path.
 * Returns a default empty system if the file is missing.
 */
export function loadSystemDef(filePath: string): SystemDefinition {
  if (!fs.existsSync(filePath)) {
    logger.warn(`[SystemDef] Not found: ${filePath} — using empty system`);
    return { agents: {} };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<SystemDefinition>;

    if (!raw.agents || typeof raw.agents !== "object" || Object.keys(raw.agents).length === 0) {
      logger.warn(`[SystemDef] ${filePath} defines no agents`);
      return { agents: {} };
    }

    const def: SystemDefinition = {
      version:      raw.version ?? 1,
      agents:       {},
      routes:       raw.routes,
      defaultTools: raw.defaultTools ?? "standard",
      tags:         raw.tags,
    };

    for (const [id, agentDef] of Object.entries(raw.agents)) {
      if (!agentDef.folder) {
        logger.warn(`[SystemDef] Agent "${id}" has no folder — skipping`);
        continue;
      }
      def.agents[id] = {
        folder:     agentDef.folder,
        role:       agentDef.role ?? "worker",
        respondsTo: agentDef.respondsTo ?? [],
        tags:       agentDef.tags,
        startup:    agentDef.startup ?? true,
      };
    }

    logger.info(`[SystemDef] Loaded ${Object.keys(def.agents).length} agent(s) from ${filePath}`);
    return def;
  } catch (e: any) {
    logger.error(`[SystemDef] Failed to parse ${filePath}: ${e.message}`);
    return { agents: {} };
  }
}

/**
 * Resolve an agent folder path from a SystemAgentDef.
 * If the folder is relative, it's resolved against the system.json's parent dir.
 */
export function resolveAgentFolder(systemDir: string, def: SystemAgentDef): string {
  if (path.isAbsolute(def.folder)) return def.folder;
  return path.resolve(systemDir, def.folder);
}
