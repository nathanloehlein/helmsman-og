import { loadConfig, type AppConfig } from '../config';
import type { Db } from './db';
import { parseFirefoxWebDriverUrl, SLACK_CONFIG_KEYS } from './slack/config';
import { validateSlackOAuthRedirectUri } from './slack/oauth';
import { SLACK_REVIEW_CONFIG_KEYS } from './slack/review-request';
import { PRE_PR_CONFIG_KEYS, PRE_PR_SETTING_DEFINITIONS, parsePrePrSettingValue } from '../../src/logic/prePrSettings';

export const EDITABLE_KEYS: readonly string[] = [
  ...SLACK_CONFIG_KEYS,
  ...SLACK_REVIEW_CONFIG_KEYS,
  ...PRE_PR_CONFIG_KEYS,
  'GITHUB_REVIEW_WATCH_ENABLED',
  'AGENT_ADAPTER',
  'AGENT_CMD',
  'AGENT_MAX_ATTEMPTS',
  'AGENT_MAX_COST_USD',
  'AUTO_CLAIM_INTERVAL_MS',
  'REPO_PROJECT_MAP',
  'JIRA_ENABLED',
  'JIRA_PROJECT',
  'JIRA_ASSIGNEE',
  'JIRA_JQL',
  'GITHUB_REPO',
  'GITHUB_PR_AUTHOR',
];

export const SECRET_KEYS: readonly string[] = ['JIRA_API_TOKEN', 'GITHUB_TOKEN', 'JIRA_EMAIL', 'SLACK_BOT_TOKEN', 'SLACK_OAUTH_CLIENT_SECRET'];

export const WRITABLE_SECRET_KEYS: readonly string[] = ['JIRA_API_TOKEN', 'SLACK_OAUTH_CLIENT_SECRET'];

export function publicConfig(cfg: AppConfig): Record<string, unknown> {
  return {
    JIRA_ENABLED: String(cfg.jiraEnabled),
    AGENT_ADAPTER: cfg.agentAdapter,
    AGENT_CMD: cfg.agentCmd,
    AGENT_MAX_ATTEMPTS: cfg.maxAttempts,
    AGENT_MAX_COST_USD: cfg.maxCostUsd,
    ...Object.fromEntries(PRE_PR_SETTING_DEFINITIONS.map(({ key, envKey }) => [envKey, cfg.prePr[key]])),
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
    if (['JIRA_ENABLED', 'SLACK_ENABLED', 'SLACK_WATCH_ENABLED', 'GITHUB_REVIEW_WATCH_ENABLED'].includes(key) && value !== 'true' && value !== 'false') {
      throw new Error(`${key} must be true or false`);
    }
    if (key === 'SLACK_BROWSER' && value !== 'cmux' && value !== 'firefox') throw new Error('Slack browser must be cmux or firefox');
    if (key === 'SLACK_TRANSPORT' && !['browser', 'mcp'].includes(value)) throw new Error('Slack transport must be browser or mcp');
    if (key === 'SLACK_MCP_TEAM_ID' && value.trim() && !/^T[A-Z0-9]{2,31}$/.test(value.trim())) throw new Error('Enter a Slack workspace ID starting with T.');
    if (key === 'SLACK_REVIEW_GROUP_ID' && value.trim() && !/^S[A-Z0-9]{2,31}$/.test(value.trim())) throw new Error('Enter a Slack user group ID starting with S.');
    if (key === 'SLACK_OAUTH_CLIENT_ID' && value.trim() && !/^\d+\.\d+$/.test(value.trim())) throw new Error('Enter the Slack OAuth app client ID.');
    if (key === 'SLACK_OAUTH_REDIRECT_URI' && value.trim()) validateSlackOAuthRedirectUri(value.trim());
    if (key === 'SLACK_FIREFOX_WEBDRIVER_URL') parseFirefoxWebDriverUrl(value);
    const slackTarget = value.trim().replace(key === 'SLACK_REVIEW_CHANNEL' ? /^#/ : /^@/, '');
    if (key === 'SLACK_REVIEW_CHANNEL' && slackTarget && !/^(?:[CG][A-Z\d]{2,31}|[a-z\d_-]{1,80})$/.test(slackTarget)) {
      throw new Error('Slack review channel must be a channel name or channel ID');
    }
    if (key === 'SLACK_REVIEW_MENTION' && slackTarget && !/^[a-z\d_-]{1,80}$/.test(slackTarget)) {
      throw new Error('Slack review mention must be a user group handle');
    }
    const prePrSetting = PRE_PR_SETTING_DEFINITIONS.find(({ envKey }) => envKey === key);
    if (prePrSetting && value.trim() !== '' && parsePrePrSettingValue(value, prePrSetting) === undefined) {
      throw new Error(`${key} must be a whole number from ${prePrSetting.min} to ${prePrSetting.max}`);
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
    return Boolean(this.effectiveEnv().JIRA_API_TOKEN?.trim());
  }

}
