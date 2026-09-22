import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSlackMcp, startSlackOAuth } from './slackMcp';

const connected = { status: 'connected', configured: true, connected: true, teamId: 'T123', userId: 'U123', redirectUri: 'https://example.com/callback', message: 'Connected' };
afterEach(() => vi.unstubAllGlobals());

describe('Slack MCP requests', () => {
  it('validates connection responses and uses JSON POSTs for mutations', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(connected));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchSlackMcp('check')).toEqual(connected);
    expect(fetcher).toHaveBeenCalledWith('/api/slack/mcp/check', expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    fetcher.mockResolvedValueOnce(Response.json(connected));
    expect(await fetchSlackMcp('disconnect')).toEqual(connected);
    expect(fetcher).toHaveBeenLastCalledWith('/api/slack/oauth/disconnect', expect.objectContaining({ method: 'POST', body: '{}' }));
  });

  it.each([null, [], {}, { ...connected, connected: 'yes' }, { ...connected, teamId: {} }, { ...connected, status: 'unknown' }])('rejects malformed status %j', async value => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(value)));
    expect(await fetchSlackMcp()).toBeNull();
  });

  it.each(['https://evil.example/oauth/v2/authorize', 'http://slack.com/oauth/v2/authorize', 'https://slack.com.evil.example/oauth/v2/authorize', 'https://slack.com@evil.example/oauth/v2/authorize', 'https://slack.com/other', 'https://user@slack.com/oauth/v2/authorize'])('blocks untrusted OAuth redirects %s', async authorizationUrl => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ authorizationUrl })));
    expect(await startSlackOAuth()).toEqual({ error: expect.stringContaining('Could not start Slack authorization') });
  });

  it('preserves actionable server errors', async () => {
    const error = 'Open Helmsman at https://helmsman.example.com/config to connect Slack';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error }, { status: 400 })));
    expect(await startSlackOAuth()).toEqual({ error });
  });

  it('accepts the Slack OAuth authorization URL', async () => {
    const authorizationUrl = 'https://slack.com/oauth/v2/authorize?client_id=123&state=example';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ authorizationUrl })));
    expect(await startSlackOAuth()).toEqual({ authorizationUrl });
  });
});
