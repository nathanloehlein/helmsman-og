import { createHash, randomUUID } from 'node:crypto';
import { isGithubRepo } from '../pr-lists';
import type { RunRow } from './db';
import type { RequestedReviewPr } from './github-review-watcher';
import type { SlackNotification, SlackStore } from './slack/store';

export interface CreatedPrReviewsOptions {
  store: SlackStore;
  getRun: (id: string) => RunRow | null;
  isRunActive: (id: string) => boolean;
  canLaunch: (repo: string) => boolean;
  fetchPr: (repo: string, number: number) => Promise<RequestedReviewPr | null>;
  findExistingReview?: (repo: string, number: number, headSha: string) => string | null;
  launch: (input: { repo: string; prNumber: number; mode: 'review'; runId: string; headSha: string }) => string;
  now?: () => string;
  claimTtlMs?: number;
}

export interface CreatedPrReviews {
  enqueue(input: { parentRunId: string; repo: string; prNumber: number }): string;
  poll(): Promise<void>;
}

const SOURCE = 'helmsman-created-prs';
const CHANNEL = 'Helmsman created PRs';
const RUN_ID = /^[a-z\d_-]{1,128}$/i;

function identity(parentRunId: string, repo: string, prNumber: number): string {
  return createHash('sha256').update(JSON.stringify([SOURCE, parentRunId, repo.toLowerCase(), prNumber])).digest('hex');
}

function validPr(pr: RequestedReviewPr | null): pr is RequestedReviewPr {
  return !!pr && typeof pr.headSha === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(pr.headSha)
    && ['open', 'closed'].includes(pr.state) && typeof pr.draft === 'boolean';
}

function parentId(notification: SlackNotification): string | null {
  try {
    const url = new URL(notification.sourceUrl, 'http://helmsman.local');
    const id = url.searchParams.get('run');
    return url.origin === 'http://helmsman.local' && url.pathname === '/runs' && id && RUN_ID.test(id)
      && isGithubRepo(notification.repo) && Number.isSafeInteger(notification.prNumber) && notification.prNumber > 0
      && identity(id, notification.repo, notification.prNumber) === notification.id ? id : null;
  } catch { return null; }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCreatedPrReviews(options: CreatedPrReviewsOptions): CreatedPrReviews {
  const { store } = options;
  const now = options.now ?? (() => new Date().toISOString());
  let pending: Promise<void> | null = null;
  const claimTtlMs = options.claimTtlMs ?? 300_000;
  if (!Number.isFinite(claimTtlMs) || claimTtlMs < 1000) throw new Error('Dispatch claim lifetime must be at least one second');

  function update(notification: SlackNotification, status: SlackNotification['status'], error: string | null = null): void {
    if (notification.status !== status || notification.error !== error) store.updateNotification(notification.id, status, now(), error);
  }

  function recover(notification: SlackNotification): boolean {
    if (!notification.runId) return false;
    const run = options.getRun(notification.runId);
    if (!run && !options.isRunActive(notification.runId)) return false;
    const failed = run?.status === 'failed' || run?.status === 'stopped';
    update(notification, failed ? 'failed' : 'launched', failed ? 'PR review failed or stopped; open the voyage for details' : null);
    return true;
  }

  async function scan(): Promise<void> {
    for (const claim of store.dispatchClaims(SOURCE)) {
      const notification = store.getNotification(claim.notificationId);
      if (!notification) { store.releaseDispatch(claim.notificationId, claim.token); continue; }
      if (recover(notification) || notification.status !== 'queued') store.releaseDispatch(notification.id, claim.token);
      else if (Date.parse(now()) - Date.parse(claim.claimedAt) >= claimTtlMs) store.releaseDispatch(notification.id, claim.token);
    }
    for (const notification of store.launchedNotifications(SOURCE)) {
      if (!recover(notification)) update(notification, 'queued');
    }
    for (const notification of store.queuedNotifications(SOURCE)) {
      if (recover(notification)) continue;
      const parentRunId = parentId(notification);
      if (!parentRunId || !notification.runId || !RUN_ID.test(notification.runId)) {
        update(notification, 'blocked', 'Invalid persisted PR review request');
        continue;
      }
      const parent = options.getRun(parentRunId);
      if (!parent) {
        update(notification, 'queued', 'Waiting for the PR creation voyage to become available');
        continue;
      }
      if (parent.status === 'failed' || parent.status === 'stopped') {
        update(notification, 'blocked', 'PR creation voyage failed or stopped');
        continue;
      }
      if (parent.status !== 'succeeded' || options.isRunActive(parentRunId) || !options.canLaunch(notification.repo)) continue;
      const token = randomUUID();
      if (!store.claimDispatch(notification.id, token, now())) continue;
      try {
        let pr: RequestedReviewPr | null;
        try {
          pr = await options.fetchPr(notification.repo, notification.prNumber);
          if (!validPr(pr)) throw new Error('Pull request is unavailable; will retry');
        } catch (error) {
          if (store.ownsDispatch(notification.id, token)) update(notification, 'queued', errorMessage(error));
          continue;
        }
        if (!store.ownsDispatch(notification.id, token)) continue;
        if (pr.state !== 'open' || pr.merged || pr.draft) {
          update(notification, 'blocked', pr.draft ? 'Pull request is a draft' : 'Pull request is no longer open');
          continue;
        }
        try {
          if (recover(notification)) continue;
          const existing = options.findExistingReview?.(notification.repo, notification.prNumber, pr.headSha);
          if (existing) {
            store.setNotificationRunId(notification.id, existing);
            const linked = { ...notification, runId: existing };
            if (!recover(linked)) update(notification, 'launched');
            continue;
          }
          if (!options.canLaunch(notification.repo)) continue;
          const launched = options.launch({ repo: notification.repo, prNumber: notification.prNumber, mode: 'review', runId: notification.runId, headSha: pr.headSha });
          if (launched !== notification.runId) throw new Error('Launcher returned an unexpected run ID');
          update(notification, 'launched');
        } catch (error) {
          if (!recover(notification)) update(notification, 'failed', errorMessage(error));
        }
      } finally { store.releaseDispatch(notification.id, token); }
    }
  }

  return {
    enqueue(input) {
      if (!input || typeof input.parentRunId !== 'string' || !RUN_ID.test(input.parentRunId)
        || typeof input.repo !== 'string' || !isGithubRepo(input.repo) || !Number.isSafeInteger(input.prNumber) || input.prNumber < 1) {
        throw new Error('Invalid created PR review request');
      }
      const repo = input.repo;
      const id = identity(input.parentRunId, repo, input.prNumber);
      const timestamp = now();
      store.insertNotification(SOURCE, {
        id, repo, prNumber: input.prNumber, prUrl: `https://github.com/${repo}/pull/${input.prNumber}`,
        sourceUrl: `/runs?run=${encodeURIComponent(input.parentRunId)}`, author: 'Helmsman', channelName: CHANNEL,
        status: 'queued', runId: `created-${id}`, createdAt: timestamp, updatedAt: timestamp, readAt: null, error: null,
      });
      return id;
    },
    poll() {
      pending ??= scan().finally(() => { pending = null; });
      return pending;
    },
  };
}
