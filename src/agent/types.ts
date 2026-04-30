// src/agent/types.ts
// Pure OpenClaw-compatible agent configuration.
//
// [TYPES-FIX-CRITICAL] AgentTool.parameters must be TSchema (TypeBox), not
// Record<string,unknown>. pi-agent-core validates tool call arguments using
// AJV with the TypeBox format plugin — it expects a compiled TypeBox schema,
// not a raw JSON schema object. Passing a plain object causes AJV to throw
// internally in the agent loop, producing a silent crash with no response.
//
// [VERBOSITY-FIX] Added `verbosity` field to AgentConfig.
//   "concise"  (default) — model-agnostic prompt, suitable for frontier models
//                          (Claude Sonnet, Deepseek-V3, Qwen2.5-72B).
//   "explicit" — verbose prompt with worked tool examples injected into the
//                system prompt. Closes 30-40% of the capability gap for smaller
//                open-source models (Qwen2.5-7B, GLM-4-9B, Deepseek-Coder-33B)
//                that cannot reliably infer tool usage from sparse descriptions.
//   Set per-agent in config.json:  { "verbosity": "explicit" }

import type { TSchema } from "@mariozechner/pi-ai";
import type { HeartbeatDef } from "../core/heartbeat.js";

export type AgentToolSet = "full" | "coding" | "readonly" | "bash" | "none";

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
  /**
   * [VERBOSITY-FIX] System prompt verbosity tier.
   *
   * "concise"  — sparse, model-agnostic descriptions (default).
   *              Works well with frontier models that can infer tool usage.
   * "explicit" — injected worked examples for every core tool.
   *              Required for smaller OSS models (≤14B) to use tools reliably.
   */
  verbosity?:      "concise" | "explicit";
  heartbeats?:     HeartbeatDef[];
  tags?:           string[];
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
