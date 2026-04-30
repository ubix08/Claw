// src/tools/cron.ts — Cron-based workflow automation tools
//
// Tools for creating, managing, and deleting scheduled tasks using croner:
// - CronCreate: Schedule recurring tasks
// - CronList: View all scheduled crons
// - CronDelete: Remove scheduled tasks

import * as fs from "fs";
import * as path from "path";
import { Cron } from "croner";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "../agent/types.js";
import { logger } from "../core/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CronEntry {
  id: string;
  schedule: string;
  command: string;
  description?: string;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
}

interface CronStorage {
  crons: CronEntry[];
}

// ── Cron Manager ──────────────────────────────────────────────────────────────

class CronManager {
  private crons: Map<string, Cron> = new Map();
  private storage: CronStorage = { crons: [] };
  private storageFile: string;

  constructor(workspaceDir: string) {
    this.storageFile = path.join(workspaceDir, "crons.json");
    this.load();
  }

  /**
   * Load crons from storage
   */
  private load(): void {
    if (!fs.existsSync(this.storageFile)) {
      return;
    }

    try {
      const data = fs.readFileSync(this.storageFile, "utf-8");
      this.storage = JSON.parse(data);

      // Restore active crons
      for (const entry of this.storage.crons) {
        if (entry.enabled) {
          this.startCron(entry);
        }
      }
    } catch (e: any) {
      logger.error(`[Cron] Failed to load crons: ${e.message}`);
    }
  }

  /**
   * Save crons to storage
   */
  private save(): void {
    try {
      fs.writeFileSync(this.storageFile, JSON.stringify(this.storage, null, 2), "utf-8");
    } catch (e: any) {
      logger.error(`[Cron] Failed to save crons: ${e.message}`);
    }
  }

  /**
   * Start a cron job
   */
  private startCron(entry: CronEntry): void {
    try {
      const job = new Cron(entry.schedule, () => {
        logger.info(`[Cron] Running: ${entry.id} - ${entry.description || entry.command}`);
        entry.lastRun = Date.now();
        this.save();

        // Execute command (placeholder - would need bash tool integration)
        // For now, just log
        logger.debug(`[Cron] Command: ${entry.command}`);
      });

      this.crons.set(entry.id, job);

      // Update next run time
      const nextRun = job.nextRun();
      if (nextRun) {
        entry.nextRun = nextRun.getTime();
      }
    } catch (e: any) {
      logger.error(`[Cron] Failed to start cron ${entry.id}: ${e.message}`);
    }
  }

  /**
   * Create a new cron job
   */
  create(
    schedule: string,
    command: string,
    description?: string
  ): { id: string; nextRun?: Date } {
    // Generate unique ID
    const id = `cron_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Validate schedule
    try {
      const testJob = new Cron(schedule, () => {});
      const nextRun = testJob.nextRun();
      testJob.stop();

      // Create entry
      const entry: CronEntry = {
        id,
        schedule,
        command,
        description,
        enabled: true,
        nextRun: nextRun?.getTime(),
      };

      this.storage.crons.push(entry);
      this.save();

      // Start the cron
      this.startCron(entry);

      return { id, nextRun: nextRun || undefined };
    } catch (e: any) {
      throw new Error(`Invalid cron schedule: ${e.message}`);
    }
  }

  /**
   * Delete a cron job
   */
  delete(id: string): boolean {
    const index = this.storage.crons.findIndex(c => c.id === id);
    if (index === -1) {
      return false;
    }

    // Stop the cron if running
    const job = this.crons.get(id);
    if (job) {
      job.stop();
      this.crons.delete(id);
    }

    // Remove from storage
    this.storage.crons.splice(index, 1);
    this.save();

    return true;
  }

  /**
   * List all cron jobs
   */
  list(): CronEntry[] {
    // Update next run times
    for (const entry of this.storage.crons) {
      if (entry.enabled) {
        const job = this.crons.get(entry.id);
        if (job) {
          const nextRun = job.nextRun();
          if (nextRun) {
            entry.nextRun = nextRun.getTime();
          }
        }
      }
    }

    return [...this.storage.crons];
  }

  /**
   * Stop all cron jobs
   */
  stopAll(): void {
    for (const job of this.crons.values()) {
      job.stop();
    }
    this.crons.clear();
  }
}

// ── Global manager instance ───────────────────────────────────────────────────

let globalManager: CronManager | null = null;

function getManager(workspaceDir: string): CronManager {
  if (!globalManager) {
    globalManager = new CronManager(workspaceDir);
  }
  return globalManager;
}

// ── Tool Schemas ──────────────────────────────────────────────────────────────

const cronCreateSchema = Type.Object({
  schedule: Type.String({
    description: "Cron schedule expression (e.g., '0 * * * *' for hourly, '*/5 * * * *' for every 5 minutes)"
  }),
  command: Type.String({
    description: "Command to execute on schedule (bash command or skill name)"
  }),
  description: Type.Optional(Type.String({
    description: "Human-readable description of what this cron does"
  })),
});

const cronDeleteSchema = Type.Object({
  id: Type.String({
    description: "ID of the cron job to delete"
  }),
});

const cronListSchema = Type.Object({});

// ── Helper Functions ──────────────────────────────────────────────────────────

function ok(text: string, details?: any) {
  return { content: [{ type: "text" as const, text }], details: details || {} };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: {} };
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return "Never";
  return new Date(timestamp).toISOString();
}

// ── Tool Factories ────────────────────────────────────────────────────────────

export function createCronCreateTool(workspaceDir: string): AgentTool {
  return {
    name: "cron_create",
    label: "Create Cron Job",
    description:
      "Schedule a recurring task using cron syntax. " +
      "Examples: '0 * * * *' (hourly), '*/5 * * * *' (every 5 min), '0 9 * * 1' (Mondays at 9am). " +
      "Use standard 5-field cron format: minute hour day month weekday.",
    parameters: cronCreateSchema,
    execute: async (_id, params: {
      schedule: string;
      command: string;
      description?: string;
    }) => {
      try {
        const manager = getManager(workspaceDir);
        const result = manager.create(params.schedule, params.command, params.description);

        const lines: string[] = [];
        lines.push(`✅ Cron job created successfully`);
        lines.push(`ID: ${result.id}`);
        lines.push(`Schedule: ${params.schedule}`);
        lines.push(`Command: ${params.command}`);
        if (params.description) {
          lines.push(`Description: ${params.description}`);
        }
        if (result.nextRun) {
          lines.push(`Next run: ${result.nextRun.toISOString()}`);
        }

        return ok(lines.join("\n"), { id: result.id, nextRun: result.nextRun });
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

export function createCronDeleteTool(workspaceDir: string): AgentTool {
  return {
    name: "cron_delete",
    label: "Delete Cron Job",
    description:
      "Delete a scheduled cron job by ID. " +
      "Use cron_list to see all scheduled jobs and their IDs.",
    parameters: cronDeleteSchema,
    execute: async (_id, params: { id: string }) => {
      try {
        const manager = getManager(workspaceDir);
        const success = manager.delete(params.id);

        if (!success) {
          return err(`Cron job not found: ${params.id}`);
        }

        return ok(`✅ Cron job deleted: ${params.id}`);
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

export function createCronListTool(workspaceDir: string): AgentTool {
  return {
    name: "cron_list",
    label: "List Cron Jobs",
    description:
      "List all scheduled cron jobs with their schedules, commands, and next run times.",
    parameters: cronListSchema,
    execute: async (_id, _params: {}) => {
      try {
        const manager = getManager(workspaceDir);
        const crons = manager.list();

        if (crons.length === 0) {
          return ok("No scheduled cron jobs.", { count: 0 });
        }

        const lines: string[] = [];
        lines.push(`# Scheduled Cron Jobs (${crons.length})\n`);

        for (const cron of crons) {
          lines.push(`## ${cron.id}`);
          if (cron.description) {
            lines.push(`**Description:** ${cron.description}`);
          }
          lines.push(`**Schedule:** ${cron.schedule}`);
          lines.push(`**Command:** ${cron.command}`);
          lines.push(`**Status:** ${cron.enabled ? "✅ Enabled" : "❌ Disabled"}`);
          if (cron.lastRun) {
            lines.push(`**Last Run:** ${formatDate(cron.lastRun)}`);
          }
          if (cron.nextRun) {
            lines.push(`**Next Run:** ${formatDate(cron.nextRun)}`);
          }
          lines.push("");
        }

        return ok(lines.join("\n"), {
          count: crons.length,
          enabled: crons.filter(c => c.enabled).length,
        });
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ── Export All Cron Tools ─────────────────────────────────────────────────────

export function createCronTools(workspaceDir: string): AgentTool[] {
  return [
    createCronCreateTool(workspaceDir),
    createCronDeleteTool(workspaceDir),
    createCronListTool(workspaceDir),
  ];
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

export function shutdownCron(): void {
  if (globalManager) {
    globalManager.stopAll();
    globalManager = null;
  }
}
