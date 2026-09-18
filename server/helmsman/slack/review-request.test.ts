import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PrStatus } from '../../github';
import { openSlackReviewRequester, publicSlackReviewSettings, slackReviewSettings } from './review-request';

const clients: ReturnType<typeof openSlackReviewRequester>[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const input = { repo: 'owner/repo', prNumber: 42, requestId: 'b3d6f43c-108c-4d3a-a760-c55a99e4c941' };
const secondId = 'b3d6f43c-108c-4d3a-a760-c55a99e4c942';
const channel = { id: 'C123', name: 'airo-editing' };
const group = { id: 'S123', handle: 'airo-editing-squad', date_delete: 0 };
const permalink = 'https://example.slack.com/archives/C123/p1234567890000123';

function fixture(options: { path?: string; env?: Record<string, string | undefined>; pr?: Partial<PrStatus>; replies?: Record<string, unknown>; now?: () => number } = {}) {
  const env = { SLACK_BOT_TOKEN: 'secret-test-token', ...options.env };
  const replies = {
    'conversations.list': { ok: true, channels: [channel] },
    'conversations.info': { ok: true, channel },
    'usergroups.list': { ok: true, usergroups: [group] },
    'chat.postMessage': { ok: true, channel: channel.id, ts: '1234567890.000123' },
    'chat.getPermalink': { ok: true, permalink },
    ...options.replies,
  } as Record<string, unknown>;
  const fetchMock = vi.fn<typeof fetch>(async (url) => {
    const method = new URL(String(url)).pathname.split('/').pop() ?? '';
    const reply = replies[method];
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  const getPr = vi.fn(async () => ({ isOwnPr: true, state: 'open', merged: false, ...options.pr }) as PrStatus);
  const client = openSlackReviewRequester(options.path ?? ':memory:', { settings: () => slackReviewSettings(env), getPr, fetch: fetchMock, now: options.now });
  clients.push(client);
  const posts = () => fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/chat.postMessage'));
  return { client, fetchMock, getPr, posts };
}

describe('Slack review requests', () => {
  it('defaults the destination and mention without exposing the token', () => {
    expect(publicSlackReviewSettings({ SLACK_BOT_TOKEN: 'secret' })).toEqual({ SLACK_REVIEW_CHANNEL: 'airo-editing', SLACK_REVIEW_MENTION: 'airo-editing-squad' });
    expect(slackReviewSettings({ SLACK_REVIEW_CHANNEL: '#another-channel', SLACK_REVIEW_MENTION: '@another-group' })).toMatchObject({ channel: 'another-channel', mention: 'another-group' });
  });

  it('resolves the exact user group and sends only the canonical authored PR URL', async () => {
    const { client, posts, fetchMock, getPr } = fixture();
    expect(await client.request({ ...input, text: '@channel malicious override', url: 'https://evil.invalid' }))
      .toEqual({ ok: true, channel: 'airo-editing', mention: 'airo-editing-squad', permalink });
    expect(getPr).toHaveBeenCalledWith(input.repo, input.prNumber);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({
      channel: 'C123', text: '<!subteam^S123|airo-editing-squad> Could you review this PR? https://github.com/owner/repo/pull/42',
      client_msg_id: input.requestId, unfurl_links: false, unfurl_media: false,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer secret-test-token' });
  });

  it('accepts channel and group IDs while retaining readable confirmation labels', async () => {
    const { client, fetchMock } = fixture({ env: { SLACK_REVIEW_CHANNEL: 'C123', SLACK_REVIEW_MENTION: 'S123' } });
    expect(await client.request(input)).toMatchObject({ channel: channel.name, mention: group.handle });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('conversations.info?channel=C123');
  });

  it.each([null, {}, { ...input, repo: '../../bad' }, { ...input, prNumber: '42' }, { ...input, requestId: 'not-a-uuid' }])('rejects malformed request %# without API calls', async (body) => {
    const { client, fetchMock } = fixture();
    await expect(client.request(body)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{ isOwnPr: false }, { state: 'closed' as const }, { merged: true }])('only posts for an owned open PR %#', async (pr) => {
    const { client, fetchMock } = fixture({ pr });
    await expect(client.request(input)).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports missing configuration before doing any work', async () => {
    const { client, fetchMock, getPr } = fixture({ env: { SLACK_BOT_TOKEN: '' } });
    await expect(client.request(input)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getPr).not.toHaveBeenCalled();
  });

  it('does not silently send plain text if the requested user group cannot be resolved', async () => {
    const { client, posts } = fixture({ replies: { 'usergroups.list': { ok: true, usergroups: [null, { id: 'S999', handle: 'someone-else' }] } } });
    await expect(client.request(input)).rejects.toThrow('user group was not found');
    expect(posts()).toHaveLength(0);
  });

  it('coalesces duplicate clicks and enforces a per-PR cooldown for new request IDs', async () => {
    const { client, posts } = fixture();
    const results = await Promise.all([client.request(input), client.request(input)]);
    expect(results[0]).toEqual(results[1]);
    expect(await client.request({ ...input, requestId: secondId })).toEqual(results[0]);
    expect(posts()).toHaveLength(1);
  });

  it('persists successful receipts across process restarts and rejects request ID reuse for another PR', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'helmsman-slack-review-'));
    directories.push(directory);
    const path = join(directory, 'state.sqlite');
    const first = fixture({ path });
    await first.client.request(input);
    const second = fixture({ path });
    expect(await second.client.request(input)).toMatchObject({ permalink });
    await expect(second.client.request({ ...input, prNumber: 43 })).rejects.toMatchObject({ status: 409 });
    expect(second.fetchMock).not.toHaveBeenCalled();
  });

  it('never automatically retries an ambiguous send and keeps the warning after reopening', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'helmsman-slack-uncertain-'));
    directories.push(directory);
    const path = join(directory, 'state.sqlite');
    const first = fixture({ path, replies: { 'chat.postMessage': new Error('Network timed out') } });
    await expect(first.client.request(input)).rejects.toMatchObject({ uncertain: true });
    const second = fixture({ path });
    await expect(second.client.request(input)).rejects.toMatchObject({ status: 409, uncertain: true });
    await expect(second.client.request({ ...input, requestId: secondId })).rejects.toMatchObject({ status: 409, uncertain: true });
    expect(first.posts()).toHaveLength(1);
    expect(second.fetchMock).not.toHaveBeenCalled();
  });

  it('reports definite Slack rejection with actionable permissions feedback', async () => {
    const { client, posts } = fixture({ replies: { 'chat.postMessage': { ok: false, error: 'missing_scope' } } });
    await expect(client.request(input)).rejects.toMatchObject({ uncertain: false, message: expect.stringContaining('missing_scope') });
    await expect(client.request(input)).rejects.toMatchObject({ uncertain: false });
    expect(posts()).toHaveLength(2);
  });

  it.each(['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout', 'unknown_new_error'])('locks ambiguous Slack application error %s against retries', async (error) => {
    const { client, posts } = fixture({ replies: { 'chat.postMessage': { ok: false, error } } });
    await expect(client.request(input)).rejects.toMatchObject({ uncertain: true });
    await expect(client.request(input)).rejects.toMatchObject({ status: 409, uncertain: true });
    expect(posts()).toHaveLength(1);
  });

  it.each([null, {}, { ok: true, channel: 'OTHER', ts: '123.456' }])('does not retry unverified Slack receipts %#', async (reply) => {
    const { client, posts } = fixture({ replies: { 'chat.postMessage': reply } });
    await expect(client.request(input)).rejects.toMatchObject({ uncertain: true });
    await expect(client.request(input)).rejects.toMatchObject({ status: 409, uncertain: true });
    expect(posts()).toHaveLength(1);
  });

  it('allows retrying a definitely failed request using the same ID after its cause is fixed', async () => {
    const { client, getPr, posts } = fixture({ pr: { isOwnPr: false } });
    await expect(client.request(input)).rejects.toMatchObject({ status: 409, uncertain: false });
    getPr.mockResolvedValue({ isOwnPr: true, state: 'open', merged: false } as PrStatus);
    expect(await client.request(input)).toMatchObject({ ok: true });
    expect(posts()).toHaveLength(1);
  });

  it('persists a cooldown-deduplicated request ID so late retries cannot send another message', async () => {
    let timestamp = 100_000;
    const { client, posts } = fixture({ now: () => timestamp });
    await client.request(input);
    await client.request({ ...input, requestId: secondId });
    timestamp += 120_000;
    expect(await client.request({ ...input, requestId: secondId })).toMatchObject({ ok: true });
    expect(posts()).toHaveLength(1);
  });

  it('keeps a confirmed send successful if permalink lookup fails', async () => {
    const { client, posts } = fixture({ replies: { 'chat.getPermalink': new Error('Lookup unavailable') } });
    expect(await client.request(input)).toMatchObject({ ok: true, permalink: null });
    expect(await client.request(input)).toMatchObject({ ok: true, permalink: null });
    expect(posts()).toHaveLength(1);
  });
});
