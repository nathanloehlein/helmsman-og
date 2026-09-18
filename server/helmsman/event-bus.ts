import type { AgentEvent } from './agents/adapter';

type Listener = (e: AgentEvent) => void;

export class RunBus {
  private readonly listeners: Map<string, Set<Listener>> = new Map();

  subscribe(runId: string, fn: Listener): () => void {
    const set: Set<Listener> = this.listeners.get(runId) ?? new Set();
    set.add(fn);
    this.listeners.set(runId, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  publish(runId: string, e: AgentEvent): void {
    const set: Set<Listener> | undefined = this.listeners.get(runId);
    if (!set) return;
    for (const fn of set) fn(e);
  }
}
