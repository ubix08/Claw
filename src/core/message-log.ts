// src/core/message-log.ts — Team message log (JSONL-only, local edition)
//
// Fix log:
//   [FIX-ML-1] Removed all db.ts imports (getDb, insertTeamMessage,
//              updateTeamMessageReply, readRecentTeamMessages).
//              db.ts is an HF-only SQLite layer that does not exist locally.
//              All persistence is JSONL on disk — already durable on local FS.
//
//   [FIX-ML-2] Removed dead `clawdDir` constructor parameter and field.
//              It was kept "for API compatibility" but no call site actually
//              passes it, and it was never forwarded internally.
//
//   [FIX-ML-3] Removed all `if (getDb())` branches — dead code locally.
//              Message log is now a clean, minimal JSONL implementation.

import * as fs     from "fs";
import * as path   from "path";
import * as crypto from "crypto";
import { logger }  from "./logger.js";
import type { AgentMessage } from "./types.js";

export class MessageLog {
  private logFile: string;
  private teamId:  string;

  /**
   * @param sharedDir  Absolute path to the team's shared/ directory.
   * @param teamId     Explicit team ID.
   */
  constructor(sharedDir: string, teamId: string) {
    this.logFile = path.join(sharedDir, "messages.jsonl");
    this.teamId  = teamId;
    fs.mkdirSync(sharedDir, { recursive: true });
  }

  append(msg: AgentMessage): void {
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(msg) + "\n", "utf-8");
    } catch (e: any) {
      logger.warn(`[MessageLog:${this.teamId}] append failed (id=${msg.id}): ${e.message}`);
    }
  }

  updateReply(msgId: string, reply: string, outputFile?: string): void {
    if (!fs.existsSync(this.logFile)) return;
    try {
      const lines   = fs.readFileSync(this.logFile, "utf-8").split("\n").filter(Boolean);
      const updated = lines.map(l => {
        try {
          const m = JSON.parse(l) as AgentMessage;
          if (m.id !== msgId) return l;
          return JSON.stringify({
            ...m, reply,
            ...(outputFile && { outputFile }),
            repliedAt: new Date().toISOString(),
          });
        } catch { return l; }
      });
      const tmp = `${this.logFile}.tmp`;
      fs.writeFileSync(tmp, updated.join("\n") + "\n", "utf-8");
      fs.renameSync(tmp, this.logFile);
    } catch (e: any) {
      logger.warn(`[MessageLog:${this.teamId}] updateReply failed (id=${msgId}): ${e.message}`);
    }
  }

  readRecent(limit = 30): AgentMessage[] {
    if (!fs.existsSync(this.logFile)) return [];
    try {
      return fs.readFileSync(this.logFile, "utf-8")
        .split("\n").filter(Boolean)
        .slice(-limit)
        .map(l => { try { return JSON.parse(l) as AgentMessage; } catch { return null; } })
        .filter((m): m is AgentMessage => m !== null);
    } catch { return []; }
  }

  formatRecent(limit = 20): string {
    const msgs = this.readRecent(limit);
    if (!msgs.length) return "(no messages yet)";
    return msgs.map(m => {
      const ts  = m.sentAt.slice(0, 16).replace("T", " ");
      const rep = m.outputFile
        ? `  ↩ file: ${m.outputFile}`
        : m.reply
          ? `  ↩ [${m.to}]: ${m.reply.slice(0, 200)}`
          : "  ↩ (pending)";
      return `[${ts}] [${m.mode}] ${m.from} → ${m.to}: ${m.content.slice(0, 200)}\n${rep}`;
    }).join("\n\n");
  }

  get filePath(): string { return this.logFile; }
}

export function newMessageId(): string { return crypto.randomUUID(); }
