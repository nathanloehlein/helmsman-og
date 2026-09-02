import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadRepoScope,
  saveRepoScope,
  loadConfigCollapsed,
  saveConfigCollapsed,
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
