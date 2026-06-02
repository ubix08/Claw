// src/agent/mailbox.ts — Persisted message queue per agent

import * as fs   from "fs";
import * as path from "path";
import { logger } from "../core/logger.js";

/**
 * Envelope for all inter-agent communication.
 * Pushed into an agent's mailbox; consumed one-at-a-time.
 */
export interface AgentEnvelope {
  id:             string;
  from:           string;
  to:             string;
  type:           "task" | "result" | "status" | "schedule" | "system";
  payload:        unknown;
  timestamp:      string;  // ISO-8601
  correlationId?: string;  // pairs result ↔ originating task
}

/**
 * Per-agent FIFO queue backed by an append-only JSONL log.
 *
 *   {agentDir}/messages.jsonl       — all messages ever received (audit trail)
 *   {agentDir}/messages.cursor      — count of messages already consumed
 *
 * At startup `replay()` re-reads the JSONL from the cursor position so only
 * unconsumed messages enter the in-memory queue. Consumed messages stay in the
 * log for audit and are skipped on the next restart.
 */
export class AgentMailbox {
  private queue: AgentEnvelope[] = [];
  private logPath: string;
  private cursorPath: string;
  private _cursor: number = 0;

  constructor(agentDir: string) {
    this.logPath   = path.join(agentDir, "messages.jsonl");
    this.cursorPath = path.join(agentDir, "messages.cursor");
  }

  /** Enqueue a new envelope and append it to the audit log. */
  push(msg: AgentEnvelope): void {
    this.queue.push(msg);
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, JSON.stringify(msg) + "\n", "utf-8");
    } catch (e: any) {
      logger.warn(`[Mailbox] Failed to persist message ${msg.id}: ${e.message}`);
    }
  }

  /** Dequeue the next pending envelope (null if empty). */
  pop(): AgentEnvelope | null {
    const msg = this.queue.shift() ?? null;
    if (msg) {
      this._cursor++;
      this._persistCursor();
    }
    return msg;
  }

  /** Preview the next envelope without dequeuing. */
  peek(): AgentEnvelope | null {
    return this.queue[0] ?? null;
  }

  get length(): number { return this.queue.length; }

  /** Drain the queue (useful during shutdown). */
  clear(): void {
    this.queue = [];
  }

  /**
   * Replay the JSONL log from the last cursor position.
   * Call once at agent startup to recover in-flight messages.
   */
  replay(): void {
    if (!fs.existsSync(this.logPath)) return;
    this._cursor = this._readCursor();
    const lines = fs.readFileSync(this.logPath, "utf-8").split("\n").filter(Boolean);

    for (let i = this._cursor; i < lines.length; i++) {
      try {
        const msg = JSON.parse(lines[i]) as AgentEnvelope;
        this.queue.push(msg);
      } catch {
        logger.warn(`[Mailbox] Corrupt entry at line ${i + 1} — skipping`);
      }
    }

    if (lines.length > this._cursor) {
      logger.info(`[Mailbox] Replayed ${lines.length - this._cursor} pending message(s)`);
    }
  }

  // ── Private ──

  private _persistCursor(): void {
    try {
      fs.writeFileSync(this.cursorPath, String(this._cursor), "utf-8");
    } catch {}
  }

  private _readCursor(): number {
    try {
      return parseInt(fs.readFileSync(this.cursorPath, "utf-8").trim(), 10) || 0;
    } catch {
      return 0;
    }
  }
}
