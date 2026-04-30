// src/skills-install.ts — OpenClaw-compatible skill installer
//
// Pure OpenClaw-compatible implementation.
//
// Changes:
//   [SI-FIX-1] REMOVED teamId — team agent skill install no longer supported.
//   [SI-FIX-2] uninstallSkill() accepts opts object { agentId? } only.
//   [SI-FIX-3] installSkillAt() public export for installing into an arbitrary dir.
//   [SI-FIX-4] listInstalledSkills() now accepts ListOptions (its own type) instead
//              of the semantically wrong UninstallOptions. ListOptions is a shared
//              base { agentId?: string } — uninstall still has its own alias.
//              Fixes type-hygiene issue flagged in evaluation item #14.
//   [HUB-CLEAN] HUB_REGISTRY now contains ONLY verified OpenClaw sources from
//               badlogic/pi-mono. Fictional lobehub and community entries removed.
//               stars field removed — not part of OpenClaw hub spec.
//
// Team refactor:
//   REMOVED  teamId field from InstallOptions and UninstallOptions
//   REMOVED  CLAWD_TEAMS_DIR import
//   REMOVED  teamAgentDir import
//   REMOVED  team+agent path branch in _resolveDestBase()
//
// Supported sources:
//   GitHub shorthand:  owner/repo[/subpath[@ref]]
//   GitHub URL:        https://github.com/owner/repo/tree/ref/path
//   GitHub raw URL:    https://raw.githubusercontent.com/owner/repo/ref/path/SKILL.md
//   Local path:        ./my-skill/  or  /abs/path/to/skill/
//
// Install targets:
//   (default)            ~/.clawd/skills/<n>/
//   opts.agentId only    ~/.clawd/agents/<id>/skills/<n>/

import * as fs      from "fs";
import * as path    from "path";
import * as https   from "https";
import * as http    from "http";
import * as os      from "os";
import * as crypto  from "crypto";
import matter       from "gray-matter";
import { logger }   from "./core/logger.js";
import {
  CLAWD_SKILLS_DIR,
  CLAWD_AGENTS_DIR,
  agentDir,
} from "./config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InstallOptions {
  /** Install into a specific solo agent's skills dir instead of global. */
  agentId?:  string;
  /** Override the skill name derived from SKILL.md frontmatter. */
  name?:     string;
  /** Overwrite without backup if the skill already exists. */
  force?:    boolean;
  /** Print detailed progress. */
  verbose?:  boolean;
}

/**
 * [SI-FIX-4] Shared base for operations that only need an optional agentId.
 * Both UninstallOptions and ListOptions derive from this so each has a
 * semantically correct type without code duplication.
 */
export interface AgentScopedOptions {
  agentId?: string;
}

/** Options accepted by uninstallSkill(). */
export type UninstallOptions = AgentScopedOptions;

/**
 * [SI-FIX-4] Options accepted by listInstalledSkills().
 * Previously this was incorrectly typed as UninstallOptions — listing skills
 * does not involve uninstalling them, so using the uninstall type was wrong.
 */
export type ListOptions = AgentScopedOptions;

export interface InstallResult {
  skillName:   string;
  installedAt: string;
  source:      string;
  files:       string[];
}

export interface UninstallResult {
  skillName:   string;
  removedFrom: string;
}

// ── Hub Registry ──────────────────────────────────────────────────────────────
//
// Contains only real, verified OpenClaw skills from badlogic/pi-mono.
// All sources are live GitHub paths that resolve to a directory containing
// a valid SKILL.md with `openclaw` namespace frontmatter.

export interface HubEntry {
  name:        string;
  source:      string;
  description: string;
  tags:        string[];
  hub:         "openclaw";
}

export const HUB_REGISTRY: HubEntry[] = [
  {
    name:        "web-search",
    source:      "badlogic/pi-mono/packages/coding-agent/skills/web-search",
    description: "Search the web using DuckDuckGo or Brave",
    tags:        ["search", "web"],
    hub:         "openclaw",
  },
  {
    name:        "web-fetch",
    source:      "badlogic/pi-mono/packages/coding-agent/skills/web-fetch",
    description: "Fetch and read web pages, extract main content",
    tags:        ["web", "fetch"],
    hub:         "openclaw",
  },
  {
    name:        "github",
    source:      "badlogic/pi-mono/packages/coding-agent/skills/github",
    description: "Interact with GitHub repos, issues, PRs, code search",
    tags:        ["github", "code"],
    hub:         "openclaw",
  },
  {
    name:        "memory",
    source:      "badlogic/pi-mono/packages/coding-agent/skills/memory",
    description: "Persistent cross-session memory in markdown files",
    tags:        ["memory"],
    hub:         "openclaw",
  },
  {
    name:        "sequential-thinking",
    source:      "badlogic/pi-mono/packages/coding-agent/skills/sequential-thinking",
    description: "Structured step-by-step reasoning",
    tags:        ["reasoning"],
    hub:         "openclaw",
  },
  {
    name:        "code-review",
    source:      "badlogic/pi-mono/packages/coding-agent/skills/code-review",
    description: "Systematic code review, security and quality checks",
    tags:        ["code", "review"],
    hub:         "openclaw",
  },
];

// ── Parsed source descriptor ───────────────────────────────────────────────────

interface GitHubSource { kind: "github"; owner: string; repo: string; ref: string; subpath: string; }
interface RawSource    { kind: "raw-url"; url: string; }
interface LocalSource  { kind: "local";  dir: string; }
type SkillSource = GitHubSource | RawSource | LocalSource;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Install a skill from `source` into the appropriate skills directory.
 *
 * Target resolution:
 *   opts.agentId  → ~/.clawd/agents/<a>/skills/<n>/
 *   (default)     → ~/.clawd/skills/<n>/
 */
export async function installSkill(
  source: string,
  opts:   InstallOptions = {},
): Promise<InstallResult> {
  const log = opts.verbose ? console.log : (_: string) => {};

  log(`  Resolving source: ${source}`);
  const parsed = _parseSource(source);

  const tmpDir = path.join(os.tmpdir(), `clawd-skill-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    log(`  Fetching skill files…`);
    await _fetchSkill(parsed, tmpDir, log);

    const skillMdPath = path.join(tmpDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      throw new Error(
        `No SKILL.md found in the source.\n` +
        `A valid skill directory must contain a SKILL.md file with "name:" and "description:" frontmatter.`,
      );
    }

    const fm = matter(fs.readFileSync(skillMdPath, "utf-8")).data as any;
    if (!fm.name)        throw new Error(`SKILL.md is missing required "name:" frontmatter field.`);
    if (!fm.description) throw new Error(`SKILL.md is missing required "description:" frontmatter field.`);

    const skillName = opts.name ?? _sanitizeName(fm.name);
    log(`  Skill name: ${skillName}`);

    const destBase = _resolveDestBase(opts);
    const destDir  = path.join(destBase, skillName);

    if (fs.existsSync(destDir)) {
      if (!opts.force) {
        const backupDir = `${destDir}.backup-${Date.now()}`;
        fs.renameSync(destDir, backupDir);
        log(`  Backed up existing skill to: ${path.basename(backupDir)}`);
      } else {
        fs.rmSync(destDir, { recursive: true, force: true });
        log(`  Removed existing installation (--force).`);
      }
    }

    fs.mkdirSync(destDir, { recursive: true });
    const files = _copyDir(tmpDir, destDir);
    log(`  Installed ${files.length} file(s) to: ${destDir}`);
    logger.info(`[SkillInstall] "${skillName}" installed to ${destDir}`);

    return { skillName, installedAt: destDir, source, files };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Install a skill directly into a known absolute directory.
 * Used by any caller that has already resolved the path.
 */
export async function installSkillAt(
  source:  string,
  destDir: string,
  opts:    { name?: string; force?: boolean; verbose?: boolean } = {},
): Promise<InstallResult> {
  const log = opts.verbose ? console.log : (_: string) => {};

  const parsed = _parseSource(source);
  const tmpDir = path.join(os.tmpdir(), `clawd-skill-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    await _fetchSkill(parsed, tmpDir, log);

    const skillMdPath = path.join(tmpDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath))
      throw new Error(`No SKILL.md found in source: ${source}`);

    const fm = matter(fs.readFileSync(skillMdPath, "utf-8")).data as any;
    if (!fm.name)        throw new Error(`SKILL.md missing "name:" frontmatter.`);
    if (!fm.description) throw new Error(`SKILL.md missing "description:" frontmatter.`);

    const skillName = opts.name ?? _sanitizeName(fm.name);
    const dest      = path.join(destDir, skillName);

    if (fs.existsSync(dest)) {
      if (!opts.force) { fs.renameSync(dest, `${dest}.backup-${Date.now()}`); }
      else             { fs.rmSync(dest, { recursive: true, force: true }); }
    }

    fs.mkdirSync(dest, { recursive: true });
    const files = _copyDir(tmpDir, dest);
    logger.info(`[SkillInstall] "${skillName}" installed to ${dest}`);
    return { skillName, installedAt: dest, source, files };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Uninstall a skill by name.
 * Accepts opts object { agentId? }.
 */
export function uninstallSkill(
  skillName: string,
  opts:      UninstallOptions = {},
): UninstallResult {
  const safeSkillName = _sanitizeName(skillName);
  const baseDir       = _resolveDestBase(opts);
  const skillDir      = path.join(baseDir, safeSkillName);

  if (!fs.existsSync(skillDir)) {
    throw new Error(
      `Skill "${safeSkillName}" not found at ${skillDir}.\n` +
      `Run: clawd skills list  to see installed skills.`,
    );
  }

  fs.rmSync(skillDir, { recursive: true, force: true });
  logger.info(`[SkillInstall] "${safeSkillName}" uninstalled from ${skillDir}`);
  return { skillName: safeSkillName, removedFrom: skillDir };
}

/**
 * Update an already-installed skill by re-fetching from its original source.
 */
export async function updateSkill(
  source: string,
  opts:   InstallOptions = {},
): Promise<InstallResult> {
  return installSkill(source, { ...opts, force: true });
}

/**
 * List installed skills.
 * [SI-FIX-4] Accepts ListOptions (not UninstallOptions) — semantically correct.
 */
export function listInstalledSkills(
  opts: ListOptions = {},
): Array<{ name: string; description: string; dir: string }> {
  const baseDir = _resolveDestBase(opts);
  if (!fs.existsSync(baseDir)) return [];

  const results: Array<{ name: string; description: string; dir: string }> = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); }
  catch { return results; }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillDir    = path.join(baseDir, e.name);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;
    try {
      const fm = matter(fs.readFileSync(skillMdPath, "utf-8")).data as any;
      results.push({
        name:        fm.name        ?? e.name,
        description: fm.description ?? "",
        dir:         skillDir,
      });
    } catch { /* skip malformed */ }
  }
  return results;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function _resolveDestBase(opts: AgentScopedOptions): string {
  if (opts.agentId) {
    return path.join(CLAWD_AGENTS_DIR, opts.agentId, "skills");
  }
  return CLAWD_SKILLS_DIR;
}

function _parseSource(source: string): SkillSource {
  // Raw GitHub URL
  if (source.startsWith("https://raw.githubusercontent.com/")) {
    return { kind: "raw-url", url: source };
  }

  // GitHub tree URL: https://github.com/owner/repo/tree/ref/path
  const treeMatch = source.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/,
  );
  if (treeMatch) {
    return {
      kind: "github",
      owner: treeMatch[1]!, repo: treeMatch[2]!,
      ref: treeMatch[3]!, subpath: treeMatch[4]!,
    };
  }

  // Local path
  if (source.startsWith("./") || source.startsWith("/") || source.startsWith("~/")) {
    const dir = source.startsWith("~/")
      ? path.join(os.homedir(), source.slice(2))
      : path.resolve(source);
    return { kind: "local", dir };
  }

  // GitHub shorthand: owner/repo[/subpath[@ref]]
  const parts = source.split("@");
  const ref   = parts.length > 1 ? parts[1]! : "HEAD";
  const rest  = parts[0]!.split("/");
  if (rest.length < 2) throw new Error(`Cannot parse skill source: "${source}"`);
  const owner   = rest[0]!;
  const repo    = rest[1]!;
  const subpath = rest.slice(2).join("/");
  return { kind: "github", owner, repo, ref, subpath };
}

async function _fetchSkill(
  source: SkillSource,
  destDir: string,
  log: (s: string) => void,
): Promise<void> {
  if (source.kind === "local") {
    if (!fs.existsSync(source.dir))
      throw new Error(`Local skill path does not exist: ${source.dir}`);
    _copyDir(source.dir, destDir);
    return;
  }

  if (source.kind === "raw-url") {
    const content = await _httpsGet(source.url);
    fs.writeFileSync(path.join(destDir, "SKILL.md"), content);
    return;
  }

  // GitHub
  await _fetchGitHubTree(source, source.subpath, destDir, log);
}

async function _fetchGitHubTree(
  source:  GitHubSource,
  subpath: string,
  destDir: string,
  log:     (s: string) => void,
): Promise<void> {
  const apiPath = `/repos/${source.owner}/${source.repo}/contents/${subpath}`;
  const entries = await _githubContentsApi(apiPath, source.ref) as any[];

  if (!Array.isArray(entries)) {
    throw new Error(`Expected a directory listing from GitHub API for: ${subpath}`);
  }

  for (const entry of entries) {
    if (entry.type === "file" && entry.download_url) {
      log(`    Downloading: ${entry.name}`);
      const content = await _httpsGetBuf(entry.download_url);
      fs.writeFileSync(path.join(destDir, entry.name), content);
    } else if (entry.type === "dir") {
      const subDest = path.join(destDir, entry.name);
      fs.mkdirSync(subDest, { recursive: true });
      await _fetchGitHubTree(source, `${subpath}/${entry.name}`, subDest, log);
    }
  }
}

async function _githubContentsApi(apiPath: string, ref: string): Promise<unknown> {
  const url = `https://api.github.com${apiPath}?ref=${encodeURIComponent(ref)}`;
  const buf = await _httpsGetBuf(url, {
    "User-Agent":    "clawd-skill-installer/1.0",
    "Accept":        "application/vnd.github.v3+json",
  });
  return JSON.parse(buf.toString("utf-8"));
}

async function _httpsGet(url: string, headers?: Record<string, string>): Promise<string> {
  return (await _httpsGetBuf(url, headers)).toString("utf-8");
}

async function _httpsGetBuf(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const mod     = url.startsWith("https://") ? https : http;
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path:     parsedUrl.pathname + parsedUrl.search,
      headers:  { "User-Agent": "clawd-skill-installer/1.0", ...headers },
    };
    const req = (mod as typeof https).get(
      options as any,
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          _httpsGetBuf(res.headers.location, headers).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end",  () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
  });
}

function _copyDir(src: string, dest: string): string[] {
  fs.mkdirSync(dest, { recursive: true });
  const files: string[] = [];
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      files.push(..._copyDir(srcPath, destPath));
    } else {
      fs.copyFileSync(srcPath, destPath);
      files.push(entry.name);
    }
  }
  return files;
}

function _sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
