// src/core/types.ts — local edition
// browser_connected / browser_disconnected event types removed.
//
// Fix log:
//   [FIX-TYPES-1] Added agent_keepalive to AgentEvent union.
//                 Agent.prompt() emits this every 15s during long-running tasks
//                 so SSE connections survive proxy idle timeouts.
//                 api.ts _routeChatStream() forwards it to the client.
//   [FIX-TYPES-2] Added "truncated" to AgentRunResult.status and agent_truncated
//                 to AgentEvent. Emitted when clawd's own maxTurns limit is hit.
//                 This is distinct from "failed" — partial output is valid and
//                 the agent session is preserved.

export type RunMode = "reply" | "work";

export interface AgentRunResult {
  agentId:     string;
  agentName:   string;
  sessionId:   string;
  mode:        RunMode;
  /** succeeded = clean finish, failed = error, truncated = clawd maxTurns reached */
  status:      "succeeded" | "failed" | "truncated";
  output:      string;
  outputFile?: string;
  durationMs:  number;
  turnCount:   number;
  toolsUsed:   string[];
}

export interface WorkspaceEntry {
  id:        string;
  sessionId: string;
  agentId:   string;
  agentName: string;
  createdAt: string;
  dir:       string;
}

export interface AgentMessage {
  id:          string;
  sessionId:   string;
  from:        string;
  to:          string;
  mode:        RunMode;
  content:     string;
  reply?:      string;
  outputFile?: string;
  sentAt:      string;
  repliedAt?:  string;
}

export interface StagedReview {
  id:           string;
  sessionId:    string;
  agentId:      string;
  agentName:    string;
  stagedAt:     string;
  stagedPath:   string;
  contentType:  string;
  notes:        string;
  contentFile?: string;
}

export type AgentEvent =
  | { type: "agent_started";         agentId: string; agentName: string; sessionId: string; mode: RunMode }
  | { type: "agent_token";           agentId: string; agentName: string; delta: string }
  | { type: "agent_tool";            agentId: string; agentName: string; toolName: string; argSummary: string }
  | { type: "agent_succeeded";       agentId: string; agentName: string; result: AgentRunResult }
  | { type: "agent_failed";          agentId: string; agentName: string; error: string }
  // [FIX-TYPES-1] Keepalive ping emitted during long-running agent tasks.
  | { type: "agent_keepalive";       agentId: string; agentName: string; elapsedMs: number }
  // [FIX-TYPES-2] Emitted when clawd's maxTurns limit is reached (not an error).
  | { type: "agent_truncated";       agentId: string; agentName: string; result: AgentRunResult }
  | { type: "heartbeat_fired";       agentId: string; label: string }
  | { type: "review_staged";         review: StagedReview }
  | { type: "message_sent";          from: string; to: string; mode: RunMode }
  | { type: "orchestrator_routing";  teamId: string; orchestratorId: string }
  | { type: "shared_memory_updated"; teamId: string; file: string; author: string }
  | { type: "agent_skills_reloaded"; agentId: string; count: number };

export type AgentEventHandler = (event: AgentEvent) => void;
