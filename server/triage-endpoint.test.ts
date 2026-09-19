import { describe, expect, it, vi } from 'vitest';
import { buildTriageResponse } from './triage-endpoint';
import type { TriageGroups } from './jira';
import type { JiraConfig } from './config';
import type { JiraIssue } from './types';

const FULL_ENV = {
  JIRA_BASE_URL: 'https://x.atlassian.net', JIRA_EMAIL: 'a@b.com', JIRA_API_TOKEN: 't',
  JIRA_PROJECT: 'AIROBUILD', JIRA_ASSIGNEE: 'me',
  GITHUB_TOKEN: 'gh', GITHUB_REPO: 'o/r', GITHUB_PR_AUTHOR: 'bot',
  REPO_PROJECT_MAP: 'o/a=PROJA',
};

function issue(key: string, statusName: string, categoryKey: string): JiraIssue {
  return {
    key,
    fields: {
      summary: `${key} title`,
      status: { name: statusName, statusCategory: { key: categoryKey } },
      priority: { name: 'P2' },
      resolutiondate: null,
    },
  };
}

const OK_GROUPS: TriageGroups = {
  unassignedBacklog: [issue('B-1', 'Backlog', 'new')],
  unassignedTodo: [issue('T-1', 'To Do', 'new')],
  mineOpen: [issue('M-1', 'In Progress', 'indeterminate')],
};

const OK_DEPS = {
  fetchTriageGroups: async (): Promise<TriageGroups> => OK_GROUPS,
};

describe('buildTriageResponse', () => {
  it('maps each group of issues to tickets when Jira succeeds', async () => {
    const r = await buildTriageResponse(FULL_ENV, OK_DEPS, null);
    expect(r.degraded).toBe(false);
    expect(r.groups.unassignedBacklog.map((t) => t.id)).toEqual(['B-1']);
    expect(r.groups.unassignedTodo.map((t) => t.id)).toEqual(['T-1']);
    expect(r.groups.mineOpen.map((t) => t.id)).toEqual(['M-1']);
    expect(r.groups.mineOpen[0].status).toBe('in-progress');
    expect(r.jiraBaseUrl).toBe('https://x.atlassian.net');
  });

  it('re-scopes Jira to the mapped project for the selected repo', async () => {
    let seenProject = '';
    const r = await buildTriageResponse(FULL_ENV, {
      fetchTriageGroups: async (jira: JiraConfig): Promise<TriageGroups> => {
        seenProject = jira.project;
        return OK_GROUPS;
      },
    }, 'o/a');
    expect(seenProject).toBe('PROJA');
    expect(r.selectedRepo).toBe('o/a');
  });

  it('degrades to empty groups when Jira throws', async () => {
    const r = await buildTriageResponse(FULL_ENV, {
      fetchTriageGroups: async (): Promise<TriageGroups> => { throw new Error('boom'); },
    }, null);
    expect(r.degraded).toBe(true);
    expect(r.groups.unassignedBacklog).toEqual([]);
    expect(r.groups.mineOpen).toEqual([]);
  });

  it('does not fall back to the default project for an unmapped galleon', async () => {
    const fetchTriageGroups = vi.fn(OK_DEPS.fetchTriageGroups);
    const result = await buildTriageResponse(FULL_ENV, { fetchTriageGroups }, 'o/unmapped');
    expect(fetchTriageGroups).not.toHaveBeenCalled();
    expect(result.degraded).toBe(false);
    expect(result.groups).toEqual({ unassignedBacklog: [], unassignedTodo: [], mineOpen: [] });
  });

  it('matches galleons case-insensitively and filters every triage group by its mapped project', async () => {
    const rows = [issue('PROJA-1', 'To Do', 'new'), issue('OTHER-2', 'To Do', 'new')];
    const fetchTriageGroups = vi.fn(async (): Promise<TriageGroups> => ({ unassignedBacklog: rows, unassignedTodo: rows, mineOpen: rows }));
    const result = await buildTriageResponse({ ...FULL_ENV, JIRA_JQL: 'assignee = currentUser()' }, { fetchTriageGroups }, 'O/A');
    expect(fetchTriageGroups).toHaveBeenCalledWith(expect.objectContaining({ project: 'PROJA' }), expect.any(String), expect.any(String));
    for (const group of [result.groups.unassignedBacklog, result.groups.unassignedTodo, result.groups.mineOpen]) {
      expect(group.map(ticket => [ticket.id, ticket.repo])).toEqual([['PROJA-1', 'O/A']]);
    }
  });

  it('degrades with a null jiraBaseUrl when Jira is not configured', async () => {
    const r = await buildTriageResponse({}, OK_DEPS, null);
    expect(r.degraded).toBe(true);
    expect(r.jiraBaseUrl).toBeNull();
    expect(r.groups.unassignedTodo).toEqual([]);
  });
});
