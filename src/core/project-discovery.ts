// src/core/project-discovery.ts — Agent folder discovery
//
// Walks up the directory tree from a start directory to discover
// self-contained agent folders.
//
// Agent folders are directories containing config.json that define
// runnable agents. They can be found at:
//   - <dir>/agents/<name>/     — project-level agent folders
//   - <dir>/.clawd/agents/<name>/ — clawd-managed agent folders
//   - <dir>/.claude/agents/<name>/ — Claude Code compat agents
//   - <dir>/.opencode/agents/<name>/ — OpenCode compat agents
//
// Discovery stops before reaching ~/.clawd to avoid picking up
// globally-installed agents as project-level ones.

import * as fs   from "fs";
import * as path from "path";
import { getClawdDir } from "../config.js";
import { logger }      from "./logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectDiscoveryResult {
  /** The resolved project root directory (closest directory with discoveries). */
  projectRoot: string | null;

  /** Content of .mcp.json (first one found, closest to cwd wins). */
  mcpConfig: Record<string, unknown> | null;

  /** All discovered filesystem paths for transparency/debugging. */
  filesFound: string[];

  /** Self-contained agent folders found in the project tree.
   *  Each is a directory containing config.json. */
  agentFolders: string[];
}

// ── Public API ────────────────────────────────────────────────────────────────

export function discoverProjectConfig(
  startDir?: string,
  stopDir?: string,
): ProjectDiscoveryResult {
  const start = startDir ? path.resolve(startDir) : process.cwd();
  const stop  = stopDir ? path.resolve(stopDir) : getClawdDir();

  const result: ProjectDiscoveryResult = {
    projectRoot:  null,
    mcpConfig:    null,
    filesFound:   [],
    agentFolders: [],
  };

  let current = start;
  let reachedStop = false;

  while (true) {
    if (path.resolve(current) === stop) {
      reachedStop = true;
      break;
    }

    // Check for project-level agents/ folder
    const agentsDir = path.join(current, "agents");
    if (fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory()) {
      for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const agentFolder = path.join(agentsDir, entry.name);
        const configPath  = path.join(agentFolder, "config.json");
        if (fs.existsSync(configPath) && !result.agentFolders.includes(agentFolder)) {
          result.agentFolders.push(agentFolder);
          result.filesFound.push(agentFolder);
          logger.debug(`[ProjectDiscovery] agent folder: ${agentFolder}`);
        }
      }
    }

    // Check for .clawd/agents/ subdirectory
    const clawdDir = path.join(current, ".clawd");
    if (fs.existsSync(clawdDir) && fs.statSync(clawdDir).isDirectory()) {
      discoverAgentSubdirs(path.join(clawdDir, "agents"), result);
    }

    // Check for .claude/agents/ subdirectory (Claude Code compat)
    const claudeDir = path.join(current, ".claude");
    if (fs.existsSync(claudeDir) && fs.statSync(claudeDir).isDirectory()) {
      discoverAgentSubdirs(path.join(claudeDir, "agents"), result);
    }

    // Check for .opencode/agents/ subdirectory (OpenCode compat)
    const opencodeDir = path.join(current, ".opencode");
    if (fs.existsSync(opencodeDir) && fs.statSync(opencodeDir).isDirectory()) {
      discoverAgentSubdirs(path.join(opencodeDir, "agents"), result);
    }

    // Check for root-level .mcp.json
    const rootMcp = path.join(current, ".mcp.json");
    if (fs.existsSync(rootMcp) && !result.mcpConfig) {
      try {
        result.mcpConfig = JSON.parse(fs.readFileSync(rootMcp, "utf-8"));
        result.filesFound.push(rootMcp);
        logger.debug(`[ProjectDiscovery] mcp: ${rootMcp}`);
      } catch (e: any) {
        logger.warn(`[ProjectDiscovery] Bad .mcp.json ${rootMcp}: ${e.message}`);
      }
    }

    // Set projectRoot to first directory with any discovery
    if (!result.projectRoot && result.agentFolders.length > 0) {
      result.projectRoot = current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (reachedStop) {
    logger.debug(`[ProjectDiscovery] Reached stop boundary: ${stop}`);
  }

  if (result.filesFound.length > 0) {
    logger.info(`[ProjectDiscovery] Discovered ${result.filesFound.length} agent folders from ${start}`);
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function discoverAgentSubdirs(
  agentsPath: string,
  result: ProjectDiscoveryResult,
): void {
  if (!fs.existsSync(agentsPath) || !fs.statSync(agentsPath).isDirectory()) return;
  for (const entry of fs.readdirSync(agentsPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentFolder = path.join(agentsPath, entry.name);
    const configPath  = path.join(agentFolder, "config.json");
    if (fs.existsSync(configPath) && !result.agentFolders.includes(agentFolder)) {
      result.agentFolders.push(agentFolder);
      result.filesFound.push(agentFolder);
      logger.debug(`[ProjectDiscovery] agent folder: ${agentFolder}`);
    }
  }
}
