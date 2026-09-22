import { describe, expect, it, vi } from 'vitest';
import { createSlackMcp, SLACK_MCP_URL } from './mcp';

const input = { requestId: '11111111-1111-4111-8111-111111111111', repo: 'owner/repo', prNumber: 42, channel: 'reviews', mention: 'reviewers' };
const channel = { id: 'C123', name: 'reviews', context_team_id: 'T123' };
const message = (ts = '1700000000.000001') => ({ ts, channel: { id: 'C123' }, user: 'U123', text: '<https://github.com/owner/repo/pull/42|PR>', permalink: `https://example.slack.com/archives/C123/p${ts.replace('.', '')}` });

function fixture(options: { sse?: boolean; tool?: (name: string, args: Record<string, unknown>) => unknown; channel?: unknown; group?: string;
  token?: () => Promise<string>; raw?: (name: string, id: number) => Response | null;
  canSend?: () => boolean; connectionVersion?: () => string; teamId?: () => string; channelId?: () => string; channelName?: () => string;
} = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const requests: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe(SLACK_MCP_URL);
    expect(init?.redirect).toBe('error');
    expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer test-token');
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    requests.push(body);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result: unknown = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'slack', version: '1' } };
    if (body.method === 'tools/call') {
      const name = String(body.params.name);
      const args = body.params.arguments as Record<string, unknown>;
      calls.push({ name, args });
      const raw = options.raw?.(name, body.id);
      if (raw) return raw;
      const data = name === 'get_channel_info' || name === 'get_channel_info_by_name' ? options.channel ?? channel
        : options.tool?.(name, args) ?? (name === 'send_message' ? { channel: 'C123', ts: '1700000000.000001' }
          : { matches: [message()], paging: { total: 1, pages: 1, page: 1 } });
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    const value = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    return options.sse ? new Response(`: ping\r\n\r\nevent: message\r\ndata: ${value}\r\n\r\n`, { headers: { 'content-type': 'text/event-stream' } })
      : new Response(value, { headers: { 'content-type': 'application/json' } });
  });
  const client = createSlackMcp({ accessToken: options.token ?? (async () => 'test-token'), teamId: options.teamId ?? (() => 'T123'),
    channelId: options.channelId ?? (() => 'C123'), channelName: options.channelName ?? (() => 'reviews'),
    mentionGroupId: () => options.group ?? 'S123', canSend: options.canSend, connectionVersion: options.connectionVersion, fetcher });
  return { client, calls, requests, fetcher };
}

describe('Slack MCP transport', () => {
  it.each([false, true])('initializes and checks the exact configured channel read-only (SSE=%s)', async sse => {
    const { client, requests, calls } = fixture({ sse });
    await client.check();
    expect(requests.map(request => request.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    expect(calls).toEqual([{ name: 'get_channel_info', args: { team_id: 'T123', channel_id: 'C123' } }]);
  });

  it.each([{ ...channel, context_team_id: 'TOTHER' }, { ...channel, id: 'COTHER' }, { ...channel, name: 'other' }, { ...channel, is_archived: true }])('rejects an unexpected channel before sending', async wrong => {
    const { client, calls } = fixture({ channel: wrong });
    await expect(client.send(input)).rejects.toMatchObject({ status: 409, uncertain: false });
    expect(calls.some(call => call.name === 'send_message')).toBe(false);
  });

  it('posts one real user-group mention and returns a validated receipt', async () => {
    const { client, calls } = fixture();
    await expect(client.send(input)).resolves.toEqual({ channel: 'reviews', mention: 'reviewers', permalink: 'https://app.slack.com/archives/C123/p1700000000000001' });
    expect(calls.at(-1)).toEqual({ name: 'send_message', args: { team_id: 'T123', channel_id: 'C123', text: '<!subteam^S123|reviewers> Could you review this PR? https://github.com/owner/repo/pull/42' } });
  });

  it('resolves an alternate channel by its exact name', async () => {
    const { client, calls } = fixture({ channel: { ...channel, name: 'other', id: 'COTHER' }, tool: () => ({ channel: 'COTHER', ts: '1700000000.000001' }) });
    await expect(client.send({ ...input, channel: 'other' })).resolves.toMatchObject({ channel: 'other' });
    expect(calls[0]).toEqual({ name: 'get_channel_info_by_name', args: { team_id: 'T123', channel_name: 'other', types: 'public_channel' } });
  });

  it('requires an actual configured user-group ID before any network request', async () => {
    const { client, fetcher } = fixture({ group: '@reviewers' });
    await expect(client.send(input)).rejects.toMatchObject({ status: 409, uncertain: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not mark preflight authentication failure as uncertain delivery', async () => {
    const { client, fetcher } = fixture({ token: async () => { throw new Error('authentication needed'); } });
    await expect(client.send(input)).rejects.toMatchObject({ uncertain: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['missing', 'changed'])('aborts safely when credentials are %s after channel lookup', async change => {
    const token = vi.fn().mockResolvedValueOnce('test-token');
    if (change === 'missing') token.mockRejectedValue(new Error('Disconnected'));
    else token.mockResolvedValue('replacement-token');
    const { client, calls } = fixture({ token });
    await expect(client.send(input)).rejects.toMatchObject({ uncertain: false });
    expect(calls.some(call => call.name === 'send_message')).toBe(false);
    expect(token).toHaveBeenCalledTimes(2);
  });

  it.each(['team', 'channel', 'name', 'group', 'version', 'disabled'])('aborts safely when %s changes during preflight', async change => {
    let changed = false;
    const options = {
      teamId: () => changed && change === 'team' ? 'TOTHER' : 'T123',
      channelId: () => changed && change === 'channel' ? 'COTHER' : 'C123',
      channelName: () => changed && change === 'name' ? 'other' : 'reviews',
      group: 'S123',
      connectionVersion: () => changed && change === 'version' ? '2' : '1',
      canSend: () => !(changed && change === 'disabled'),
      raw: (name: string) => {
        if (name === 'get_channel_info') { changed = true; if (change === 'group') options.group = 'SOTHER'; }
        return null;
      },
    };
    const { client, calls } = fixture(options);
    await expect(client.send(input)).rejects.toMatchObject({ status: 409, uncertain: false });
    expect(calls.some(call => call.name === 'send_message')).toBe(false);
  });

  it('rechecks settings after awaiting the credential revalidation', async () => {
    let enabled = true;
    const token = vi.fn().mockResolvedValueOnce('test-token').mockImplementation(async () => { enabled = false; return 'test-token'; });
    const { client, calls } = fixture({ token, canSend: () => enabled });
    await expect(client.send(input)).rejects.toMatchObject({ status: 409, uncertain: false });
    expect(calls.some(call => call.name === 'send_message')).toBe(false);
  });

  it('does not start a connection when sends are disabled', async () => {
    const { client, fetcher } = fixture({ canSend: () => false });
    await expect(client.send(input)).rejects.toMatchObject({ status: 409, uncertain: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['lost', 'malformed', 'wrong-channel', 'wrong-timestamp', 'http'])('never retries a send with an unconfirmed %s response', async failure => {
    const { client, calls } = fixture({
      raw: name => name !== 'send_message' ? null : failure === 'http' ? new Response(null, { status: 502 }) : failure === 'malformed' ? new Response('broken') : null,
      tool: () => {
        if (failure === 'lost') throw new Error('connection lost');
        return { channel: failure === 'wrong-channel' ? 'COTHER' : 'C123', ts: failure === 'wrong-timestamp' ? 'not-a-timestamp' : '1700000000.000001' };
      },
    });
    await expect(client.send(input)).rejects.toMatchObject({ status: 502, uncertain: true });
    expect(calls.filter(call => call.name === 'send_message')).toHaveLength(1);
  });

  it('searches messages including thread replies, with overlap and page traversal', async () => {
    const { client, calls } = fixture({ tool: (_name, args) => ({ matches: [{ ...message(`170000000${Number(args.page)}.000001`), thread_ts: '1600000000.000001' }], paging: { total: 2, pages: 2, page: args.page } }) });
    const result = await client.scan({ since: '1700000000.000000' });
    expect(result.complete).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ channelId: 'C123', author: 'U123', prUrls: ['https://github.com/owner/repo/pull/42'] });
    expect(calls.filter(call => call.name === 'search_messages').map(call => call.args)).toEqual([1, 2].map(page => ({ team_id: 'T123', query: 'in:C123 after:2023-11-12 github.com', count: 100, page })));
    expect(calls.some(call => call.name === 'get_channel_history')).toBe(false);
  });

  it('accepts a verified empty search', async () => {
    const { client } = fixture({ tool: () => ({ matches: [], paging: { total: 0, pages: 0, page: 1 } }) });
    await expect(client.scan({ since: null })).resolves.toEqual({ messages: [], complete: true });
  });

  it.each(['changing-total', 'duplicate-page', 'limit'])('retains scan cursor when pagination is incomplete: %s', async reason => {
    const { client, calls } = fixture({ tool: (_name, args) => ({ matches: [message(reason === 'limit' ? `170000${String(args.page).padStart(4, '0')}.000001` : '1700000000.000001')],
      paging: { total: reason === 'limit' ? 51 : reason === 'changing-total' ? Number(args.page) + 1 : 2, pages: reason === 'limit' ? 51 : 2, page: args.page } }) });
    const result = await client.scan({ since: null });
    expect(result.complete).toBe(false);
    if (reason === 'limit') expect(calls.filter(call => call.name === 'search_messages')).toHaveLength(50);
  });

  it.each([{ ...message(), channel: { id: 'COTHER' } }, { ...message(), permalink: 'https://evil.example/archives/C123/p1700000000000001' }, { ...message(), ts: null }])('rejects untrusted search identities', async match => {
    const { client } = fixture({ tool: () => ({ matches: [match], paging: { total: 1, pages: 1, page: 1 } }) });
    await expect(client.scan({ since: null })).rejects.toThrow();
  });

  it('rejects MCP tool errors without leaking their response content', async () => {
    const { client } = fixture({ raw: (_name, id) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'secret-token' }] } })) });
    await expect(client.check()).rejects.toThrow('Slack MCP could not complete the operation.');
  });

  it('bounds response size', async () => {
    const { client } = fixture({ raw: () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
    await expect(client.check()).rejects.toThrow('size limit');
  });
});
