import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchIssueSummary } from './jira';
import type { JiraConfig } from './config';

const jira: JiraConfig = {
  baseUrl: 'https://example.atlassian.net',
  email: 'bot@example.com',
  apiToken: 'token',
  project: 'PROJ',
  assignee: 'bot',
  jql: null,
};

describe('fetchIssueSummary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the summary on a successful response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ fields: { summary: 'Hello' } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const summary: string | null = await fetchIssueSummary(jira, 'PROJ-1');

    expect(summary).toBe('Hello');
  });

  it('returns null on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      text: async () => 'not found',
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const summary: string | null = await fetchIssueSummary(jira, 'PROJ-1');

    expect(summary).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const summary: string | null = await fetchIssueSummary(jira, 'PROJ-1');

    expect(summary).toBeNull();
  });
});
