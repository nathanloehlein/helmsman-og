import type { GithubProfile } from '../src/data/profile';
import type { GithubConfig } from './config';
import { cachedGithubRead } from './github-read-cache';

export async function fetchGithubProfile(github: GithubConfig | null): Promise<GithubProfile> {
  const fallback = github?.author?.trim() || null;
  if (!github) return { displayName: fallback, login: fallback };
  try {
    const response = await cachedGithubRead(github, 'https://api.github.com/user');
    if (!response.ok) return { displayName: fallback, login: fallback };
    const data = await response.json() as { name?: unknown; login?: unknown } | null;
    const login = typeof data?.login === 'string' ? data.login.trim() || fallback : fallback;
    const displayName = typeof data?.name === 'string' ? data.name.trim() || login : login;
    return { displayName, login };
  } catch {
    return { displayName: fallback, login: fallback };
  }
}
