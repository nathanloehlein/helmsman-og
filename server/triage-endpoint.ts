import type { Ticket } from '../src/types';
import type { AppConfig, JiraConfig } from './config';
import { loadConfig } from './config';
import type { TriageGroups } from './jira';
import { fetchTriageGroups } from './jira';
import { issueToTicket } from './snapshot';
import type { JiraIssue } from './types';

export interface TriageGroupsView {
  unassignedBacklog: Ticket[];
  unassignedTodo: Ticket[];
  mineOpen: Ticket[];
}

export interface TriageResponse {
  groups: TriageGroupsView;
  degraded: boolean;
  selectedRepo: string | null;
  jiraBaseUrl: string | null;
}

export interface TriageDeps {
  fetchTriageGroups: (jira: JiraConfig, statusBacklog: string, statusTodo: string) => Promise<TriageGroups>;
}

const DEFAULT_DEPS: TriageDeps = { fetchTriageGroups };

const EMPTY_GROUPS: TriageGroupsView = { unassignedBacklog: [], unassignedTodo: [], mineOpen: [] };

export async function buildTriageResponse(
  env: Record<string, string | undefined>,
  deps: TriageDeps = DEFAULT_DEPS,
  selectedRepo: string | null = null,
): Promise<TriageResponse> {
  const config: AppConfig = loadConfig(env);

  if (!config.jira) {
    return { groups: EMPTY_GROUPS, degraded: true, selectedRepo, jiraBaseUrl: null };
  }

  const mappedProject: string | undefined = selectedRepo
    ? Object.entries(config.repoProjectMap).find(([repo]) => repo.toLowerCase() === selectedRepo.toLowerCase())?.[1]
    : undefined;
  if (selectedRepo && !mappedProject) {
    return { groups: EMPTY_GROUPS, degraded: false, selectedRepo, jiraBaseUrl: config.jira.baseUrl };
  }
  const jira: JiraConfig = mappedProject
    ? { ...config.jira, project: mappedProject }
    : config.jira;
  const repoLabel: string = selectedRepo ?? config.repoLabel;
  const tickets = (issues: JiraIssue[]): Ticket[] => issues
    .filter(issue => !selectedRepo || (typeof issue?.key === 'string' && issue.key.toLowerCase().startsWith(`${jira.project.toLowerCase()}-`)))
    .map(issue => issueToTicket(issue, repoLabel));

  try {
    const groups: TriageGroups = await deps.fetchTriageGroups(
      jira,
      config.statusBacklog,
      config.statusTodo,
    );
    return {
      groups: {
        unassignedBacklog: tickets(groups.unassignedBacklog),
        unassignedTodo: tickets(groups.unassignedTodo),
        mineOpen: tickets(groups.mineOpen),
      },
      degraded: false,
      selectedRepo,
      jiraBaseUrl: config.jira.baseUrl,
    };
  } catch {
    return { groups: EMPTY_GROUPS, degraded: true, selectedRepo, jiraBaseUrl: config.jira.baseUrl };
  }
}
