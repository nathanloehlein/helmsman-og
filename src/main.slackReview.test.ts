import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from './main';
import { loadDashboard } from './data/mock';

const views: DashboardView[] = [];
const permalink = 'https://godaddy.slack.com/archives/C123/p1789730000000000';
const success = { ok: true, channel: 'airo-editing', mention: 'airo-editing-squad', permalink };
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status });

async function setup(post: (body: Record<string, unknown>) => Response | Promise<Response> = () => json(success), withRun = false, savedRequests: unknown[] = []) {
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
    if (url.pathname === '/api/config') return json({ config: {}, overridden: [] });
    if (url.pathname === '/api/slack/review-requests') return json({ requests: savedRequests });
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
  const receipt = { requestId: 'cf94674b-727a-4aa8-99ae-70cbccfa6dd8', repo: 'org/repo', prNumber: 42, status: 'sent',
    lastRequestedAt: '2026-09-18T12:00:00Z', lastSentAt: '2026-09-18T12:00:01Z', permalink, error: null };

  it('restores confirmed delivery history after reload and sends reminders only on an explicit click with a new ID', async () => {
    const { root, view, button, writes } = await setup(() => json({ ...success, sentAt: new Date().toISOString() }), false, [receipt]);
    expect(root.querySelector<HTMLTimeElement>('.slack-review-result time')?.dateTime).toBe(receipt.lastSentAt);
    expect(root.querySelector('.slack-review-result')?.textContent).toContain('Last requested');
    expect(root.querySelector<HTMLAnchorElement>('.slack-review-result a')?.href).toBe(permalink);
    expect(button().textContent).toBe('Request again in Slack');
    await view.refresh();
    expect(writes).toEqual([]);
    button().click();
    await vi.waitFor(() => expect(button().textContent).toBe('Inspection requested'));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.requestId).not.toBe(receipt.requestId);
    expect(button().disabled).toBe(true);
    expect(root.querySelector<HTMLTimeElement>('.slack-review-result time')?.dateTime).not.toBe(receipt.lastSentAt);
  });

  it.each(['pending', 'uncertain'])('preserves %s delivery across reload without enabling another send', async status => {
    const { root, view, button, writes } = await setup(() => json(success), false, [{ ...receipt, status }]);
    expect(button().disabled).toBe(true);
    expect(root.querySelector<HTMLTimeElement>('.slack-review-result time')?.dateTime).toBe(receipt.lastSentAt);
    expect(root.querySelector('.slack-review-result')?.textContent).toContain(status === 'pending' ? 'already in progress' : 'Delivery unconfirmed');
    await view.refresh();
    button().click();
    expect(writes).toEqual([]);
  });

  it('keeps unknown historical confirmation times explicit', async () => {
    const { root } = await setup(() => json(success), false, [{ ...receipt, lastSentAt: null }]);
    expect(root.querySelector('.slack-review-result')?.textContent).toContain('Request time unavailable');
    expect(root.querySelector('.slack-review-result time')).toBeNull();
  });

  it('accepts a later persisted confirmation when the local response had no timestamp', async () => {
    const saved: unknown[] = [];
    const { root, view, button, writes } = await setup(() => json(success), false, saved);
    button().click();
    await vi.waitFor(() => expect(button().disabled).toBe(true));
    await vi.waitFor(() => expect(button().textContent).toBe('Inspection requested'));
    saved.push({ ...receipt, requestId: writes[0]?.requestId, lastRequestedAt: new Date().toISOString() });
    await view.refresh();
    expect(root.querySelector<HTMLTimeElement>('.slack-review-result time')?.dateTime).toBe(receipt.lastSentAt);
    expect(button().textContent).toBe('Request again in Slack');
    expect(button().disabled).toBe(false);
  });

  it('ignores a delayed pending snapshot for an already confirmed request', async () => {
    const saved: unknown[] = [];
    const sentAt = new Date().toISOString();
    const { root, view, button, writes } = await setup(() => json({ ...success, sentAt }), false, saved);
    button().click();
    await vi.waitFor(() => expect(button().textContent).toBe('Inspection requested'));
    saved.push({ ...receipt, requestId: writes[0]?.requestId, status: 'pending',
      lastRequestedAt: new Date(Date.now() + 1000).toISOString(), lastSentAt: null, permalink: null });
    await view.refresh();
    expect(button().textContent).toBe('Inspection requested');
    expect(root.querySelector<HTMLTimeElement>('.slack-review-result time')?.dateTime).toBe(sentAt);
    expect(root.querySelector<HTMLAnchorElement>('.slack-review-result a')?.href).toBe(permalink);
  });

  it('retains the last successful timestamp and link during a failed repeat request', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const { root, button } = await setup(() => pending, false, [receipt]);
    button().click();
    expect(root.querySelector<HTMLTimeElement>('.slack-review-result time')?.dateTime).toBe(receipt.lastSentAt);
    expect(root.querySelector<HTMLAnchorElement>('.slack-review-result a')?.href).toBe(permalink);
    finish(json({ error: 'Browser disconnected', uncertain: false }, 409));
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(root.querySelector<HTMLTimeElement>('.slack-review-result time')?.dateTime).toBe(receipt.lastSentAt);
    expect(root.querySelector<HTMLAnchorElement>('.slack-review-result a')?.href).toBe(permalink);
  });

  it.each(['pending', 'uncertain'])('replaces local success with a newer %s receipt from another tab', async status => {
    const saved: unknown[] = [];
    const { root, view, button } = await setup(() => json({ ...success, sentAt: receipt.lastSentAt }), false, saved);
    button().click();
    await vi.waitFor(() => expect(button().textContent).toBe('Request again in Slack'));
    saved.push({ ...receipt, status, lastRequestedAt: new Date(Date.now() + 1000).toISOString() });
    await view.refresh();
    expect(button().disabled).toBe(true);
    expect(root.querySelector('.slack-review-result')?.textContent).toContain(status === 'pending' ? 'already in progress' : 'Delivery unconfirmed');
  });

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
      ? json({ error: 'Open #airo-editing in your signed-in Slack browser.' }, 409) : json(success));
    button().click();
    await vi.waitFor(() => expect(root.querySelector('.slack-review-result[role=alert]')?.textContent).toBe('Open #airo-editing in your signed-in Slack browser.'));
    expect(button().disabled).toBe(false);
    await view.refresh();
    expect(root.querySelector('.slack-review-result[role=alert]')?.textContent).toBe('Open #airo-editing in your signed-in Slack browser.');
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
      ? json({ error: 'Open your signed-in Slack browser first.', uncertain: false }, 409) : json(success));
    button().click();
    await vi.waitFor(() => expect(root.querySelector('.slack-review-result[role=alert]')?.textContent).toBe('Open your signed-in Slack browser first.'));
    button().click();
    await vi.waitFor(() => expect(button().textContent).toBe('Inspection requested'));
    expect(writes).toHaveLength(2);
    expect(writes[1]?.requestId).not.toBe(writes[0]?.requestId);
  });
});
