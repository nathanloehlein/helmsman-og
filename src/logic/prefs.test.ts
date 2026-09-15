import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadRepoScope,
  saveRepoScope,
  loadConfigCollapsed,
  saveConfigCollapsed,
  loadCollapsed,
  saveCollapsed,
} from './prefs';

describe('repo scope pref', () => {
  beforeEach(() => localStorage.clear());

  it('returns null when unset', () => {
    expect(loadRepoScope()).toBeNull();
  });

  it('round-trips a repo', () => {
    saveRepoScope('acme/widgets');
    expect(loadRepoScope()).toBe('acme/widgets');
  });

  it('clears when saved null', () => {
    saveRepoScope('acme/widgets');
    saveRepoScope(null);
    expect(loadRepoScope()).toBeNull();
  });

  it('treats an empty stored value as null', () => {
    localStorage.setItem('runner.repoScope', '');
    expect(loadRepoScope()).toBeNull();
  });
});

describe('config collapsed pref', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to false', () => {
    expect(loadConfigCollapsed()).toBe(false);
  });

  it('round-trips true', () => {
    saveConfigCollapsed(true);
    expect(loadConfigCollapsed()).toBe(true);
  });

  it('round-trips false', () => {
    saveConfigCollapsed(true);
    saveConfigCollapsed(false);
    expect(loadConfigCollapsed()).toBe(false);
  });
});

describe('surface collapsed set pref', () => {
  beforeEach(() => localStorage.clear());

  it('returns an empty set when unset', () => {
    expect(loadCollapsed().size).toBe(0);
  });

  it('round-trips a set of ids', () => {
    saveCollapsed(new Set(['triage:backlog', 'cmux:list']));
    const loaded: Set<string> = loadCollapsed();
    expect(loaded.has('triage:backlog')).toBe(true);
    expect(loaded.has('cmux:list')).toBe(true);
    expect(loaded.size).toBe(2);
  });

  it('round-trips an empty set', () => {
    saveCollapsed(new Set(['runs:drawer']));
    saveCollapsed(new Set());
    expect(loadCollapsed().size).toBe(0);
  });

  it('returns an empty set on malformed JSON', () => {
    localStorage.setItem('gomaestro.collapsed', '{not json');
    expect(loadCollapsed().size).toBe(0);
  });

  it('ignores non-string entries', () => {
    localStorage.setItem('gomaestro.collapsed', JSON.stringify(['triage:mine', 42, null]));
    const loaded: Set<string> = loadCollapsed();
    expect(loaded.has('triage:mine')).toBe(true);
    expect(loaded.size).toBe(1);
  });
});
