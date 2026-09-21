import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSlackStore, type SlackStore } from './store';
import { createSlackWatcher, parsePullRequestUrl, type SlackMessage, type SlackWatcherOptions } from './watcher';

const activation = '2026-09-17T12:00:00.000Z';
const activationTs = Date.parse(activation) / 1000;
const stores: SlackStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function message(offset: number, prUrls = ['https://github.com/org/repo/pull/42']): SlackMessage {
  return { channelId: 'C123', ts: (activationTs + offset).toFixed(6), permalink: 'https://example.slack.com/archives/C123/p123', author: 'Someone', prUrls };
}

function setup(overrides: Partial<SlackWatcherOptions> = {}) {
  const store = overrides.store ?? openSlackStore(':memory:');
  if (!stores.includes(store)) stores.push(store);
  const scan = vi.fn().mockResolvedValue({ messages: [message(1)], complete: true });
  const active = new Set<string>();
  const launch = vi.fn(({ runId }: { runId: string }) => { active.add(runId); return runId; });
  const options: SlackWatcherOptions = {
    store, clientId: 'T123', channelId: 'C123', channelName: 'airo-editing',
    source: { scan }, allowedRepos: () => ['org/repo'], canLaunch: () => true,
    isOwnPr: async () => false,
    getRun: () => null, isRunActive: id => active.has(id), launch, now: () => activation,
    ...overrides,
  };
  return { store, scan, launch, options, watcher: createSlackWatcher(options) };
}

describe('Slack PR URL validation', () => {
  it('canonicalizes full PR links with anchors and query parameters', () => {
    expect(parsePullRequestUrl('https://github.com/Org/Repo/pull/42/?diff=split#discussion')).toEqual({
      repo: 'org/repo', prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42',
    });
  });

  it.each([
    null, {}, '/org/repo/pull/42', 'http://github.com/org/repo/pull/42',
    'https://github.com.evil.test/org/repo/pull/42', 'https://github.com@evil.test/org/repo/pull/42',
    'https://github.com/org/repo/pull/0', 'https://github.com/org/repo/pull/9007199254740993',
    'https://github.com/org/repo/pull/42/files', 'https://github.com/org/repo/issues/42',
    'https://github.com:8443/org/repo/pull/42',
  ])('rejects invalid PR URL %s', (value) => {
    expect(parsePullRequestUrl(value)).toBeNull();
  });
});

describe('Slack watcher', () => {
  it('skips own PRs posted by anyone, including reposts, while reviewing other authors', async () => {
    const isOwnPr = vi.fn(async (_repo: string, prNumber: number) => prNumber === 42);
    const { watcher, scan, launch, store } = setup({ isOwnPr });
    scan.mockResolvedValue({ messages: [message(1), { ...message(2, ['https://github.com/org/repo/pull/43']), author: 'Me' }], complete: true });
    await watcher.poll();
    scan.mockResolvedValue({ messages: [message(1), { ...message(3), author: 'Me' }], complete: true });
    await watcher.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ prNumber: 43 });
    expect(store.listNotifications().filter(row => row.prNumber === 42)).toHaveLength(2);
    expect(store.listNotifications().filter(row => row.prNumber === 42).every(row => row.status === 'blocked' && row.error?.includes('your pull request'))).toBe(true);
    expect(isOwnPr).toHaveBeenCalledTimes(3);
  });

  it('checks persisted queued PRs before launching after restart even when Slack is unavailable', async () => {
    const initial = setup({ canLaunch: () => false });
    await initial.watcher.poll();
    const restarted = setup({ store: initial.store, isOwnPr: async () => true });
    restarted.scan.mockRejectedValue(new Error('browser closed'));
    await restarted.watcher.poll();
    expect(restarted.launch).not.toHaveBeenCalled();
    expect(initial.store.listNotifications()[0]).toMatchObject({ status: 'blocked', error: expect.stringContaining('your pull request') });
  });

  it.each(['unknown', 'throws'])('retries ownership lookup when it %s without losing the queued PR', async (failure) => {
    const isOwnPr = vi.fn<SlackWatcherOptions['isOwnPr']>().mockResolvedValue(false);
    if (failure === 'throws') isOwnPr.mockRejectedValueOnce(new Error('GitHub unavailable'));
    else isOwnPr.mockResolvedValueOnce(null);
    const { watcher, scan, launch, store } = setup({ isOwnPr });
    await watcher.poll();
    expect(launch).not.toHaveBeenCalled();
    expect(store.listNotifications()[0]).toMatchObject({ status: 'queued', error: expect.stringContaining('will retry') });
    scan.mockResolvedValue({ messages: [], complete: true });
    await watcher.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.listNotifications()[0]).toMatchObject({ status: 'launched', error: null });
  });

  it.each(['disabled', 'removed', 'active'])('does not launch if eligibility changes to %s during ownership lookup', async (change) => {
    let eligible = true;
    let active = false;
    const { watcher, launch, store } = setup({
      canLaunch: () => change === 'disabled' ? eligible : true,
      allowedRepos: () => change === 'removed' && !eligible ? [] : ['org/repo'],
      isRunActive: () => active,
      isOwnPr: async () => { eligible = false; active = change === 'active'; return false; },
    });
    await watcher.poll();
    expect(launch).not.toHaveBeenCalled();
    expect(store.listNotifications()[0]?.status).toBe(change === 'active' ? 'launched' : 'queued');
  });

  it('uses activation as the baseline and captures posts arriving during the first scan', async () => {
    const { watcher, scan, launch, store } = setup();
    scan.mockResolvedValue({ messages: [message(-60), message(1)], complete: true });
    await watcher.poll();
    expect(scan).toHaveBeenCalledWith({ since: activationTs.toFixed(6) });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.listNotifications()).toHaveLength(1);
    expect(watcher.health()).toMatchObject({ status: 'healthy', lastSuccessAt: activation });
  });

  it('launches each full link once per message regardless of author, and launches reposts', async () => {
    const { watcher, scan, launch, store } = setup();
    const first = message(1, [
      'https://github.com/org/repo/pull/42', 'https://github.com/ORG/REPO/pull/42#discussion',
      'https://github.com/org/repo/pull/43', '/org/repo/pull/44',
    ]);
    first.author = 'Me';
    scan.mockResolvedValue({ messages: [first, { ...message(2), channelId: 'OTHER' }], complete: true });
    await watcher.poll();
    await watcher.poll();
    expect(launch).toHaveBeenCalledTimes(2);
    scan.mockResolvedValue({ messages: [first, message(3)], complete: true });
    await watcher.poll();
    expect(launch).toHaveBeenCalledTimes(3);
    expect(store.listNotifications().every(row => row.status === 'launched')).toBe(true);
  });

  it('retains the cursor after partial scans and failures while deduplicating discovered requests', async () => {
    const { watcher, scan, launch } = setup();
    scan.mockResolvedValueOnce({ messages: [message(900)], complete: false });
    await watcher.poll();
    expect(watcher.health().status).toBe('partial');
    scan.mockRejectedValueOnce(new Error('signed out'));
    await watcher.poll();
    expect(watcher.health()).toMatchObject({ status: 'unavailable', error: 'signed out', lastSuccessAt: null });
    scan.mockResolvedValueOnce({ messages: [message(900)], complete: true });
    await watcher.poll();
    expect(scan.mock.calls.map(call => call[0].since)).toEqual(Array(3).fill(activationTs.toFixed(6)));
    expect(launch).toHaveBeenCalledTimes(1);
    await watcher.poll();
    expect(scan).toHaveBeenLastCalledWith({ since: (activationTs + 600).toFixed(6) });
  });

  it('persists queued requests before launch, survives reopen, and marks launch unread', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'helmsman-slack-'));
    directories.push(directory);
    const path = join(directory, 'state.db');
    const initial = setup({ store: openSlackStore(path), canLaunch: () => false });
    await initial.watcher.poll();
    const queued = initial.store.listNotifications()[0]!;
    expect(queued).toMatchObject({ status: 'queued', runId: `slack-${queued.id}` });
    initial.store.markRead(queued.id, activation);
    stores.splice(stores.indexOf(initial.store), 1);
    initial.store.close();
    const restarted = setup({ store: openSlackStore(path), now: () => '2026-09-17T12:10:00.000Z' });
    restarted.scan.mockRejectedValue(new Error('browser closed'));
    await restarted.watcher.poll();
    expect(restarted.launch).toHaveBeenCalledExactlyOnceWith({ repo: 'org/repo', prNumber: 42, mode: 'review', runId: queued.runId });
    expect(restarted.store.listNotifications()[0]).toMatchObject({ id: queued.id, status: 'launched', readAt: null });
  });

  it.each(['persisted', 'active'])('recovers a %s run without launching twice', async (kind) => {
    const initial = setup({ canLaunch: () => false });
    await initial.watcher.poll();
    const runId = initial.store.listNotifications()[0]!.runId;
    const restarted = setup({
      store: initial.store,
      getRun: id => kind === 'persisted' && id === runId ? { status: 'running' } : null,
      isRunActive: id => kind === 'active' && id === runId,
    });
    await restarted.watcher.poll();
    expect(restarted.launch).not.toHaveBeenCalled();
    expect(initial.store.listNotifications()[0]?.status).toBe('launched');
  });

  it('restarts a launch interrupted before a run row existed, retaining its run ID', async () => {
    const initial = setup();
    await initial.watcher.poll();
    const runId = initial.store.listNotifications()[0]!.runId;
    const restarted = setup({ store: initial.store });
    await restarted.watcher.poll();
    expect(restarted.launch).toHaveBeenCalledExactlyOnceWith({ repo: 'org/repo', prNumber: 42, mode: 'review', runId });
  });

  it('never retries a completed run after restart', async () => {
    const initial = setup();
    await initial.watcher.poll();
    const restarted = setup({ store: initial.store, getRun: () => ({ status: 'succeeded' }) });
    await restarted.watcher.poll();
    expect(restarted.launch).not.toHaveBeenCalled();
    expect(initial.store.listNotifications()[0]?.status).toBe('launched');
  });

  it('blocks unsupported repositories and lets another repository pass a busy one', async () => {
    const { watcher, scan, launch, store } = setup({
      allowedRepos: () => ['org/repo', 'org/other'], canLaunch: repo => repo !== 'org/repo',
    });
    scan.mockResolvedValue({ messages: [message(1, [
      'https://github.com/org/repo/pull/1', 'https://github.com/org/other/pull/2', 'https://github.com/untrusted/repo/pull/3',
    ])], complete: true });
    await watcher.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ repo: 'org/other', prNumber: 2 });
    expect(store.listNotifications().find(row => row.prNumber === 1)?.status).toBe('queued');
    expect(store.listNotifications().find(row => row.prNumber === 3)).toMatchObject({ status: 'blocked', error: 'Galleon untrusted/repo is not configured' });
  });

  it('persists launch errors and does not automatically retry an uncertain launch', async () => {
    const launch = vi.fn(() => { throw new Error('launch failed'); });
    const { watcher, store } = setup({ launch });
    await watcher.poll();
    await watcher.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.listNotifications()[0]).toMatchObject({ status: 'failed', error: 'launch failed' });
  });

  it('turns a later asynchronous run failure into an unread persistent notification', async () => {
    const getRun = vi.fn<SlackWatcherOptions['getRun']>().mockReturnValue(null);
    const { watcher, store } = setup({ getRun });
    await watcher.poll();
    const id = store.listNotifications()[0]!.id;
    expect(store.markRead(id, activation)).toBe(true);
    getRun.mockReturnValue({ status: 'failed' });
    await watcher.poll();
    expect(store.listNotifications()[0]).toMatchObject({ status: 'failed', readAt: null, error: expect.stringContaining('PR run failed') });
  });

  it('coalesces overlapping polls and tolerates malformed external message data', async () => {
    const { watcher, scan, launch } = setup();
    let finish: ((result: unknown) => void) | undefined;
    scan.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = watcher.poll();
    const second = watcher.poll();
    expect(first).toBe(second);
    finish?.({ messages: [null, {}, { ...message(1), prUrls: null }, message(2)], complete: true });
    await first;
    expect(scan).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('retains queued posts when disabled during a scan and launches after re-enabling', async () => {
    let enabled = true;
    const { watcher, scan, launch, store } = setup({ canLaunch: () => enabled });
    let finish: ((result: unknown) => void) | undefined;
    scan.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = watcher.poll();
    enabled = false;
    finish?.({ messages: [message(1)], complete: true });
    await pending;
    expect(launch).not.toHaveBeenCalled();
    const notification = store.listNotifications()[0]!;
    expect(notification.status).toBe('queued');
    enabled = true;
    await watcher.poll();
    expect(launch).toHaveBeenCalledExactlyOnceWith({ repo: 'org/repo', prNumber: 42, mode: 'review', runId: notification.runId });
    expect(store.listNotifications()).toHaveLength(1);
    expect(store.listNotifications()[0]?.status).toBe('launched');
  });
});
