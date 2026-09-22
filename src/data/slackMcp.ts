export interface SlackMcpStatus {
  status: 'setup-required' | 'disconnected' | 'connected' | 'error';
  configured: boolean;
  connected: boolean;
  teamId: string | null;
  userId: string | null;
  redirectUri: string;
  message: string;
}

function isStatus(value: unknown): value is SlackMcpStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const status = value as Partial<SlackMcpStatus>;
  return ['setup-required', 'disconnected', 'connected', 'error'].includes(status.status ?? '')
    && typeof status.configured === 'boolean' && typeof status.connected === 'boolean'
    && (status.teamId === null || typeof status.teamId === 'string')
    && (status.userId === null || typeof status.userId === 'string')
    && typeof status.redirectUri === 'string' && typeof status.message === 'string';
}

export async function fetchSlackMcp(action?: 'check' | 'disconnect'): Promise<SlackMcpStatus | null> {
  const endpoint = action === 'disconnect' ? '/api/slack/oauth/disconnect'
    : action === 'check' ? '/api/slack/mcp/check' : '/api/slack/mcp';
  try {
    const response = await fetch(endpoint, { method: action ? 'POST' : 'GET', ...(action ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}), signal: AbortSignal.timeout(action === 'check' ? 80_000 : 20_000) });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    return isStatus(value) ? value : null;
  } catch { return null; }
}

export async function startSlackOAuth(): Promise<{ authorizationUrl: string } | { error: string }> {
  const fallback = 'Could not start Slack authorization. Check the saved OAuth app settings and try again.';
  try {
    const response = await fetch('/api/slack/oauth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) });
    const value: unknown = await response.json();
    if (!response.ok) return { error: value && typeof value === 'object' && 'error' in value
      && typeof value.error === 'string' && value.error.trim() ? value.error : fallback };
    if (!value || typeof value !== 'object' || !('authorizationUrl' in value) || typeof value.authorizationUrl !== 'string') return { error: fallback };
    const url = new URL(value.authorizationUrl);
    return url.protocol === 'https:' && url.hostname === 'slack.com' && url.port === ''
      && url.pathname === '/oauth/v2/authorize' && !url.username && !url.password ? { authorizationUrl: url.href } : { error: fallback };
  } catch { return { error: fallback }; }
}
