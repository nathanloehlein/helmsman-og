import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPirateMode, setPirateMode, term, wording } from './terminology';

afterEach(() => {
  vi.unstubAllGlobals();
  setPirateMode(true);
  localStorage.clear();
});

describe('interface terminology', () => {
  it('defaults to pirate mode and persists the explicit plain preference', () => {
    expect(isPirateMode()).toBe(true);
    expect(term('success')).toBe('Shipshape');
    setPirateMode(false);
    expect(localStorage.getItem('helmsman.pirateMode')).toBe('false');
    expect(isPirateMode()).toBe(false);
    expect(term('failed')).toBe('Failed');
    setPirateMode(true);
    expect(term('failed')).toBe('Marooned');
  });

  it.each([
    ['tokens', 'Tokens', 'Tokens'], ['agent', 'Agent', 'Deckhand'],
    ['start', 'Start', 'Weigh anchor'], ['review', 'Review', 'Inspection'],
    ['pr', 'PR', 'Bounty'], ['repository', 'Repository', 'Galleon'],
    ['run', 'Run', 'Voyage'], ['launchTicket', 'Start ticket run', 'Start ticket voyage'],
  ] as const)('maps the explicit %s label without relying on storage', (key, plain, pirate) => {
    expect(wording(key, false)).toBe(plain);
    expect(wording(key, true)).toBe(pirate);
  });

  it('remains usable when browser storage is inaccessible', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    setPirateMode(false);
    expect(isPirateMode()).toBe(false);
    expect(term('dashboard')).toBe('Dashboard');
    setPirateMode(true);
    expect(term('dashboard')).toBe('Helm');
  });

  it('keeps the live preference when writes fail but stale storage can still be read', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'true', setItem: () => { throw new Error('quota'); } });
    setPirateMode(false);
    expect(isPirateMode()).toBe(false);
    expect(term('dashboard')).toBe('Dashboard');
  });
});
