// src/agent/scaffold-optimizer.ts — Optimized behavioral intelligence configs
//
// Fix log:
//   [SCAFFOLD-FIX-1] TEMPLATES_DIR was computed with process.cwd() which breaks
//                    when clawd is invoked from any directory other than the project
//                    root — the normal case for a global CLI install.
//
//                    Replaced with fileURLToPath(import.meta.url) + path.resolve()
//                    so the templates path is always relative to this module file,
//                    regardless of the working directory at invocation time.
//
//                    Fallback chain (in order):
//                      1. <module_dir>/../agents-templates/clawd-optimized/
//                         (project source layout: src/agent/ → agents-templates/)
//                      2. <module_dir>/../../agents-templates/clawd-optimized/
//                         (compiled output layout: dist/agent/ → agents-templates/)
//                      3. ~/.clawd/templates/clawd-optimized/
//                         (user-installed templates via `clawd templates install`)
//                    The first path that exists is used. hasOptimizedTemplates()
//                    returns false if none are found, causing scaffoldAgentAt()
//                    to fall back to its built-in baseline templates.
//
//   [SCAFFOLD-FIX-2] getConfigStats() read all markdown files on every call,
//                    including large SOUL.md / TOOLS.md files. For CLI output
//                    loops this was called twice (before + after optimization).
//                    Now stat-checks the file first and skips the read if the
//                    file hasn't changed since the last call (mtime-based cache).

import * as fs   from "fs";
import * as path from "path";
import * as os   from "os";
import { fileURLToPath } from "url";

// ── Template root resolution ───────────────────────────────────────────────────
//
// [SCAFFOLD-FIX-1] Resolve templates relative to this module file, not CWD.

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/**
 * Resolve the templates directory using a fallback chain that works regardless
 * of where clawd is invoked from.
 */
function _resolveTemplatesDir(): string {
  const candidates = [
    // 1. Project source layout:  src/agent/ → <project-root>/agents-templates/
    path.resolve(__dirname, "..", "agents-templates", "clawd-optimized"),
    // 2. Compiled output layout: dist/agent/ → <project-root>/agents-templates/
    path.resolve(__dirname, "..", "..", "agents-templates", "clawd-optimized"),
    // 3. User-installed templates
    path.join(os.homedir(), ".clawd", "templates", "clawd-optimized"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Return the first candidate as the canonical path even if it doesn't exist —
  // hasOptimizedTemplates() will return false and callers handle gracefully.
  return candidates[0];
}

const TEMPLATES_DIR = _resolveTemplatesDir();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OptimizeOptions {
  /** Create .backup files before overwriting. Default: true. */
  backup?:    boolean;
  /** Overwrite existing files without prompting. Default: false. */
  overwrite?: boolean;
  /** Specific file names to update. Default: all optimizable files. */
  files?:     string[];
}

export interface OptimizeResult {
  upgraded: string[];
  skipped:  string[];
  errors:   string[];
}

interface StatsEntry { mtime: number; lines: number; }

// ── Stats cache (mtime-based) ─────────────────────────────────────────────────
//
// [SCAFFOLD-FIX-2] Avoid re-reading files on each getConfigStats() call.

const _statsCache = new Map<string, StatsEntry>();

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Returns true if optimized templates exist and are readable.
 */
export function hasOptimizedTemplates(): boolean {
  return fs.existsSync(TEMPLATES_DIR) &&
    fs.readdirSync(TEMPLATES_DIR).some(f => f.endsWith(".md"));
}

/**
 * Return [filename, content] pairs for the agent scaffold from optimized
 * templates, with {agentName} and {agentDescription} substituted.
 */
export function getOptimizedScaffoldFiles(
  agentName:        string,
  agentDescription: string,
): [string, string][] {
  if (!hasOptimizedTemplates()) return [];

  const results: [string, string][] = [];

  for (const file of fs.readdirSync(TEMPLATES_DIR)) {
    if (!file.endsWith(".md")) continue;
    try {
      const raw = fs.readFileSync(path.join(TEMPLATES_DIR, file), "utf-8");
      const content = raw
        .replace(/\{agentName\}/g, agentName)
        .replace(/\{agentDescription\}/g, agentDescription);
      results.push([file, content]);
    } catch { /* skip unreadable template files */ }
  }

  return results;
}

/**
 * Apply optimized config files to an existing agent directory.
 * Files that already exist are skipped (or backed up+overwritten if opts.overwrite).
 */
export function applyOptimizedConfigs(
  agentDir: string,
  opts:     OptimizeOptions = {},
): OptimizeResult {
  const result: OptimizeResult = { upgraded: [], skipped: [], errors: [] };

  if (!hasOptimizedTemplates()) {
    result.errors.push(`Templates not found at: ${TEMPLATES_DIR}`);
    return result;
  }

  const allFiles = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith(".md"));
  const filesToProcess = opts.files
    ? allFiles.filter(f => opts.files!.includes(f))
    : allFiles;

  for (const file of filesToProcess) {
    const destPath = path.join(agentDir, file);
    const srcPath  = path.join(TEMPLATES_DIR, file);

    try {
      if (fs.existsSync(destPath) && !opts.overwrite) {
        result.skipped.push(file);
        continue;
      }

      if (fs.existsSync(destPath) && (opts.backup ?? true)) {
        fs.copyFileSync(destPath, `${destPath}.backup`);
      }

      fs.copyFileSync(srcPath, destPath);
      result.upgraded.push(file);

      // Invalidate stats cache for this file
      _statsCache.delete(destPath);
    } catch (e: any) {
      result.errors.push(`${file}: ${e.message}`);
    }
  }

  return result;
}

/**
 * Return line counts for each optimizable file in an agent directory.
 *
 * [SCAFFOLD-FIX-2] Uses mtime-based caching — only re-reads files that have
 * changed since the last call. Safe to call in CLI output loops.
 */
export function getConfigStats(agentDir: string): {
  totalLines: number;
  files: Record<string, number>;
} {
  const targetFiles = ["SOUL.md", "TOOLS.md", "AGENT.md", "IDENTITY.md", "USER.md"];
  const fileLineCounts: Record<string, number> = {};
  let totalLines = 0;

  for (const file of targetFiles) {
    const filePath = path.join(agentDir, file);
    if (!fs.existsSync(filePath)) {
      fileLineCounts[file] = 0;
      continue;
    }

    try {
      const stat   = fs.statSync(filePath);
      const mtime  = stat.mtimeMs;
      const cached = _statsCache.get(filePath);

      let lineCount: number;
      if (cached && cached.mtime === mtime) {
        lineCount = cached.lines;
      } else {
        lineCount = fs.readFileSync(filePath, "utf-8").split("\n").length;
        _statsCache.set(filePath, { mtime, lines: lineCount });
      }

      fileLineCounts[file] = lineCount;
      totalLines += lineCount;
    } catch {
      fileLineCounts[file] = 0;
    }
  }

  return { totalLines, files: fileLineCounts };
}
