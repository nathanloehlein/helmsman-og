import type { GithubConfig } from './config';
import { cachedGithubRead } from './github-read-cache';
import { isGithubRepo } from './pr-lists';

export async function fetchPrOwnership(github: GithubConfig | null, repo: string, prNumber: number): Promise<boolean | null> {
  if (!github?.token || !isGithubRepo(repo) || !Number.isSafeInteger(prNumber) || prNumber < 1) return null;
  try {
    const [viewerResponse, prResponse] = await Promise.all([
      cachedGithubRead(github, 'https://api.github.com/user'),
      cachedGithubRead(github, `https://api.github.com/repos/${repo}/pulls/${prNumber}`),
    ]);
    if (!viewerResponse.ok || !prResponse.ok) return null;
    const viewer = await viewerResponse.json() as { login?: unknown } | null;
    const pr = await prResponse.json() as { user?: { login?: unknown } | null } | null;
    const viewerLogin = typeof viewer?.login === 'string' ? viewer.login.trim().toLowerCase() : '';
    const authorLogin = typeof pr?.user?.login === 'string' ? pr.user.login.trim().toLowerCase() : '';
    if (!viewerLogin || !authorLogin) return null;
    return authorLogin === viewerLogin || authorLogin === github.author?.trim().toLowerCase();
  } catch {
    return null;
  }
}
