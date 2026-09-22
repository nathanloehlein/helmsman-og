export interface FirefoxBridgeStatus {
  status: 'running' | 'stopped' | 'blocked';
  bridgeRunning: boolean;
  firefoxReady: boolean;
  canStart: boolean;
  message: string;
}

export async function fetchFirefoxBridge(start = false): Promise<FirefoxBridgeStatus | null> {
  try {
    const response = await fetch('/api/slack/firefox-bridge', {
      method: start ? 'POST' : 'GET', signal: AbortSignal.timeout(start ? 15_000 : 5_000),
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object') return null;
    const status = value as Partial<FirefoxBridgeStatus>;
    return ['running', 'stopped', 'blocked'].includes(status.status ?? '')
      && typeof status.bridgeRunning === 'boolean' && typeof status.firefoxReady === 'boolean'
      && typeof status.canStart === 'boolean' && typeof status.message === 'string'
      ? status as FirefoxBridgeStatus : null;
  } catch { return null; }
}
