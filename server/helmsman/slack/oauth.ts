import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export const SLACK_USER_SCOPES = [
  'channels:read', 'chat:write', 'search:read',
] as const;

export interface SlackOAuthSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  teamId: string;
}

export interface SlackOAuthStatus {
  status: 'setup-required' | 'disconnected' | 'connected' | 'error';
  configured: boolean;
  connected: boolean;
  teamId: string | null;
  userId: string | null;
  redirectUri: string;
  message: string;
}

interface Token {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  teamId: string;
  userId: string;
}

const STATE_TTL_MS = 10 * 60_000;
const SETUP_MESSAGE = 'Configure the Slack app client ID, client secret, registered redirect URL, and workspace ID.';
const CONNECT_MESSAGE = 'Connect your Slack account to use Slack MCP.';
const FAILURE_MESSAGE = 'Slack authorization failed. Check the app configuration and reconnect.';
const STATE_MESSAGE = 'Slack authorization expired or could not be verified. Start connecting again.';
const REFRESH_MESSAGE = 'Slack authorization could not be refreshed. Try again or reconnect your Slack account.';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function validateSlackOAuthRedirectUri(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/api/slack/oauth/callback') throw new Error();
    return url.toString();
  } catch {
    throw new Error('Slack OAuth redirect URL must use HTTPS and the path /api/slack/oauth/callback, without credentials, query, or fragment.');
  }
}

function configured(settings: SlackOAuthSettings): boolean {
  try {
    validateSlackOAuthRedirectUri(settings.redirectUri);
    return Boolean(settings.clientId && settings.clientSecret && /^T[A-Z0-9]+$/.test(settings.teamId));
  } catch {
    return false;
  }
}

function userToken(value: unknown, now: number): Pick<Token, 'accessToken' | 'refreshToken' | 'expiresAt'> {
  const data = record(value);
  const accessToken = string(data.access_token);
  const refreshToken = string(data.refresh_token) || null;
  const scopes = new Set(string(data.scope).split(/[\s,]+/));
  const expires = data.expires_in;
  if (!accessToken || data.token_type !== 'user' || SLACK_USER_SCOPES.some(scope => !scopes.has(scope))) {
    throw new Error(FAILURE_MESSAGE);
  }
  if (expires !== undefined && (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0 || !refreshToken)) {
    throw new Error(FAILURE_MESSAGE);
  }
  return { accessToken, refreshToken, expiresAt: typeof expires === 'number' ? now + expires * 1000 : null };
}

export function openSlackOAuth(options: {
  path: string;
  settings: () => SlackOAuthSettings;
  fetcher?: typeof fetch;
  now?: () => number;
}) {
  if (options.path !== ':memory:') {
    const directory = dirname(options.path);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    closeSync(openSync(options.path, 'a', 0o600));
    chmodSync(options.path, 0o600);
  }
  const sql = new Database(options.path);
  sql.pragma('journal_mode = DELETE');
  sql.pragma('secure_delete = ON');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS slack_oauth_binding (id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS slack_oauth_tokens (
      id INTEGER PRIMARY KEY CHECK (id = 1), accessToken TEXT NOT NULL, refreshToken TEXT,
      expiresAt REAL, teamId TEXT NOT NULL, userId TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slack_oauth_states (hash TEXT PRIMARY KEY, expiresAt REAL NOT NULL);
  `);
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let generation = 0;
  let closed = false;
  let lastError: string | null = null;
  let refreshing: { generation: number; promise: Promise<string> } | null = null;

  function clear() {
    sql.transaction(() => {
      sql.prepare('DELETE FROM slack_oauth_tokens').run();
      sql.prepare('DELETE FROM slack_oauth_states').run();
    })();
    generation += 1;
    lastError = null;
    refreshing = null;
  }

  function context() {
    if (closed) throw new Error(CONNECT_MESSAGE);
    const raw = options.settings();
    const settings: SlackOAuthSettings = {
      clientId: string(raw?.clientId), clientSecret: string(raw?.clientSecret),
      redirectUri: string(raw?.redirectUri), teamId: string(raw?.teamId),
    };
    const fingerprint = hash(JSON.stringify(settings));
    const prior = sql.prepare('SELECT fingerprint FROM slack_oauth_binding WHERE id = 1').get() as { fingerprint: string } | undefined;
    if (prior?.fingerprint !== fingerprint) {
      clear();
      sql.prepare('INSERT OR REPLACE INTO slack_oauth_binding VALUES (1, ?)').run(fingerprint);
    }
    return { settings, fingerprint, generation };
  }

  function assertCurrent(expected: ReturnType<typeof context>) {
    const current = context();
    if (current.generation !== expected.generation || current.fingerprint !== expected.fingerprint) throw new Error(CONNECT_MESSAGE);
  }

  function readToken(): Token | undefined {
    return sql.prepare('SELECT accessToken, refreshToken, expiresAt, teamId, userId FROM slack_oauth_tokens WHERE id = 1').get() as Token | undefined;
  }

  function saveToken(token: Token) {
    sql.prepare(`INSERT OR REPLACE INTO slack_oauth_tokens (id, accessToken, refreshToken, expiresAt, teamId, userId)
      VALUES (1, @accessToken, @refreshToken, @expiresAt, @teamId, @userId)`).run(token);
    lastError = null;
  }

  async function post(endpoint: 'oauth.v2.access' | 'auth.test', values: URLSearchParams, token?: string) {
    try {
      const response = await fetcher(`https://slack.com/api/${endpoint}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: values.toString(),
      });
      if (!response.ok) throw new Error(FAILURE_MESSAGE);
      const data = record(await response.json());
      if (data.ok !== true) throw new Error(FAILURE_MESSAGE);
      return data;
    } catch {
      throw new Error(FAILURE_MESSAGE);
    }
  }

  function begin() {
    const current = context();
    if (!configured(current.settings)) throw new Error(SETUP_MESSAGE);
    const state = randomBytes(32).toString('base64url');
    sql.transaction(() => {
      sql.prepare('DELETE FROM slack_oauth_states').run();
      sql.prepare('INSERT INTO slack_oauth_states VALUES (?, ?)').run(hash(state), now() + STATE_TTL_MS);
    })();
    generation += 1;
    refreshing = null;
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.search = new URLSearchParams({
      client_id: current.settings.clientId, redirect_uri: current.settings.redirectUri,
      user_scope: SLACK_USER_SCOPES.join(','), state, team: current.settings.teamId,
    }).toString();
    return { authorizationUrl: url.toString(), state };
  }

  async function complete(query: URLSearchParams, cookieState: string): Promise<void> {
    const current = context();
    const state = query.get('state') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || typeof cookieState !== 'string'
      || !timingSafeEqual(Buffer.from(hash(state)), Buffer.from(hash(cookieState)))) throw new Error(STATE_MESSAGE);
    const pending = sql.transaction(() => {
      const row = sql.prepare('SELECT expiresAt FROM slack_oauth_states WHERE hash = ?').get(hash(state)) as { expiresAt: number } | undefined;
      sql.prepare('DELETE FROM slack_oauth_states WHERE hash = ?').run(hash(state));
      return row;
    })();
    if (!pending || pending.expiresAt <= now()) throw new Error(STATE_MESSAGE);
    if (!configured(current.settings)) throw new Error(SETUP_MESSAGE);
    try {
      if (query.has('error') || !query.get('code')) throw new Error(FAILURE_MESSAGE);
      const data = await post('oauth.v2.access', new URLSearchParams({
        client_id: current.settings.clientId, client_secret: current.settings.clientSecret,
        code: query.get('code')!, redirect_uri: current.settings.redirectUri,
      }));
      assertCurrent(current);
      const user = record(data.authed_user);
      const token = userToken(user, now());
      const identity = await post('auth.test', new URLSearchParams(), token.accessToken);
      assertCurrent(current);
      const teamId = string(identity.team_id);
      const userId = string(identity.user_id);
      if (teamId !== current.settings.teamId || string(record(data.team).id) !== teamId
        || !userId || string(user.id) !== userId || identity.bot_id || identity.is_bot === true) throw new Error(FAILURE_MESSAGE);
      saveToken({ ...token, teamId, userId });
      generation += 1;
      refreshing = null;
    } catch {
      if (!closed && generation === current.generation) lastError = FAILURE_MESSAGE;
      throw new Error(FAILURE_MESSAGE);
    }
  }

  async function accessToken(): Promise<string> {
    const current = context();
    if (!configured(current.settings)) throw new Error(SETUP_MESSAGE);
    const token = readToken();
    if (!token) throw new Error(CONNECT_MESSAGE);
    if (token.expiresAt === null || token.expiresAt > now() + 60_000) return token.accessToken;
    if (refreshing?.generation === current.generation) return refreshing.promise;
    const promise = (async () => {
      try {
        if (!token.refreshToken) throw new Error(REFRESH_MESSAGE);
        const data = await post('oauth.v2.access', new URLSearchParams({
          client_id: current.settings.clientId, client_secret: current.settings.clientSecret,
          grant_type: 'refresh_token', refresh_token: token.refreshToken,
        }));
        assertCurrent(current);
        const replacement = userToken(data, now());
        if (data.team_id && data.team_id !== token.teamId) throw new Error(REFRESH_MESSAGE);
        if (record(data.team).id && record(data.team).id !== token.teamId) throw new Error(REFRESH_MESSAGE);
        if (data.user_id && data.user_id !== token.userId) throw new Error(REFRESH_MESSAGE);
        saveToken({ ...token, ...replacement });
        return replacement.accessToken;
      } catch {
        if (!closed && generation === current.generation) lastError = REFRESH_MESSAGE;
        throw new Error(REFRESH_MESSAGE);
      }
    })();
    const pending = { generation: current.generation, promise };
    refreshing = pending;
    try {
      return await promise;
    } finally {
      if (refreshing === pending) refreshing = null;
    }
  }

  async function status(): Promise<SlackOAuthStatus> {
    let current = context();
    let token = readToken();
    if (configured(current.settings) && token) {
      try { await accessToken(); } catch { /* The public status uses only sanitized local messages. */ }
      current = context();
      token = readToken();
    }
    const ready = configured(current.settings);
    const connected = ready && Boolean(token) && !lastError;
    return {
      status: !ready ? 'setup-required' : lastError ? 'error' : connected ? 'connected' : 'disconnected',
      configured: ready, connected, teamId: token?.teamId ?? null, userId: token?.userId ?? null,
      redirectUri: current.settings.redirectUri,
      message: !ready ? SETUP_MESSAGE : lastError ?? (connected ? 'Slack account connected.' : CONNECT_MESSAGE),
    };
  }

  return {
    status, begin, complete, accessToken,
    isConnected() {
      if (closed) return false;
      const current = context();
      const token = readToken();
      return configured(current.settings) && !lastError && Boolean(token)
        && (token?.expiresAt === null || (token?.expiresAt ?? 0) > now());
    },
    disconnect() { context(); clear(); },
    close() {
      if (closed) return;
      closed = true;
      generation += 1;
      sql.close();
    },
  };
}
