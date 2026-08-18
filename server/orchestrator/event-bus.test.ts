import { describe, expect, it, vi } from 'vitest';
import { RunBus } from './event-bus';
import type { AgentEvent } from './agents/adapter';

const ev: AgentEvent = { kind: 'log', text: 'hi' };

describe('RunBus', () => {
  it('delivers events to subscribers of that run only', () => {
    const bus = new RunBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('r1', a);
    bus.subscribe('r2', b);
    bus.publish('r1', ev);
    expect(a).toHaveBeenCalledWith(ev);
    expect(b).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new RunBus();
    const a = vi.fn();
    const off = bus.subscribe('r1', a);
    off();
    bus.publish('r1', ev);
    expect(a).not.toHaveBeenCalled();
  });
});
