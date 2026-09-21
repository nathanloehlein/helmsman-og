import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSlackReviewRequests, requestSlackReview, SlackReviewRequestError } from './slackReview';

const requestId = 'cf94674b-727a-4aa8-99ae-70cbccfa6dd8';
const permalink = 'https://godaddy.slack.com/archives/C123/p1789730000000000';
const result = { ok: true, channel: 'airo-editing', mention: 'airo-editing-squad', permalink };
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status });
afterEach(() => vi.unstubAllGlobals());

describe('Slack review request client', () => {
  const state = { requestId, repo: 'org/repo', prNumber: 42, status: 'sent', lastRequestedAt: '2026-09-21T12:00:00Z',
    lastSentAt: '2026-09-21T12:00:01Z', permalink, error: null };

  it('loads persisted request state for the selected galleon without sending', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ requests: [state] }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchSlackReviewRequests('org/repo')).toEqual([state]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/slack/review-requests?repo=org%2Frepo', { signal: expect.any(AbortSignal) });
  });

  it.each([null, {}, { requests: [null] }, { requests: [{ ...state, repo: 'other/repo' }] },
    { requests: [{ ...state, lastSentAt: 'invalid' }] }, { requests: [{ ...state, status: 'delivered' }] }])('rejects invalid or out-of-scope history %#', async payload => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(payload)));
    expect(await fetchSlackReviewRequests('org/repo')).toBeNull();
  });

  it('keeps legacy unknown timestamps and unresolved delivery state without unsafe links', async () => {
    const value = { ...state, status: 'uncertain', lastSentAt: null, permalink: 'javascript:alert(1)' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ requests: [value] })));
    expect(await fetchSlackReviewRequests()).toEqual([{ ...value, permalink: null }]);
  });

  it('distinguishes unavailable history from an empty journal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchSlackReviewRequests()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ requests: [] })));
    expect(await fetchSlackReviewRequests()).toEqual([]);
  });

  it('returns the confirmed send timestamp for immediate rendering', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...result, sentAt: state.lastSentAt })));
    expect(await requestSlackReview('org/repo', 42, requestId)).toMatchObject({ sentAt: state.lastSentAt });
  });
  it('sends only the selected PR and stable idempotency key to the server', async () => {
    const fetch = vi.fn().mockResolvedValue(json(result));
    vi.stubGlobal('fetch', fetch);
    expect(await requestSlackReview('org/repo', 42, requestId)).toEqual({ channel: 'airo-editing', mention: 'airo-editing-squad', permalink });
    expect(fetch).toHaveBeenCalledWith('/api/slack/review-request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'org/repo', prNumber: 42, requestId }),
    });
  });

  it('preserves actionable server errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'Open #airo-editing in your signed-in Slack browser.' }, 409)));
    await expect(requestSlackReview('org/repo', 42, requestId)).rejects.toThrow('Open #airo-editing in your signed-in Slack browser.');
  });

  it.each([[undefined, true], [true, true], [false, false]])('preserves server delivery certainty (%s)', async (uncertain, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'Request failed.', uncertain }, 409)));
    const error = await requestSlackReview('org/repo', 42, requestId).catch(error => error as unknown);
    expect(error).toBeInstanceOf(SlackReviewRequestError);
    expect(error).toMatchObject({ uncertain: expected });
  });

  it.each([null, {}, { ok: false }, { ...result, channel: null }, { ...result, mention: 42 }])('rejects incomplete success responses without claiming a send was confirmed', async data => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(data)));
    await expect(requestSlackReview('org/repo', 42, requestId)).rejects.toThrow('Check the channel before retrying');
  });

  it.each(['javascript:alert(1)', 'https://evil.example/archives/C123/p123', 'https://slack.com.evil.example/archives/C123/p123', 'https://user:pass@godaddy.slack.com/archives/C123/p123'])('removes unsafe message permalinks: %s', async unsafe => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...result, permalink: unsafe })));
    expect((await requestSlackReview('org/repo', 42, requestId)).permalink).toBeNull();
  });

  it('never automatically retries an uncertain network failure', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('Connection closed'));
    vi.stubGlobal('fetch', fetch);
    await expect(requestSlackReview('org/repo', 42, requestId)).rejects.toThrow('Connection closed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
