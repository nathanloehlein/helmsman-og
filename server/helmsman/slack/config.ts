export const SLACK_INTERVAL_MS = 300_000;

export const SLACK_CONFIG_KEYS = ['SLACK_ENABLED', 'SLACK_WATCH_ENABLED', 'SLACK_CLIENT_ID', 'SLACK_CHANNEL_ID', 'SLACK_CHANNEL_NAME', 'SLACK_BROWSER_SURFACE'] as const;

export function slackIntegrationEnabled(env: Record<string, string | undefined>): boolean {
  return env.SLACK_ENABLED !== 'false';
}

export function slackSettings(env: Record<string, string | undefined>) {
  const enabled = slackIntegrationEnabled(env) && env.SLACK_WATCH_ENABLED === 'true';
  const clientId = env.SLACK_CLIENT_ID?.trim() ?? '';
  const channelId = env.SLACK_CHANNEL_ID?.trim() ?? '';
  const channelName = env.SLACK_CHANNEL_NAME?.trim() ?? '';
  const surface = env.SLACK_BROWSER_SURFACE?.trim() || undefined;
  const error = enabled && (!/^[A-Z0-9]{3,32}$/.test(clientId) || !/^C[A-Z0-9]{2,31}$/.test(channelId)
    || !/^[a-z0-9_-]{1,80}$/.test(channelName)
    || surface !== undefined && !/^(?:surface:[1-9]\d*|[a-f0-9-]{36})$/i.test(surface))
    ? 'Set a valid Slack client, channel, and browser surface in Config.' : null;
  return { enabled, clientId, channelId, channelName, surface, error };
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
  };
}
