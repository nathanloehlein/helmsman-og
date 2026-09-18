import type { Todo } from '../src/data/todos';
import type { Ticket } from '../src/types';
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
  jiraEnabled: boolean;
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
  todos: Todo[] = [],
): Promise<DashboardResponse> {
  const config: AppConfig = loadConfig(env);
  const degraded: string[] = [];

  let queueIssues: JiraIssue[] = [];
  let activeIssues: JiraIssue[] = [];
  let underwayIssues: JiraIssue[] = [];
  let underwayAvailable = false;
  let prs: GithubPr[] = [];
  let openPrs: OpenAuthoredPr[] = [];
  const mappedProject = selectedRepo
    ? Object.entries(config.repoProjectMap).find(([repo]) => repo.toLowerCase() === selectedRepo.toLowerCase())?.[1]
    : undefined;
  const selectedProject = selectedRepo ? mappedProject : config.jira?.project;

  if (config.jira && selectedProject) {
    const jira: JiraConfig = { ...config.jira, project: selectedProject };
    const scopedIssues = (issues: JiraIssue[]) => selectedRepo
      ? issues.filter(issue => typeof issue?.key === 'string' && issue.key.toLowerCase().startsWith(`${selectedProject.toLowerCase()}-`))
      : issues;
    await Promise.all([
      Promise.all([
        deps.fetchQueueIssues(jira),
        deps.fetchActiveIssues(jira),
      ]).then(([queue, active]) => {
        queueIssues = scopedIssues(queue);
        activeIssues = scopedIssues(active);
      }).catch(() => { degraded.push('jira'); }),
      deps.fetchMineOpenIssues?.(jira).then((issues) => {
        underwayIssues = scopedIssues(issues);
        underwayAvailable = true;
      }).catch(() => { degraded.push('jira-underway'); }),
    ]);
  } else if (config.jira && selectedRepo) {
    underwayAvailable = true;
  } else if (config.jiraEnabled) {
    degraded.push('jira');
  }

  if (config.github) {
    try {
      const configuredRepos: string[] = Array.from(
        new Set([...Object.keys(config.repoProjectMap), ...(config.github.repo ? [config.github.repo] : []), ...(!config.jiraEnabled ? todos.map(todo => todo.repo) : [])]),
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
      ...(!config.jiraEnabled && config.github?.repo ? [config.github.repo] : []),
      ...(!config.jiraEnabled ? todos.map(todo => todo.repo) : []),
      ...prs.map((pr) => pr.repo).filter((r): r is string => !!r),
    ]),
  ).sort();
  const scopedPrs: GithubPr[] = selectedRepo
    ? prs.filter((pr) => pr.repo?.toLowerCase() === selectedRepo.toLowerCase())
    : prs;
  const scopedOpenPrs = selectedRepo
    ? openPrs.filter((pr) => pr.repo?.toLowerCase() === selectedRepo.toLowerCase())
    : openPrs;
  const repoLabel: string = selectedRepo
    ? selectedRepo
    : config.repoLabel;

  const snapshot: DashboardSnapshot = assembleSnapshot({
    queueIssues,
    activeIssues,
    prs: scopedPrs,
    openPrs: scopedOpenPrs,
    repo: repoLabel,
    now,
  });
  snapshot.underway = underwayIssues.map((issue) => issueToTicket(issue, repoLabel));
  snapshot.underwayAvailable = underwayAvailable;

  if (config.jiraEnabled && !selectedRepo && (jiraDegraded || githubDegraded)) {
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

  if (!config.jiraEnabled) {
    const scoped = todos.filter(todo => !selectedRepo || todo.repo === selectedRepo);
    const ticket = (todo: Todo): Ticket => ({
      id: todo.id, title: todo.title, repo: todo.repo, priority: todo.priority, updatedAt: todo.updatedAt,
      status: todo.state === 'in_progress' ? 'in-progress' : todo.state === 'in_review' ? 'in-review' : todo.state === 'done' ? 'done' : 'backlog',
    });
    snapshot.queue = scoped.filter(todo => todo.state === 'todo' && todo.description.trim()).map(ticket);
    snapshot.underway = scoped.filter(todo => todo.state === 'in_progress' || todo.state === 'in_review').map(ticket);
    snapshot.underwayAvailable = true;
    snapshot.steps = [];
    snapshot.stats = {
      completedToday: scoped.filter(todo => todo.state === 'done' && todo.completedAt?.slice(0, 10) === now.toISOString().slice(0, 10)).length,
      awaitingReview: scoped.filter(todo => todo.state === 'in_review').length,
      avgCycleMinutes: 0,
    };
    snapshot.throughput7d = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(now.getTime() - (6 - index) * 86_400_000).toISOString().slice(0, 10);
      return scoped.filter(todo => todo.state === 'done' && todo.completedAt?.slice(0, 10) === day).length;
    });
  }
  return { snapshot, degraded, repos, selectedRepo, jiraBaseUrl: config.jira?.baseUrl ?? null, jiraEnabled: config.jiraEnabled };
}
