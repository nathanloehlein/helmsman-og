import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleSlackConnection } from './oauth-http';
import { openSlackOAuth, SLACK_USER_SCOPES } from './oauth';

const resources: Array<{ server: Server; oauth: ReturnType<typeof openSlackOAuth> }> = [];
afterEach(async () => {
  for (const { server, oauth } of resources.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    oauth.close();
  }
});

const callbackOrigin = 'https://helmsman.example';
const settings = {
  clientId: '123.456', clientSecret: 'private-client-secret', teamId: 'T123',
  redirectUri: `${callbackOrigin}/api/slack/oauth/callback`,
};

async function fixture() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => new Response(JSON.stringify(
    String(url).endsWith('/auth.test')
      ? { ok: true, team_id: 'T123', user_id: 'U123' }
      : {
        ok: true, team: { id: 'T123' }, authed_user: {
          id: 'U123', access_token: 'private-access-token', token_type: 'user', scope: SLACK_USER_SCOPES.join(','),
        },
      },
  )));
  const oauth = openSlackOAuth({ path: ':memory:', settings: () => settings, fetcher });
  const check = vi.fn(async () => {});
  const connected = vi.fn();
  const disconnected = vi.fn();
  const deps = { oauth, check, connected, disconnected };
  const server = createServer((req, res) => {
    void handleSlackConnection(req, res, new URL(req.url ?? '/', 'http://localhost'), deps)
      .then(handled => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  resources.push({ server, oauth });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test HTTP server has no port');
  const origin = `http://127.0.0.1:${address.port}`;
  function request(path: string, init: RequestInit = {}) { return fetch(`${origin}${path}`, { redirect: 'manual', ...init }); }
  function post(path: string, headers: Record<string, string> = {}) {
    return request(path, { method: 'POST', headers: { Origin: callbackOrigin, 'Content-Type': 'application/json', ...headers }, body: '{}' });
  }
  async function start() {
    const result = await post('/api/slack/oauth/start');
    const body = await result.json() as { authorizationUrl: string };
    const state = new URL(body.authorizationUrl).searchParams.get('state') ?? '';
    const cookie = result.headers.get('set-cookie')?.split(';')[0] ?? '';
    return { result, body, state, cookie };
  }
  async function callback(state: string, cookie: string, extra = '') {
    return request(`/api/slack/oauth/callback?state=${state}&code=private-auth-code${extra}`, { headers: { Cookie: cookie } });
  }
  async function connect() {
    const pending = await start();
    return callback(pending.state, pending.cookie);
  }
  return { oauth, fetcher, check, connected, disconnected, origin, request, post, start, callback, connect };
}

describe('Slack OAuth HTTP routes', () => {
  it('serves sanitized, non-cacheable connection status without exposing credentials', async () => {
    const { request, connect, oauth } = await fixture();
    const disconnected = await request('/api/slack/mcp');
    expect(disconnected.headers.get('content-type')).toBe('application/json');
    expect(disconnected.headers.get('cache-control')).toBe('no-store');
    expect(await disconnected.json()).toMatchObject({ status: 'disconnected', connected: false });
    await connect();
    expect(await oauth.accessToken()).toBe('private-access-token');
    const connected = await request('/api/slack/mcp');
    const text = await connected.text();
    expect(JSON.parse(text)).toMatchObject({ status: 'connected', userId: 'U123', teamId: 'T123' });
    expect(text).not.toMatch(/private-|access_token|clientSecret|refreshToken/);
  });

  it('requires trusted Origin and JSON content type on every connection mutation', async () => {
    const { request, post, oauth, check, connected, disconnected } = await fixture();
    const begin = vi.spyOn(oauth, 'begin');
    const disconnect = vi.spyOn(oauth, 'disconnect');
    for (const path of ['/api/slack/oauth/start', '/api/slack/oauth/disconnect', '/api/slack/mcp/check']) {
      for (const origin of ['https://attacker.example', 'null', `${callbackOrigin}/path`, 'file://']) {
        expect((await post(path, { Origin: origin })).status).toBe(403);
      }
      expect((await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
      expect((await post(path, { 'Content-Type': 'text/plain' })).status).toBe(403);
      expect((await post(path, { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(403);
    }
    expect(begin).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
  });

  it('starts only on the registered HTTPS origin and binds state to a Secure HttpOnly SameSite cookie', async () => {
    const { post, start, origin, oauth } = await fixture();
    const begin = vi.spyOn(oauth, 'begin');
    const local = await post('/api/slack/oauth/start', { Origin: origin });
    expect(local.status).toBe(409);
    expect((await local.json() as { error: string }).error).toContain(`${callbackOrigin}/config`);
    expect(local.headers.get('set-cookie')).toBeNull();
    expect(begin).not.toHaveBeenCalled();
    const pending = await start();
    expect(pending.result.status).toBe(200);
    expect(pending.result.headers.get('set-cookie')).toBe(
      `helmsman_slack_oauth=${pending.state}; Path=/api/slack/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
    expect(Object.keys(pending.body)).toEqual(['authorizationUrl']);
    expect(pending.body.authorizationUrl).not.toContain('private-');
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it('validates callback cookie through OAuth before checking read-only MCP access and activating', async () => {
    const { start, callback, check, connected, oauth } = await fixture();
    const complete = vi.spyOn(oauth, 'complete');
    let finishCheck!: () => void;
    check.mockImplementationOnce(() => new Promise<void>(resolve => { finishCheck = resolve; }));
    const pending = await start();
    const resultPromise = callback(pending.state, `unrelated=foo; ${pending.cookie}; another=bar`);
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(complete.mock.calls[0]?.[0].get('state')).toBe(pending.state);
    expect(complete.mock.calls[0]?.[1]).toBe(pending.state);
    expect(connected).not.toHaveBeenCalled();
    finishCheck();
    const result = await resultPromise;
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe('/config?slack_oauth=connected');
    expect(result.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
    expect(connected).toHaveBeenCalledTimes(1);
    expect(check.mock.invocationCallOrder[0]).toBeLessThan(connected.mock.invocationCallOrder[0]!);
  });

  it('never activates or exchanges tokens for a missing/mismatched callback cookie or replay', async () => {
    const { start, callback, check, connected, fetcher } = await fixture();
    const pending = await start();
    for (const cookie of ['', 'helmsman_slack_oauth=forged']) {
      const result = await callback(pending.state, cookie);
      expect(result.status).toBe(303);
      expect(result.headers.get('location')).toBe('/config?slack_oauth=error');
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
    await callback(pending.state, pending.cookie);
    const replay = await callback(pending.state, pending.cookie);
    expect(replay.headers.get('location')).toBe('/config?slack_oauth=error');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(connected).toHaveBeenCalledTimes(1);
  });

  it('does not activate if MCP verification fails and never reflects errors or arbitrary redirect targets', async () => {
    const { start, callback, check, connected } = await fixture();
    check.mockRejectedValueOnce(new Error('private-access-token provider details'));
    const pending = await start();
    const result = await callback(pending.state, pending.cookie, '&redirect_uri=https://attacker.example&next=//attacker.example');
    expect(result.headers.get('location')).toBe('/config?slack_oauth=error');
    expect(await result.text()).toBe('');
    expect(JSON.stringify([...result.headers])).not.toMatch(/private-|attacker/);
    expect(connected).not.toHaveBeenCalled();
    const denied = await start();
    const error = await callback(denied.state, denied.cookie, '&error=private-provider-detail');
    expect(error.headers.get('location')).toBe('/config?slack_oauth=error');
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('disconnect deletes the private token, clears the browser cookie, and stops the transport', async () => {
    const { connect, post, oauth, disconnected, origin } = await fixture();
    await connect();
    expect(await oauth.accessToken()).toBe('private-access-token');
    const result = await post('/api/slack/oauth/disconnect', { Origin: origin });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: 'disconnected', userId: null, teamId: null });
    expect(result.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    expect(disconnected).toHaveBeenCalledTimes(1);
    await expect(oauth.accessToken()).rejects.toThrow('Connect');
  });

  it('check only calls MCP for a connected account and sanitizes verification failures', async () => {
    const { post, check, connect, connected } = await fixture();
    const disconnected = await post('/api/slack/mcp/check');
    expect(await disconnected.json()).toMatchObject({ connected: false });
    expect(check).not.toHaveBeenCalled();
    await connect();
    const success = await post('/api/slack/mcp/check');
    expect(await success.json()).toMatchObject({ connected: true, message: expect.stringContaining('workspace and channel') });
    check.mockRejectedValueOnce(new Error('private-client-secret private-access-token'));
    const failure = await post('/api/slack/mcp/check');
    const text = await failure.text();
    expect(JSON.parse(text)).toMatchObject({ status: 'error', connected: false });
    expect(text).not.toContain('private-');
    expect(connected).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported methods and leaves unrelated routes for the outer router', async () => {
    const { request, fetcher, check } = await fixture();
    for (const [path, method] of [
      ['/api/slack/oauth/start', 'GET'], ['/api/slack/oauth/disconnect', 'GET'], ['/api/slack/mcp/check', 'GET'],
      ['/api/slack/oauth/callback', 'POST'], ['/api/slack/mcp', 'POST'], ['/api/slack/oauth/start', 'DELETE'],
    ]) {
      const result = await request(path!, { method });
      expect(result.status).toBe(405);
      expect(await result.json()).toEqual({ error: 'Method not allowed.' });
    }
    expect((await request('/other')).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it('does not activate a callback that finishes verification after the user disconnects', async () => {
    const { start, callback, check, post, connected, oauth } = await fixture();
    let finishCheck!: () => void;
    check.mockImplementationOnce(() => new Promise<void>(resolve => { finishCheck = resolve; }));
    const pending = await start();
    const resultPromise = callback(pending.state, pending.cookie);
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await post('/api/slack/oauth/disconnect');
    finishCheck();
    const result = await resultPromise;
    expect(result.headers.get('location')).toBe('/config?slack_oauth=error');
    expect(connected).not.toHaveBeenCalled();
    expect(await oauth.status()).toMatchObject({ connected: false });
  });

  it('does not report a stale successful connection check after disconnect', async () => {
    const { connect, post, check } = await fixture();
    await connect();
    let finishCheck!: () => void;
    check.mockImplementationOnce(() => new Promise<void>(resolve => { finishCheck = resolve; }));
    const resultPromise = post('/api/slack/mcp/check');
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    await post('/api/slack/oauth/disconnect');
    finishCheck();
    const result = await resultPromise;
    expect(await result.json()).toMatchObject({ connected: false });
  });
});
