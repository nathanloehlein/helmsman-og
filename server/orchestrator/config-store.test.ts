import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db';
import { loadConfig } from '../config';
import { ConfigStore, publicConfig } from './config-store';

let db: Db;
afterEach(() => db?.close());

describe('ConfigStore', () => {
  it('returns loadConfig(env) unchanged when there are no overrides', () => {
    db = openDb(':memory:');
    const store: ConfigStore = new ConfigStore({}, db);
    expect(store.current()).toEqual(loadConfig({}));
  });

  it('layers a set override on top of the base env', () => {
    db = openDb(':memory:');
    const store: ConfigStore = new ConfigStore({}, db);
    const now: () => string = () => '2026-08-24T00:00:00.000Z';
    store.setOverride('AGENT_MAX_ATTEMPTS', '3', now);
    expect(store.current().maxAttempts).toBe(3);
    expect(store.overrides().AGENT_MAX_ATTEMPTS).toBe('3');
  });

  it('throws when setting a secret key as an override', () => {
    db = openDb(':memory:');
    const store: ConfigStore = new ConfigStore({}, db);
    const now: () => string = () => '2026-08-24T00:00:00.000Z';
    expect(() => store.setOverride('JIRA_API_TOKEN', 'x', now)).toThrow();
  });

  it('throws when setting a key that is not editable', () => {
    db = openDb(':memory:');
    const store: ConfigStore = new ConfigStore({}, db);
    const now: () => string = () => '2026-08-24T00:00:00.000Z';
    expect(() => store.setOverride('NOPE', 'x', now)).toThrow();
  });

  it('publicConfig exposes only non-secret effective values', () => {
    db = openDb(':memory:');
    const store: ConfigStore = new ConfigStore({}, db);
    const pub: Record<string, unknown> = publicConfig(store.current());
    expect(pub).toHaveProperty('AGENT_ADAPTER');
    expect(pub).toHaveProperty('AGENT_MAX_ATTEMPTS');
    expect(pub).not.toHaveProperty('JIRA_API_TOKEN');
    expect(pub).not.toHaveProperty('GITHUB_TOKEN');
    expect(pub).not.toHaveProperty('JIRA_EMAIL');
    expect(pub).not.toHaveProperty('apiToken');
    expect(pub).not.toHaveProperty('token');
  });

  it('every key publicConfig renders is an accepted override key (UI vocab == gate vocab)', () => {
    db = openDb(':memory:');
    const store: ConfigStore = new ConfigStore({}, db);
    const keys: string[] = Object.keys(publicConfig(store.current()));
    for (const key of keys) {
      expect(() => store.setOverride(key, 'x', () => '2026-08-24T00:00:00.000Z')).not.toThrow();
    }
    db.close();
  });
});
