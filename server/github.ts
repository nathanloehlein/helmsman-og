import type { GithubConfig } from './config';
import type { GithubPr, PrReviewDecision } from './types';

interface RawPr {
  number: number;
  title: string;
  head: { ref: string };
  user: { login: string } | null;
  merged_at: string | null;
  created_at: string;
}

interface RawReview {
  state: string;
  submitted_at: string | null;
}

const API: string = 'https://api.github.com';

function headers(github: GithubConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${github.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function latestReviewDecision(github: GithubConfig, prNumber: number): Promise<PrReviewDecision> {
  const res: Response = await fetch(`${API}/repos/${github.repo}/pulls/${prNumber}/reviews?per_page=100`, {
    headers: headers(github),
  });
  if (!res.ok) return null;
  const reviews: RawReview[] = await res.json();
  const decisive: RawReview[] = reviews.filter((r) => r.state === 'CHANGES_REQUESTED' || r.state === 'APPROVED');
  const last: RawReview | undefined = decisive[decisive.length - 1];
  if (!last) return 'REVIEW_REQUIRED';
  return last.state === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : 'APPROVED';
}

export async function fetchAuthoredPrs(github: GithubConfig): Promise<GithubPr[]> {
  const res: Response = await fetch(
    `${API}/repos/${github.repo}/pulls?state=all&sort=updated&direction=desc&per_page=20`,
    { headers: headers(github) },
  );
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  const raw: RawPr[] = await res.json();
  const mine: RawPr[] = raw.filter((pr) => pr.user?.login === github.author).slice(0, 8);
  return Promise.all(
    mine.map(async (pr): Promise<GithubPr> => ({
      number: pr.number,
      title: pr.title,
      headRef: pr.head.ref,
      authorLogin: pr.user?.login ?? '',
      mergedAt: pr.merged_at,
      createdAt: pr.created_at,
      reviewDecision: pr.merged_at ? null : await latestReviewDecision(github, pr.number),
    })),
  );
}
