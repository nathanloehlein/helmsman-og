import { slackIntegrationEnabled } from './config';
import Database from 'better-sqlite3';
import { isGithubRepo } from '../../pr-lists';
import type { PrStatus } from '../../github';
import type { SlackReviewRequestState } from '../../../src/data/slackReview';

export const SLACK_REVIEW_CONFIG_KEYS = ['SLACK_REVIEW_CHANNEL', 'SLACK_REVIEW_MENTION'] as const;

export function slackReviewSettings(env: Record<string, string | undefined>) {
  return {
    enabled: slackIntegrationEnabled(env),
    channel: env.SLACK_REVIEW_CHANNEL?.trim().replace(/^#/, '') || 'airo-editing',
    mention: env.SLACK_REVIEW_MENTION?.trim().replace(/^@/, '') || 'airo-editing-squad',
  };
}

export function publicSlackReviewSettings(env: Record<string, string | undefined>): Record<string, string> {
  const settings = slackReviewSettings(env);
  return { SLACK_REVIEW_CHANNEL: settings.channel, SLACK_REVIEW_MENTION: settings.mention };
}

export class SlackReviewError extends Error {
  readonly status: number;
  readonly uncertain: boolean;
  constructor(message: string, status = 502, uncertain = false) { super(message); this.status = status; this.uncertain = uncertain; }
}

export interface SlackReviewResult {
  ok: true;
  channel: string;
  mention: string;
  permalink: string | null;
  sentAt?: string | null;
}

interface ReviewInput { requestId: string; repo: string; prNumber: number }
interface Receipt extends ReviewInput {
  channelTarget: string;
  mentionTarget: string;
  status: 'pending' | 'sent' | 'failed' | 'uncertain';
  createdAt: number;
  sentAt: number | null;
  channel: string | null;
  mention: string | null;
  permalink: string | null;
}

interface RequesterDeps {
  settings: () => ReturnType<typeof slackReviewSettings>;
  getPr: (repo: string, prNumber: number) => Promise<PrStatus | null>;
  send: (input: ReviewInput & { channel: string; mention: string }) => Promise<{
    channel: string;
    mention: string;
    permalink: string | null;
  }>;
  now?: () => number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validateInput(value: unknown): ReviewInput {
  const input = object(value);
  if (typeof input?.repo !== 'string' || !isGithubRepo(input.repo)
    || typeof input.prNumber !== 'number' || !Number.isSafeInteger(input.prNumber) || input.prNumber < 1
    || typeof input.requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(input.requestId)) {
    throw new SlackReviewError('A galleon, PR number, and unique request ID are required.', 400);
  }
  return { repo: input.repo, prNumber: input.prNumber, requestId: input.requestId };
}

function sentReceipt(row: Receipt): SlackReviewResult {
  return { ok: true, channel: row.channel ?? row.channelTarget, mention: row.mention ?? row.mentionTarget, permalink: row.permalink,
    sentAt: row.sentAt === null ? null : new Date(row.sentAt).toISOString() };
}

export function openSlackReviewRequester(path: string, deps: RequesterDeps): {
  request(input: unknown): Promise<SlackReviewResult>;
  list(repo: string | null): SlackReviewRequestState[];
  close(): void;
} {
  const sql = new Database(path);
  sql.pragma('journal_mode = WAL');
  sql.exec(`CREATE TABLE IF NOT EXISTS slack_review_requests (
    requestId TEXT PRIMARY KEY, repo TEXT NOT NULL, prNumber INTEGER NOT NULL,
    channelTarget TEXT NOT NULL, mentionTarget TEXT NOT NULL, status TEXT NOT NULL,
    createdAt INTEGER NOT NULL, channel TEXT, mention TEXT, permalink TEXT
  );
  CREATE INDEX IF NOT EXISTS slack_review_cooldown ON slack_review_requests(repo, prNumber, channelTarget, mentionTarget, createdAt);`);
  const columns = sql.prepare('PRAGMA table_info(slack_review_requests)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'sentAt')) sql.exec('ALTER TABLE slack_review_requests ADD COLUMN sentAt INTEGER');
  const now = deps.now ?? Date.now;
  const flights = new Map<string, { key: string; promise: Promise<SlackReviewResult> }>();

  async function request(input: ReviewInput): Promise<SlackReviewResult> {
    const settings = deps.settings();
    if (!settings.enabled) throw new SlackReviewError('Slack integration is disabled. Enable it in Config.', 409);
    if (!/^(?:[CG][A-Z\d]{2,31}|[a-z\d_-]{1,80})$/.test(settings.channel)
      || !/^[a-z\d_-]{1,80}$/.test(settings.mention)) {
      throw new SlackReviewError('Set a valid Slack review channel and user group handle in Config.', 400);
    }
    const reservation = sql.transaction((): SlackReviewResult | null => {
      const prior = sql.prepare('SELECT * FROM slack_review_requests WHERE requestId = ?').get(input.requestId) as Receipt | undefined;
      if (prior) {
        if (prior.repo !== input.repo || prior.prNumber !== input.prNumber || prior.channelTarget !== settings.channel || prior.mentionTarget !== settings.mention) {
          throw new SlackReviewError('Request ID already belongs to a different review request.', 409);
        }
        if (prior.status === 'sent') return sentReceipt(prior);
        if (prior.status !== 'failed') throw new SlackReviewError('Delivery is pending or unconfirmed. Check Slack before requesting again.', 409, true);
      }
      const recent = sql.prepare(`SELECT * FROM slack_review_requests WHERE repo = ? COLLATE NOCASE AND prNumber = ?
        AND channelTarget = ? AND mentionTarget = ? AND (status IN ('pending', 'uncertain') OR status = 'sent' AND COALESCE(sentAt, createdAt) > ?)
        ORDER BY CASE WHEN status IN ('pending', 'uncertain') THEN 0 ELSE 1 END, createdAt DESC LIMIT 1`)
        .get(input.repo, input.prNumber, settings.channel, settings.mention, now() - 60_000) as Receipt | undefined;
      if (recent?.status === 'sent') {
        sql.prepare(`INSERT INTO slack_review_requests (requestId, repo, prNumber, channelTarget, mentionTarget, status, createdAt, channel, mention, permalink, sentAt)
          VALUES (@requestId, @repo, @prNumber, @channelTarget, @mentionTarget, 'sent', @createdAt, @channel, @mention, @permalink, @sentAt)
          ON CONFLICT(requestId) DO UPDATE SET status = 'sent', createdAt = excluded.createdAt, channel = excluded.channel, mention = excluded.mention, permalink = excluded.permalink, sentAt = excluded.sentAt`)
          .run({ ...recent, ...input, createdAt: now() });
        return sentReceipt(recent);
      }
      if (recent) throw new SlackReviewError('Delivery is pending or unconfirmed. Check Slack before requesting again.', 409, true);
      sql.prepare(`INSERT INTO slack_review_requests (requestId, repo, prNumber, channelTarget, mentionTarget, status, createdAt)
        VALUES (@requestId, @repo, @prNumber, @channelTarget, @mentionTarget, 'pending', @createdAt)
        ON CONFLICT(requestId) DO UPDATE SET status = 'pending', createdAt = excluded.createdAt`)
        .run({ ...input, channelTarget: settings.channel, mentionTarget: settings.mention, createdAt: now() });
      return null;
    }).immediate();
    if (reservation) return reservation;

    let senderStarted = false;
    try {
      const pr = await deps.getPr(input.repo, input.prNumber);
      if (!pr || pr.isOwnPr !== true || pr.state !== 'open' || pr.merged) {
        throw new SlackReviewError('Review requests are available only for your open pull requests.', 409);
      }
      if (!deps.settings().enabled) throw new SlackReviewError('Slack integration is disabled. Enable it in Config.', 409);
      senderStarted = true;
      const receipt = object(await deps.send({ ...input, channel: settings.channel, mention: settings.mention }));
      if (typeof receipt?.channel !== 'string' || !/^(?:[CG][A-Z\d]{2,31}|[a-z\d_-]{1,80})$/.test(receipt.channel)
        || typeof receipt.mention !== 'string' || !/^[a-z\d_-]{1,80}$/.test(receipt.mention)
        || !(receipt.permalink === null || typeof receipt.permalink === 'string')) {
        throw new SlackReviewError('Slack delivery returned an invalid receipt. Check the channel before requesting again.', 502, true);
      }
      let permalink: string | null = null;
      if (typeof receipt.permalink === 'string') {
        try {
          const url = new URL(receipt.permalink);
          if (url.protocol === 'https:' && url.hostname.endsWith('.slack.com') && !url.username && !url.password
            && /^\/archives\/[CG][A-Z\d]+\/p\d+$/.test(url.pathname)) permalink = url.href;
        } catch {}
      }
      const sentAt = now();
      const result: SlackReviewResult = { ok: true, channel: receipt.channel, mention: receipt.mention, permalink, sentAt: new Date(sentAt).toISOString() };
      sql.prepare("UPDATE slack_review_requests SET status = 'sent', channel = ?, mention = ?, permalink = ?, sentAt = ? WHERE requestId = ?")
        .run(result.channel, result.mention, result.permalink, sentAt, input.requestId);
      return result;
    } catch (error) {
      const uncertain = senderStarted && (!(error instanceof SlackReviewError) || error.uncertain);
      sql.prepare('UPDATE slack_review_requests SET status = ? WHERE requestId = ?').run(uncertain ? 'uncertain' : 'failed', input.requestId);
      if (error instanceof SlackReviewError) throw new SlackReviewError(error.message, error.status, uncertain);
      if (uncertain) throw new SlackReviewError('Slack delivery could not be confirmed. Check the channel before requesting again.', 502, true);
      throw new SlackReviewError('Review request could not be prepared. Check GitHub connectivity.');
    }
  }

  return {
    list(repo) {
      if (repo !== null && (typeof repo !== 'string' || !isGithubRepo(repo))) throw new SlackReviewError('Galleon must be owner/name.', 400);
      const rows = sql.prepare(`SELECT * FROM slack_review_requests${repo === null ? '' : ' WHERE repo = ? COLLATE NOCASE'} ORDER BY createdAt DESC, rowid DESC`)
        .all(...(repo === null ? [] : [repo])) as Receipt[];
      const states = new Map<string, SlackReviewRequestState>();
      const sent = new Set<string>();
      for (const row of rows) {
        const key = `${row.repo.toLowerCase()}#${row.prNumber}`;
        let state = states.get(key);
        if (!state) {
          state = { requestId: row.requestId, repo: row.repo, prNumber: row.prNumber, status: row.status, lastRequestedAt: new Date(row.createdAt).toISOString(), lastSentAt: null, permalink: null, error: null };
          states.set(key, state);
        }
        if (row.status === 'sent' && (!sent.has(key) || row.sentAt !== null
          && (state.lastSentAt === null || row.sentAt > Date.parse(state.lastSentAt)))) {
          state.lastSentAt = row.sentAt === null ? null : new Date(row.sentAt).toISOString();
          state.permalink = row.permalink;
          sent.add(key);
        }
      }
      return [...states.values()];
    },
    request(value) {
      let input: ReviewInput;
      try { input = validateInput(value); } catch (error) { return Promise.reject(error); }
      const key = `${input.repo}#${input.prNumber}`;
      const existing = flights.get(input.requestId);
      if (existing) return existing.key === key ? existing.promise : Promise.reject(new SlackReviewError('Request ID is already in use.', 409));
      const promise = request(input).finally(() => flights.delete(input.requestId));
      flights.set(input.requestId, { key, promise });
      return promise;
    },
    close: () => sql.close(),
  };
}
