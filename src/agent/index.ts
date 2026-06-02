// src/agent/index.ts
export { Agent }                                                                        from "./agent.js";
export { AgentWorkspace }                                                               from "./workspace.js";
export { loadAgent, loadAgentFromPath, listAgentIds, scaffoldAgent, scaffoldAgentAt }   from "./loader.js";
export {
  discoverTemplates,
  discoverDefinitions,
  discoverAll,
  findTemplate,
  findDefinition,
}                                                                                       from "./discovery.js";
export { AgentMailbox }                                                                 from "./mailbox.js";
export type { AgentEnvelope }                                                           from "./mailbox.js";
export { AgentRegistry }                                                                from "./agent-registry.js";
export type { ManagedAgent, AgentStatus }                                               from "./agent-registry.js";
export { findSystemDef, loadSystemDef, resolveAgentFolder }                             from "./system-def.js";
export type {
  SystemDefinition,
  SystemAgentDef,
  SystemRoute,
  AgentRole,
}                                                                                       from "./system-def.js";
export type {
  AgentConfig,
  AgentTool,
  AgentToolSet,
  PromptOptions,
  AgentRoleDefinition,
}                                                                                       from "./types.js";
