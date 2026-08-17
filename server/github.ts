import type { GithubConfig } from './config';
import type { GithubPr, PrReviewDecision } from './types';

interface SearchItem {
  number: number;
  title: string;
  created_at: string;
  user: { login: string } | null;
  repository_url: string;
  pull_request?: { merged_at: string | null };
}

interface RawReview {
  state: string;
}

const API: string = 'https://api.github.com';

function headers(github: GithubConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${github.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function repoFromUrl(repositoryUrl: string): string {
  return repositoryUrl.replace(`${API}/repos/`, '');
}

async function latestReviewDecision(
  github: GithubConfig,
  repo: string,
  prNumber: number,
): Promise<PrReviewDecision> {
  const res: Response = await fetch(`${API}/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`, {
    headers: headers(github),
  });
  if (!res.ok) return null;
  const reviews: RawReview[] = await res.json();
  const decisive: RawReview[] = reviews.filter(
    (r) => r.state === 'CHANGES_REQUESTED' || r.state === 'APPROVED',
  );
  const last: RawReview | undefined = decisive[decisive.length - 1];
  if (!last) return 'REVIEW_REQUIRED';
  return last.state === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : 'APPROVED';
}

/**
 * Fetches the author's most-recent PRs across every repo they can see, via
 * GitHub's issue-search API. Author-scoped search sidesteps repo-scoped search,
 * which is SSO-gated on some private orgs and returns 422 for the token there.
 */
export async function fetchAuthoredPrs(github: GithubConfig): Promise<GithubPr[]> {
  const url: URL = new URL(`${API}/search/issues`);
  url.searchParams.set('q', `author:${github.author} type:pr`);
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', '8');

  const res: Response = await fetch(url, { headers: headers(github) });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  const body: { items?: SearchItem[] } = await res.json();
  const items: SearchItem[] = body.items ?? [];

  return Promise.all(
    items.map(async (item): Promise<GithubPr> => {
      const repo: string = repoFromUrl(item.repository_url);
      const mergedAt: string | null = item.pull_request?.merged_at ?? null;
      return {
        number: item.number,
        title: item.title,
        headRef: '',
        authorLogin: item.user?.login ?? github.author,
        mergedAt,
        createdAt: item.created_at,
        reviewDecision: mergedAt ? null : await latestReviewDecision(github, repo, item.number),
        repo,
      };
    }),
  );
}
