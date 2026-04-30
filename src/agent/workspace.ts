// src/agent/workspace.ts
// Pure OpenClaw-compatible workspace.
//
// Changes:
//   - AGENT.md added as the primary identity file (OpenClaw standard).
//     Listed first so it is always included at the top of the system prompt
//     when present. SOUL.md follows for backward compatibility.
//   - Layout description in buildSystemPromptSection() lists AGENT.md first.

import * as fs   from "fs";
import * as path from "path";
import { logger } from "../core/logger.js";
import type { AgentConfig } from "./types.js";

// Identity files read in order — each contributes a section to the system prompt.
// All are optional (silently skipped if absent).
//
// AGENT.md   — OpenClaw primary identity file (new standard)
// SOUL.md    — personality / mission (backward compat)
// IDENTITY.md — name and role
// USER.md    — user context
// TOOLS.md   — tool usage guidelines
// AGENTS.md  — team members (present in team agents)
const IDENTITY_FILES: ReadonlyArray<{ filename: string; label: string }> = [
  { filename: "AGENT.md",    label: "Agent Identity" },
  { filename: "SOUL.md",     label: "Identity & Soul" },
  { filename: "IDENTITY.md", label: "Identity" },
  { filename: "USER.md",     label: "User Context" },
  { filename: "TOOLS.md",    label: "Tool Guidelines" },
  { filename: "AGENTS.md",   label: "Team Agents" },
];

export interface PathGrant {
  name:        string;
  absoluteDir: string;
  description: string;
}

export class AgentWorkspace {
  readonly agentId:        string;
  readonly dir:            string;
  readonly setupSkillsDir: string | undefined;
  private _grants: PathGrant[] = [];

  constructor(agentId: string, dir: string, setupSkillsDir?: string) {
    this.agentId        = agentId;
    this.dir            = path.resolve(dir);
    this.setupSkillsDir = setupSkillsDir;
    logger.debug(`[Workspace:${agentId}] Root: ${this.dir}`);
  }

  get sessionsDir():  string { return path.join(this.dir, "sessions"); }
  get memoryDir():    string { return path.join(this.dir, "memory"); }
  get skillsDir():    string { return path.join(this.dir, "skills"); }
  get workspaceDir(): string { return path.join(this.dir, "workspace"); }

  addGrant(grant: PathGrant): void {
    this._grants = this._grants.filter(g => g.name !== grant.name);
    this._grants.push({ ...grant, absoluteDir: path.resolve(grant.absoluteDir) });
    logger.debug(`[Workspace:${this.agentId}] Grant added: "${grant.name}" → ${grant.absoluteDir}`);
  }
  removeGrant(name: string): void { this._grants = this._grants.filter(g => g.name !== name); }

  resolveAgentPath(rel: string): string {
    if (path.isAbsolute(rel))
      throw new Error(`[Workspace:${this.agentId}] Agent must use relative paths only. Got: "${rel}"`);
    const normalised = path.normalize(rel);
    for (const grant of this._grants) {
      const prefix = grant.name + path.sep;
      if (normalised === grant.name || normalised.startsWith(prefix)) {
        const sub      = normalised.startsWith(prefix) ? normalised.slice(prefix.length) : "";
        const absolute = sub ? path.join(grant.absoluteDir, sub) : grant.absoluteDir;
        this._assertInsideRoot(absolute, grant.absoluteDir, `grant:${grant.name}`);
        return absolute;
      }
    }
    const absolute = path.join(this.dir, normalised);
    this._assertInsideRoot(absolute, this.dir, "root");
    return absolute;
  }

  private _assertInsideRoot(absolute: string, root: string, label: string): void {
    const resolved    = path.resolve(absolute);
    const rootNorm    = path.resolve(root);
    const rootWithSep = rootNorm.endsWith(path.sep) ? rootNorm : rootNorm + path.sep;
    if (resolved !== rootNorm && !resolved.startsWith(rootWithSep))
      throw new Error(
        `[Workspace:${this.agentId}] Path escape in "${label}": "${resolved}" outside "${rootNorm}"`,
      );
  }

  ensureExists(): void {
    fs.mkdirSync(this.sessionsDir,  { recursive: true });
    fs.mkdirSync(this.memoryDir,    { recursive: true });
    fs.mkdirSync(this.skillsDir,    { recursive: true });
    fs.mkdirSync(this.workspaceDir, { recursive: true });
  }
  ensureWorkspace(): void { fs.mkdirSync(this.workspaceDir, { recursive: true }); }
  exists(): boolean       { return fs.existsSync(this.dir); }

  readFile(filename: string): string {
    const p = path.join(this.dir, filename);
    if (!fs.existsSync(p)) return "";
    try { return fs.readFileSync(p, "utf-8").trim(); }
    catch (e: any) {
      logger.warn(`[Workspace:${this.agentId}] Cannot read ${filename}: ${e.message}`);
      return "";
    }
  }

  writeFile(filename: string, content: string): void {
    const p   = path.join(this.dir, filename);
    const tmp = `${p}.tmp`;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(tmp, content, "utf-8");
      fs.renameSync(tmp, p);
    } catch (e: any) {
      logger.warn(`[Workspace:${this.agentId}] Cannot write ${filename}: ${e.message}`);
    }
  }

  listFiles(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir);
  }

  loadConfig(): AgentConfig | null {
    const raw = this.readFile("config.json");
    if (!raw) return null;
    try { return JSON.parse(raw) as AgentConfig; }
    catch (e: any) {
      logger.warn(`[Workspace:${this.agentId}] Bad config.json: ${e.message}`);
      return null;
    }
  }

  saveConfig(config: AgentConfig): void {
    this.writeFile("config.json", JSON.stringify(config, null, 2) + "\n");
  }

  /**
   * Build the workspace section of the system prompt.
   *
   * Sections included (in order):
   *   1. Root directory layout — path grants, how to use relative paths
   *   2. Identity files       — AGENT.md, SOUL.md, IDENTITY.md, USER.md,
   *                             TOOLS.md, AGENTS.md (each read fresh from disk).
   *                             Files that don't exist are silently skipped.
   *   3. Memory entries       — memory/*.md files, joined and labelled.
   */
  buildSystemPromptSection(): string {
    const parts: string[] = [];

    // ── 1. Root directory layout ─────────────────────────────────────────────
    const grantLines = this._grants.map(g =>
      `  ${g.name.padEnd(16)}← ${g.description}`,
    );
    const layout = [
      "  AGENT.md         ← your primary identity and mission (OpenClaw standard)",
      "  SOUL.md          ← your personality and soul",
      "  IDENTITY.md      ← your name and role",
      "  USER.md          ← who you serve",
      "  TOOLS.md         ← tool usage guidelines",
      "  AGENTS.md        ← team members you can message (if present)",
      "  skills/          ← available skills (read SKILL.md before using)",
      "  memory/          ← your persistent memory entries",
      "  workspace/       ← YOUR WORKING DIRECTORY — create and edit files here",
      ...grantLines,
    ].join("\n");

    const grantNote = this._grants.length > 0
      ? "\n\n" + this._grants
          .map(g => `- \`${g.name}/\` — ${g.description}. Access as \`${g.name}/FILENAME\`.`)
          .join("\n")
      : "";

    parts.push(
      `## Your Workspace\n\n` +
      `You operate inside a dedicated isolated workspace. ` +
      `All paths are relative to your root:\n\n` +
      "```\n" + layout + "\n```\n\n" +
      `**Always use relative paths.** Never use absolute paths or \`../\` to escape your root.` +
      grantNote,
    );

    // ── 2. Identity files ────────────────────────────────────────────────────
    for (const { filename, label } of IDENTITY_FILES) {
      const p       = path.join(this.dir, filename);
      const content = this.readFile(filename);
      if (content) {
        logger.debug(`[Workspace:${this.agentId}] ${label} loaded from: ${p}`);
        parts.push(content);
      } else {
        logger.debug(`[Workspace:${this.agentId}] ${label} absent: ${p}`);
      }
    }

    // ── 3. Memory ────────────────────────────────────────────────────────────
    const memFiles = this._listMemoryFiles();
    if (memFiles.length > 0) {
      const memContent = memFiles
        .map(f => { try { return fs.readFileSync(f, "utf-8").trim(); } catch { return ""; } })
        .filter(Boolean)
        .join("\n\n---\n\n");
      if (memContent) {
        parts.push(`## Memory\n\n${memContent}`);
      }
    }

    return parts.join("\n\n---\n\n");
  }

  /**
   * Rehydrate a single identity file from new content.
   * Only overwrites if the existing file contains staleMarker (so manual
   * edits made after a folder copy are never clobbered).
   * Returns true if the file was written.
   */
  rehydrateIdentityFile(
    filename:     string,
    content:      string,
    force         = false,
    staleMarker?: string,
  ): boolean {
    const p = path.join(this.dir, filename);
    if (!force && staleMarker) {
      let existing = "";
      try { existing = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : ""; } catch {}
      if (existing && !existing.includes(staleMarker)) {
        logger.debug(`[Workspace:${this.agentId}] ${filename} unchanged (no stale marker)`);
        return false;
      }
    }
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf-8");
      logger.info(`[Workspace:${this.agentId}] Rehydrated ${filename}`);
      return true;
    } catch (e: any) {
      logger.warn(`[Workspace:${this.agentId}] Could not rehydrate ${filename}: ${e.message}`);
      return false;
    }
  }

  appendMemory(content: string): void {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.writeFile(`memory/${ts}.md`, content);
  }
  listMemoryEntries(): string[]  { return this._listMemoryFiles().map(f => path.basename(f)); }
  clearMemory(): void            { for (const f of this._listMemoryFiles()) { try { fs.unlinkSync(f); } catch {} } }

  status(): {
    dir: string; workspaceDir: string;
    hasSoul: boolean; hasAgentMd: boolean; hasConfig: boolean;
    memoryCount: number; skillCount: number;
    sessionCount: number; workspaceFileCount: number;
    grants: string[];
  } {
    let memoryCount = 0, skillCount = 0, sessionCount = 0, workspaceFileCount = 0;
    try { memoryCount        = fs.readdirSync(this.memoryDir).filter(f => f.endsWith(".md")).length; } catch {}
    try { skillCount         = fs.readdirSync(this.skillsDir).length; } catch {}
    try { sessionCount       = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith(".jsonl")).length; } catch {}
    try { workspaceFileCount = fs.readdirSync(this.workspaceDir).length; } catch {}
    return {
      dir: this.dir, workspaceDir: this.workspaceDir,
      hasSoul:    fs.existsSync(path.join(this.dir, "SOUL.md")),
      hasAgentMd: fs.existsSync(path.join(this.dir, "AGENT.md")),
      hasConfig:  fs.existsSync(path.join(this.dir, "config.json")),
      memoryCount, skillCount, sessionCount, workspaceFileCount,
      grants: this._grants.map(g => g.name),
    };
  }

  private _listMemoryFiles(): string[] {
    if (!fs.existsSync(this.memoryDir)) return [];
    try {
      return fs.readdirSync(this.memoryDir)
        .filter(f => f.endsWith(".md"))
        .sort()
        .map(f => path.join(this.memoryDir, f));
    } catch { return []; }
  }
}
