import { describe, expect, it, vi } from 'vitest';
import { ProcessManager } from './process-manager';

describe('ProcessManager', () => {
  it('rejects a second run for the same repo (single-flight)', () => {
    const pm = new ProcessManager(4);
    expect(pm.canStart('o/r').ok).toBe(true);
    pm.add('r1', 'o/r', () => undefined);
    const res = pm.canStart('o/r');
    expect(res.ok).toBe(false);
  });

  it('rejects beyond max concurrency', () => {
    const pm = new ProcessManager(1);
    pm.add('r1', 'o/a', () => undefined);
    expect(pm.canStart('o/b').ok).toBe(false);
  });

  it('frees the slot on remove', () => {
    const pm = new ProcessManager(1);
    pm.add('r1', 'o/a', () => undefined);
    pm.remove('r1');
    expect(pm.canStart('o/b').ok).toBe(true);
  });

  it('stop invokes the run stopper and returns true', () => {
    const pm = new ProcessManager(4);
    const stop = vi.fn();
    pm.add('r1', 'o/a', stop);
    expect(pm.stop('r1')).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(pm.stop('missing')).toBe(false);
  });

  it('hasRun reflects whether a run id is tracked', () => {
    const pm = new ProcessManager(4);
    pm.add('r1', 'o/r', () => undefined);
    expect(pm.hasRun('r1')).toBe(true);
    expect(pm.hasRun('nope')).toBe(false);
    pm.remove('r1');
    expect(pm.hasRun('r1')).toBe(false);
  });
});
