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
export type {
  AgentTemplate,
  AgentDefinition,
  AgentDiscoveryResult,
}                                                                                       from "./discovery.js";
export type { AgentConfig, AgentTool, AgentToolSet, PromptOptions, AgentRoleDefinition } from "./types.js";
