import { loadConfig, type AppConfig } from '../config';
import type { Db } from './db';

export const EDITABLE_KEYS: readonly string[] = [
  'AGENT_ADAPTER',
  'AGENT_CMD',
  'AGENT_MAX_ATTEMPTS',
  'AGENT_MAX_COST_USD',
  'AUTO_CLAIM_INTERVAL_MS',
  'REPO_PROJECT_MAP',
  'JIRA_PROJECT',
  'JIRA_ASSIGNEE',
  'JIRA_JQL',
  'GITHUB_REPO',
  'GITHUB_PR_AUTHOR',
];

export const SECRET_KEYS: readonly string[] = ['JIRA_API_TOKEN', 'GITHUB_TOKEN', 'JIRA_EMAIL'];

export const WRITABLE_SECRET_KEYS: readonly string[] = ['JIRA_API_TOKEN'];

export function publicConfig(cfg: AppConfig): Record<string, unknown> {
  return {
    AGENT_ADAPTER: cfg.agentAdapter,
    AGENT_CMD: cfg.agentCmd,
    AGENT_MAX_ATTEMPTS: cfg.maxAttempts,
    AGENT_MAX_COST_USD: cfg.maxCostUsd,
    AUTO_CLAIM_INTERVAL_MS: cfg.autoClaimIntervalMs,
    REPO_PROJECT_MAP: Object.entries(cfg.repoProjectMap).map(([repo, project]: [string, string]): string => `${repo}=${project}`).join(','),
    JIRA_PROJECT: cfg.jira?.project ?? null,
    JIRA_ASSIGNEE: cfg.jira?.assignee ?? null,
    JIRA_JQL: cfg.jira?.jql ?? null,
    GITHUB_REPO: cfg.github?.repo ?? null,
    GITHUB_PR_AUTHOR: cfg.github?.author ?? null,
  };
}

export class ConfigStore {
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly db: Db;

  constructor(baseEnv: Record<string, string | undefined>, db: Db) {
    this.baseEnv = baseEnv;
    this.db = db;
  }

  effectiveEnv(): Record<string, string | undefined> {
    return { ...this.baseEnv, ...this.db.getConfigOverrides() };
  }

  current(): AppConfig {
    return loadConfig(this.effectiveEnv());
  }

  overrides(): Record<string, string> {
    return this.db.getConfigOverrides();
  }

  setOverride(key: string, value: string, now: () => string): void {
    if (SECRET_KEYS.includes(key) || !EDITABLE_KEYS.includes(key)) {
      throw new Error(`not an editable config key: ${key}`);
    }
    this.db.setConfigOverride(key, value, now());
  }

  setSecret(key: string, value: string, now: () => string): void {
    if (!WRITABLE_SECRET_KEYS.includes(key)) {
      throw new Error(`not a writable secret key: ${key}`);
    }
    if (value.trim() === '') {
      throw new Error(`refusing to set empty secret: ${key}`);
    }
    this.db.setConfigOverride(key, value, now());
  }

  hasJiraToken(): boolean {
    return Boolean(this.current().jira?.apiToken);
  }
}
