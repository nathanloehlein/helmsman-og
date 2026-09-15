import type { AppConfig, JiraConfig } from './config';
import { loadConfig, buildCreatedSinceJql, buildResolvedSinceJql, buildPastSlaJql, buildOpenBugsJql } from './config';
import type { BugIssue } from './jira';
import { fetchApproxCount, fetchOpenBugs, fetchOldestOpenBug, fetchResolvedDurations } from './jira';
import { assembleCard, slaLabel } from '../src/logic/bugMetrics';
import type { BugCard, BugRow, BugsResponse } from '../src/types';

export interface BugsDeps {
  fetchApproxCount: (jira: JiraConfig, jql: string) => Promise<number>;
  fetchOpenBugs: (jira: JiraConfig, project: string) => Promise<BugIssue[]>;
  fetchOldestOpenBug: (jira: JiraConfig, project: string) => Promise<{ key: string; created: string } | null>;
  fetchResolvedDurations: (jira: JiraConfig, project: string, days: number) => Promise<number[]>;
}

const DEFAULT_DEPS: BugsDeps = { fetchApproxCount, fetchOpenBugs, fetchOldestOpenBug, fetchResolvedDurations };

function toRow(issue: BugIssue, now: Date): BugRow {
  return {
    key: issue.key,
    title: issue.fields.summary,
    priority: issue.fields.priority?.name ?? '—',
    severity: issue.fields.customfield_14808?.value ?? '—',
    sla: slaLabel(issue.fields.duedate, now),
  };
}

function windowLabel(now: Date, startOffset: number, endOffset: number): string {
  const day = 86_400_000;
  const fmt = (t: number): string => new Date(t).toISOString().slice(0, 10);
  return `${fmt(now.getTime() - startOffset * day)} → ${fmt(now.getTime() - endOffset * day)}`;
}

async function buildCard(
  deps: BugsDeps, jira: JiraConfig, project: string, repo: string | null, label: string, now: Date, jiraBaseUrl: string,
): Promise<BugCard> {
  const [open, createdLast7d, completedLast7d, pastSla, issues, oldest, durations, durationsTotal] = await Promise.all([
    deps.fetchApproxCount(jira, buildOpenBugsJql(project).replace(/ ORDER BY .*/, '')),
    deps.fetchApproxCount(jira, buildCreatedSinceJql(project, 7)),
    deps.fetchApproxCount(jira, buildResolvedSinceJql(project, 7)),
    deps.fetchApproxCount(jira, buildPastSlaJql(project)),
    deps.fetchOpenBugs(jira, project),
    deps.fetchOldestOpenBug(jira, project),
    deps.fetchResolvedDurations(jira, project, 90),
    deps.fetchApproxCount(jira, buildResolvedSinceJql(project, 90)),
  ]);
  return assembleCard({
    project, repo, label, jiraBaseUrl, now,
    open, createdLast7d, completedLast7d, pastSla,
    oldestKey: oldest?.key ?? null, oldestCreated: oldest?.created ?? null,
    rows: issues.map((i) => toRow(i, now)),
    durations, durationsTotal,
  });
}

function emptyCard(project: string, repo: string | null, label: string, jiraBaseUrl: string): BugCard {
  return {
    project, repo, label, open: 0, delta: 0, completed: 0, pastSla: 0,
    oldest: null, p75: { days: null, n: 0, capped: false }, rows: [],
    degraded: true, jiraBaseUrl,
  };
}

export async function buildBugsResponse(
  env: Record<string, string | undefined>,
  now: Date,
  deps: BugsDeps = DEFAULT_DEPS,
  selectedRepo: string | null = null,
): Promise<BugsResponse> {
  const config: AppConfig = loadConfig(env);
  const generatedAt: string = now.toISOString();
  const latestWindow: string = windowLabel(now, 6, 0);
  const previousWindow: string = windowLabel(now, 13, 7);

  if (!config.jira) {
    return { cards: [], degraded: true, generatedAt, latestWindow, previousWindow };
  }
  const jiraBaseUrl: string = config.jira.baseUrl;

  const entries: [string, string][] = Object.entries(config.repoProjectMap);
  const targets: [string | null, string][] = entries.length
    ? entries.filter(([repo]) => !selectedRepo || repo === selectedRepo).map(([repo, project]) => [repo, project])
    : [[null, config.jira.project]];

  const cards: BugCard[] = await Promise.all(
    targets.map(async ([repo, project]): Promise<BugCard> => {
      const label: string = repo ? (repo.split('/').pop() ?? repo) : config.repoLabel;
      const jira: JiraConfig = { ...config.jira!, project };
      try {
        return await buildCard(deps, jira, project, repo, label, now, jiraBaseUrl);
      } catch {
        return emptyCard(project, repo, label, jiraBaseUrl);
      }
    }),
  );

  return { cards, degraded: false, generatedAt, latestWindow, previousWindow };
}
