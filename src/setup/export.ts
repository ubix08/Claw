// src/setup/export.ts — OpenClaw setup exporter
//
// Exports live solo agents as portable, re-importable OpenClaw-compatible
// templates. The output directories can be:
//   - Re-imported with:  clawd agents import ./exported-agent/
//   - Shared on GitHub and imported by others
//   - Used as a starting point for new setups
//
// What IS exported (always):
//   config.json, AGENT.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md,
//   skills/ (if any)
//
// What is NOT exported by default (opt-in via options):
//   memory/    — agent memory files (personal, usually not portable)
//   sessions/  — session history (personal, usually not portable)
//   workspace/ — task output files (transient)
//
// Team refactor:
//   REMOVED  exportTeam() function
//   REMOVED  TeamExportResult interface
//   REMOVED  import { teamDir, teamAgentDir, teamConfigPath } from "../config.js"
//   REMOVED  import type { TeamConfig } from "../team/types.js"

import * as fs   from "fs";
import * as path from "path";
import { agentDir } from "../config.js";
import { logger }   from "../core/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExportOptions {
  /** Also export agent memory/ directories. Default: false. */
  includeMemory?:   boolean;
  /** Also export session JSONL files. Default: false. */
  includeSessions?: boolean;
  /** Overwrite outDir if it already exists. Default: false. */
  force?:           boolean;
  /** Print detailed progress. Default: false. */
  verbose?:         boolean;
}

export interface AgentExportResult {
  agentId:  string;
  agentName: string;
  outDir:   string;
  /** List of files/directories written, relative to outDir. */
  files:    string[];
}

// ── Agent export ──────────────────────────────────────────────────────────────

/**
 * Export a solo agent as a portable OpenClaw-compatible template.
 *
 * Output layout:
 *   <outDir>/
 *     config.json
 *     AGENT.md
 *     SOUL.md
 *     IDENTITY.md
 *     USER.md
 *     TOOLS.md
 *     skills/
 *       <n>/
 *         SKILL.md
 *         (other skill files)
 *     memory/       (optional, if includeMemory)
 *     sessions/     (optional, if includeSessions)
 */
export function exportAgent(
  agentId: string,
  outDir:  string,
  opts:    ExportOptions = {},
): AgentExportResult {
  const log    = opts.verbose ? console.log : (_: string) => {};
  const srcDir = agentDir(agentId);

  if (!fs.existsSync(path.join(srcDir, "config.json"))) {
    throw new Error(`Agent "${agentId}" not found at ${srcDir}.`);
  }

  _prepareOutDir(outDir, opts.force);

  const files: string[] = [];

  // Read config to get name
  let agentName = agentId;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(srcDir, "config.json"), "utf-8"));
    agentName = cfg.name ?? agentId;
  } catch {}

  // ── Core identity and config files ────────────────────────────────────────
  const coreFiles = ["config.json", "AGENT.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md"];
  for (const f of coreFiles) {
    const src = path.join(srcDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(outDir, f));
      files.push(f);
      log(`  Exported: ${f}`);
    }
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  const srcSkillsDir  = path.join(srcDir, "skills");
  const destSkillsDir = path.join(outDir, "skills");
  if (fs.existsSync(srcSkillsDir)) {
    for (const entry of fs.readdirSync(srcSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const srcSkill = path.join(srcSkillsDir, entry.name);
      if (fs.existsSync(path.join(srcSkill, "SKILL.md"))) {
        _copyDirSync(srcSkill, path.join(destSkillsDir, entry.name));
        files.push(`skills/${entry.name}/`);
        log(`  Exported skill: ${entry.name}`);
      }
    }
  }

  // ── Optional: memory ──────────────────────────────────────────────────────
  if (opts.includeMemory) {
    const srcMemDir = path.join(srcDir, "memory");
    if (fs.existsSync(srcMemDir)) {
      _copyDirSync(srcMemDir, path.join(outDir, "memory"));
      files.push("memory/");
      log(`  Exported: memory/`);
    }
  }

  // ── Optional: sessions ────────────────────────────────────────────────────
  if (opts.includeSessions) {
    const srcSessDir = path.join(srcDir, "sessions");
    if (fs.existsSync(srcSessDir)) {
      _copyDirSync(srcSessDir, path.join(outDir, "sessions"));
      files.push("sessions/");
      log(`  Exported: sessions/`);
    }
  }

  logger.info(`[Export] Agent "${agentId}" → ${outDir} (${files.length} items)`);
  return { agentId, agentName, outDir, files };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function _prepareOutDir(outDir: string, force?: boolean): void {
  if (fs.existsSync(outDir)) {
    if (!force) {
      throw new Error(
        `Output directory already exists: ${outDir}\n` +
        `Use --force to overwrite.`,
      );
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
}

function _copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) _copyDirSync(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}
