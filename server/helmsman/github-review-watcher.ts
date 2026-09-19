import { createHash } from 'node:crypto';
import { isGithubRepo, type PrListResponse } from '../pr-lists';
import type { SlackHealth, SlackNotification, SlackStore } from './slack/store';

export interface RequestedReviewPr {
  headSha: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged?: boolean;
}

export interface GithubReviewWatcherOptions {
  store: SlackStore;
  fetchRequested: () => Promise<PrListResponse>;
  fetchPr: (repo: string, number: number) => Promise<RequestedReviewPr | null>;
  allowedRepos: () => readonly string[];
  canLaunch: (repo: string) => boolean;
  getRun: (id: string) => unknown;
  isRunActive: (id: string) => boolean;
  launch: (input: { repo: string; prNumber: number; mode: 'review'; runId: string; headSha: string }) => string;
  findExistingReview?: (repo: string, number: number, headSha: string) => string | null;
  now?: () => string;
  enabled?: () => boolean;
  intervalMs?: number;
}

export interface GithubReviewWatcher {
  poll(): Promise<void>;
  health(): SlackHealth;
}

const SOURCE = 'github-review-requests';
const CHANNEL = 'GitHub requested reviews';

function identity(repo: string, number: number, head: string): string {
  return createHash('sha256').update(JSON.stringify([SOURCE, repo.toLowerCase(), number, head.toLowerCase()])).digest('hex');
}

function validPr(pr: RequestedReviewPr | null): pr is RequestedReviewPr {
  return !!pr && typeof pr.headSha === 'string' && /^[a-f\d]{40,64}$/i.test(pr.headSha)
    && ['open', 'closed'].includes(pr.state) && typeof pr.draft === 'boolean';
}

function failedRun(run: unknown): boolean {
  return !!run && typeof run === 'object' && 'status' in run && run.status === 'failed';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGithubReviewWatcher(options: GithubReviewWatcherOptions): GithubReviewWatcher {
  const { store } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const enabled = options.enabled ?? (() => true);
  const state = store.ensureSource(SOURCE, now(), {
    enabled: enabled(), status: 'unavailable', channelName: CHANNEL,
    intervalMs: options.intervalMs ?? 300_000, lastSuccessAt: null, error: 'Waiting for first scan',
  });
  let pending: Promise<void> | null = null;

  function insert(repo: string, number: number, head: string, error: string | null = null): void {
    const id = identity(repo, number, head);
    const prUrl = `https://github.com/${repo}/pull/${number}`;
    const createdAt = now();
    store.insertNotification(SOURCE, {
      id, repo, prNumber: number, prUrl, sourceUrl: prUrl, author: 'GitHub', channelName: CHANNEL,
      status: error ? 'blocked' : 'queued', runId: `github-${id}`, createdAt, updatedAt: createdAt, readAt: null, error,
    });
    if (!error && store.getNotification(id)?.status === 'blocked') store.updateNotification(id, 'queued', now());
  }

  function recover(): void {
    for (const notification of store.launchedNotifications(SOURCE)) {
      const run = notification.runId ? options.getRun(notification.runId) : null;
      if (failedRun(run)) store.updateNotification(notification.id, 'failed', now(), 'PR run failed; open the run for details');
      else if (!run && notification.runId && !options.isRunActive(notification.runId)) store.updateNotification(notification.id, 'queued', now());
    }
  }

  function recoverQueued(notification: SlackNotification): boolean {
    if (!notification.runId) return false;
    const run = options.getRun(notification.runId);
    if (!run && !options.isRunActive(notification.runId)) return false;
    const failed = failedRun(run);
    store.updateNotification(notification.id, failed ? 'failed' : 'launched', now(), failed ? 'PR run failed; open the run for details' : null);
    return true;
  }

  async function scan(): Promise<void> {
    state.health = { ...state.health, enabled: enabled(), status: enabled() ? 'scanning' : 'disabled', error: null };
    store.saveSource(state);
    if (!enabled()) return;
    try {
      recover();
      const requested = await options.fetchRequested();
      if (!requested || !Array.isArray(requested.prs) || typeof requested.degraded !== 'boolean' || typeof requested.truncated !== 'boolean') {
        throw new Error('Invalid GitHub requested reviews response');
      }
      let partial = requested.degraded || requested.truncated;
      const listed = new Set<string>();
      const configured = new Map(options.allowedRepos().map(repo => [repo.toLowerCase(), repo]));
      for (const item of requested.prs) {
        if (!enabled()) return;
        if (!item || typeof item.repo !== 'string' || !isGithubRepo(item.repo) || !Number.isSafeInteger(item.number) || item.number < 1) {
          partial = true;
          continue;
        }
        const repo = item.repo.toLowerCase();
        const requestKey = `${repo}#${item.number}`;
        if (listed.has(requestKey)) continue;
        listed.add(requestKey);
        if (!configured.has(repo)) {
          insert(repo, item.number, 'unsupported', `Galleon ${repo} is not configured`);
          continue;
        }
        try {
          const pr = await options.fetchPr(repo, item.number);
          if (!validPr(pr)) { partial = true; continue; }
          const error = pr.state !== 'open' || pr.merged ? 'Pull request is no longer open' : pr.draft ? 'Pull request is a draft' : null;
          insert(repo, item.number, pr.headSha, error);
        } catch { partial = true; }
      }
      for (const notification of store.queuedNotifications(SOURCE)) {
        if (!enabled()) return;
        if (recoverQueued(notification)) continue;
        const repo = options.allowedRepos().find(repo => repo.toLowerCase() === notification.repo.toLowerCase());
        if (!repo) {
          store.updateNotification(notification.id, 'blocked', now(), `Galleon ${notification.repo} is not configured`);
          continue;
        }
        if (!listed.has(`${notification.repo.toLowerCase()}#${notification.prNumber}`)) {
          if (!partial) store.updateNotification(notification.id, 'blocked', now(), 'Review request was removed');
          continue;
        }
        let pr: RequestedReviewPr | null;
        try { pr = await options.fetchPr(repo, notification.prNumber); }
        catch { partial = true; continue; }
        try {
          if (!validPr(pr)) { partial = true; continue; }
          if (pr.state !== 'open' || pr.merged || pr.draft || identity(repo, notification.prNumber, pr.headSha) !== notification.id) {
            const reason = pr.state !== 'open' || pr.merged ? 'Pull request is no longer open' : pr.draft ? 'Pull request is a draft' : 'A newer PR revision superseded this queued review';
            store.updateNotification(notification.id, 'blocked', now(), reason);
            continue;
          }
          if (!enabled()) return;
          if (!options.allowedRepos().some(allowed => allowed.toLowerCase() === repo.toLowerCase())) {
            store.updateNotification(notification.id, 'blocked', now(), `Galleon ${repo} is not configured`);
            continue;
          }
          const existing = options.findExistingReview?.(repo, notification.prNumber, pr.headSha);
          if (existing) {
            store.setNotificationRunId(notification.id, existing);
            store.updateNotification(notification.id, 'launched', now());
            continue;
          }
          if (!options.canLaunch(repo)) continue;
          const runId = notification.runId;
          if (!runId) throw new Error('Missing persisted run ID');
          const launched = options.launch({ repo, prNumber: notification.prNumber, mode: 'review', runId, headSha: pr.headSha });
          if (launched !== runId) throw new Error('Launcher returned an unexpected run ID');
          store.updateNotification(notification.id, 'launched', now());
        } catch (error) {
          store.updateNotification(notification.id, 'failed', now(), message(error));
        }
      }
      state.health = { ...state.health, status: partial ? 'partial' : 'healthy',
        lastSuccessAt: partial ? state.health.lastSuccessAt : now(), error: partial ? 'GitHub review request scan was incomplete; queued requests retained' : null };
    } catch (error) {
      state.health = { ...state.health, status: 'unavailable', error: message(error) };
    } finally {
      if (!enabled()) state.health = { ...state.health, enabled: false, status: 'disabled', error: null };
      store.saveSource(state);
    }
  }

  return {
    poll() {
      pending ??= scan().finally(() => { pending = null; });
      return pending;
    },
    health() { return { ...state.health }; },
  };
}
