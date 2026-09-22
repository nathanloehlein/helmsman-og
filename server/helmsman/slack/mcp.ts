import { SlackReviewError } from './review-request';
import { parsePullRequestUrl, type SlackMessage } from './watcher';

export const SLACK_MCP_URL = 'https://mcp-slack.goarena.gdcorp.tools/mcp';
const CHANNEL_ID = /^[CG][A-Z\d]{2,31}$/;
const NAME = /^[a-z\d_-]{1,80}$/;
const TIMESTAMP = /^\d{10,}\.\d{6}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface SlackMcpOptions {
  accessToken: () => Promise<string>;
  teamId: () => string;
  channelId: () => string;
  channelName: () => string;
  mentionGroupId: () => string;
  canSend?: () => boolean;
  connectionVersion?: () => string;
  fetcher?: typeof fetch;
  now?: () => number;
}

interface ReviewInput { requestId: string; repo: string; prNumber: number; channel: string; mention: string }

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function protocolError(): Error { return new Error('Slack MCP returned an invalid response.'); }

async function readResponse(response: Response, id: number): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw protocolError();
  const decoder = new TextDecoder();
  const events = response.headers.get('content-type')?.includes('text/event-stream') === true;
  let buffer = '';
  let bytes = 0;
  const parse = (text: string) => {
    let value: Record<string, unknown> | null;
    try { value = object(JSON.parse(text)); } catch { throw protocolError(); }
    if (value?.jsonrpc !== '2.0') throw protocolError();
    return value;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      bytes += value?.byteLength ?? 0;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Slack MCP response exceeded the size limit.');
      buffer += decoder.decode(value, { stream: !done });
      if (events) {
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          const message = parse(data);
          if (message.id === id) return message;
        }
      }
      if (done) {
        if (events) throw protocolError();
        const message = parse(buffer);
        if (message.id !== id) throw protocolError();
        return message;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createSlackMcp(options: SlackMcpOptions) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let requestId = 0;

  function configuration() {
    const teamId = options.teamId();
    const channelId = options.channelId();
    const channelName = options.channelName();
    if (!/^T[A-Z\d]{2,31}$/.test(teamId) || !CHANNEL_ID.test(channelId) || !NAME.test(channelName)) {
      throw new SlackReviewError('Configure the Slack workspace ID, channel ID, and channel name.', 503);
    }
    return { teamId, channelId, channelName };
  }

  async function connection() {
    const config = configuration();
    const token = await options.accessToken();
    if (!token || /[\r\n]/.test(token)) throw new SlackReviewError('Connect your Slack account in Config.', 401);
    let sessionId: string | null = null;
    let protocolVersion = '2025-03-26';
    async function rpc(method: string, params?: Record<string, unknown>, beforeFetch?: () => void) {
      const notification = method === 'notifications/initialized';
      const id = ++requestId;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': protocolVersion,
        };
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        beforeFetch?.();
        const response = await fetcher(SLACK_MCP_URL, {
          method: 'POST', headers, redirect: 'error', signal: controller.signal,
          body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id } : {}), method, ...(params ? { params } : {}) }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new SlackReviewError(response.status === 401 || response.status === 403
            ? 'Slack authentication was rejected. Reconnect your Slack account in Config.'
            : `Slack MCP is unavailable (HTTP ${response.status}).`, response.status === 401 || response.status === 403 ? 401 : 502);
        }
        if (method === 'initialize') sessionId = response.headers.get('mcp-session-id');
        if (notification) { await response.body?.cancel(); return {}; }
        const message = await readResponse(response, id);
        if (message.error || !object(message.result)) throw protocolError();
        return object(message.result)!;
      } finally { clearTimeout(timeout); }
    }
    const initialized = await rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'helmsman', version: '0.3.0' } });
    if (typeof initialized.protocolVersion !== 'string' || !['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(initialized.protocolVersion)) throw protocolError();
    protocolVersion = initialized.protocolVersion;
    await rpc('notifications/initialized');
    async function call(name: string, args: Record<string, unknown>, beforeFetch?: () => void) {
      const result = await rpc('tools/call', { name, arguments: { ...args, team_id: config.teamId } }, beforeFetch);
      if (result.isError === true || !Array.isArray(result.content)) throw new Error('Slack MCP could not complete the operation.');
      const texts = result.content.flatMap(item => {
        const part = object(item);
        return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
      });
      if (texts.length !== 1) throw protocolError();
      let data: Record<string, unknown> | null;
      try { data = object(JSON.parse(texts[0]!)); } catch { throw protocolError(); }
      if (!data) throw protocolError();
      if (data.error || data.ok === false) {
        const code = typeof data.error === 'string' && /^[a-z_]{1,80}$/.test(data.error) ? ` (${data.error})` : '';
        throw new Error(`Slack rejected the operation${code}.`);
      }
      return data;
    }
    async function channel(target: string) {
      const id = [config.channelId, config.channelName].includes(target) ? config.channelId : CHANNEL_ID.test(target) ? target : null;
      const data = await call(id ? 'get_channel_info' : 'get_channel_info_by_name', id ? { channel_id: id } : { channel_name: target });
      if (typeof data.id !== 'string' || !CHANNEL_ID.test(data.id) || typeof data.name !== 'string' || !NAME.test(data.name)
        || (id ? data.id !== id : data.name !== target)
        || (data.id === config.channelId && data.name !== config.channelName)
        || (typeof data.context_team_id === 'string' && data.context_team_id !== config.teamId)
        || (typeof data.team_id === 'string' && data.team_id !== config.teamId)
        || data.is_archived === true || data.is_im === true || data.is_mpim === true) {
        throw new SlackReviewError('Slack returned an unexpected or unavailable workspace/channel.', 409);
      }
      return { id: data.id, name: data.name };
    }
    return { config, call, channel, tokenIsCurrent: async () => await options.accessToken() === token };
  }

  return {
    async check(): Promise<void> {
      const client = await connection();
      await client.channel(client.config.channelId);
    },
    async scan({ since }: { since: string | null }): Promise<{ messages: SlackMessage[]; complete: boolean }> {
      const sinceMs = since === null ? now() : /^\d+\.\d+$/.test(since) ? Number(since) * 1000 : Date.parse(since);
      if (!Number.isFinite(sinceMs) || sinceMs < 0) throw new Error('Invalid Slack scan cursor.');
      const client = await connection();
      const channel = await client.channel(client.config.channelId);
      const after = new Date(sinceMs - 2 * 86_400_000).toISOString().slice(0, 10);
      const query = `in:${channel.id} after:${after} github.com`;
      const messages = new Map<string, SlackMessage>();
      let total: number | null = null;
      const deadline = now() + 90_000;
      for (let page = 1; page <= 50 && now() < deadline; page++) {
        const data = await client.call('search_messages', { query, count: 100, page });
        const paging = object(data.paging);
        if (!Array.isArray(data.matches) || !paging || !Number.isSafeInteger(paging.total) || Number(paging.total) < 0
          || !Number.isSafeInteger(paging.pages) || Number(paging.pages) < 0 || paging.page !== page) throw protocolError();
        if (total !== null && total !== paging.total) return { messages: [...messages.values()], complete: false };
        total = Number(paging.total);
        for (const match of data.matches) {
          const row = object(match);
          const matchChannel = object(row?.channel);
          if (matchChannel?.id !== channel.id || typeof row?.ts !== 'string' || !TIMESTAMP.test(row.ts)
            || typeof row.text !== 'string' || typeof row.permalink !== 'string') throw protocolError();
          const link = new URL(row.permalink);
          if (link.protocol !== 'https:' || !link.hostname.endsWith('.slack.com') || link.port || link.username || link.password
            || link.pathname !== `/archives/${channel.id}/p${row.ts.replace('.', '')}`) throw protocolError();
          const urls = JSON.stringify({ text: row.text, attachments: row.attachments, blocks: row.blocks }).match(/https:\/\/github\.com\/[^\s<>"|\\]+/gi) ?? [];
          const prUrls = [...new Set(urls.flatMap(value => {
            const pr = parsePullRequestUrl(value.replace(/[),.;!?]+$/, ''));
            return pr ? [pr.prUrl] : [];
          }))];
          messages.set(row.ts, { channelId: channel.id, ts: row.ts, permalink: link.href,
            author: typeof row.user === 'string' ? row.user : typeof row.username === 'string' ? row.username : 'Unknown', prUrls });
        }
        if (page >= Number(paging.pages)) return { messages: [...messages.values()], complete: messages.size === total };
        if (!data.matches.length) break;
      }
      return { messages: [...messages.values()], complete: false };
    },
    async send(input: ReviewInput): Promise<{ channel: string; mention: string; permalink: string | null }> {
      let attempted = false;
      try {
        const pr = parsePullRequestUrl(`https://github.com/${input?.repo}/pull/${input?.prNumber}`);
        if (!pr || !Number.isSafeInteger(input?.prNumber) || typeof input?.requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(input.requestId)
          || typeof input.channel !== 'string' || !(CHANNEL_ID.test(input.channel) || NAME.test(input.channel)) || typeof input.mention !== 'string' || !NAME.test(input.mention)) {
          throw new SlackReviewError('Use a valid PR, request ID, Slack channel, and user group handle.', 400);
        }
        const version = options.connectionVersion?.();
        const config = configuration();
        const groupId = options.mentionGroupId();
        const assertCurrent = () => {
          const current = configuration();
          if (options.canSend?.() === false || options.connectionVersion?.() !== version || options.mentionGroupId() !== groupId
            || current.teamId !== config.teamId || current.channelId !== config.channelId || current.channelName !== config.channelName) {
            throw new SlackReviewError('Slack connection or review settings changed. Nothing was sent; try again.', 409);
          }
        };
        assertCurrent();
        if (!/^S[A-Z\d]{2,31}$/.test(groupId)) throw new SlackReviewError('Configure the Slack review user group ID (starting with S) to send a real group mention.', 409);
        const client = await connection();
        const channel = await client.channel(input.channel);
        assertCurrent();
        if (!await client.tokenIsCurrent()) throw new SlackReviewError('Slack account changed. Nothing was sent; try again.', 409);
        assertCurrent();
        const sent = await client.call('send_message', { channel_id: channel.id,
          text: `<!subteam^${groupId}|${input.mention}> Could you review this PR? ${pr.prUrl}` }, () => { attempted = true; });
        if (sent.channel !== channel.id || typeof sent.ts !== 'string' || !TIMESTAMP.test(sent.ts)) throw protocolError();
        return { channel: channel.name, mention: input.mention, permalink: `https://app.slack.com/archives/${channel.id}/p${sent.ts.replace('.', '')}` };
      } catch (error) {
        if (attempted) throw new SlackReviewError('Slack delivery could not be confirmed. Check the channel before requesting again.', 502, true);
        if (error instanceof SlackReviewError) throw error;
        throw new SlackReviewError('Slack request could not be prepared. Check the Slack connection and review settings in Config.', 503);
      }
    },
  };
}
