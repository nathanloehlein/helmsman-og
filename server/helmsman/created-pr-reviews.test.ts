import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunRow } from './db';
import { createCreatedPrReviews, type CreatedPrReviewsOptions } from './created-pr-reviews';
import { openSlackStore, type SlackStore } from './slack/store';

const stores = new Set<SlackStore>();
const directories: string[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const headSha = 'a'.repeat(40);
const input = { parentRunId: 'parent-voyage', repo: 'org/repo', prNumber: 42 };
function row(id: string, status: RunRow['status'] = 'succeeded'): RunRow {
  return { id, status, ticketId: 'ABC-42', repo: 'org/repo', adapter: 'codex', attempt: 1,
    prNumber: 42, startedAt: '2026-09-17T12:00:00.000Z', endedAt: null, costUsd: null, worktreePath: null };
}
function setup(overrides: Partial<CreatedPrReviewsOptions> = {}) {
  const store = overrides.store ?? openSlackStore(':memory:');
  stores.add(store);
  const runs = new Map<string, RunRow>([[input.parentRunId, row(input.parentRunId)]]);
  const active = new Set<string>();
  const fetchPr = vi.fn().mockResolvedValue({ headSha, state: 'open', draft: false });
  const launch = vi.fn(({ runId }: { runId: string }) => { active.add(runId); return runId; });
  const options: CreatedPrReviewsOptions = { store, getRun: id => runs.get(id) ?? null,
    isRunActive: id => active.has(id), canLaunch: () => true, fetchPr, launch,
    now: () => '2026-09-17T12:00:00.000Z', ...overrides };
  return { store, runs, active, fetchPr, launch, options, queue: createCreatedPrReviews(options) };
}

describe('created PR review queue', () => {
  it('enqueues synchronously and idempotently with a persistent parent voyage link', () => {
    const { queue, store, fetchPr, launch } = setup();
    const id = queue.enqueue(input);
    expect(queue.enqueue({ ...input, repo: 'ORG/Repo' })).toBe(id);
    expect(store.listNotifications()).toHaveLength(1);
    expect(store.getNotification(id)).toMatchObject({ status: 'queued', runId: `created-${id}`,
      author: 'Helmsman', channelName: 'Helmsman created PRs', sourceUrl: '/runs?run=parent-voyage',
      prUrl: 'https://github.com/org/repo/pull/42' });
    expect(fetchPr).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(queue.enqueue({ ...input, parentRunId: 'other-voyage' })).not.toBe(id);
  });

  it('resumes its persistent queue after reopening the database and pins the fetched revision', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'created-pr-reviews-'));
    directories.push(directory);
    const path = join(directory, 'notifications.db');
    const first = setup({ store: openSlackStore(path) });
    const id = first.queue.enqueue(input);
    first.store.close();
    stores.delete(first.store);
    const restarted = setup({ store: openSlackStore(path) });
    expect(restarted.queue.enqueue(input)).toBe(id);
    await restarted.queue.poll();
    expect(restarted.launch).toHaveBeenCalledExactlyOnceWith({ repo: 'org/repo', prNumber: 42,
      mode: 'review', runId: `created-${id}`, headSha });
    await restarted.queue.poll();
    expect(restarted.launch).toHaveBeenCalledTimes(1);
    expect(restarted.fetchPr).toHaveBeenCalledTimes(1);
  });

  it('preserves parent repository casing for local checkout resolution while deduplicating case variants', async () => {
    const { queue, store, fetchPr, launch } = setup();
    const repo = 'Org/MyRepo';
    const id = queue.enqueue({ ...input, repo });
    expect(queue.enqueue({ ...input, repo: repo.toLowerCase() })).toBe(id);
    expect(store.getNotification(id)).toMatchObject({ repo, prUrl: `https://github.com/${repo}/pull/42` });
    await queue.poll();
    expect(fetchPr).toHaveBeenCalledExactlyOnceWith(repo, 42);
    expect(launch).toHaveBeenCalledExactlyOnceWith({ repo, prNumber: 42, mode: 'review', runId: `created-${id}`, headSha });
  });

  it('does no external reads while empty, parent is running, or capacity is unavailable', async () => {
    let capacity = false;
    const { queue, fetchPr, launch, runs, active } = setup({ canLaunch: () => capacity });
    await queue.poll();
    queue.enqueue(input);
    await queue.poll();
    capacity = true;
    runs.set(input.parentRunId, row(input.parentRunId, 'running'));
    await queue.poll();
    runs.set(input.parentRunId, row(input.parentRunId));
    active.add(input.parentRunId);
    await queue.poll();
    expect(fetchPr).not.toHaveBeenCalled();
    active.delete(input.parentRunId);
    await queue.poll();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('leaves missing parents queued and blocks failed or stopped creation voyages', async () => {
    const { queue, store, runs, fetchPr } = setup();
    const id = queue.enqueue(input);
    runs.delete(input.parentRunId);
    await queue.poll();
    expect(store.getNotification(id)).toMatchObject({ status: 'queued', error: expect.stringContaining('Waiting') });
    runs.set(input.parentRunId, row(input.parentRunId, 'failed'));
    await queue.poll();
    expect(store.getNotification(id)).toMatchObject({ status: 'blocked' });
    runs.set('stopped-parent', row('stopped-parent', 'stopped'));
    const stoppedId = queue.enqueue({ ...input, parentRunId: 'stopped-parent' });
    await queue.poll();
    expect(store.getNotification(stoppedId)?.status).toBe('blocked');
    expect(fetchPr).not.toHaveBeenCalled();
  });

  it('reuses another review for the same PR head and follows asynchronous failure', async () => {
    const { queue, runs, launch, store } = setup({ findExistingReview: () => 'existing-review' });
    runs.set('existing-review', row('existing-review', 'running'));
    const id = queue.enqueue(input);
    await queue.poll();
    expect(store.getNotification(id)).toMatchObject({ status: 'launched', runId: 'existing-review' });
    runs.set('existing-review', row('existing-review', 'failed'));
    await queue.poll();
    expect(store.getNotification(id)).toMatchObject({ status: 'failed' });
    await queue.poll();
    expect(launch).not.toHaveBeenCalled();
  });

  it('recovers a queued launch already recorded or active without fetching GitHub again', async () => {
    const { queue, store, runs, active, fetchPr, launch } = setup();
    const id = queue.enqueue(input);
    runs.set(`created-${id}`, row(`created-${id}`));
    await queue.poll();
    expect(store.getNotification(id)?.status).toBe('launched');
    const nextId = queue.enqueue({ ...input, prNumber: 43 });
    active.add(`created-${nextId}`);
    await queue.poll();
    expect(store.getNotification(nextId)?.status).toBe('launched');
    expect(fetchPr).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('recovers an interrupted launch with the same deterministic run ID', async () => {
    const { queue, store, options, active, launch } = setup();
    const id = queue.enqueue(input);
    await queue.poll();
    active.clear();
    const restarted = createCreatedPrReviews(options);
    await restarted.poll();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1]?.[0]).toMatchObject({ runId: `created-${id}` });
    expect(store.getNotification(id)?.status).toBe('launched');
  });

  it('retains transient fetch errors and unavailable responses for a later poll', async () => {
    const { queue, fetchPr, store, launch } = setup();
    const id = queue.enqueue(input);
    fetchPr.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);
    await queue.poll();
    expect(store.getNotification(id)).toMatchObject({ status: 'queued', error: 'offline' });
    await queue.poll();
    expect(store.getNotification(id)).toMatchObject({ status: 'queued', error: expect.stringContaining('unavailable') });
    await queue.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.getNotification(id)).toMatchObject({ status: 'launched', error: null });
  });

  it.each([{ state: 'closed' }, { merged: true }, { draft: true }])('blocks unavailable PR state: %o', async change => {
    const { queue, store, fetchPr, launch } = setup();
    fetchPr.mockResolvedValue({ headSha, state: 'open', draft: false, ...change });
    const id = queue.enqueue(input);
    await queue.poll();
    expect(store.getNotification(id)?.status).toBe('blocked');
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not retry a failed launch automatically', async () => {
    const { queue, store, launch } = setup();
    launch.mockImplementation(() => { throw new Error('launch failed'); });
    const id = queue.enqueue(input);
    await queue.poll();
    await queue.poll();
    queue.enqueue(input);
    await queue.poll();
    expect(store.getNotification(id)).toMatchObject({ status: 'failed', error: 'launch failed' });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent polls and rechecks capacity after the external read', async () => {
    let capacity = true;
    const { queue, fetchPr, launch, store } = setup({ canLaunch: () => capacity });
    let resolve!: (value: unknown) => void;
    fetchPr.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const id = queue.enqueue(input);
    const first = queue.poll();
    const second = queue.poll();
    expect(second).toBe(first);
    capacity = false;
    resolve({ headSha, state: 'open', draft: false });
    await first;
    expect(fetchPr).toHaveBeenCalledTimes(1);
    expect(store.getNotification(id)?.status).toBe('queued');
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([{ parentRunId: '../bad' }, { parentRunId: '' }, { repo: 'invalid' }, { prNumber: 0 }, { prNumber: 1.5 }])('rejects invalid request input: %o', change => {
    const { queue, store } = setup();
    expect(() => queue.enqueue({ ...input, ...change })).toThrow('Invalid created PR review request');
    expect(store.listNotifications()).toHaveLength(0);
  });
});
