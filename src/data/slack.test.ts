import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSlack, markSlackNotificationRead, safePrUrl, safeSlackUrl } from './slack';

const item = {
  id: 'C123:123:org/repo#42', repo: 'org/repo', prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42',
  sourceUrl: 'https://company.slack.com/archives/C123/p123456789', author: 'Alex', channelName: 'airo-editing',
  status: 'launched', runId: 'run-42', createdAt: '2026-09-17T12:00:00Z', updatedAt: '2026-09-17T12:00:00Z', readAt: null, error: null,
};
const health = { enabled: true, status: 'healthy', channelName: 'airo-editing', intervalMs: 300_000, lastSuccessAt: null, error: null };
const voyage = {
  ...item, kind: 'voyage-completed', id: `voyage-${'a'.repeat(64)}`, title: 'Fix task switching',
  status: 'succeeded', sourceUrl: '/runs?run=run-42', channelName: 'Helmsman voyages', author: 'Helmsman',
};
const respond = (value: unknown) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
afterEach(() => vi.unstubAllGlobals());

describe('Slack notifications API', () => {
  it.each(['succeeded', 'failed', 'stopped'])('accepts completed voyages with %s status alongside review requests', async status => {
    const completed = { ...voyage, status, model: 'gpt-5.6-sol', effort: 'medium' };
    const withoutPr = { ...completed, id: 'voyage-without-pr', prNumber: null, prUrl: '' };
    const typedReview = { ...item, kind: 'review-request' };
    respond({ health, notifications: [item, typedReview, completed, withoutPr] });
    expect(await fetchSlack()).toEqual({ health, notifications: [item, typedReview, completed, withoutPr] });
  });

  it('rejects unsafe or malformed completed voyages without discarding valid notifications', async () => {
    const invalid = [
      { id: '<script>' }, { id: '../run-42' }, { id: '' }, { repo: 'org/..' }, { repo: 'org/repo/extra' },
      { runId: '../../escape' }, { runId: null }, { title: '' }, { title: null }, { title: '  ' },
      { sourceUrl: 'javascript:alert(1)' }, { sourceUrl: '//evil.test/runs?run=run-42' }, { sourceUrl: '/runs?run=other' },
      { status: 'running' }, { status: 'queued' }, { createdAt: 'invalid' }, { updatedAt: null }, { readAt: false },
      { prNumber: 0 }, { prNumber: 1.5 }, { prNumber: null }, { prNumber: undefined },
      { prUrl: 'javascript:alert(1)' }, { prUrl: 'https://github.com/other/repo/pull/42' },
      { error: 'unexpected' }, { model: {} }, { effort: [] }, { author: null }, { channelName: null },
      { kind: 'unknown-kind' },
    ].map(overrides => ({ ...voyage, ...overrides }));
    respond({ health, notifications: [voyage, ...invalid] });
    const parsed = await fetchSlack();
    expect(parsed?.notifications).toEqual([voyage]);
    expect(parsed?.health.status).toBe('partial');
  });

  it('preserves external task text as data while validating the completed-voyage envelope', async () => {
    const completed = { ...voyage, title: '<img src=x onerror=bad()>', model: '<script>bad()</script>' };
    respond({ health, notifications: [completed] });
    expect((await fetchSlack())?.notifications).toEqual([completed]);
  });

  it('retains valid notifications and reports partially malformed data', async () => {
    respond({ health, notifications: [null, item, { ...item, id: 'bad', prNumber: -1 }] });
    expect(await fetchSlack()).toEqual({ health: { ...health, status: 'partial', error: 'Some notifications could not be loaded.' }, notifications: [item] });
  });

  it('handles invalid payloads and network failures without breaking the dashboard', async () => {
    for (const payload of [null, {}, { health: null, notifications: [] }, { health: { ...health, intervalMs: 0 }, notifications: [] }]) {
      respond(payload);
      expect(await fetchSlack()).toBeNull();
    }
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchSlack()).toBeNull();
  });

  it('validates optional GitHub health and model routing while retaining the original contract', async () => {
    const githubHealth = { ...health, channelName: 'GitHub requested reviews' };
    const githubItem = { ...item, sourceUrl: item.prUrl, channelName: githubHealth.channelName, model: 'gpt-5.6-sol', effort: 'medium', complexity: 'low' };
    respond({ health, githubHealth, notifications: [githubItem] });
    expect(await fetchSlack()).toEqual({ health, githubHealth, notifications: [githubItem] });
    respond({ health, githubHealth: { ...githubHealth, enabled: 'true' }, notifications: [item] });
    expect(await fetchSlack()).toBeNull();
    respond({ health, notifications: [item, { ...githubItem, model: {} }, { ...githubItem, effort: [] }, { ...githubItem, complexity: 'extreme' }] });
    const parsed = await fetchSlack();
    expect(parsed?.notifications).toEqual([item]);
    expect(parsed?.health.status).toBe('partial');
  });

  it('encodes notification IDs and only acknowledges a confirmed persisted read', async () => {
    respond({ ok: true });
    expect(await markSlackNotificationRead(item.id)).toBe(true);
    expect(fetch).toHaveBeenCalledWith(`/api/slack/notifications/${encodeURIComponent(item.id)}/read`, expect.objectContaining({ method: 'POST' }));
    respond({ ok: false });
    expect(await markSlackNotificationRead(item.id)).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    expect(await markSlackNotificationRead(item.id)).toBe(false);
  });

  it('only links trusted Slack permalinks and the matching GitHub PR', () => {
    expect(safeSlackUrl(item.sourceUrl)).toBe(item.sourceUrl);
    for (const url of ['javascript:alert(1)', 'https://company.slack.com.evil.test/archives/C123/p123', 'https://evil.test/archives/C123/p123', 'https://user@company.slack.com/archives/C123/p123']) expect(safeSlackUrl(url)).toBeNull();
    expect(safePrUrl(item.prUrl, item.repo, 42)).toBe(item.prUrl);
    expect(safePrUrl(item.prUrl, 'other/repo', 42)).toBeNull();
    expect(safePrUrl('https://github.com.evil.test/org/repo/pull/42', item.repo, 42)).toBeNull();
  });
});
