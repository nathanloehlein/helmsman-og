export interface UiConfig {
  config: Record<string, unknown>;
  overridden: string[];
  jiraTokenSet?: boolean;
  slackTokenSet?: boolean;
}

export async function getConfig(): Promise<UiConfig> {
  try {
    const res: Response = await fetch('/api/config');
    if (!res.ok) return { config: {}, overridden: [], jiraTokenSet: false };
    return (await res.json()) as UiConfig;
  } catch {
    return { config: {}, overridden: [], jiraTokenSet: false };
  }
}

export async function setConfig(key: string, value: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res: Response = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch((): { error?: string } => ({}));
      return { ok: false, error: body.error };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
