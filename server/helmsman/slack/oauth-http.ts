import type { IncomingMessage, ServerResponse } from 'node:http';
import type { openSlackOAuth } from './oauth';

interface SlackConnectionDeps {
  oauth: ReturnType<typeof openSlackOAuth>;
  check: () => Promise<void>;
  connected: () => void;
  disconnected: () => void;
}

const COOKIE = 'helmsman_slack_oauth';
const generations = new WeakMap<SlackConnectionDeps['oauth'], number>();

function cookie(state: string, clear = false): string {
  return `${COOKIE}=${state}; Path=/api/slack/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=${clear ? 0 : 600}`;
}

export function trustedSlackOrigin(req: IncomingMessage, redirectUri: string): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
    if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.host === req.headers.host) return true;
    return Boolean(redirectUri && parsed.origin === new URL(redirectUri).origin);
  } catch { return false; }
}

export async function handleSlackConnection(req: IncomingMessage, res: ServerResponse, url: URL, deps: SlackConnectionDeps): Promise<boolean> {
  const path = url.pathname;
  if (!['/api/slack/mcp', '/api/slack/mcp/check', '/api/slack/oauth/start', '/api/slack/oauth/disconnect', '/api/slack/oauth/callback'].includes(path)) return false;
  const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(value));
  };
  if (path === '/api/slack/oauth/callback' && req.method === 'GET') {
    let result = 'error';
    const generation = generations.get(deps.oauth) ?? 0;
    try {
      const state = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
      await deps.oauth.complete(url.searchParams, state);
      const authorized = await deps.oauth.status();
      await deps.check();
      const current = await deps.oauth.status();
      if (!current.connected || current.teamId !== authorized.teamId || current.userId !== authorized.userId
        || (generations.get(deps.oauth) ?? 0) !== generation) throw new Error('Connection changed');
      deps.connected();
      generations.set(deps.oauth, generation + 1);
      result = 'connected';
    } catch {}
    res.writeHead(303, { Location: `/config?slack_oauth=${result}`, 'Set-Cookie': cookie('', true), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
    return true;
  }
  if (path === '/api/slack/mcp' && req.method === 'GET') {
    json(200, await deps.oauth.status());
    return true;
  }
  if (req.method !== 'POST' || path === '/api/slack/mcp' || path === '/api/slack/oauth/callback') {
    json(405, { error: 'Method not allowed.' });
    return true;
  }
  const status = await deps.oauth.status();
  if (!trustedSlackOrigin(req, status.redirectUri) || req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    json(403, { error: 'Use the Slack connection controls in Helmsman Config.' });
    return true;
  }
  if (path === '/api/slack/oauth/start') {
    try {
      if (!status.configured) { json(409, { error: status.message }); return true; }
      const callbackOrigin = new URL(status.redirectUri).origin;
      if (req.headers.origin !== callbackOrigin) {
        json(409, { error: `Open Helmsman at ${callbackOrigin}/config to connect Slack. The registered HTTPS callback must use the same browser origin.` });
        return true;
      }
      const pending = deps.oauth.begin();
      generations.set(deps.oauth, (generations.get(deps.oauth) ?? 0) + 1);
      json(200, { authorizationUrl: pending.authorizationUrl }, { 'Set-Cookie': cookie(pending.state) });
    } catch { json(409, { error: 'Slack authorization could not start. Check the app settings and try again.' }); }
  } else if (path === '/api/slack/oauth/disconnect') {
    deps.oauth.disconnect();
    generations.set(deps.oauth, (generations.get(deps.oauth) ?? 0) + 1);
    deps.disconnected();
    json(200, await deps.oauth.status(), { 'Set-Cookie': cookie('', true) });
  } else if (!status.connected) {
    json(200, status);
  } else {
    const generation = generations.get(deps.oauth) ?? 0;
    try {
      await deps.check();
      const current = await deps.oauth.status();
      json(200, current.connected && current.teamId === status.teamId && current.userId === status.userId
        && (generations.get(deps.oauth) ?? 0) === generation
        ? { ...current, message: 'Slack MCP connected. The configured workspace and channel are accessible.' } : current);
    }
    catch { json(200, { ...status, status: 'error', connected: false, message: 'Slack MCP could not verify access. Check the workspace and channel settings, or reconnect Slack.' }); }
  }
  return true;
}
