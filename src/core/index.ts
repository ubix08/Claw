// src/core/index.ts — local edition
// db.ts removed entirely — no export from it.
// workspace-log.ts removed — WorkspaceLog / getWorkspaceLog have zero import
// consumers in the active codebase. File can be deleted.
export * from "./types.js";
export { logger }                               from "./logger.js";
export { EventBus, getDefaultBus }              from "./event-bus.js";
export { MessageLog, newMessageId }             from "./message-log.js";
export { SessionStore }                         from "./session-store.js";
export { HeartbeatScheduler }                   from "./heartbeat.js";
export type { HeartbeatDef, HeartbeatCallback } from "./heartbeat.js";
