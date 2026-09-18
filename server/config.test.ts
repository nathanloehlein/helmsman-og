import { describe, expect, it } from 'vitest';
import {
  buildActiveJql,
  buildMineOpenJql,
  buildQueueJql,
  buildUnassignedBacklogJql,
  buildUnassignedTodoJql,
  loadConfig,
} from './config';

const FULL = {
  JIRA_BASE_URL: 'https://x.atlassian.net',
  JIRA_EMAIL: 'a@b.com',
  JIRA_API_TOKEN: 't',
  JIRA_PROJECT: 'AIROBUILD',
  JIRA_ASSIGNEE: 'me',
  GITHUB_TOKEN: 'gh',
  GITHUB_REPO: 'o/r',
  GITHUB_PR_AUTHOR: 'bot',
};

describe('loadConfig', () => {
  it('defaults pre-PR settings to two reviewers, three rounds, and 45 minutes per stage', () => {
    expect(loadConfig({}).prePr).toEqual({ reviewerCount: 2, maxRounds: 3, stageTimeoutMinutes: 45 });
  });

  it('loads valid pre-PR settings independently', () => {
    expect(loadConfig({
      PRE_PR_REVIEWER_COUNT: '1',
      PRE_PR_MAX_ROUNDS: ' 5 ',
      PRE_PR_STAGE_TIMEOUT_MINUTES: '180',
    }).prePr).toEqual({ reviewerCount: 1, maxRounds: 5, stageTimeoutMinutes: 180 });
  });

  it.each(['', ' ', '0', '-1', '1.5', '2x', '1e2', 'Infinity', 'NaN', '999999999999999999'])('defaults invalid pre-PR settings %j', (value) => {
    expect(loadConfig({
      PRE_PR_REVIEWER_COUNT: value,
      PRE_PR_MAX_ROUNDS: value,
      PRE_PR_STAGE_TIMEOUT_MINUTES: value,
    }).prePr).toEqual({ reviewerCount: 2, maxRounds: 3, stageTimeoutMinutes: 45 });
  });

  it('defaults only invalid pre-PR values without discarding valid settings', () => {
    expect(loadConfig({
      PRE_PR_REVIEWER_COUNT: '3',
      PRE_PR_MAX_ROUNDS: '1',
      PRE_PR_STAGE_TIMEOUT_MINUTES: '4',
    }).prePr).toEqual({ reviewerCount: 2, maxRounds: 1, stageTimeoutMinutes: 45 });
  });

  it('populates both sources when all vars present', () => {
    const cfg = loadConfig(FULL);
    expect(cfg.jira?.project).toBe('AIROBUILD');
    expect(cfg.github?.author).toBe('bot');
    expect(cfg.repoLabel).toBe('o/r');
  });

  it('nulls jira when a required jira var is missing', () => {
    const { JIRA_API_TOKEN, ...rest } = FULL;
    expect(loadConfig(rest).jira).toBeNull();
  });

  it('nulls github when token or author is missing', () => {
    const { GITHUB_TOKEN, ...noToken } = FULL;
    expect(loadConfig(noToken).github).toBeNull();
    const { GITHUB_PR_AUTHOR, ...noAuthor } = FULL;
    expect(loadConfig(noAuthor).github).toBeNull();
  });

  it('keeps github without a repo and labels it by author', () => {
    const { GITHUB_REPO, ...rest } = FULL;
    const cfg = loadConfig(rest);
    expect(cfg.github?.author).toBe('bot');
    expect(cfg.repoLabel).toBe('@bot');
  });

  it('falls back to Helmsman label when github is absent entirely', () => {
    const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_PR_AUTHOR, ...rest } = FULL;
    expect(loadConfig(rest).repoLabel).toBe('Helmsman');
  });

  it('parses REPO_PROJECT_MAP into a repo→project record (trimming spaces)', () => {
    const cfg = loadConfig({ ...FULL, REPO_PROJECT_MAP: 'o/a=PROJA, o/b = PROJB' });
    expect(cfg.repoProjectMap).toEqual({ 'o/a': 'PROJA', 'o/b': 'PROJB' });
  });

  it('defaults repoProjectMap to an empty object', () => {
    expect(loadConfig(FULL).repoProjectMap).toEqual({});
  });

  it('builds default queue JQL from project + assignee', () => {
    const cfg = loadConfig(FULL);
    expect(buildQueueJql(cfg.jira!)).toBe(
      'project = "AIROBUILD" AND assignee = "me" AND status = Backlog ORDER BY priority',
    );
  });

  it('uses explicit JIRA_JQL override for the queue', () => {
    const cfg = loadConfig({ ...FULL, JIRA_JQL: 'filter = 42' });
    expect(buildQueueJql(cfg.jira!)).toBe('filter = 42');
  });

  it('builds a 7-day active JQL', () => {
    const cfg = loadConfig(FULL);
    expect(buildActiveJql(cfg.jira!)).toBe(
      'project = "AIROBUILD" AND assignee = "me" AND status IN ("In Progress","In Review","Done") AND updated >= -7d ORDER BY updated DESC',
    );
  });

  it('leaves a currentUser() function assignee unquoted in both JQLs', () => {
    const cfg = loadConfig({ ...FULL, JIRA_ASSIGNEE: 'currentUser()' });
    expect(buildQueueJql(cfg.jira!)).toBe(
      'project = "AIROBUILD" AND assignee = currentUser() AND status = Backlog ORDER BY priority',
    );
    expect(buildActiveJql(cfg.jira!)).toBe(
      'project = "AIROBUILD" AND assignee = currentUser() AND status IN ("In Progress","In Review","Done") AND updated >= -7d ORDER BY updated DESC',
    );
  });

  it('builds unassigned backlog + todo JQLs with assignee IS EMPTY', () => {
    const cfg = loadConfig(FULL);
    expect(buildUnassignedBacklogJql(cfg.jira!, cfg.statusBacklog)).toBe(
      'project = "AIROBUILD" AND assignee IS EMPTY AND status = "Backlog" ORDER BY priority',
    );
    expect(buildUnassignedTodoJql(cfg.jira!, cfg.statusTodo)).toBe(
      'project = "AIROBUILD" AND assignee IS EMPTY AND status = "To Do" ORDER BY priority',
    );
  });

  it('builds a mine-open JQL spanning every non-done status', () => {
    const cfg = loadConfig({ ...FULL, JIRA_ASSIGNEE: 'currentUser()' });
    expect(buildMineOpenJql(cfg.jira!)).toBe(
      'project = "AIROBUILD" AND assignee = currentUser() AND statusCategory != Done ORDER BY status ASC, priority ASC',
    );
  });

  it('defaults triage status names and overrides them from env', () => {
    expect(loadConfig(FULL).statusBacklog).toBe('Backlog');
    expect(loadConfig(FULL).statusTodo).toBe('To Do');
    const cfg = loadConfig({ ...FULL, JIRA_STATUS_BACKLOG: 'Icebox', JIRA_STATUS_TODO: 'Selected' });
    expect(cfg.statusBacklog).toBe('Icebox');
    expect(cfg.statusTodo).toBe('Selected');
  });

  it('defaults botAccountId to null, maxAttempts to 1, and jira lifecycle statuses', () => {
    const cfg = loadConfig(FULL);
    expect(cfg.botAccountId).toBeNull();
    expect(cfg.maxAttempts).toBe(1);
    expect(cfg.statusInProgress).toBe('In Progress');
    expect(cfg.statusInReview).toBe('In Review');
  });

  it('overrides botAccountId, maxAttempts, and jira lifecycle statuses from env', () => {
    const cfg = loadConfig({
      ...FULL,
      BOT_ACCOUNT_ID: 'acct-123',
      AGENT_MAX_ATTEMPTS: '3',
      JIRA_STATUS_IN_PROGRESS: 'Doing',
      JIRA_STATUS_IN_REVIEW: 'Ready for Review',
    });
    expect(cfg.botAccountId).toBe('acct-123');
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.statusInProgress).toBe('Doing');
    expect(cfg.statusInReview).toBe('Ready for Review');
  });

  it('falls back to maxAttempts 1 when AGENT_MAX_ATTEMPTS is not a valid number', () => {
    const cfg = loadConfig({ ...FULL, AGENT_MAX_ATTEMPTS: 'not-a-number' });
    expect(cfg.maxAttempts).toBe(1);
  });

  it('defaults autoClaimIntervalMs to 60000', () => {
    const cfg = loadConfig(FULL);
    expect(cfg.autoClaimIntervalMs).toBe(60000);
  });

  it('overrides autoClaimIntervalMs from AUTO_CLAIM_INTERVAL_MS', () => {
    const cfg = loadConfig({ ...FULL, AUTO_CLAIM_INTERVAL_MS: '15000' });
    expect(cfg.autoClaimIntervalMs).toBe(15000);
  });

  it('falls back to autoClaimIntervalMs 60000 when AUTO_CLAIM_INTERVAL_MS is not a valid number', () => {
    const cfg = loadConfig({ ...FULL, AUTO_CLAIM_INTERVAL_MS: 'not-a-number' });
    expect(cfg.autoClaimIntervalMs).toBe(60000);
  });

  it('defaults agentAdapter to codex and agentCmd to null', () => {
    const cfg = loadConfig(FULL);
    expect(cfg.agentAdapter).toBe('codex');
    expect(cfg.agentCmd).toBeNull();
  });

  it('unset AGENT_ADAPTER yields codex', () => {
    expect(loadConfig({ ...FULL, AGENT_ADAPTER: undefined }).agentAdapter).toBe('codex');
  });

  it('explicit claude-code preserved', () => {
    expect(loadConfig({ ...FULL, AGENT_ADAPTER: 'claude-code' }).agentAdapter).toBe('claude-code');
  });

  it('command preserved', () => {
    expect(loadConfig({ ...FULL, AGENT_ADAPTER: 'command' }).agentAdapter).toBe('command');
  });

  it('selects the command adapter and template from env', () => {
    const cfg = loadConfig({ ...FULL, AGENT_ADAPTER: 'command', AGENT_CMD: 'run {ticket}' });
    expect(cfg.agentAdapter).toBe('command');
    expect(cfg.agentCmd).toBe('run {ticket}');
  });

  it('falls back to codex for an unrecognized AGENT_ADAPTER value', () => {
    const cfg = loadConfig({ ...FULL, AGENT_ADAPTER: 'foo' });
    expect(cfg.agentAdapter).toBe('codex');
  });

  it('defaults maxCostUsd to null', () => {
    const cfg = loadConfig(FULL);
    expect(cfg.maxCostUsd).toBeNull();
  });

  it('parses AGENT_MAX_COST_USD as a float', () => {
    const cfg = loadConfig({ ...FULL, AGENT_MAX_COST_USD: '2.5' });
    expect(cfg.maxCostUsd).toBe(2.5);
  });

  it('falls back to maxCostUsd null when AGENT_MAX_COST_USD is not a valid number', () => {
    const cfg = loadConfig({ ...FULL, AGENT_MAX_COST_USD: 'x' });
    expect(cfg.maxCostUsd).toBeNull();
  });
});

describe('Jira source toggle', () => {
  it('defaults on and disables credentials without affecting GitHub', () => {
    expect(loadConfig(FULL).jiraEnabled).toBe(true);
    const cfg = loadConfig({ ...FULL, JIRA_ENABLED: 'false' });
    expect(cfg.jiraEnabled).toBe(false);
    expect(cfg.jira).toBeNull();
    expect(cfg.github).toEqual(loadConfig(FULL).github);
    expect(loadConfig({ ...FULL, JIRA_ENABLED: 'true' }).jira).not.toBeNull();
  });
});
