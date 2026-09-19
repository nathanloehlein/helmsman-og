import Database from 'better-sqlite3';
import { isGithubRepo } from '../../pr-lists';
import type { PrStatus } from '../../github';

export const SLACK_REVIEW_CONFIG_KEYS = ['SLACK_REVIEW_CHANNEL', 'SLACK_REVIEW_MENTION'] as const;

export function slackReviewSettings(env: Record<string, string | undefined>) {
  return {
    token: env.SLACK_BOT_TOKEN?.trim() ?? '',
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

class SlackApiRejection extends SlackReviewError {}

const DEFINITE_REJECTIONS = new Set([
  'not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'token_expired',
  'no_permission', 'missing_scope', 'not_allowed_token_type', 'ekm_access_denied', 'team_access_not_granted',
  'channel_not_found', 'not_in_channel', 'is_archived', 'restricted_action', 'restricted_action_read_only_channel',
  'posting_to_general_channel_denied', 'msg_too_long', 'no_text', 'too_many_attachments', 'invalid_blocks',
  'invalid_arguments', 'invalid_arg_name', 'invalid_array_arg', 'invalid_charset', 'invalid_form_data',
  'invalid_post_type', 'missing_post_type', 'rate_limited', 'ratelimited',
]);

export interface SlackReviewResult {
  ok: true;
  channel: string;
  mention: string;
  permalink: string | null;
}

interface ReviewInput { requestId: string; repo: string; prNumber: number }
interface Receipt extends ReviewInput {
  channelTarget: string;
  mentionTarget: string;
  status: 'pending' | 'sent' | 'failed' | 'uncertain';
  createdAt: number;
  channel: string | null;
  mention: string | null;
  permalink: string | null;
}

interface RequesterDeps {
  settings: () => ReturnType<typeof slackReviewSettings>;
  getPr: (repo: string, prNumber: number) => Promise<PrStatus | null>;
  fetch?: typeof fetch;
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
  return { ok: true, channel: row.channel ?? row.channelTarget, mention: row.mention ?? row.mentionTarget, permalink: row.permalink };
}

export function openSlackReviewRequester(path: string, deps: RequesterDeps): {
  request(input: unknown): Promise<SlackReviewResult>;
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
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const flights = new Map<string, { key: string; promise: Promise<SlackReviewResult> }>();

  async function request(input: ReviewInput): Promise<SlackReviewResult> {
    const settings = deps.settings();
    if (!settings.token) throw new SlackReviewError('Set a Slack bot token in Config to request reviews.', 503);
    if (!/^(?:[CG][A-Z\d]{2,31}|[a-z\d_-]{1,80})$/.test(settings.channel)
      || !/^(?:S[A-Z\d]{2,31}|[a-z\d_-]{1,80})$/.test(settings.mention)) {
      throw new SlackReviewError('Set a valid Slack review channel and user group in Config.', 400);
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
        AND channelTarget = ? AND mentionTarget = ? AND createdAt > ? AND status IN ('pending', 'sent', 'uncertain') ORDER BY createdAt DESC LIMIT 1`)
        .get(input.repo, input.prNumber, settings.channel, settings.mention, now() - 60_000) as Receipt | undefined;
      if (recent?.status === 'sent') {
        sql.prepare(`INSERT INTO slack_review_requests (requestId, repo, prNumber, channelTarget, mentionTarget, status, createdAt, channel, mention, permalink)
          VALUES (@requestId, @repo, @prNumber, @channelTarget, @mentionTarget, 'sent', @createdAt, @channel, @mention, @permalink)
          ON CONFLICT(requestId) DO UPDATE SET status = 'sent', createdAt = excluded.createdAt, channel = excluded.channel, mention = excluded.mention, permalink = excluded.permalink`)
          .run({ ...recent, ...input, createdAt: now() });
        return sentReceipt(recent);
      }
      if (recent) throw new SlackReviewError('A request was just attempted for this PR. Check Slack before requesting again.', 409, true);
      sql.prepare(`INSERT INTO slack_review_requests (requestId, repo, prNumber, channelTarget, mentionTarget, status, createdAt)
        VALUES (@requestId, @repo, @prNumber, @channelTarget, @mentionTarget, 'pending', @createdAt)
        ON CONFLICT(requestId) DO UPDATE SET status = 'pending', createdAt = excluded.createdAt`)
        .run({ ...input, channelTarget: settings.channel, mentionTarget: settings.mention, createdAt: now() });
      return null;
    }).immediate();
    if (reservation) return reservation;

    const api = async (method: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      const write = method === 'chat.postMessage';
      const url = new URL(`https://slack.com/api/${method}`);
      if (!write) for (const [key, value] of Object.entries(body)) url.searchParams.set(key, String(value));
      const response = await fetchImpl(url.href, {
        method: write ? 'POST' : 'GET', headers: { Authorization: `Bearer ${settings.token}`, ...(write ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
        ...(write ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        if ([400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status)) throw new SlackApiRejection(`Slack ${method} failed (${response.status}).`);
        throw new SlackReviewError(`Slack ${method} failed (${response.status}).`);
      }
      const result = object(await response.json());
      if (result?.ok !== true) {
        const code = typeof result?.error === 'string' && /^[a-z_]+$/.test(result.error) ? result.error : 'invalid_response';
        const ErrorType = result?.ok === false && (!write || DEFINITE_REJECTIONS.has(code)) ? SlackApiRejection : SlackReviewError;
        throw new ErrorType(`Slack ${method}: ${code}. Check the bot permissions and channel membership.`);
      }
      return result;
    };

    let posting = false;
    let posted = false;
    try {
      const pr = await deps.getPr(input.repo, input.prNumber);
      if (!pr || pr.isOwnPr !== true || pr.state !== 'open' || pr.merged) {
        throw new SlackReviewError('Review requests are available only for your open pull requests.', 409);
      }
      let channel: Record<string, unknown> | null = null;
      if (/^[CG][A-Z\d]+$/.test(settings.channel)) {
        channel = object((await api('conversations.info', { channel: settings.channel })).channel);
      } else {
        let cursor = '';
        for (let page = 0; page < 100; page++) {
          const result = await api('conversations.list', { types: 'public_channel', exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) });
          channel = (Array.isArray(result.channels) ? result.channels : []).map(object).find(value => value?.name === settings.channel) ?? null;
          if (channel) break;
          const next = object(result.response_metadata)?.next_cursor;
          if (typeof next !== 'string' || !next.trim() || next === cursor) break;
          cursor = next;
        }
      }
      if (typeof channel?.id !== 'string' || !/^[CG][A-Z\d]{2,31}$/.test(channel.id)
        || typeof channel.name !== 'string' || !/^[a-z\d_-]{1,80}$/.test(channel.name) || channel.is_archived === true
        || /^[CG][A-Z\d]+$/.test(settings.channel) && channel.id !== settings.channel) {
        throw new SlackReviewError('Slack review channel was not found. Use a public channel name or a channel ID.', 400);
      }
      const groups = await api('usergroups.list', { include_disabled: false });
      const group = (Array.isArray(groups.usergroups) ? groups.usergroups : []).map(object).find(value =>
        (value?.id === settings.mention || value?.handle === settings.mention) && !value?.date_delete);
      if (typeof group?.id !== 'string' || !/^S[A-Z\d]{2,31}$/.test(group.id)
        || typeof group.handle !== 'string' || !/^[a-z\d_-]{1,80}$/.test(group.handle)) {
        throw new SlackReviewError('Slack review user group was not found. Configure its handle or group ID.', 400);
      }
      const text = `<!subteam^${group.id}|${group.handle}> Could you review this PR? https://github.com/${input.repo}/pull/${input.prNumber}`;
      posting = true;
      const message = await api('chat.postMessage', { channel: channel.id, text, client_msg_id: input.requestId, unfurl_links: false, unfurl_media: false });
      if (message.channel !== channel.id || typeof message.ts !== 'string' || !/^\d+\.\d+$/.test(message.ts)) {
        throw new SlackReviewError('Slack accepted the request but its message receipt could not be verified. Check Slack before retrying.');
      }
      posted = true;
      const result: SlackReviewResult = { ok: true, channel: channel.name, mention: group.handle, permalink: null };
      sql.prepare("UPDATE slack_review_requests SET status = 'sent', channel = ?, mention = ? WHERE requestId = ?")
        .run(result.channel, result.mention, input.requestId);
      try {
        const link = await api('chat.getPermalink', { channel: channel.id, message_ts: message.ts });
        if (typeof link.permalink === 'string') {
          const url = new URL(link.permalink);
          if (url.protocol === 'https:' && url.hostname.endsWith('.slack.com') && !url.username && !url.password
            && url.pathname === `/archives/${channel.id}/p${message.ts.replace('.', '')}`) result.permalink = url.href;
        }
      } catch {}
      sql.prepare('UPDATE slack_review_requests SET permalink = ? WHERE requestId = ?').run(result.permalink, input.requestId);
      return result;
    } catch (error) {
      const uncertain = posting && !(error instanceof SlackApiRejection);
      if (!posted) sql.prepare('UPDATE slack_review_requests SET status = ? WHERE requestId = ?').run(uncertain ? 'uncertain' : 'failed', input.requestId);
      if (uncertain) throw new SlackReviewError('Slack delivery could not be confirmed. Check the channel before requesting again.', 502, true);
      if (error instanceof SlackReviewError) throw error;
      throw new SlackReviewError('Review request could not be prepared. Check GitHub and Slack connectivity.');
    }
  }

  return {
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
