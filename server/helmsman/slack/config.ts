import type { SlackBrowserTransport } from './browser';

export const SLACK_INTERVAL_MS = 300_000;

export const SLACK_CONFIG_KEYS = ['SLACK_ENABLED', 'SLACK_WATCH_ENABLED', 'SLACK_CLIENT_ID', 'SLACK_CHANNEL_ID', 'SLACK_CHANNEL_NAME', 'SLACK_BROWSER_SURFACE', 'SLACK_BROWSER', 'SLACK_FIREFOX_WEBDRIVER_URL'] as const;
export const DEFAULT_FIREFOX_WEBDRIVER_URL = 'http://127.0.0.1:4444';

export function parseFirefoxWebDriverUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim() || DEFAULT_FIREFOX_WEBDRIVER_URL); } catch { throw new Error('Firefox WebDriver must use a local HTTP endpoint.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Firefox WebDriver must use a local HTTP endpoint without credentials, a path, or query parameters.');
  }
  return url.origin;
}

function firefoxSurface(value: string): boolean {
  if (!value.startsWith('firefox:') || value.length > 4096) return false;
  try {
    const handle = decodeURIComponent(value.slice(8));
    return Boolean(handle) && !/[\x00-\x1f\x7f]/.test(handle) && encodeURIComponent(handle) === value.slice(8);
  } catch { return false; }
}

export function slackIntegrationEnabled(env: Record<string, string | undefined>): boolean {
  return env.SLACK_ENABLED !== 'false';
}

export function slackSettings(env: Record<string, string | undefined>) {
  const enabled = slackIntegrationEnabled(env) && env.SLACK_WATCH_ENABLED === 'true';
  const clientId = env.SLACK_CLIENT_ID?.trim() ?? '';
  const channelId = env.SLACK_CHANNEL_ID?.trim() ?? '';
  const channelName = env.SLACK_CHANNEL_NAME?.trim() ?? '';
  const browserValue = env.SLACK_BROWSER?.trim() || 'cmux';
  const browser: 'cmux' | 'firefox' = browserValue === 'firefox' ? 'firefox' : 'cmux';
  let error: string | null = browserValue === 'cmux' || browserValue === 'firefox' ? null : 'Slack browser must be cmux or firefox.';
  let firefoxWebDriverUrl = DEFAULT_FIREFOX_WEBDRIVER_URL;
  try { firefoxWebDriverUrl = parseFirefoxWebDriverUrl(env.SLACK_FIREFOX_WEBDRIVER_URL ?? ''); }
  catch (cause) { error ??= cause instanceof Error ? cause.message : 'Firefox WebDriver configuration is invalid.'; }
  const configuredSurface = env.SLACK_BROWSER_SURFACE?.trim() || undefined;
  const cmuxSurface = configuredSurface !== undefined && /^(?:surface:[1-9]\d*|[a-f0-9-]{36})$/i.test(configuredSurface);
  const surface = browser === 'firefox' && cmuxSurface ? undefined : configuredSurface;
  if (surface !== undefined && !(browser === 'firefox' ? firefoxSurface(surface) : cmuxSurface)) {
    error ??= 'Set a valid Slack browser tab reference in Config.';
  }
  if (enabled && (!/^[A-Z0-9]{3,32}$/.test(clientId) || !/^C[A-Z0-9]{2,31}$/.test(channelId)
    || !/^[a-z0-9_-]{1,80}$/.test(channelName))) error ??= 'Set a valid Slack client and channel in Config.';
  return { enabled, clientId, channelId, channelName, surface, browser, firefoxWebDriverUrl, error };
}

export function createSlackBrowserTransportSelector(firefox: (endpoint: string) => SlackBrowserTransport, cmux: SlackBrowserTransport) {
  const transports = new Map<string, SlackBrowserTransport>();
  const select = (settings: Pick<ReturnType<typeof slackSettings>, 'browser' | 'firefoxWebDriverUrl'>): SlackBrowserTransport => {
    if (settings.browser === 'cmux') return cmux;
    const endpoint = parseFirefoxWebDriverUrl(settings.firefoxWebDriverUrl);
    let transport = transports.get(endpoint);
    if (!transport) { transport = firefox(endpoint); transports.set(endpoint, transport); }
    return transport;
  };
  return Object.assign(select, { reset: () => transports.clear() });
}

export function publicSlackSettings(env: Record<string, string | undefined>): Record<string, unknown> {
  const settings = slackSettings(env);
  return {
    SLACK_ENABLED: String(slackIntegrationEnabled(env)),
    SLACK_WATCH_ENABLED: env.SLACK_WATCH_ENABLED === 'true' ? 'true' : 'false',
    SLACK_CLIENT_ID: settings.clientId,
    SLACK_CHANNEL_ID: settings.channelId,
    SLACK_CHANNEL_NAME: settings.channelName,
    SLACK_BROWSER_SURFACE: settings.surface ?? '',
    SLACK_BROWSER: settings.browser,
    SLACK_FIREFOX_WEBDRIVER_URL: settings.firefoxWebDriverUrl,
  };
}
