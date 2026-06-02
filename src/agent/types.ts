// src/agent/types.ts
// AI-OS Agent type definitions.
//
// [TYPES-FIX-CRITICAL] AgentTool.parameters must be TSchema (TypeBox), not
// Record<string,unknown>. pi-agent-core validates tool call arguments using
// AJV with the TypeBox format plugin — it expects a compiled TypeBox schema.

import type { TSchema } from "@mariozechner/pi-ai";
import type { HeartbeatDef } from "../core/heartbeat.js";

export type AgentToolSet = "full" | "standard" | "observe" | "bash" | "none";

export interface AgentConfig {
  name:            string;
  description?:    string;
  model?:          string;
  provider?:       string;
  tools:           AgentToolSet;
  persistent:      boolean;
  maxTurns:        number;
  timeoutSeconds:  number;
  thinkingLevel?:  "off" | "minimal" | "low" | "medium" | "high";
  heartbeats?:     HeartbeatDef[];
  tags?:           string[];
}

/**
 * Lightweight agent definition used for subagent spawning.
 */
export interface AgentRoleDefinition {
  id:                  string;
  name:                string;
  description:         string;
  tools?:              AgentToolSet;
  persistent?:         boolean;
  maxTurns?:           number;
  timeoutSeconds?:     number;
  provider?:           string;
  model?:              string;
  workspace?:          string;
  systemPromptPrefix?: string;
  systemPromptSuffix?: string;
  tags?:               string[];
}

export interface PromptOptions {
  mode?:         "reply" | "work";
  workspaceDir?: string;
  priorOutputs?: Record<string, string>;
  context?:      string;
}

// [TYPES-FIX-CRITICAL] parameters is TSchema — required by pi-agent-core.
export interface AgentTool<TParams extends TSchema = TSchema> {
  name:        string;
  label?:      string;
  description: string;
  parameters:  TParams;
  execute: (
    toolCallId: string,
    params:     any,
    signal?:    AbortSignal,
    onUpdate?:  (u: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>;
}
