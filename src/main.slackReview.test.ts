import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';

const views: DashboardView[] = [];
const permalink = 'https://godaddy.slack.com/archives/C123/p1789730000000000';
const success = { ok: true, channel: 'airo-editing', mention: 'airo-editing-squad', permalink };
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status });

async function setup(post: (body: Record<string, unknown>) => Response | Promise<Response> = () => json(success), withRun = false) {
  window.history.replaceState(null, '', withRun ? '/prs?run=review-run' : '/prs');
  const snapshot = await loadDashboard();
  snapshot.myOpenPrs = [{ repo: 'org/repo', number: 42, title: 'Improve search', draft: false, reviewDecision: '', createdAt: '2026-09-18T12:00:00Z' }];
  const writes: Record<string, unknown>[] = [];
  const reads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), window.location.origin);
    if (init?.method === 'POST') {
      if (url.pathname !== '/api/slack/review-request') throw new Error(`Unexpected write ${url.pathname}`);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push(body);
      return post(body);
    }
    reads.push(url.pathname);
    if (url.pathname === '/api/context') return json({ repos: ['org/repo'], jiraBaseUrl: null });
    if (url.pathname === '/api/dashboard') return json({ snapshot, degraded: [], repos: ['org/repo'], selectedRepo: null, jiraBaseUrl: null });
    if (url.pathname === '/api/agents') return json({ runs: withRun ? [{
      id: 'review-run', ticketId: 'Review search', repo: 'org/repo', prNumber: 42, status: 'succeeded', attempt: 1,
      startedAt: '2026-09-18T12:00:00Z', costUsd: null,
    }] : [], autoClaim: [], caps: { maxAttempts: 1, maxCostUsd: null } });
    if (url.pathname === '/api/pr') return json({
      repo: 'org/repo', number: 42, state: 'open', isOwnPr: true, draft: false, merged: false, headRefName: 'search',
      reviewDecision: '', comments: 0, checks: { passed: 1, failed: 0, pending: 0 }, url: 'https://github.com/org/repo/pull/42',
    });
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [], slackTokenSet: true });
    if (url.pathname === '/api/slack') return json({ health: { enabled: false, status: 'disabled', channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: null }, notifications: [] });
    if (url.pathname === '/api/pr/review-requests' || url.pathname === '/api/pr/open') return json({ prs: [], degraded: false, truncated: false });
    return json({}, 404);
  }));
  const root = document.querySelector<HTMLElement>('#app')!;
  const view = new DashboardView(root);
  views.push(view);
  await view.start();
  const button = () => root.querySelector<HTMLButtonElement>('.pr-authored [data-slack-review-request]')!;
  expect(button()).not.toBeNull();
  return { root, view, writes, reads, button };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} });
});
afterEach(() => {
  views.splice(0).forEach(view => view.destroy());
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('Slack review requests from authored PRs', () => {
  it('preserves the successful Slack receipt when reopening a voyage drawer', async () => {
    const { root, writes } = await setup(() => json(success), true);
    const drawerButton = () => root.querySelector<HTMLButtonElement>('.run-drawer-pr [data-slack-review-request]');
    await vi.waitFor(() => expect(drawerButton()).not.toBeNull());
    drawerButton()!.click();
    await vi.waitFor(() => expect(drawerButton()?.textContent).toBe('Inspection requested'));
    const previous = drawerButton();
    root.querySelector<HTMLButtonElement>('.run-tab-select[data-tabid="review-run"]')!.click();
    await vi.waitFor(() => expect(drawerButton()).not.toBeNull());
    expect(drawerButton()).not.toBe(previous);
    expect(drawerButton()?.textContent).toBe('Inspection requested');
    expect(drawerButton()?.disabled).toBe(true);
    expect(root.querySelector<HTMLAnchorElement>('.run-drawer-pr .slack-review-result a')?.href).toBe(permalink);
    drawerButton()!.click();
    expect(writes).toHaveLength(1);
  });

  it('does not send on load or refresh and intercepts the explicit button before PR navigation', async () => {
    const { root, view, writes, reads, button } = await setup();
    await view.refresh();
    expect(writes).toEqual([]);
    button().click();
    await vi.waitFor(() => expect(button().textContent).toBe('Inspection requested'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ repo: 'org/repo', prNumber: 42 });
    expect(writes[0]?.requestId).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i);
    expect(reads).not.toContain('/api/pr');
    expect(window.location.pathname).toBe('/prs');
    expect(window.location.search).toBe('');
    expect(root.querySelector<HTMLAnchorElement>('.slack-review-result a')?.href).toBe(permalink);
  });

  it('deduplicates rapid clicks and preserves pending and success state through inbox refresh', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const { view, writes, button } = await setup(() => pending);
    button().click();
    button().click();
    expect(writes).toHaveLength(1);
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe('Sending…');
    await view.refresh();
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe('Sending…');
    button().click();
    expect(writes).toHaveLength(1);
    finish(json(success));
    await vi.waitFor(() => expect(button().textContent).toBe('Inspection requested'));
    await view.refresh();
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe('Inspection requested');
    button().click();
    expect(writes).toHaveLength(1);
  });

  it('shows actionable errors across polling and reuses the request ID on an explicit retry', async () => {
    let attempt = 0;
    const { root, view, writes, button } = await setup(() => ++attempt === 1
      ? json({ error: 'Invite the Slack bot to #airo-editing.' }, 409) : json(success));
    button().click();
    await vi.waitFor(() => expect(root.querySelector('.slack-review-result[role=alert]')?.textContent).toBe('Invite the Slack bot to #airo-editing.'));
    expect(button().disabled).toBe(false);
    await view.refresh();
    expect(root.querySelector('.slack-review-result[role=alert]')?.textContent).toBe('Invite the Slack bot to #airo-editing.');
    expect(writes).toHaveLength(1);
    button().click();
    await vi.waitFor(() => expect(button().textContent).toBe('Inspection requested'));
    expect(writes).toHaveLength(2);
    expect(writes[1]?.requestId).toBe(writes[0]?.requestId);
  });

  it('renders remote errors as plain text and never inserts unsafe permalink links', async () => {
    let attempt = 0;
    const payload = '<img src=x onerror="alert(1)">';
    const { root, button } = await setup(() => ++attempt === 1 ? json({ error: payload }, 400) : json({ ...success, permalink: 'javascript:alert(1)' }));
    button().click();
    await vi.waitFor(() => expect(root.querySelector('.slack-review-result')?.textContent).toBe(payload));
    expect(root.querySelector('.slack-review-result img')).toBeNull();
    button().click();
    await vi.waitFor(() => expect(button().textContent).toBe('Inspection requested'));
    expect(root.querySelector('.slack-review-result a')).toBeNull();
    expect(root.querySelector('.slack-review-result')?.textContent).toContain('Sent to #airo-editing');
  });

  it('uses a fresh request ID only after the server confirms nothing was sent', async () => {
    let attempt = 0;
    const { root, writes, button } = await setup(() => ++attempt === 1
      ? json({ error: 'Configure a bot token first.', uncertain: false }, 409) : json(success));
    button().click();
    await vi.waitFor(() => expect(root.querySelector('.slack-review-result[role=alert]')?.textContent).toBe('Configure a bot token first.'));
    button().click();
    await vi.waitFor(() => expect(button().textContent).toBe('Inspection requested'));
    expect(writes).toHaveLength(2);
    expect(writes[1]?.requestId).not.toBe(writes[0]?.requestId);
  });
});
