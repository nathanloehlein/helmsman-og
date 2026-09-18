import { describe, expect, it, vi } from 'vitest';
import { makeLiveJiraActions } from './jira-actions';
import type { JiraConfig } from '../config';

const config: JiraConfig = { baseUrl: 'https://jira.example.com', email: 'a@b.com', apiToken: 't', project: 'T', assignee: 'me', jql: null };

describe('live Jira actions', () => {
  it('disables already-created actions immediately', async () => {
    let current: JiraConfig | null = config;
    const fetcher = vi.fn<typeof fetch>();
    const actions = makeLiveJiraActions(() => current, fetcher);
    current = null;
    await actions.assign('T-1', 'bot');
    expect(await actions.transition('T-1', 'In Review')).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocks transition writes when Jira is disabled during the lookup', async () => {
    let current: JiraConfig | null = config;
    const fetcher = vi.fn<typeof fetch>(async () => {
      current = null;
      return Response.json({ transitions: [{ id: '1', name: 'Review', to: { name: 'In Review' } }] });
    });
    const actions = makeLiveJiraActions(() => current, fetcher);
    expect(await actions.transition('T-1', 'In Review')).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
