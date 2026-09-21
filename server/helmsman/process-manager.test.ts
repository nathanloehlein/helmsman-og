import { describe, expect, it, vi } from 'vitest';
import { ProcessManager, RunConflictError } from './process-manager';

describe('ProcessManager', () => {
  it('allows independent runs in the same repository', () => {
    const pm = new ProcessManager(4);
    pm.reserve('r1', 'o/r', () => undefined, { ticketId: 'T-1', branch: 'agent/r1' });
    pm.reserve('r2', 'o/r', () => undefined, { ticketId: 'T-2', branch: 'agent/r2' });
    expect(pm.count()).toBe(2);
    expect(pm.canStart('o/r')).toEqual({ ok: true });
  });

  it('reserves ticket identities before preparation and releases them on failure', () => {
    const pm = new ProcessManager(4);
    pm.reserve('r1', 'o/r', () => undefined, { ticketId: 'T-1', branch: 'agent/r1' });
    expect(() => pm.reserve('r2', 'o/r', () => undefined, { ticketId: 't-1' })).toThrow(RunConflictError);
    expect(() => pm.reserve('r3', 'o/another', () => undefined, { ticketId: 'T-1' })).toThrow('ticket T-1');
    pm.remove('r1');
    expect(() => pm.reserve('r2', 'o/r', () => undefined, { ticketId: 'T-1' })).not.toThrow();
  });

  it('keeps pending PR updates exclusive and checks the resolved branch before setup', () => {
    const pm = new ProcessManager(4);
    pm.reserve('writer', 'o/r', () => undefined, { branch: 'feature' });
    pm.reserve('rerun', 'o/r', () => undefined, { prNumber: 42 });
    expect(() => pm.reserve('duplicate', 'o/r', () => undefined, { prNumber: 42 })).toThrow('PR #42');
    expect(() => pm.updateResources('rerun', { prNumber: 42, branch: 'feature' })).toThrow('branch feature');
    expect(pm.canStart('o/r', { prNumber: 42 }).ok).toBe(false);
    expect(() => pm.updateResources('rerun', { prNumber: 42, branch: 'other' })).not.toThrow();
    expect(pm.canStart('o/r', { branch: 'other' }).ok).toBe(false);
  });

  it('permits detached reviews alongside writers and preserves the global cap', () => {
    const pm = new ProcessManager(2);
    pm.reserve('writer', 'o/r', () => undefined, { branch: 'feature', prNumber: 42 });
    pm.reserve('review', 'o/r', () => undefined);
    expect(pm.count()).toBe(2);
    expect(() => pm.reserve('third', 'o/r', () => undefined)).toThrow('max concurrency');
    expect(() => pm.updateResources('writer', { branch: 'feature', prNumber: 42 })).not.toThrow();
  });

  it('restores already running processes even above the current cap, retaining their branch reservations', () => {
    const pm = new ProcessManager(1);
    pm.restore('r1', 'o/r', () => undefined, { branch: 'first' });
    pm.restore('r2', 'o/r', () => undefined, { branch: 'second' });
    expect(pm.count()).toBe(2);
    expect(pm.canStart('o/other').ok).toBe(false);
    pm.remove('r1');
    expect(pm.canStart('o/r', { branch: 'second' }, 'new-id').ok).toBe(false);
  });

  it('does not replace an active run reservation with a duplicate ID', () => {
    const pm = new ProcessManager(4);
    pm.reserve('r1', 'o/r', () => undefined, { branch: 'first' });
    expect(() => pm.reserve('r1', 'o/r', () => undefined, { branch: 'second' })).toThrow('already active');
    expect(pm.canStart('o/r', { branch: 'first' }).ok).toBe(false);
  });

  it('rejects beyond max concurrency', () => {
    const pm = new ProcessManager(1);
    pm.reserve('r1', 'o/a', () => undefined);
    expect(pm.canStart('o/b').ok).toBe(false);
  });

  it('compares repositories without case but preserves case-sensitive Git branch identity', () => {
    const pm = new ProcessManager(4);
    pm.reserve('r1', 'Org/MyRepo', () => undefined, { branch: 'Fix/Feature' });
    expect(pm.canStart('org/myrepo', { branch: 'Fix/Feature' })).toMatchObject({ ok: false });
    expect(pm.canStart('ORG/MYREPO', { branch: 'fix/feature' })).toMatchObject({ ok: true });
    expect(pm.canStart('org/another-repo', { branch: 'Fix/Feature' })).toMatchObject({ ok: true });
    expect(pm.activeRepos()).toEqual(['Org/MyRepo']);
    pm.remove('r1');
    expect(pm.canStart('org/myrepo', { branch: 'Fix/Feature' })).toMatchObject({ ok: true });
  });

  it('frees the slot on remove', () => {
    const pm = new ProcessManager(1);
    pm.reserve('r1', 'o/a', () => undefined);
    pm.remove('r1');
    expect(pm.canStart('o/b').ok).toBe(true);
  });

  it('stop invokes the run stopper and returns true', () => {
    const pm = new ProcessManager(4);
    const stop = vi.fn();
    pm.reserve('r1', 'o/a', stop);
    expect(pm.stop('r1')).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(pm.stop('missing')).toBe(false);
  });

  it('hasRun reflects whether a run id is tracked', () => {
    const pm = new ProcessManager(4);
    pm.reserve('r1', 'o/r', () => undefined);
    expect(pm.hasRun('r1')).toBe(true);
    expect(pm.hasRun('nope')).toBe(false);
    pm.remove('r1');
    expect(pm.hasRun('r1')).toBe(false);
  });
});
