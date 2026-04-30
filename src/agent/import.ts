// src/agent/import.ts — OpenClaw solo agent template importer
//
// Symmetric to src/team/import.ts but for individual solo agents.
//
// An OpenClaw solo agent template is a directory with:
//   config.json         — AgentConfig (required)
//   AGENT.md            — primary identity file
//   SOUL.md             — personality / working style
//   IDENTITY.md         — name and role
//   USER.md             — user context
//   TOOLS.md            — tool usage guidelines
//   skills/<n>/      — bundled skills (optional)
//     SKILL.md
//
// Supported sources — identical to teams import:
//   GitHub shorthand:  owner/repo[/subpath[@ref]]
//   GitHub URL:        https://github.com/owner/repo/tree/ref/path
//   Local path:        ./my-agent/  or  /abs/path/to/agent/  or  ~/path/

import * as fs     from "fs";
import * as path   from "path";
import * as https  from "https";
import * as http   from "http";
import * as os     from "os";
import * as crypto from "crypto";
import { agentDir }         from "../config.js";
import { scaffoldAgentAt }  from "./loader.js";
import { logger }           from "../core/logger.js";
import type { AgentConfig } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentImportOptions {
  /** Override the agent ID derived from config.json name. */
  agentId?:    string;
  /** Overwrite existing agent without prompting. */
  force?:      boolean;
  /** Skip copying agent-bundled skills from the template. */
  skipSkills?: boolean;
  /** Print detailed progress. */
  verbose?:    boolean;
}

export interface AgentImportResult {
  agentId:         string;
  agentName:       string;
  skillsInstalled: string[];
  agentDir:        string;
}

interface GitHubSource { kind: "github"; owner: string; repo: string; ref: string; subpath: string; }
interface LocalSource  { kind: "local";  dir: string; }
type TemplateSource = GitHubSource | LocalSource;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Import a solo agent template from a local path or GitHub URL/shorthand.
 *
 * The template directory must contain a config.json at its root.
 * Identity files (AGENT.md, SOUL.md, etc.) and skills/ are copied verbatim.
 */
export async function importAgent(
  source: string,
  opts:   AgentImportOptions = {},
): Promise<AgentImportResult> {
  const log = opts.verbose ? console.log : (_: string) => {};

  log(`  Resolving agent template source: ${source}`);
  const parsed = _parseSource(source);

  const tmpDir = path.join(os.tmpdir(), `clawd-agent-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    log(`  Fetching template…`);
    await _fetchTemplate(parsed, tmpDir, log);
    return _applyTemplate(tmpDir, opts, log);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Template application ───────────────────────────────────────────────────────

function _applyTemplate(
  tmpDir: string,
  opts:   AgentImportOptions,
  log:    (s: string) => void,
): AgentImportResult {
  // ── 1. Read config.json ────────────────────────────────────────────────────
  const configPath = path.join(tmpDir, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Template is missing config.json.\n` +
      `Expected layout:\n  config.json\n  AGENT.md\n  SOUL.md\n  skills/<n>/SKILL.md\n`,
    );
  }

  let templateConfig: AgentConfig;
  try {
    templateConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as AgentConfig;
  } catch (e: any) {
    throw new Error(`config.json is not valid JSON: ${e.message}`);
  }

  if (!templateConfig.name || typeof templateConfig.name !== "string") {
    throw new Error(`config.json: "name" must be a non-empty string.`);
  }

  // ── 2. Derive agentId ─────────────────────────────────────────────────────
  const agentId = (
    opts.agentId ??
    templateConfig.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "")
  );

  if (!agentId || !/^[a-z0-9_-]+$/.test(agentId)) {
    throw new Error(
      `Agent ID "${agentId}" is invalid. Use lowercase letters, numbers, hyphens, underscores.\n` +
      `Override with --id <id>.`,
    );
  }

  const destDir = agentDir(agentId);

  // ── 3. Check existing ─────────────────────────────────────────────────────
  if (fs.existsSync(path.join(destDir, "config.json"))) {
    if (!opts.force) {
      throw new Error(
        `Agent "${agentId}" already exists at ${destDir}.\n` +
        `Use --force to overwrite or choose a different ID with --id <id>.`,
      );
    }
    log(`  Overwriting existing agent (--force).`);
  }

  // ── 4. Scaffold with template config ──────────────────────────────────────
  // FIX: scaffoldAgentAt signature is (agentId, dir, config, overwrite) — 4 args only.
  scaffoldAgentAt(agentId, destDir, templateConfig, !!opts.force);
  log(`  Scaffolded agent: ${agentId} at ${destDir}`);

  // ── 5. Copy identity files from template ──────────────────────────────────
  const workspaceFiles = ["AGENT.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md"];
  for (const wf of workspaceFiles) {
    const src = path.join(tmpDir, wf);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(destDir, wf));
      log(`  Copied ${wf} → ${agentId}/`);
    }
  }

  // ── 6. Copy bundled skills ────────────────────────────────────────────────
  const skillsInstalled: string[] = [];

  if (!opts.skipSkills) {
    const srcSkillsDir  = path.join(tmpDir, "skills");
    const destSkillsDir = path.join(destDir, "skills");

    if (fs.existsSync(srcSkillsDir)) {
      fs.mkdirSync(destSkillsDir, { recursive: true });
      for (const entry of fs.readdirSync(srcSkillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const srcSkill  = path.join(srcSkillsDir, entry.name);
        const destSkill = path.join(destSkillsDir, entry.name);
        if (fs.existsSync(path.join(srcSkill, "SKILL.md"))) {
          _copyDirSync(srcSkill, destSkill);
          skillsInstalled.push(entry.name);
          log(`  Installed skill: ${entry.name}`);
        }
      }
    }
  }

  return {
    agentId,
    agentName:       templateConfig.name,
    skillsInstalled,
    agentDir:        destDir,
  };
}

// ── Source parsing ─────────────────────────────────────────────────────────────

function _parseSource(source: string): TemplateSource {
  if (source.startsWith("./") || source.startsWith("/") || source.startsWith("~/")) {
    const resolved = source.startsWith("~/")
      ? path.join(os.homedir(), source.slice(2))
      : path.resolve(source);
    return { kind: "local", dir: resolved };
  }

  const ghTreeMatch = source.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?(.*)$/,
  );
  if (ghTreeMatch) {
    const [, owner, repo, ref, subpath] = ghTreeMatch;
    return { kind: "github", owner, repo, ref, subpath: subpath ?? "" };
  }

  const shortMatch = source.match(
    /^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)(?:\/([^@]*))?(?:@(.+))?$/,
  );
  if (shortMatch) {
    const [, owner, repo, subpath, ref] = shortMatch;
    return { kind: "github", owner, repo, ref: ref ?? "HEAD", subpath: subpath ?? "" };
  }

  throw new Error(
    `Cannot parse template source: "${source}"\n` +
    `Supported formats:\n` +
    `  owner/repo/path[@ref]               GitHub shorthand\n` +
    `  https://github.com/owner/repo/...   GitHub URL\n` +
    `  ./path/to/agent/                    Local directory\n`,
  );
}

// ── Fetch helpers ──────────────────────────────────────────────────────────────

async function _fetchTemplate(
  source:  TemplateSource,
  destDir: string,
  log:     (s: string) => void,
): Promise<void> {
  if (source.kind === "local") {
    if (!fs.existsSync(source.dir)) {
      throw new Error(`Template path does not exist: ${source.dir}`);
    }
    _copyDirSync(source.dir, destDir);
    log(`  Copied from local: ${source.dir}`);
    return;
  }
  await _fetchGitHubTree(source, source.subpath, destDir, log);
}

async function _fetchGitHubTree(
  source:  GitHubSource,
  subpath: string,
  destDir: string,
  log:     (s: string) => void,
): Promise<void> {
  const { owner, repo, ref } = source;
  const apiPath = subpath
    ? `/repos/${owner}/${repo}/contents/${subpath}`
    : `/repos/${owner}/${repo}/contents`;

  const entries = await _githubContentsApi(apiPath, ref);
  if (!Array.isArray(entries)) {
    throw new Error(`Expected a directory at "${subpath || "/"}" in ${owner}/${repo}`);
  }

  for (const entry of entries as any[]) {
    if (entry.type === "file") {
      log(`  Downloading: ${entry.path}`);
      const content = await _httpsGetBuffer(entry.download_url, {
        "User-Agent": "clawd-agent-importer/1.0",
        ...(process.env["GITHUB_TOKEN"]
          ? { "Authorization": `token ${process.env["GITHUB_TOKEN"]}` }
          : {}),
      });
      const localPath = path.join(destDir, entry.name);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, content);
    } else if (entry.type === "dir") {
      const subDest = path.join(destDir, entry.name);
      fs.mkdirSync(subDest, { recursive: true });
      await _fetchGitHubTree(
        source,
        subpath ? `${subpath}/${entry.name}` : entry.name,
        subDest,
        log,
      );
    }
  }
}

async function _githubContentsApi(apiPath: string, ref: string): Promise<unknown> {
  const refParam = ref && ref !== "HEAD" ? `?ref=${encodeURIComponent(ref)}` : "";
  const url      = `https://api.github.com${apiPath}${refParam}`;
  const body     = await _httpsGet(url, {
    "User-Agent": "clawd-agent-importer/1.0",
    "Accept":     "application/vnd.github.v3+json",
    ...(process.env["GITHUB_TOKEN"]
      ? { "Authorization": `token ${process.env["GITHUB_TOKEN"]}` }
      : {}),
  });
  const json = JSON.parse(body);
  if (json.message) {
    if (json.message.toLowerCase().includes("rate limit"))
      throw new Error(`GitHub API rate limit hit. Set GITHUB_TOKEN env var to increase limits.`);
    if (json.message.toLowerCase().includes("not found"))
      throw new Error(`GitHub path not found: ${apiPath}`);
    throw new Error(`GitHub API error: ${json.message}`);
  }
  return json;
}

function _httpsGet(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === "https:" ? https : http;
    const req    = lib.get(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          _httpsGet(res.headers.location, headers).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end",  () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
  });
}

function _httpsGetBuffer(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === "https:" ? https : http;
    const req    = lib.get(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          _httpsGetBuffer(res.headers.location, headers).then(resolve, reject);
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
  });
}

function _copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src,  entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) _copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}