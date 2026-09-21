import { createHash } from 'node:crypto';
import { isGithubRepo } from '../../pr-lists';
import type { SlackHealth, SlackSourceState, SlackStore } from './store';

export interface SlackMessage {
  channelId: string;
  ts: string;
  permalink: string;
  author: string;
  prUrls: string[];
}

export interface SlackSource {
  scan(options: { since: string | null }): Promise<{ messages: SlackMessage[]; complete: boolean }>;
}

export interface SlackWatcherOptions {
  store: SlackStore;
  clientId: string;
  channelId: string;
  channelName: string;
  source: SlackSource;
  allowedRepos: () => readonly string[];
  canLaunch: (repo: string) => boolean;
  isOwnPr: (repo: string, prNumber: number) => Promise<boolean | null>;
  getRun: (runId: string) => unknown;
  isRunActive: (runId: string) => boolean;
  launch: (input: { repo: string; prNumber: number; mode: 'review'; runId: string }) => string;
  now?: () => string;
  intervalMs?: number;
}

export interface SlackWatcher {
  poll(): Promise<void>;
  health(): SlackHealth;
}

export function parsePullRequestUrl(value: unknown): { repo: string; prNumber: number; prUrl: string } | null {
  if (typeof value !== 'string' || !/^https:\/\/github\.com\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) return null;
    const match = /^\/([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(url.pathname);
    if (!match) return null;
    const prNumber = Number(match[3]);
    if (!Number.isSafeInteger(prNumber)) return null;
    const repo = `${match[1]}/${match[2]}`.toLowerCase();
    if (!isGithubRepo(repo)) return null;
    return { repo, prNumber, prUrl: `https://github.com/${repo}/pull/${prNumber}` };
  } catch { return null; }
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{10,}\.\d{1,6}$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSlackWatcher(options: SlackWatcherOptions): SlackWatcher {
  const { store } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const intervalMs = options.intervalMs ?? 300_000;
  const key = JSON.stringify([options.clientId, options.channelId]);
  const state: SlackSourceState = store.ensureSource(key, now(), {
    enabled: true, status: 'unavailable', channelName: options.channelName,
    intervalMs, lastSuccessAt: null, error: 'Waiting for first scan',
  });
  state.health = { ...state.health, enabled: true, channelName: options.channelName, intervalMs };
  const activatedTs = Date.parse(state.activatedAt) / 1000;
  let pending: Promise<void> | null = null;

  async function drainQueue(): Promise<void> {
    for (const notification of store.launchedNotifications(key)) {
      const run = notification.runId ? options.getRun(notification.runId) : null;
      if (run && typeof run === 'object' && 'status' in run && run.status === 'failed') {
        store.updateNotification(notification.id, 'failed', now(), 'PR run failed; open the run for details');
      } else if (!run && notification.runId && !options.isRunActive(notification.runId)) {
        store.updateNotification(notification.id, 'queued', now());
      }
    }
    const allowed = new Map(options.allowedRepos().map(repo => [repo.toLowerCase(), repo]));
    for (const notification of store.queuedNotifications(key)) {
      const runId = notification.runId;
      if (!runId) {
        store.updateNotification(notification.id, 'failed', now(), 'Missing persisted run ID');
        continue;
      }
      try {
        const run = options.getRun(runId);
        if (run || options.isRunActive(runId)) {
          const failed = run && typeof run === 'object' && 'status' in run && run.status === 'failed';
          store.updateNotification(notification.id, failed ? 'failed' : 'launched', now(), failed ? 'PR run failed; open the run for details' : null);
          continue;
        }
        const repo = allowed.get(notification.repo.toLowerCase());
        if (!repo) {
          store.updateNotification(notification.id, 'blocked', now(), `Galleon ${notification.repo} is not configured`);
          continue;
        }
        if (!options.canLaunch(repo)) continue;
        let isOwnPr: boolean | null;
        try { isOwnPr = await options.isOwnPr(repo, notification.prNumber); }
        catch { isOwnPr = null; }
        if (isOwnPr === true) {
          store.updateNotification(notification.id, 'blocked', now(), 'Automatic Slack review skipped: this is your pull request');
          continue;
        }
        if (isOwnPr !== false) {
          store.updateNotification(notification.id, 'queued', now(), 'Could not verify pull request ownership; will retry');
          continue;
        }
        if (!options.allowedRepos().some(allowed => allowed.toLowerCase() === repo.toLowerCase()) || !options.canLaunch(repo)) continue;
        if (options.getRun(runId) || options.isRunActive(runId)) {
          store.updateNotification(notification.id, 'launched', now());
          continue;
        }
        const launchedId = options.launch({ repo, prNumber: notification.prNumber, mode: 'review', runId });
        if (launchedId !== runId) throw new Error('Launcher returned an unexpected run ID');
        store.updateNotification(notification.id, 'launched', now());
      } catch (error) {
        store.updateNotification(notification.id, 'failed', now(), errorMessage(error));
      }
    }
  }

  async function scan(): Promise<void> {
    state.health = { ...state.health, status: 'scanning', error: null };
    store.saveSource(state);
    try {
      const cursorTs = timestamp(state.cursor) ?? activatedTs;
      const since = Math.max(activatedTs, cursorTs - 300).toFixed(6);
      const result = await options.source.scan({ since });
      if (!result || !Array.isArray(result.messages) || typeof result.complete !== 'boolean') throw new Error('Invalid Slack scan response');
      let nextCursor = cursorTs;
      for (const message of result.messages) {
        const ts = timestamp(message?.ts);
        if (!message || message.channelId !== options.channelId || ts === null || ts < activatedTs) continue;
        nextCursor = Math.max(nextCursor, ts);
        for (const value of Array.isArray(message.prUrls) ? message.prUrls : []) {
          const pr = parsePullRequestUrl(value);
          if (!pr) continue;
          const id = createHash('sha256').update(JSON.stringify([key, message.channelId, message.ts, pr.prUrl])).digest('hex');
          const createdAt = now();
          store.insertNotification(key, {
            id, ...pr, sourceUrl: typeof message.permalink === 'string' ? message.permalink : '',
            author: typeof message.author === 'string' ? message.author : 'Unknown',
            channelName: options.channelName, status: 'queued', runId: `slack-${id}`,
            createdAt, updatedAt: createdAt, readAt: null, error: null,
          });
        }
      }
      if (result.complete) {
        state.cursor = nextCursor.toFixed(6);
        state.health = { ...state.health, status: 'healthy', lastSuccessAt: now(), error: null };
      } else {
        state.health = { ...state.health, status: 'partial', error: 'Slack scan was incomplete; cursor retained for retry' };
      }
    } catch (error) {
      state.health = { ...state.health, status: 'unavailable', error: errorMessage(error) };
    } finally {
      store.saveSource(state);
      await drainQueue();
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
