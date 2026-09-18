import { afterEach, describe, expect, it, vi } from 'vitest';
import { getContext } from './context';

afterEach(() => vi.unstubAllGlobals());

describe('getContext', () => {
  it('reads local application metadata and normalizes duplicate repositories', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ repos: ['org/a', 'org/a'], jiraBaseUrl: 'https://jira.example.com' })));
    vi.stubGlobal('fetch', fetcher);
    expect(await getContext()).toEqual({ repos: ['org/a'], jiraBaseUrl: 'https://jira.example.com' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/context');
  });

  it.each([null, {}, { repos: [null], jiraBaseUrl: null }, { repos: ['../invalid'], jiraBaseUrl: null }, { repos: [], jiraBaseUrl: 1 }])('rejects malformed context for a safe bootstrap fallback', async data => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data))));
    expect(await getContext()).toBeNull();
  });

  it('allows an empty installation and no Jira configuration', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ repos: [], jiraBaseUrl: null }))));
    expect(await getContext()).toEqual({ repos: [], jiraBaseUrl: null });
  });

  it('handles unavailable endpoints and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockRejectedValueOnce(new Error('offline')));
    expect(await getContext()).toBeNull();
    expect(await getContext()).toBeNull();
  });
});
