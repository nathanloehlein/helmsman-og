import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSlackOAuth, SLACK_USER_SCOPES, validateSlackOAuthRedirectUri, type SlackOAuthSettings } from './oauth';

const clients: ReturnType<typeof openSlackOAuth>[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const defaults: SlackOAuthSettings = {
  clientId: '123.456', clientSecret: 'private-client-secret',
  redirectUri: 'https://helmsman.example/api/slack/oauth/callback', teamId: 'T123',
};

function user(overrides: Record<string, unknown> = {}) {
  return { id: 'U123', access_token: 'private-access-token', scope: SLACK_USER_SCOPES.join(','), token_type: 'user', ...overrides };
}

function grant(overrides: Record<string, unknown> = {}) {
  return { ok: true, authed_user: user(), team: { id: 'T123' }, ...overrides };
}

function response(data: unknown) { return new Response(JSON.stringify(data)); }

function fixture(options: { path?: string; settings?: SlackOAuthSettings } = {}) {
  let time = 100_000;
  let settings = options.settings ?? { ...defaults };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(grant()));
  const client = openSlackOAuth({ path: options.path ?? ':memory:', settings: () => settings, fetcher, now: () => time });
  clients.push(client);
  async function connect(data = grant()) {
    fetcher.mockResolvedValueOnce(response(data)).mockResolvedValueOnce(response({ ok: true, team_id: 'T123', user_id: 'U123' }));
    const { state } = client.begin();
    await client.complete(new URLSearchParams({ state, code: 'private-oauth-code' }), state);
    return state;
  }
  return { client, fetcher, connect, setTime(value: number) { time = value; }, setSettings(value: SlackOAuthSettings) { settings = value; } };
}

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(res => { resolve = res; });
  return { promise, resolve };
}

describe('Slack user OAuth', () => {
  it('requires the registered HTTPS callback with no embedded credentials or extra parameters', () => {
    expect(validateSlackOAuthRedirectUri(defaults.redirectUri)).toBe(defaults.redirectUri);
    for (const url of [
      '', 'http://localhost:8787/api/slack/oauth/callback', 'https://example.com/other',
      'https://user:password@example.com/api/slack/oauth/callback',
      'https://example.com/api/slack/oauth/callback?secret=private',
      'https://example.com/api/slack/oauth/callback#fragment',
    ]) expect(() => validateSlackOAuthRedirectUri(url)).toThrow('must use HTTPS');
  });

  it('requires explicit app credentials and workspace without trying a provider or browser', async () => {
    const { client, fetcher } = fixture({ settings: { ...defaults, clientSecret: '' } });
    expect(await client.status()).toMatchObject({ status: 'setup-required', configured: false, connected: false });
    expect(() => client.begin()).toThrow('Configure');
    await expect(client.accessToken()).rejects.toThrow('Configure');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requests user permissions, a pinned workspace, registered redirect URI, and unpredictable state', async () => {
    const { client } = fixture();
    expect(await client.status()).toMatchObject({ status: 'disconnected', configured: true });
    const first = client.begin();
    const url = new URL(first.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('user_scope')?.split(',')).toEqual(SLACK_USER_SCOPES);
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('team')).toBe('T123');
    expect(url.searchParams.get('redirect_uri')).toBe(defaults.redirectUri);
    expect(url.searchParams.get('state')).toBe(first.state);
    expect(first.authorizationUrl).not.toContain(defaults.clientSecret);
    expect(client.begin().state).not.toBe(first.state);
  });

  it('persists user identity and tokens privately, stores only a hash of pending state, and polls locally', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'helmsman-oauth-'));
    directories.push(directory);
    const path = join(directory, 'private', 'oauth.sqlite');
    const first = fixture({ path });
    const pending = first.client.begin();
    expect(readFileSync(path).includes(Buffer.from(pending.state))).toBe(false);
    await first.connect();
    expect(await first.client.accessToken()).toBe('private-access-token');
    expect(await first.client.status()).toMatchObject({ status: 'connected', teamId: 'T123', userId: 'U123' });
    await first.client.status();
    expect(first.fetcher).toHaveBeenCalledTimes(2);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, 'private')).mode & 0o777).toBe(0o700);
    first.client.close();
    const next = fixture({ path });
    expect(await next.client.accessToken()).toBe('private-access-token');
    expect(await next.client.status()).toMatchObject({ connected: true });
    expect(next.fetcher).not.toHaveBeenCalled();
    next.client.disconnect();
    expect(readFileSync(path).includes(Buffer.from('private-access-token'))).toBe(false);
  });

  it('rejects forged state, cookie mismatch, replay, and expired state before exchanging codes', async () => {
    const { client, fetcher, connect, setTime } = fixture();
    const { state } = client.begin();
    await expect(client.complete(new URLSearchParams({ state, code: 'code' }), 'wrong-cookie')).rejects.toThrow('verified');
    expect(fetcher).not.toHaveBeenCalled();
    setTime(100_000 + 600_000);
    await expect(client.complete(new URLSearchParams({ state, code: 'code' }), state)).rejects.toThrow('expired');
    expect(fetcher).not.toHaveBeenCalled();
    const consumed = await connect();
    await expect(client.complete(new URLSearchParams({ state: consumed, code: 'code' }), consumed)).rejects.toThrow('verified');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('consumes denied authorizations and never echoes Slack errors, codes, or secrets', async () => {
    const { client, fetcher } = fixture();
    const { state } = client.begin();
    const query = new URLSearchParams({ state, error: 'private-provider-details', code: 'private-oauth-code' });
    await expect(client.complete(query, state)).rejects.toThrow('Slack authorization failed');
    await expect(client.complete(query, state)).rejects.toThrow('verified');
    expect(JSON.stringify(await client.status())).not.toMatch(/private-/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['bot token', grant({ authed_user: user({ token_type: 'bot' }) })],
    ['missing scope', grant({ authed_user: user({ scope: 'chat:write' }) })],
    ['wrong workspace', grant({ team: { id: 'TOTHER' } })],
    ['different user', grant({ authed_user: user({ id: 'UOTHER' }) })],
    ['malformed response', null],
    ['missing refresh token for an expiring grant', grant({ authed_user: user({ expires_in: 43200 }) })],
  ])('fails closed for %s', async (_name, data) => {
    const { client, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(response(data)).mockResolvedValueOnce(response({ ok: true, team_id: 'T123', user_id: 'U123' }));
    const { state } = client.begin();
    await expect(client.complete(new URLSearchParams({ state, code: 'code' }), state)).rejects.toThrow('Slack authorization failed');
    expect(await client.status()).toMatchObject({ status: 'error', connected: false, userId: null });
    await expect(client.accessToken()).rejects.toThrow('Connect');
  });

  it('checks auth.test identity and protects token exchange from redirects', async () => {
    const { client, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(response(grant())).mockResolvedValueOnce(response({ ok: true, team_id: 'TOTHER', user_id: 'U123' }));
    const { state } = client.begin();
    await expect(client.complete(new URLSearchParams({ state, code: 'code' }), state)).rejects.toThrow('failed');
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://slack.com/api/auth.test');
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer private-access-token' });
  });

  it('refreshes a rotating user token only once for concurrent callers and stores its replacement', async () => {
    const { client, connect, fetcher, setTime } = fixture();
    await connect(grant({ authed_user: user({ expires_in: 120, refresh_token: 'private-refresh-token' }) }));
    setTime(170_000);
    const refresh = deferred();
    fetcher.mockReturnValueOnce(refresh.promise);
    const one = client.accessToken();
    const two = client.accessToken();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new URLSearchParams(String(fetcher.mock.calls[2]?.[1]?.body)).get('grant_type')).toBe('refresh_token');
    refresh.resolve(response({ ok: true, ...user({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 43200 }) }));
    expect(await Promise.all([one, two])).toEqual(['rotated-access', 'rotated-access']);
    expect(await client.accessToken()).toBe('rotated-access');
    expect(await client.status()).toMatchObject({ connected: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('never returns an expired token when refresh fails and does not expose transport errors', async () => {
    const { client, connect, fetcher, setTime } = fixture();
    await connect(grant({ authed_user: user({ expires_in: 120, refresh_token: 'private-refresh-token' }) }));
    setTime(300_000);
    fetcher.mockRejectedValue(new Error('private-client-secret and private-refresh-token'));
    await expect(client.accessToken()).rejects.toThrow('could not be refreshed');
    const status = await client.status();
    expect(status).toMatchObject({ status: 'error', connected: false });
    expect(JSON.stringify(status)).not.toMatch(/private-/);
  });

  it.each(['teamId', 'clientId', 'clientSecret', 'redirectUri'] as const)('invalidates persisted grants when %s changes', async key => {
    const { client, connect, setSettings, fetcher } = fixture();
    await connect();
    setSettings({ ...defaults, [key]: key === 'redirectUri' ? 'https://other.example/api/slack/oauth/callback' : 'TOTHER' });
    expect(await client.status()).toMatchObject({ connected: false, userId: null });
    await expect(client.accessToken()).rejects.toThrow('Connect');
    setSettings(defaults);
    expect(await client.status()).toMatchObject({ connected: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('disconnects immediately and rejects a late OAuth exchange without restoring credentials', async () => {
    const { client, fetcher } = fixture();
    const exchange = deferred();
    fetcher.mockReturnValueOnce(exchange.promise);
    const { state } = client.begin();
    const pending = client.complete(new URLSearchParams({ state, code: 'code' }), state);
    client.disconnect();
    exchange.resolve(response(grant()));
    await expect(pending).rejects.toThrow('failed');
    expect(await client.status()).toMatchObject({ status: 'disconnected', connected: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect after disconnect during token refresh', async () => {
    const { client, connect, fetcher, setTime } = fixture();
    await connect(grant({ authed_user: user({ expires_in: 120, refresh_token: 'private-refresh-token' }) }));
    setTime(300_000);
    const refresh = deferred();
    fetcher.mockReturnValueOnce(refresh.promise);
    const pending = client.accessToken();
    client.disconnect();
    refresh.resolve(response({ ok: true, ...user({ access_token: 'rotated', refresh_token: 'rotated-refresh', expires_in: 43200 }) }));
    await expect(pending).rejects.toThrow('refreshed');
    expect(await client.status()).toMatchObject({ status: 'disconnected', connected: false });
    await expect(client.accessToken()).rejects.toThrow('Connect');
  });

  it('does not overwrite a newly authorized account with a late refresh from the previous account', async () => {
    const { client, connect, fetcher, setTime } = fixture();
    await connect(grant({ authed_user: user({ expires_in: 120, refresh_token: 'private-refresh-token' }) }));
    setTime(300_000);
    const { state } = client.begin();
    const refresh = deferred();
    fetcher.mockReturnValueOnce(refresh.promise);
    const pending = client.accessToken();
    fetcher.mockResolvedValueOnce(response(grant({ authed_user: user({ access_token: 'new-account-token', id: 'U456' }) })))
      .mockResolvedValueOnce(response({ ok: true, team_id: 'T123', user_id: 'U456' }));
    await client.complete(new URLSearchParams({ state, code: 'new-account-code' }), state);
    refresh.resolve(response({ ok: true, ...user({ access_token: 'old-account-refreshed', refresh_token: 'rotated-refresh', expires_in: 43200 }) }));
    await expect(pending).rejects.toThrow('refreshed');
    expect(await client.accessToken()).toBe('new-account-token');
    expect(await client.status()).toMatchObject({ connected: true, userId: 'U456' });
  });

  it('rejects authorization already in flight when the configured workspace changes', async () => {
    const { client, fetcher, setSettings } = fixture();
    const exchange = deferred();
    fetcher.mockReturnValueOnce(exchange.promise);
    const { state } = client.begin();
    const pending = client.complete(new URLSearchParams({ state, code: 'code' }), state);
    setSettings({ ...defaults, teamId: 'TOTHER' });
    exchange.resolve(response(grant()));
    await expect(pending).rejects.toThrow('failed');
    expect(await client.status()).toMatchObject({ status: 'disconnected', connected: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
