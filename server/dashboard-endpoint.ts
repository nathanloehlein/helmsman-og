import type { DashboardSnapshot } from '../src/data/mock';
import type { GithubPr, JiraIssue } from './types';
import type { AppConfig, GithubConfig, JiraConfig } from './config';
import { loadConfig } from './config';
import { assembleSnapshot, issueToTicket } from './snapshot';
import { fetchActiveIssues, fetchMineOpenIssues, fetchQueueIssues } from './jira';
import { fetchAuthoredPrs, fetchOpenAuthoredPrs, type OpenAuthoredPr } from './github';
import { loadDashboard } from '../src/data/mock';

export interface DashboardResponse {
  snapshot: DashboardSnapshot;
  degraded: string[];
  repos: string[];
  selectedRepo: string | null;
  jiraBaseUrl: string | null;
}

export interface Deps {
  fetchQueueIssues: (jira: JiraConfig) => Promise<JiraIssue[]>;
  fetchActiveIssues: (jira: JiraConfig) => Promise<JiraIssue[]>;
  fetchMineOpenIssues?: (jira: JiraConfig) => Promise<JiraIssue[]>;
  fetchAuthoredPrs: (github: GithubConfig, repos: string[]) => Promise<GithubPr[]>;
  fetchOpenAuthoredPrs: (github: GithubConfig, repos: string[]) => Promise<OpenAuthoredPr[]>;
  loadMock: () => Promise<DashboardSnapshot>;
}

const DEFAULT_DEPS: Deps = {
  fetchQueueIssues,
  fetchActiveIssues,
  fetchMineOpenIssues,
  fetchAuthoredPrs,
  fetchOpenAuthoredPrs,
  loadMock: loadDashboard,
};

export async function buildDashboardResponse(
  env: Record<string, string | undefined>,
  now: Date,
  deps: Deps = DEFAULT_DEPS,
  selectedRepo: string | null = null,
): Promise<DashboardResponse> {
  const config: AppConfig = loadConfig(env);
  const degraded: string[] = [];

  let queueIssues: JiraIssue[] = [];
  let activeIssues: JiraIssue[] = [];
  let underwayIssues: JiraIssue[] = [];
  let underwayAvailable = false;
  let prs: GithubPr[] = [];
  let openPrs: OpenAuthoredPr[] = [];

  if (config.jira) {
    const mappedProject: string | undefined = selectedRepo
      ? config.repoProjectMap[selectedRepo]
      : undefined;
    const jira: JiraConfig = mappedProject
      ? { ...config.jira, project: mappedProject }
      : config.jira;
    await Promise.all([
      Promise.all([
        deps.fetchQueueIssues(jira),
        deps.fetchActiveIssues(jira),
      ]).then(([queue, active]) => {
        queueIssues = queue;
        activeIssues = active;
      }).catch(() => { degraded.push('jira'); }),
      deps.fetchMineOpenIssues?.(jira).then((issues) => {
        underwayIssues = issues;
        underwayAvailable = true;
      }).catch(() => { degraded.push('jira-underway'); }),
    ]);
  } else {
    degraded.push('jira');
  }

  if (config.github) {
    try {
      const configuredRepos: string[] = Array.from(
        new Set([...Object.keys(config.repoProjectMap), ...(config.github.repo ? [config.github.repo] : [])]),
      );
      [prs, openPrs] = await Promise.all([
        deps.fetchAuthoredPrs(config.github, configuredRepos),
        deps.fetchOpenAuthoredPrs(config.github, configuredRepos),
      ]);
    } catch {
      degraded.push('github');
    }
  } else {
    degraded.push('github');
  }

  const jiraDegraded: boolean = degraded.includes('jira');
  const githubDegraded: boolean = degraded.includes('github');

  const repos: string[] = Array.from(
    new Set([
      ...Object.keys(config.repoProjectMap),
      ...prs.map((pr) => pr.repo).filter((r): r is string => !!r),
    ]),
  ).sort();
  const scopedPrs: GithubPr[] = selectedRepo
    ? prs.filter((pr) => pr.repo === selectedRepo)
    : prs;
  const repoLabel: string = selectedRepo
    ? (selectedRepo.split('/').pop() ?? selectedRepo)
    : config.repoLabel;

  const snapshot: DashboardSnapshot = assembleSnapshot({
    queueIssues,
    activeIssues,
    prs: scopedPrs,
    openPrs,
    repo: repoLabel,
    now,
  });
  snapshot.underway = underwayIssues.map((issue) => issueToTicket(issue, repoLabel));
  snapshot.underwayAvailable = underwayAvailable;

  if (jiraDegraded || githubDegraded) {
    const mock: DashboardSnapshot = await deps.loadMock();
    if (jiraDegraded) {
      snapshot.queue = mock.queue;
      snapshot.steps = mock.steps;
      snapshot.stats = mock.stats;
      snapshot.throughput7d = mock.throughput7d;
    }
    if (githubDegraded) {
      snapshot.shipped = jiraDegraded ? mock.shipped : [];
      snapshot.myOpenPrs = jiraDegraded ? mock.myOpenPrs : [];
    }
    if (jiraDegraded && githubDegraded) {
      snapshot.activity = mock.activity;
    }
  }

  return { snapshot, degraded, repos, selectedRepo, jiraBaseUrl: config.jira?.baseUrl ?? null };
}
