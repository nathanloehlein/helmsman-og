export interface GithubProfile {
  displayName: string | null;
  login: string | null;
}

export async function loadProfile(): Promise<GithubProfile> {
  try {
    const response = await fetch('/api/github/profile', { headers: { Accept: 'application/json' } });
    if (!response.ok) return { displayName: null, login: null };
    const data = await response.json() as Partial<GithubProfile> | null;
    const login = typeof data?.login === 'string' ? data.login.trim() || null : null;
    const displayName = typeof data?.displayName === 'string' ? data.displayName.trim() || login : login;
    return { displayName, login };
  } catch {
    return { displayName: null, login: null };
  }
}
