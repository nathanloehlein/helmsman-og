import { describe, expect, it } from 'vitest';
import { buildActiveJql, buildQueueJql, loadConfig } from './config';

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

  it('falls back to backlog-runner label when github is absent entirely', () => {
    const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_PR_AUTHOR, ...rest } = FULL;
    expect(loadConfig(rest).repoLabel).toBe('backlog-runner');
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
});
