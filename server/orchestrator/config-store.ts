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

export function publicConfig(cfg: AppConfig): Record<string, unknown> {
  return {
    agentAdapter: cfg.agentAdapter,
    agentCmd: cfg.agentCmd,
    maxAttempts: cfg.maxAttempts,
    maxCostUsd: cfg.maxCostUsd,
    autoClaimIntervalMs: cfg.autoClaimIntervalMs,
    repoProjectMap: cfg.repoProjectMap,
    jiraProject: cfg.jira?.project ?? null,
    jiraAssignee: cfg.jira?.assignee ?? null,
    jiraJql: cfg.jira?.jql ?? null,
    githubRepo: cfg.github?.repo ?? null,
    githubAuthor: cfg.github?.author ?? null,
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
}
