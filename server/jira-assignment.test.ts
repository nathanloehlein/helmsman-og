import { describe, expect, it, vi } from 'vitest';
import { assignIssueToCurrentUser } from './jira';
import type { JiraConfig } from './config';

const jira = { baseUrl: 'https://jira.example.com', email: 'me@example.com', apiToken: 'test', project: 'AB', assignee: 'someone-else' } as JiraConfig;

describe('assignIssueToCurrentUser', () => {
  it('uses the authenticated Jira account and verifies the assignment response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ accountId: 'my-id' }))).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await assignIssueToCurrentUser(jira, 'AB-1', fetcher);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://jira.example.com/rest/api/3/myself');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ accountId: 'my-id' }) });
  });
  it.each([null, {}, { accountId: 5 }, { accountId: '' }])('does not mutate when identity is invalid: %j', async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(assignIssueToCurrentUser(jira, 'AB-1', fetcher)).rejects.toThrow('account ID');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not report success on a rejected assignment', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ accountId: 'my-id' }))).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(assignIssueToCurrentUser(jira, 'AB-1', fetcher)).rejects.toThrow('403');
  });
});
