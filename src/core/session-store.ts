// src/core/session-store.ts — Session persistence (local edition)
//
// Fix log:
//   [FIX-SS-1] Removed all db.ts imports (persistSessionFile, restoreSessionFile,
//              clearSessionTurns). These were HF-only SQLite operations.
//              Locally, sessions live exclusively in
//              ~/.clawd/agents/<id>/sessions/session.jsonl — the pi-coding-agent
//              SDK writes and reads this file directly. No bridge needed.
//
//   [FIX-SS-2] Removed dead `clawdDir` constructor parameter and field.
//
//   [FIX-SS-3] restore() — returns 0 (nothing to restore; disk is durable).
//              The caller (agent.ts) logs only when count > 0, so this is clean.
//
//   [FIX-SS-4] sync() — no-op. The SDK writes the JSONL directly; we don't
//              need to copy it anywhere.
//
//   [FIX-SS-5] clear() — deletes the JSONL file so the next session starts
//              fresh. This is the only operation that has real local work.
//
//   [FIX-SS-6] startAutoSync / stopAutoSync — retained as no-ops for API
//              compatibility with agent.ts which calls them on persistent agents.

import * as fs   from "fs";
import * as path from "path";
import { logger } from "./logger.js";

export class SessionStore {
  private agentId:   string;
  private jsonlPath: string;
  private _timer:    ReturnType<typeof setInterval> | null = null;

  constructor(agentId: string, sessionsDir: string) {
    this.agentId   = agentId;
    this.jsonlPath = path.join(sessionsDir, "session.jsonl");
  }

  /**
   * Ensure the sessions directory exists.
   * Returns 0 — nothing to restore; disk is already persistent.
   */
  restore(): number {
    try {
      fs.mkdirSync(path.dirname(this.jsonlPath), { recursive: true });
    } catch (e: any) {
      logger.warn(`[SessionStore:${this.agentId}] Cannot create sessionsDir: ${e.message}`);
    }
    return 0;
  }

  /** No-op locally — the SDK writes session.jsonl directly. */
  sync(): void {}

  /** Start background sync timer (no-op locally; retained for API compatibility). */
  startAutoSync(_intervalMs = 60_000): void {
    // No-op on local installs. Session JSONL is written by the SDK.
  }

  stopAutoSync(): void {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /**
   * Delete the session JSONL so the next session starts clean.
   * Called on explicit reset or model switch.
   */
  clear(): void {
    try {
      if (fs.existsSync(this.jsonlPath)) fs.unlinkSync(this.jsonlPath);
    } catch (e: any) {
      logger.warn(`[SessionStore:${this.agentId}] clear failed: ${e.message}`);
    }
  }

  /** Final cleanup. Called from Agent.dispose(). */
  dispose(): void {
    this.stopAutoSync();
  }
}
