// src/core/event-bus.ts
import type { AgentEvent, AgentEventHandler } from "./types.js";

export class EventBus {
  private handlers = new Set<AgentEventHandler>();
  subscribe(h: AgentEventHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  emit(event: AgentEvent): void {
    for (const h of this.handlers) { try { h(event); } catch {} }
  }
  dispose(): void { this.handlers.clear(); }
}

let _bus: EventBus | null = null;
export function getDefaultBus(): EventBus {
  if (!_bus) _bus = new EventBus();
  return _bus;
}
export function _resetDefaultBus(): void { _bus?.dispose(); _bus = null; }
