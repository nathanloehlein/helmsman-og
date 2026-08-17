import type { DashboardSnapshot } from '../src/data/mock';
import type { GithubPr, JiraIssue } from './types';
import type { AppConfig, GithubConfig, JiraConfig } from './config';
import { loadConfig } from './config';
import { assembleSnapshot } from './snapshot';
import { fetchActiveIssues, fetchQueueIssues } from './jira';
import { fetchAuthoredPrs } from './github';
import { loadDashboard } from '../src/data/mock';

export interface DashboardResponse {
  snapshot: DashboardSnapshot;
  degraded: string[];
}

export interface Deps {
  fetchQueueIssues: (jira: JiraConfig) => Promise<JiraIssue[]>;
  fetchActiveIssues: (jira: JiraConfig) => Promise<JiraIssue[]>;
  fetchAuthoredPrs: (github: GithubConfig) => Promise<GithubPr[]>;
  loadMock: () => Promise<DashboardSnapshot>;
}

const DEFAULT_DEPS: Deps = {
  fetchQueueIssues,
  fetchActiveIssues,
  fetchAuthoredPrs,
  loadMock: loadDashboard,
};

export async function buildDashboardResponse(
  env: Record<string, string | undefined>,
  now: Date,
  deps: Deps = DEFAULT_DEPS,
): Promise<DashboardResponse> {
  const config: AppConfig = loadConfig(env);
  const degraded: string[] = [];

  let queueIssues: JiraIssue[] = [];
  let activeIssues: JiraIssue[] = [];
  let prs: GithubPr[] = [];

  if (config.jira) {
    try {
      [queueIssues, activeIssues] = await Promise.all([
        deps.fetchQueueIssues(config.jira),
        deps.fetchActiveIssues(config.jira),
      ]);
    } catch {
      degraded.push('jira');
    }
  } else {
    degraded.push('jira');
  }

  if (config.github) {
    try {
      prs = await deps.fetchAuthoredPrs(config.github);
    } catch {
      degraded.push('github');
    }
  } else {
    degraded.push('github');
  }

  const jiraDegraded: boolean = degraded.includes('jira');
  const githubDegraded: boolean = degraded.includes('github');

  const snapshot: DashboardSnapshot = assembleSnapshot({
    queueIssues,
    activeIssues,
    prs,
    repo: config.repoLabel,
    now,
  });

  if (jiraDegraded || githubDegraded) {
    const mock: DashboardSnapshot = await deps.loadMock();
    if (jiraDegraded) {
      snapshot.queue = mock.queue;
      snapshot.currentTicket = mock.currentTicket;
      snapshot.steps = mock.steps;
      snapshot.stats = mock.stats;
      snapshot.throughput7d = mock.throughput7d;
    }
    if (githubDegraded) {
      snapshot.shipped = jiraDegraded ? mock.shipped : [];
    }
    if (jiraDegraded && githubDegraded) {
      snapshot.activity = mock.activity;
    }
  }

  return { snapshot, degraded };
}
