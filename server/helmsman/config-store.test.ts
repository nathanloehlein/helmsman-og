import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db';
import { loadConfig } from '../config';
import { ConfigStore, EDITABLE_KEYS, publicConfig } from './config-store';

let db: Db;
afterEach(() => db?.close());

describe('ConfigStore', () => {
  it('exposes effective pre-PR defaults and updates overrides immediately', () => {
    db = openDb(':memory:');
    const store = new ConfigStore({}, db);
    expect(publicConfig(store.current())).toMatchObject({
      PRE_PR_REVIEWER_COUNT: 2,
      PRE_PR_MAX_ROUNDS: 3,
      PRE_PR_STAGE_TIMEOUT_MINUTES: 45,
    });
    store.setOverride('PRE_PR_REVIEWER_COUNT', '1', () => '2026-09-17T00:00:00.000Z');
    store.setOverride('PRE_PR_MAX_ROUNDS', '5', () => '2026-09-17T00:00:00.000Z');
    store.setOverride('PRE_PR_STAGE_TIMEOUT_MINUTES', '180', () => '2026-09-17T00:00:00.000Z');
    expect(store.current().prePr).toEqual({ reviewerCount: 1, maxRounds: 5, stageTimeoutMinutes: 180 });
    expect(publicConfig(store.current())).toMatchObject({
      PRE_PR_REVIEWER_COUNT: 1,
      PRE_PR_MAX_ROUNDS: 5,
      PRE_PR_STAGE_TIMEOUT_MINUTES: 180,
    });
  });

  it.each([
    ['PRE_PR_REVIEWER_COUNT', '0'], ['PRE_PR_REVIEWER_COUNT', '3'],
    ['PRE_PR_MAX_ROUNDS', '0'], ['PRE_PR_MAX_ROUNDS', '6'],
    ['PRE_PR_STAGE_TIMEOUT_MINUTES', '4'], ['PRE_PR_STAGE_TIMEOUT_MINUTES', '181'],
    ['PRE_PR_MAX_ROUNDS', '2.5'], ['PRE_PR_MAX_ROUNDS', '2x'],
    ['PRE_PR_MAX_ROUNDS', '1e0'], ['PRE_PR_MAX_ROUNDS', 'Infinity'],
  ])('rejects invalid %s=%s without changing stored values', (key, value) => {
    db = openDb(':memory:');
    const store = new ConfigStore({}, db);
    expect(() => store.setOverride(key, value, () => '2026-09-17T00:00:00.000Z')).toThrow(/whole number/);
    expect(store.overrides()).toEqual({});
  });

  it('uses defaults for blank pre-PR overrides even when the environment sets another value', () => {
    db = openDb(':memory:');
    const store = new ConfigStore({ PRE_PR_REVIEWER_COUNT: '1', PRE_PR_MAX_ROUNDS: '5', PRE_PR_STAGE_TIMEOUT_MINUTES: '180' }, db);
    for (const key of ['PRE_PR_REVIEWER_COUNT', 'PRE_PR_MAX_ROUNDS', 'PRE_PR_STAGE_TIMEOUT_MINUTES']) {
      store.setOverride(key, ' ', () => '2026-09-17T00:00:00.000Z');
    }
    expect(store.current().prePr).toEqual({ reviewerCount: 2, maxRounds: 3, stageTimeoutMinutes: 45 });
  });

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

  it('setSecret writes JIRA_API_TOKEN live without exposing it in publicConfig', () => {
    db = openDb(':memory:');
    const store: ConfigStore = new ConfigStore(
      { JIRA_BASE_URL: 'https://x.atlassian.net', JIRA_EMAIL: 'e@x', JIRA_API_TOKEN: 'old', JIRA_PROJECT: 'AB' },
      db,
    );
    const now: () => string = () => '2026-08-24T00:00:00.000Z';
    store.setSecret('JIRA_API_TOKEN', 'fresh-token', now);
    expect(store.current().jira?.apiToken).toBe('fresh-token');
    expect(publicConfig(store.current())).not.toHaveProperty('JIRA_API_TOKEN');
    expect(Object.values(publicConfig(store.current()))).not.toContain('fresh-token');
  });

  it('setSecret refuses non-writable secrets and non-secret keys', () => {
    db = openDb(':memory:');
    const store: ConfigStore = new ConfigStore({}, db);
    const now: () => string = () => '2026-08-24T00:00:00.000Z';
    expect(() => store.setSecret('GITHUB_TOKEN', 'x', now)).toThrow();
    expect(() => store.setSecret('JIRA_EMAIL', 'x', now)).toThrow();
    expect(() => store.setSecret('AGENT_MAX_ATTEMPTS', '3', now)).toThrow();
  });

  it('reports whether a Jira token is present without revealing it', () => {
    db = openDb(':memory:');
    const store: ConfigStore = new ConfigStore(
      { JIRA_BASE_URL: 'https://x.atlassian.net', JIRA_EMAIL: 'e@x', JIRA_API_TOKEN: 't', JIRA_PROJECT: 'AB' },
      db,
    );
    expect(store.hasJiraToken()).toBe(true);
    expect(new ConfigStore({}, db).hasJiraToken()).toBe(false);
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
      expect(EDITABLE_KEYS).toContain(key);
    }
    db.close();
  });
});
