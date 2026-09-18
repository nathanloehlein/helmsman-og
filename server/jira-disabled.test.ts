import { expect, it, vi } from 'vitest';
import { buildTriageResponse } from './triage-endpoint';
import { buildBugsResponse } from './bugs-endpoint';

it('does not read Jira on direct triage or bugs requests while disabled', async () => {
  const env = { JIRA_ENABLED: 'false', JIRA_BASE_URL: 'https://jira.example.com', JIRA_EMAIL: 'a@b.com', JIRA_API_TOKEN: 'token' };
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('Jira is disabled'); });
  const triage = await buildTriageResponse(env, { fetchTriageGroups: forbidden });
  const bugs = await buildBugsResponse(env, new Date(), { verifyAuth: forbidden, fetchApproxCount: forbidden, fetchOpenBugs: forbidden, fetchOldestOpenBug: forbidden, fetchResolvedDurations: forbidden });
  expect(triage.groups).toEqual({ unassignedBacklog: [], unassignedTodo: [], mineOpen: [] });
  expect(bugs.cards).toEqual([]);
  expect(forbidden).not.toHaveBeenCalled();
});
