// src/tools/tasks.ts — Task management tools
//
// Mirrors Claude Code's Task tools:
// - TaskCreate: Create new task items
// - TaskGet: Retrieve task details
// - TaskList: List all tasks
// - TaskUpdate: Update task status/dependencies
// - TaskStop: Kill background tasks (for bash tool integration)
//
// Tasks are persisted in workspace/tasks.json

import * as path from "path";
import * as fs from "fs";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "../agent/types.js";

// ── Task Types ────────────────────────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
  dependencies?: string[];
  created: number;
  updated: number;
  details?: string;
}

interface TaskStore {
  tasks: Task[];
  version: string;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const taskCreateSchema = Type.Object({
  title: Type.String({
    description: "Task title (short, descriptive)"
  }),
  description: Type.Optional(Type.String({
    description: "Detailed task description"
  })),
  status: Type.Optional(Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("blocked"),
    Type.Literal("cancelled"),
  ], {
    description: "Initial task status (default: pending)"
  })),
});

const taskGetSchema = Type.Object({
  task_id: Type.String({
    description: "ID of the task to retrieve"
  }),
});

const taskUpdateSchema = Type.Object({
  task_id: Type.String({
    description: "ID of the task to update"
  }),
  status: Type.Optional(Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("blocked"),
    Type.Literal("cancelled"),
  ])),
  details: Type.Optional(Type.String({
    description: "Updated task details"
  })),
  dependencies: Type.Optional(Type.Array(Type.String(), {
    description: "Task IDs this task depends on"
  })),
  delete: Type.Optional(Type.Boolean({
    description: "If true, delete the task"
  })),
});

// ── Task Store Management ─────────────────────────────────────────────────────

class TaskManager {
  private tasksFile: string;

  constructor(workspaceDir: string) {
    this.tasksFile = path.join(workspaceDir, "tasks.json");
  }

  load(): TaskStore {
    if (!fs.existsSync(this.tasksFile)) {
      return { tasks: [], version: "1.0" };
    }

    try {
      const data = fs.readFileSync(this.tasksFile, "utf-8");
      return JSON.parse(data);
    } catch (e: any) {
      return { tasks: [], version: "1.0" };
    }
  }

  save(store: TaskStore): void {
    try {
      fs.mkdirSync(path.dirname(this.tasksFile), { recursive: true });
      fs.writeFileSync(
        this.tasksFile,
        JSON.stringify(store, null, 2),
        "utf-8"
      );
    } catch (e: any) {
      throw new Error(`Failed to save tasks: ${e.message}`);
    }
  }

  create(title: string, description?: string, status?: Task["status"]): Task {
    const store = this.load();
    const task: Task = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      title,
      description,
      status: status || "pending",
      created: Date.now(),
      updated: Date.now(),
    };

    store.tasks.push(task);
    this.save(store);

    return task;
  }

  get(taskId: string): Task | null {
    const store = this.load();
    return store.tasks.find(t => t.id === taskId) || null;
  }

  list(): Task[] {
    const store = this.load();
    return store.tasks;
  }

  update(
    taskId: string,
    updates: {
      status?: Task["status"];
      details?: string;
      dependencies?: string[];
    }
  ): Task | null {
    const store = this.load();
    const task = store.tasks.find(t => t.id === taskId);

    if (!task) return null;

    if (updates.status) task.status = updates.status;
    if (updates.details !== undefined) task.details = updates.details;
    if (updates.dependencies !== undefined) task.dependencies = updates.dependencies;
    task.updated = Date.now();

    this.save(store);
    return task;
  }

  delete(taskId: string): boolean {
    const store = this.load();
    const index = store.tasks.findIndex(t => t.id === taskId);

    if (index === -1) return false;

    store.tasks.splice(index, 1);
    this.save(store);

    return true;
  }
}

// ── Tool Factories ────────────────────────────────────────────────────────────

export function createTaskCreateTool(workspaceDir: string): AgentTool {
  const manager = new TaskManager(workspaceDir);

  return {
    name: "task_create",
    label: "Create Task",
    description:
      "Create a new task item in the task list. " +
      "Tasks persist during the session and help track work progress.",
    parameters: taskCreateSchema,
    execute: async (_id, params: { title: string; description?: string; status?: Task["status"] }) => {
      try {
        const task = manager.create(params.title, params.description, params.status);

        return {
          content: [{
            type: "text" as const,
            text: `Task created: ${task.id}\nTitle: ${task.title}\nStatus: ${task.status}`
          }],
          details: { taskId: task.id, task },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e.message}` }],
          details: {},
        };
      }
    },
  };
}

export function createTaskGetTool(workspaceDir: string): AgentTool {
  const manager = new TaskManager(workspaceDir);

  return {
    name: "task_get",
    label: "Get Task",
    description: "Retrieve full details for a specific task by ID.",
    parameters: taskGetSchema,
    execute: async (_id, params: { task_id: string }) => {
      try {
        const task = manager.get(params.task_id);

        if (!task) {
          return {
            content: [{ type: "text" as const, text: `Task not found: ${params.task_id}` }],
            details: {},
          };
        }

        const lines: string[] = [];
        lines.push(`Task: ${task.id}`);
        lines.push(`Title: ${task.title}`);
        lines.push(`Status: ${task.status}`);
        if (task.description) lines.push(`Description: ${task.description}`);
        if (task.details) lines.push(`Details: ${task.details}`);
        if (task.dependencies?.length) {
          lines.push(`Dependencies: ${task.dependencies.join(", ")}`);
        }
        lines.push(`Created: ${new Date(task.created).toISOString()}`);
        lines.push(`Updated: ${new Date(task.updated).toISOString()}`);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { task },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e.message}` }],
          details: {},
        };
      }
    },
  };
}

export function createTaskListTool(workspaceDir: string): AgentTool {
  const manager = new TaskManager(workspaceDir);

  return {
    name: "task_list",
    label: "List Tasks",
    description: "List all tasks with their current status.",
    parameters: Type.Object({}),
    execute: async (_id, _params: {}) => {
      try {
        const tasks = manager.list();

        if (tasks.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No tasks found" }],
            details: { count: 0 },
          };
        }

        // Group by status
        const byStatus: Record<string, Task[]> = {
          pending: [],
          in_progress: [],
          completed: [],
          blocked: [],
          cancelled: [],
        };

        for (const task of tasks) {
          byStatus[task.status].push(task);
        }

        const lines: string[] = [];
        lines.push(`Total tasks: ${tasks.length}\n`);

        for (const [status, statusTasks] of Object.entries(byStatus)) {
          if (statusTasks.length === 0) continue;

          lines.push(`## ${status.toUpperCase()} (${statusTasks.length})\n`);
          for (const task of statusTasks) {
            const deps = task.dependencies?.length
              ? ` [depends on: ${task.dependencies.length}]`
              : "";
            lines.push(`- ${task.id}: ${task.title}${deps}`);
          }
          lines.push("");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { count: tasks.length, tasks },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e.message}` }],
          details: {},
        };
      }
    },
  };
}

export function createTaskUpdateTool(workspaceDir: string): AgentTool {
  const manager = new TaskManager(workspaceDir);

  return {
    name: "task_update",
    label: "Update Task",
    description:
      "Update task status, dependencies, details, or delete a task. " +
      "Use this to mark tasks as in_progress, completed, or manage dependencies.",
    parameters: taskUpdateSchema,
    execute: async (_id, params: {
      task_id: string;
      status?: Task["status"];
      details?: string;
      dependencies?: string[];
      delete?: boolean;
    }) => {
      try {
        // Handle deletion
        if (params.delete) {
          const deleted = manager.delete(params.task_id);
          if (!deleted) {
            return {
              content: [{ type: "text" as const, text: `Task not found: ${params.task_id}` }],
              details: {},
            };
          }
          return {
            content: [{ type: "text" as const, text: `Task deleted: ${params.task_id}` }],
            details: { deleted: true },
          };
        }

        // Handle update
        const task = manager.update(params.task_id, {
          status: params.status,
          details: params.details,
          dependencies: params.dependencies,
        });

        if (!task) {
          return {
            content: [{ type: "text" as const, text: `Task not found: ${params.task_id}` }],
            details: {},
          };
        }

        const lines: string[] = [];
        lines.push(`Task updated: ${task.id}`);
        lines.push(`Title: ${task.title}`);
        lines.push(`Status: ${task.status}`);
        if (task.details) lines.push(`Details: ${task.details}`);
        if (task.dependencies?.length) {
          lines.push(`Dependencies: ${task.dependencies.join(", ")}`);
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { task },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e.message}` }],
          details: {},
        };
      }
    },
  };
}

export function createTaskStopTool(): AgentTool {
  return {
    name: "task_stop",
    label: "Stop Task",
    description:
      "Kill a running background task by ID. " +
      "Note: This is for background bash processes, not task list items.",
    parameters: Type.Object({
      task_id: Type.String({
        description: "Process ID or background task ID to kill"
      }),
    }),
    execute: async (_id, params: { task_id: string }) => {
      try {
        // In a real implementation, this would track background processes
        // For now, we'll just provide a placeholder

        return {
          content: [{
            type: "text" as const,
            text: `TaskStop not fully implemented yet. ` +
                  `Background process management requires integration with bash tool. ` +
                  `Task ID: ${params.task_id}`
          }],
          details: { implemented: false },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e.message}` }],
          details: {},
        };
      }
    },
  };
}

// ── Export All Task Tools ─────────────────────────────────────────────────────

export function createTaskTools(workspaceDir: string): AgentTool[] {
  return [
    createTaskCreateTool(workspaceDir),
    createTaskGetTool(workspaceDir),
    createTaskListTool(workspaceDir),
    createTaskUpdateTool(workspaceDir),
    createTaskStopTool(),
  ];
}
