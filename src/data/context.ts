export interface AppContext {
  repos: string[];
  jiraBaseUrl: string | null;
  jiraEnabled?: boolean;
}

export async function getContext(): Promise<AppContext | null> {
  try {
    const response = await fetch('/api/context');
    if (!response.ok) return null;
    const data = await response.json() as Partial<AppContext> | null;
    if (!data || !Array.isArray(data.repos) || !data.repos.every(repo => typeof repo === 'string' && /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(repo))) return null;
    if (data.jiraBaseUrl !== null && typeof data.jiraBaseUrl !== 'string') return null;
    return { repos: [...new Set(data.repos)], jiraBaseUrl: data.jiraBaseUrl,
      ...(typeof data.jiraEnabled === 'boolean' ? { jiraEnabled: data.jiraEnabled } : {}) };
  } catch {
    return null;
  }
}
