import { describe, expect, it, vi } from 'vitest';
import type { JiraConfig } from '../config';
import { makeJiraActions, type JiraActions } from './jira-actions';

function jiraConfig(): JiraConfig {
  return {
    baseUrl: 'https://example.atlassian.net',
    email: 'bot@example.com',
    apiToken: 'token123',
    project: 'AIROBUILD',
    assignee: 'currentUser()',
    jql: null,
  };
}

function jsonResponse(body: unknown, ok: boolean = true, status: number = 200): Response {
  return {
    ok,
    status,
    json: async (): Promise<unknown> => body,
    text: async (): Promise<string> => JSON.stringify(body),
  } as Response;
}

const TRANSITIONS_BODY: { transitions: Array<{ id: string; name: string; to: { name: string } }> } = {
  transitions: [
    { id: '11', name: 'Start Progress', to: { name: 'In Progress' } },
    { id: '21', name: 'Send to review', to: { name: 'In Review' } },
    { id: '31', name: 'Mark done', to: { name: 'Done' } },
  ],
};

describe('makeJiraActions', () => {
  describe('assign', () => {
    it('PUTs the assignee with Basic auth', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
      const actions: JiraActions = makeJiraActions(jiraConfig(), fetchImpl);

      await actions.assign('AIROBUILD-1', 'acc-123');

      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init]: [string | URL, RequestInit] = fetchImpl.mock.calls[0] as [string | URL, RequestInit];
      expect(String(url)).toBe('https://example.atlassian.net/rest/api/3/issue/AIROBUILD-1/assignee');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ accountId: 'acc-123' }));
      const headers: Record<string, string> = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Basic ${Buffer.from('bot@example.com:token123').toString('base64')}`);
      expect(headers.Accept).toBe('application/json');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('resolves without throwing on a network error', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));
      const actions: JiraActions = makeJiraActions(jiraConfig(), fetchImpl);

      await expect(actions.assign('AIROBUILD-1', 'acc-123')).resolves.toBeUndefined();
    });

    it('resolves without throwing on a non-2xx response', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, false, 500));
      const actions: JiraActions = makeJiraActions(jiraConfig(), fetchImpl);

      await expect(actions.assign('AIROBUILD-1', 'acc-123')).resolves.toBeUndefined();
    });
  });

  describe('transition', () => {
    it('looks up the transition id for the target status and POSTs it', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(TRANSITIONS_BODY))
        .mockResolvedValueOnce(jsonResponse({}));
      const actions: JiraActions = makeJiraActions(jiraConfig(), fetchImpl);

      const result: boolean = await actions.transition('AIROBUILD-1', 'in review');

      expect(result).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      const [getUrl, getInit]: [string | URL, RequestInit] = fetchImpl.mock.calls[0] as [string | URL, RequestInit];
      expect(String(getUrl)).toBe('https://example.atlassian.net/rest/api/3/issue/AIROBUILD-1/transitions');
      expect(getInit.method).toBeUndefined();
      const getHeaders: Record<string, string> = getInit.headers as Record<string, string>;
      expect(getHeaders.Authorization).toBe(`Basic ${Buffer.from('bot@example.com:token123').toString('base64')}`);

      const [postUrl, postInit]: [string | URL, RequestInit] = fetchImpl.mock.calls[1] as [string | URL, RequestInit];
      expect(String(postUrl)).toBe('https://example.atlassian.net/rest/api/3/issue/AIROBUILD-1/transitions');
      expect(postInit.method).toBe('POST');
      expect(postInit.body).toBe(JSON.stringify({ transition: { id: '21' } }));
    });

    it('returns false when the target status is not offered', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(TRANSITIONS_BODY));
      const actions: JiraActions = makeJiraActions(jiraConfig(), fetchImpl);

      const result: boolean = await actions.transition('AIROBUILD-1', 'Blocked');

      expect(result).toBe(false);
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('returns false without throwing when the transitions fetch is a 500', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({}, false, 500));
      const actions: JiraActions = makeJiraActions(jiraConfig(), fetchImpl);

      await expect(actions.transition('AIROBUILD-1', 'In Review')).resolves.toBe(false);
    });

    it('returns false without throwing when the POST transition is a 500', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(TRANSITIONS_BODY))
        .mockResolvedValueOnce(jsonResponse({}, false, 500));
      const actions: JiraActions = makeJiraActions(jiraConfig(), fetchImpl);

      await expect(actions.transition('AIROBUILD-1', 'In Review')).resolves.toBe(false);
    });

    it('returns false without throwing on a network error', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));
      const actions: JiraActions = makeJiraActions(jiraConfig(), fetchImpl);

      await expect(actions.transition('AIROBUILD-1', 'In Review')).resolves.toBe(false);
    });
  });
});
