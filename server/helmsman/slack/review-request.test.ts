import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { PrStatus } from '../../github';
import { openSlackReviewRequester, publicSlackReviewSettings, slackReviewSettings, SlackReviewError } from './review-request';

const clients: ReturnType<typeof openSlackReviewRequester>[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const input = { repo: 'owner/repo', prNumber: 42, requestId: 'b3d6f43c-108c-4d3a-a760-c55a99e4c941' };
const secondId = 'b3d6f43c-108c-4d3a-a760-c55a99e4c942';
const permalink = 'https://example.slack.com/archives/C123/p1234567890000123';
const receipt = { channel: 'airo-editing', mention: 'airo-editing-squad', permalink };
type Send = Parameters<typeof openSlackReviewRequester>[1]['send'];

function fixture(options: { path?: string; env?: Record<string, string | undefined>; pr?: Partial<PrStatus>; now?: () => number } = {}) {
  const send = vi.fn<Send>().mockResolvedValue(receipt);
  const getPr = vi.fn(async () => ({ isOwnPr: true, state: 'open', merged: false, ...options.pr }) as PrStatus);
  const client = openSlackReviewRequester(options.path ?? ':memory:', { settings: () => slackReviewSettings(options.env ?? {}), getPr, send, now: options.now });
  clients.push(client);
  return { client, send, getPr };
}

function persistentPath() {
  const directory = mkdtempSync(join(tmpdir(), 'helmsman-slack-review-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

function close(client: ReturnType<typeof openSlackReviewRequester>) {
  client.close();
  clients.splice(clients.indexOf(client), 1);
}

describe('Slack review requests', () => {
  it('preserves the confirmed send time across cooldown aliases and restarts with scoped read-only history', async () => {
    const path = persistentPath();
    let timestamp = 100_000;
    const first = fixture({ path, now: () => timestamp });
    first.send.mockImplementationOnce(async () => { timestamp = 110_000; return receipt; });
    expect(await first.client.request(input)).toMatchObject({ sentAt: new Date(110_000).toISOString() });
    timestamp = 120_000;
    expect(await first.client.request({ ...input, requestId: secondId })).toMatchObject({ sentAt: new Date(110_000).toISOString() });
    expect(first.send).toHaveBeenCalledTimes(1);
    close(first.client);
    const reopened = fixture({ path });
    const expected = [{ requestId: secondId, repo: input.repo, prNumber: input.prNumber, status: 'sent',
      lastRequestedAt: new Date(120_000).toISOString(), lastSentAt: new Date(110_000).toISOString(), permalink, error: null }];
    expect(reopened.client.list('OWNER/REPO')).toEqual(expected);
    expect(reopened.client.list(null)).toEqual(expected);
    expect(reopened.client.list('another/repo')).toEqual([]);
    expect(() => reopened.client.list('../bad')).toThrow('owner/name');
    expect(reopened.send).not.toHaveBeenCalled();
    expect(reopened.getPr).not.toHaveBeenCalled();
  });

  it('retains the last confirmed delivery while a newer request is pending or uncertain', async () => {
    let timestamp = 100_000;
    const { client, send } = fixture({ now: () => timestamp });
    await client.request(input);
    timestamp = 200_000;
    let fail!: (error: Error) => void;
    send.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const pending = client.request({ ...input, requestId: secondId });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(client.list(input.repo)).toMatchObject([{ requestId: secondId, status: 'pending', lastSentAt: new Date(100_000).toISOString(), permalink }]);
    const failure = expect(pending).rejects.toMatchObject({ uncertain: true });
    fail(new Error('private transport details'));
    await failure;
    expect(client.list(input.repo)).toMatchObject([{ requestId: secondId, status: 'uncertain', lastSentAt: new Date(100_000).toISOString(), permalink, error: null }]);
    expect(JSON.stringify(client.list(input.repo))).not.toContain('private');
  });

  it('migrates old receipts without inventing a confirmed send timestamp', () => {
    const path = persistentPath();
    const sql = new Database(path);
    sql.exec(`CREATE TABLE slack_review_requests (requestId TEXT PRIMARY KEY, repo TEXT NOT NULL, prNumber INTEGER NOT NULL,
      channelTarget TEXT NOT NULL, mentionTarget TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL,
      channel TEXT, mention TEXT, permalink TEXT)`);
    sql.prepare('INSERT INTO slack_review_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.requestId, input.repo, input.prNumber, receipt.channel, receipt.mention, 'sent', 100_000, receipt.channel, receipt.mention, permalink);
    sql.close();
    const { client, send } = fixture({ path });
    expect(client.list(input.repo)).toMatchObject([{ status: 'sent', lastRequestedAt: new Date(100_000).toISOString(), lastSentAt: null, permalink }]);
    expect(send).not.toHaveBeenCalled();
  });

  it('selects the latest confirmation from historical receipts completed out of request order', async () => {
    const path = persistentPath();
    let timestamp = 100_000;
    const { client } = fixture({ path, now: () => timestamp });
    await client.request(input);
    timestamp = 200_000;
    await client.request({ ...input, requestId: secondId });
    const sql = new Database(path);
    sql.prepare('UPDATE slack_review_requests SET sentAt = ? WHERE requestId = ?').run(300_000, input.requestId);
    sql.close();
    expect(client.list(input.repo)).toMatchObject([{ requestId: secondId, lastRequestedAt: new Date(200_000).toISOString(),
      lastSentAt: new Date(300_000).toISOString() }]);
  });

  it('defaults and normalizes destinations without requiring or retaining a token', () => {
    expect(slackReviewSettings({ SLACK_BOT_TOKEN: 'secret' })).toEqual({ enabled: true, channel: 'airo-editing', mention: 'airo-editing-squad' });
    expect(publicSlackReviewSettings({ SLACK_BOT_TOKEN: 'secret' })).toEqual({ SLACK_REVIEW_CHANNEL: 'airo-editing', SLACK_REVIEW_MENTION: 'airo-editing-squad' });
    expect(slackReviewSettings({ SLACK_REVIEW_CHANNEL: ' #another-channel ', SLACK_REVIEW_MENTION: ' @another-group ' })).toEqual({ enabled: true, channel: 'another-channel', mention: 'another-group' });
  });

  it('sends without a token and passes only canonical PR identifiers and configured destinations', async () => {
    const { client, send, getPr } = fixture();
    expect(await client.request({ ...input, text: '@channel malicious override', url: 'https://evil.invalid' }))
      .toMatchObject({ ok: true, ...receipt });
    expect(getPr).toHaveBeenCalledWith(input.repo, input.prNumber);
    expect(send).toHaveBeenCalledExactlyOnceWith({ ...input, channel: receipt.channel, mention: receipt.mention });
  });

  it('accepts channel IDs while retaining readable confirmation labels', async () => {
    const { client, send } = fixture({ env: { SLACK_REVIEW_CHANNEL: 'C123' } });
    expect(await client.request(input)).toMatchObject({ ok: true, ...receipt });
    expect(send).toHaveBeenCalledExactlyOnceWith({ ...input, channel: 'C123', mention: receipt.mention });
  });

  it.each([null, {}, { ...input, repo: '../../bad' }, { ...input, prNumber: '42' }, { ...input, requestId: 'not-a-uuid' }])('rejects malformed request %# without external calls', async (body) => {
    const { client, send, getPr } = fixture();
    await expect(client.request(body)).rejects.toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
    expect(getPr).not.toHaveBeenCalled();
  });

  it.each([{ isOwnPr: false }, { state: 'closed' as const }, { merged: true }])('only sends for an owned open PR %#', async (pr) => {
    const { client, send } = fixture({ pr });
    await expect(client.request(input)).rejects.toMatchObject({ status: 409, uncertain: false });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([{ SLACK_REVIEW_CHANNEL: '@channel' }, { SLACK_REVIEW_MENTION: 'bad group' }, { SLACK_REVIEW_MENTION: 'S123' }])('rejects invalid configuration before doing any work %#', async (env) => {
    const { client, send, getPr } = fixture({ env });
    await expect(client.request(input)).rejects.toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
    expect(getPr).not.toHaveBeenCalled();
  });

  it('coalesces duplicate clicks and enforces a per-PR cooldown for new request IDs', async () => {
    const { client, send } = fixture();
    const results = await Promise.all([client.request(input), client.request(input)]);
    expect(results[0]).toEqual(results[1]);
    expect(await client.request({ ...input, repo: 'OWNER/REPO', requestId: secondId })).toEqual(results[0]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('shares an in-flight send and accepts its late confirmation without sending again', async () => {
    const { client, send } = fixture();
    let complete!: (value: typeof receipt) => void;
    send.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const first = client.request(input);
    const duplicate = client.request(input);
    expect(duplicate).toBe(first);
    await expect(client.request({ ...input, prNumber: 43 })).rejects.toMatchObject({ status: 409 });
    await expect(client.request({ ...input, requestId: secondId })).rejects.toMatchObject({ status: 409, uncertain: true });
    expect(send).toHaveBeenCalledTimes(1);
    complete(receipt);
    expect(await first).toMatchObject({ ok: true, ...receipt });
    expect(await duplicate).toEqual(await client.request({ ...input, requestId: secondId }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('blocks concurrent new request IDs after a pending delivery outlives the sent cooldown', async () => {
    let timestamp = 100_000;
    const { client, send, getPr } = fixture({ now: () => timestamp });
    let finish!: (value: typeof receipt) => void;
    send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = client.request(input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    timestamp += 120_000;
    const retries = await Promise.allSettled([
      client.request({ ...input, repo: 'OWNER/REPO', requestId: secondId }),
      client.request({ ...input, requestId: 'b3d6f43c-108c-4d3a-a760-c55a99e4c943' }),
    ]);
    expect(retries).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ status: 409, uncertain: true }) },
      { status: 'rejected', reason: expect.objectContaining({ status: 409, uncertain: true }) },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getPr).toHaveBeenCalledTimes(1);
    finish(receipt);
    await pending;
    await expect(client.request({ ...input, requestId: secondId })).resolves.toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh request after the confirmed-send cooldown expires while retaining old idempotency keys', async () => {
    let timestamp = 100_000;
    const { client, send } = fixture({ now: () => timestamp });
    const first = await client.request(input);
    expect(await client.request({ ...input, requestId: secondId })).toEqual(first);
    timestamp += 120_000;
    expect(await client.request({ ...input, requestId: secondId })).toEqual(first);
    expect(await client.request({ ...input, requestId: 'b3d6f43c-108c-4d3a-a760-c55a99e4c943' }))
      .toMatchObject({ sentAt: new Date(timestamp).toISOString() });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('persists successful receipts across process restarts and rejects request ID reuse for another PR', async () => {
    const path = persistentPath();
    const first = fixture({ path });
    await first.client.request(input);
    close(first.client);
    const second = fixture({ path });
    expect(await second.client.request(input)).toMatchObject({ ok: true, ...receipt });
    await expect(second.client.request({ ...input, prNumber: 43 })).rejects.toMatchObject({ status: 409 });
    expect(second.send).not.toHaveBeenCalled();
    expect(second.getPr).not.toHaveBeenCalled();
  });

  it.each([new Error('private transport details'), new SlackReviewError('Check Slack before retrying.', 502, true)])('never retries an ambiguous send and keeps its warning after reopening %#', async (error) => {
    const path = persistentPath();
    const first = fixture({ path, now: () => 100_000 });
    first.send.mockRejectedValue(error);
    await expect(first.client.request(input)).rejects.toMatchObject({ uncertain: true });
    close(first.client);
    const second = fixture({ path, now: () => 300_000 });
    await expect(second.client.request(input)).rejects.toMatchObject({ status: 409, uncertain: true });
    await expect(second.client.request({ ...input, requestId: secondId })).rejects.toMatchObject({ status: 409, uncertain: true });
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).not.toHaveBeenCalled();
  });

  it('preserves actionable definite sender errors and permits retry after correction', async () => {
    const { client, send } = fixture();
    send.mockRejectedValueOnce(new SlackReviewError('Open Slack and sign in.', 503, false));
    await expect(client.request(input)).rejects.toMatchObject({ status: 503, uncertain: false, message: 'Open Slack and sign in.' });
    expect(await client.request(input)).toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { ...receipt, channel: '' }, { ...receipt, mention: null }, { ...receipt, permalink: undefined }])('does not retry unverified sender receipts %#', async (value) => {
    const { client, send } = fixture();
    send.mockResolvedValue(value as typeof receipt);
    await expect(client.request(input)).rejects.toMatchObject({ uncertain: true });
    await expect(client.request(input)).rejects.toMatchObject({ status: 409, uncertain: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('GitHub timed out'), new SlackReviewError('GitHub unavailable', 502, true)])('keeps getPr failures retriable because sending has not begun %#', async (error) => {
    const { client, getPr, send } = fixture();
    getPr.mockRejectedValueOnce(error);
    await expect(client.request(input)).rejects.toMatchObject({ uncertain: false });
    expect(send).not.toHaveBeenCalled();
    expect(await client.request(input)).toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('allows retrying a definitely failed ownership check after its cause is fixed', async () => {
    const { client, getPr, send } = fixture({ pr: { isOwnPr: false } });
    await expect(client.request(input)).rejects.toMatchObject({ status: 409, uncertain: false });
    getPr.mockResolvedValue({ isOwnPr: true, state: 'open', merged: false } as PrStatus);
    expect(await client.request(input)).toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('persists a cooldown-deduplicated request ID so late retries cannot send another message', async () => {
    let timestamp = 100_000;
    const { client, send } = fixture({ now: () => timestamp });
    await client.request(input);
    await client.request({ ...input, requestId: secondId });
    timestamp += 120_000;
    expect(await client.request({ ...input, requestId: secondId })).toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'javascript:alert(1)', 'https://evil.invalid/archives/C123/p123', 'https://example.slack.com.evil.invalid/archives/C123/p123'])('keeps confirmed sends successful without a usable permalink %#', async (link) => {
    const { client, send } = fixture();
    send.mockResolvedValue({ ...receipt, permalink: link });
    expect(await client.request(input)).toMatchObject({ ok: true, permalink: null });
    expect(await client.request(input)).toMatchObject({ ok: true, permalink: null });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

it('blocks manual requests while integration is off without external calls', async () => {
  const { client, send, getPr } = fixture({ env: { SLACK_ENABLED: 'false' } });
  await expect(client.request(input)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('disabled') });
  expect(send).not.toHaveBeenCalled();
  expect(getPr).not.toHaveBeenCalled();
});

it('rechecks integration state after preparing a request', async () => {
  const env = { SLACK_ENABLED: 'true' };
  const { client, getPr, send } = fixture({ env });
  getPr.mockImplementationOnce(async () => {
    env.SLACK_ENABLED = 'false';
    return { isOwnPr: true, state: 'open', merged: false } as PrStatus;
  });
  await expect(client.request(input)).rejects.toMatchObject({ status: 409, uncertain: false });
  expect(send).not.toHaveBeenCalled();
  env.SLACK_ENABLED = 'true';
  await expect(client.request(input)).resolves.toMatchObject({ ok: true });
});
