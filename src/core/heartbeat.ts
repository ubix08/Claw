// src/core/heartbeat.ts
import { logger }        from "./logger.js";
import type { EventBus } from "./event-bus.js";

export interface HeartbeatDef {
  cron:             string;
  task:             string;
  label?:           string;
  broadcastResult?: boolean;
}
export type HeartbeatCallback = (task: string) => Promise<string>;

export class HeartbeatScheduler {
  private handles:   Array<ReturnType<typeof setInterval>> = [];
  private _cronJobs: Array<{ stop(): void }> = [];
  private started    = false;
  private bus:       EventBus;
  private agentId:   string;
  private agentName: string;

  constructor(agentId: string, agentName: string, bus: EventBus) {
    this.agentId = agentId; this.agentName = agentName; this.bus = bus;
  }

  start(defs: HeartbeatDef[], callback: HeartbeatCallback): void {
    this.stop(); this.started = true;
    if (!defs.length) return;
    logger.info(`[Heartbeat:${this.agentId}] Scheduling ${defs.length} heartbeat(s)`);
    for (const def of defs) this._schedule(def, callback);
  }

  stop(): void {
    for (const h of this.handles) clearInterval(h);
    this.handles = [];
    for (const job of this._cronJobs) { try { job.stop(); } catch {} }
    this._cronJobs = [];
    this.started = false;
  }

  get isRunning(): boolean { return this.started; }

  private _schedule(def: HeartbeatDef, cb: HeartbeatCallback): void {
    const label = def.label ?? `${this.agentId}:heartbeat`;
    const cron  = def.cron.trim();
    if (cron.startsWith("interval:")) {
      const secs = parseInt(cron.slice("interval:".length), 10);
      if (isNaN(secs) || secs < 10) {
        logger.warn(`[Heartbeat:${this.agentId}] Invalid interval "${cron}" — skipped`); return;
      }
      logger.info(`[Heartbeat:${this.agentId}] ${label} → every ${secs}s`);
      this.handles.push(setInterval(() => this._fire(def, label, cb), secs * 1000));
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Cron } = require("croner");
        const job = new Cron(cron, () => this._fire(def, label, cb));
        logger.info(`[Heartbeat:${this.agentId}] ${label} → cron "${cron}" (next: ${job.nextRun()?.toISOString() ?? "unknown"})`);
        this._cronJobs.push(job);
      } catch {
        logger.warn(`[Heartbeat:${this.agentId}] "${cron}" requires "croner" — falling back to 24h interval.`);
        this.handles.push(setInterval(() => this._fire(def, label, cb), 24 * 3600 * 1000));
      }
    }
  }

  private async _fire(def: HeartbeatDef, label: string, cb: HeartbeatCallback): Promise<void> {
    logger.info(`[Heartbeat:${this.agentId}] ⏰ ${label} firing`);
    this.bus.emit({ type: "heartbeat_fired", agentId: this.agentId, label });
    try {
      const result = await cb(def.task);
      if (def.broadcastResult !== false) logger.info(`[Heartbeat:${this.agentId}] ${label} →\n${result.slice(0, 400)}`);
    } catch (e: any) {
      logger.error(`[Heartbeat:${this.agentId}] ${label} failed: ${e.message}`);
    }
  }
}
