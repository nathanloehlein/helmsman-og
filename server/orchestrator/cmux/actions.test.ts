import { describe, expect, it } from 'vitest';
import { actionsFor, keysFor } from './actions';

describe('actions', () => {
  it('offers the universal terminal set for an unknown provider', () => {
    expect(actionsFor(null).map((a) => a.action)).toEqual(['enter', 'escape', 'interrupt']);
  });

  it('adds agent actions for a known provider', () => {
    const acts = actionsFor('claude').map((a) => a.action);
    expect(acts).toContain('continue');
    expect(acts).toContain('stop');
    expect(acts).toContain('approve');
  });

  it('maps approve to y then Enter', () => {
    expect(keysFor('claude', 'approve')).toEqual(['y', 'Enter']);
  });

  it('interrupt is Ctrl-C for any tab', () => {
    expect(keysFor(null, 'interrupt')).toEqual(['C-c']);
  });

  it('returns null for an action the provider does not offer', () => {
    expect(keysFor(null, 'approve')).toBeNull();
  });
});
