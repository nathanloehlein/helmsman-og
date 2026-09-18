import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSlackStore, type SlackStore } from './slack/store';
import { createGithubReviewWatcher, type GithubReviewWatcherOptions } from './github-review-watcher';

const stores: SlackStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const head = 'a'.repeat(40);
const nextHead = 'b'.repeat(40);
const request = { repo: 'org/repo', number: 42, title: 'Update', reviewDecision: 'REVIEW_REQUIRED', draft: false, createdAt: '2026-09-17T12:00:00.000Z' };

function setup(overrides: Partial<GithubReviewWatcherOptions> = {}) {
  const store = overrides.store ?? openSlackStore(':memory:');
  if (!stores.includes(store)) stores.push(store);
  const active = new Set<string>();
  const fetchRequested = vi.fn().mockResolvedValue({ prs: [request], degraded: false, truncated: false });
  const fetchPr = vi.fn().mockResolvedValue({ headSha: head, state: 'open', draft: false });
  const launch = vi.fn(({ runId }: { runId: string }) => { active.add(runId); return runId; });
  const options: GithubReviewWatcherOptions = {
    store, fetchRequested, fetchPr, allowedRepos: () => ['org/repo'], canLaunch: () => true,
    getRun: () => null, isRunActive: id => active.has(id), launch, now: () => '2026-09-17T12:00:00.000Z', ...overrides,
  };
  return { store, fetchRequested, fetchPr, launch, active, options, watcher: createGithubReviewWatcher(options) };
}

describe('GitHub requested review watcher', () => {
  it('launches currently pending reviews on the initial poll once per revision', async () => {
    const { watcher, launch, store } = setup();
    await watcher.poll();
    await watcher.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ repo: 'org/repo', prNumber: 42, mode: 'review', headSha: head });
    expect(store.listNotifications()[0]).toMatchObject({ status: 'launched', channelName: 'GitHub requested reviews', sourceUrl: 'https://github.com/org/repo/pull/42' });
  });

  it('deduplicates after watcher restart and starts a review for a new head', async () => {
    const initial = setup();
    await initial.watcher.poll();
    const oldId = initial.store.listNotifications()[0]!.runId;
    const restarted = setup({ store: initial.store, getRun: id => id === oldId ? { status: 'succeeded' } : null });
    await restarted.watcher.poll();
    expect(restarted.launch).not.toHaveBeenCalled();
    restarted.fetchPr.mockResolvedValue({ headSha: nextHead, state: 'open', draft: false });
    await restarted.watcher.poll();
    expect(restarted.launch).toHaveBeenCalledTimes(1);
    expect(restarted.store.listNotifications()).toHaveLength(2);
  });

  it('retains a durable queue while busy and marks it unread after launch', async () => {
    const initial = setup({ canLaunch: () => false });
    await initial.watcher.poll();
    const notification = initial.store.listNotifications()[0]!;
    expect(notification.status).toBe('queued');
    initial.store.markRead(notification.id, '2026-09-17T12:01:00.000Z');
    const restarted = setup({ store: initial.store });
    await restarted.watcher.poll();
    expect(restarted.launch.mock.calls[0]?.[0]).toMatchObject({ runId: notification.runId });
    expect(restarted.store.listNotifications()[0]).toMatchObject({ status: 'launched', readAt: null });
  });

  it('cancels queued work only after a complete list confirms request removal', async () => {
    let busy = true;
    const { watcher, fetchRequested, launch, store } = setup({ canLaunch: () => !busy });
    await watcher.poll();
    busy = false;
    fetchRequested.mockResolvedValue({ prs: [], degraded: true, truncated: false });
    await watcher.poll();
    expect(store.listNotifications()[0]?.status).toBe('queued');
    expect(watcher.health().status).toBe('partial');
    fetchRequested.mockResolvedValue({ prs: [], degraded: false, truncated: true });
    await watcher.poll();
    expect(store.listNotifications()[0]?.status).toBe('queued');
    fetchRequested.mockResolvedValue({ prs: [], degraded: false, truncated: false });
    await watcher.poll();
    expect(store.listNotifications()[0]).toMatchObject({ status: 'blocked', error: 'Review request was removed' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('keeps queued work when list or PR fetching fails', async () => {
    const { watcher, fetchRequested, fetchPr, launch, store } = setup({ canLaunch: () => false });
    await watcher.poll();
    fetchRequested.mockRejectedValueOnce(new Error('rate limited'));
    await watcher.poll();
    expect(watcher.health().status).toBe('unavailable');
    fetchPr.mockRejectedValue(new Error('offline'));
    await watcher.poll();
    expect(store.listNotifications()[0]?.status).toBe('queued');
    expect(watcher.health().status).toBe('partial');
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches the original queued request after an incomplete list recovers', async () => {
    let busy = true;
    const { watcher, fetchRequested, launch, store } = setup({ canLaunch: () => !busy });
    await watcher.poll();
    const runId = store.listNotifications()[0]!.runId;
    busy = false;
    fetchRequested.mockResolvedValueOnce({ prs: [], degraded: true, truncated: true });
    await watcher.poll();
    expect(launch).not.toHaveBeenCalled();
    expect(store.listNotifications()[0]?.status).toBe('queued');
    await watcher.poll();
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ runId });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.listNotifications()).toHaveLength(1);
    expect(watcher.health().status).toBe('healthy');
  });

  it('blocks the stale queued revision and dispatches its replacement', async () => {
    let busy = true;
    const { watcher, fetchPr, store, launch } = setup({ canLaunch: () => !busy });
    await watcher.poll();
    const oldId = store.listNotifications()[0]!.id;
    busy = false;
    fetchPr.mockResolvedValue({ headSha: nextHead, state: 'open', draft: false });
    await watcher.poll();
    expect(store.listNotifications().find(row => row.id === oldId)).toMatchObject({ status: 'blocked', error: expect.stringContaining('newer PR revision') });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ headSha: nextHead });
  });

  it.each([{ state: 'closed', draft: false }, { state: 'open', draft: true }])('validates current PR state before dispatch: %o', async (state) => {
    const { watcher, fetchPr, launch, store } = setup();
    fetchPr.mockResolvedValueOnce({ headSha: head, state: 'open', draft: false });
    fetchPr.mockResolvedValueOnce({ headSha: head, ...state });
    await watcher.poll();
    expect(launch).not.toHaveBeenCalled();
    expect(store.listNotifications()[0]?.status).toBe('blocked');
  });

  it('never fetches or launches an unconfigured repository', async () => {
    const { watcher, fetchRequested, fetchPr, launch, store } = setup();
    fetchRequested.mockResolvedValue({ prs: [{ ...request, repo: 'other/repo' }], degraded: false, truncated: false });
    await watcher.poll();
    expect(fetchPr).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(store.listNotifications()[0]).toMatchObject({ status: 'blocked', error: 'Repository other/repo is not configured' });
  });

  it('coalesces an existing review and persists the shared run link', async () => {
    const { watcher, launch, store } = setup({ findExistingReview: () => 'slack-existing-review', getRun: id => id === 'slack-existing-review' ? { status: 'running' } : null });
    await watcher.poll();
    expect(launch).not.toHaveBeenCalled();
    await watcher.poll();
    expect(launch).not.toHaveBeenCalled();
    expect(store.listNotifications()[0]).toMatchObject({ status: 'launched', runId: 'slack-existing-review' });
  });

  it('starts a previously blocked draft when it becomes ready on the same head', async () => {
    const { watcher, fetchPr, launch, store } = setup();
    fetchPr.mockResolvedValue({ headSha: head, state: 'open', draft: true });
    await watcher.poll();
    expect(store.listNotifications()[0]?.status).toBe('blocked');
    fetchPr.mockResolvedValue({ headSha: head, state: 'open', draft: false });
    await watcher.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.listNotifications()).toHaveLength(1);
    expect(store.listNotifications()[0]?.status).toBe('launched');
  });

  it('recovers an interrupted launch with its persisted ID and records asynchronous failure', async () => {
    const initial = setup();
    await initial.watcher.poll();
    const notification = initial.store.listNotifications()[0]!;
    const restarted = setup({ store: initial.store });
    await restarted.watcher.poll();
    expect(restarted.launch.mock.calls[0]?.[0]).toMatchObject({ runId: notification.runId });
    const failed = setup({ store: initial.store, getRun: () => ({ status: 'failed' }) });
    await failed.watcher.poll();
    expect(failed.launch).not.toHaveBeenCalled();
    expect(initial.store.listNotifications()[0]?.status).toBe('failed');
  });

  it('does not launch if disabled while awaiting a PR response', async () => {
    let enabled = true;
    const { watcher, fetchPr, launch } = setup({ enabled: () => enabled });
    fetchPr.mockImplementation(async () => { enabled = false; return { headSha: head, state: 'open', draft: false }; });
    await watcher.poll();
    expect(launch).not.toHaveBeenCalled();
    expect(watcher.health()).toMatchObject({ enabled: false, status: 'disabled' });
  });
});
