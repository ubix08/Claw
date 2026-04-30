// src/core/workspace-log.ts
import * as fs    from "fs";
import * as path  from "path";
import { logger } from "./logger.js";
import { CLAWD_DIR } from "../config.js";
import type { WorkspaceEntry } from "./types.js";

const DEFAULT_JOURNAL_PATH = path.join(CLAWD_DIR, "workspace-log.json");

export class WorkspaceLog {
  private logPath: string;
  constructor(logPath = DEFAULT_JOURNAL_PATH) { this.logPath = logPath; }

  record(sessionId: string, agentId: string, agentName: string, dir: string): void {
    const entry: WorkspaceEntry = { id: sessionId, sessionId, agentId, agentName, createdAt: new Date().toISOString(), dir };
    this._append(entry);
    logger.debug(`[WorkspaceLog] recorded: ${agentName} → ${dir}`);
  }

  listAll():                  WorkspaceEntry[] { return this._read(); }
  listBySession(sid: string): WorkspaceEntry[] { return this._read().filter(e => e.sessionId === sid); }
  listByAgent(aid: string):   WorkspaceEntry[] { return this._read().filter(e => e.agentId   === aid); }

  clean(olderThanDays = 7): { removed: number; freed: string[] } {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const keep: WorkspaceEntry[] = []; const freed: string[] = [];
    for (const e of this._read()) {
      if (new Date(e.createdAt).getTime() < cutoff && !fs.existsSync(e.dir)) freed.push(e.dir);
      else keep.push(e);
    }
    this._write(keep);
    return { removed: freed.length, freed };
  }

  private _read(): WorkspaceEntry[] {
    if (!fs.existsSync(this.logPath)) return [];
    try { const r = JSON.parse(fs.readFileSync(this.logPath, "utf-8")); return Array.isArray(r) ? r : []; }
    catch { return []; }
  }
  private _write(entries: WorkspaceEntry[]): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      const tmp = `${this.logPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", "utf-8");
      fs.renameSync(tmp, this.logPath);
    } catch (e: any) { logger.warn(`[WorkspaceLog] write failed: ${e.message}`); }
  }
  private _append(e: WorkspaceEntry): void { const all = this._read(); all.push(e); this._write(all); }
}

let _log: WorkspaceLog | null = null;
export function getWorkspaceLog(): WorkspaceLog {
  if (!_log) _log = new WorkspaceLog(); return _log;
}
