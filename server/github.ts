import type { GithubConfig } from './config';
import type { GithubPr, PrReviewDecision } from './types';

interface SearchItem {
  number: number;
  title: string;
  created_at: string;
  state?: string;
  user: { login: string } | null;
  repository_url: string;
  draft?: boolean;
  pull_request?: { merged_at: string | null };
}

export interface OpenAuthoredPr {
  number: number;
  title: string;
  repo: string;
  reviewDecision: PrReviewDecision;
  draft: boolean;
  createdAt: string;
}

interface RawReview {
  state: string;
  user: { login: string } | null;
}

interface PullRequestItem {
  number: number;
}

interface PullRequestDetail {
  state: string;
  draft?: boolean;
  merged?: boolean;
  head: { ref: string; sha: string };
  comments?: number;
  html_url: string;
  requested_reviewers?: unknown[];
  requested_teams?: unknown[];
}

interface CheckRun {
  status: string;
  conclusion: string | null;
}

interface CheckRunsResponse {
  check_runs: CheckRun[];
}

export interface ReviewTally {
  requested: number;
  approved: number;
  changesRequested: number;
  commented: number;
}

export interface PrStatus {
  number: number;
  repo: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  headRefName: string;
  headSha: string;
  reviewDecision: PrReviewDecision;
  comments: number;
  checks: { passed: number; failed: number; pending: number };
  reviews: ReviewTally;
  url: string;
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

async function fetchReviews(
  github: GithubConfig,
  repo: string,
  prNumber: number,
): Promise<RawReview[] | null> {
  const res: Response = await fetch(`${API}/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`, {
    headers: headers(github),
  });
  if (!res.ok) return null;
  return res.json();
}

function decisionFromReviews(reviews: RawReview[]): PrReviewDecision {
  const decisive: RawReview[] = reviews.filter(
    (r) => r.state === 'CHANGES_REQUESTED' || r.state === 'APPROVED',
  );
  const last: RawReview | undefined = decisive[decisive.length - 1];
  if (!last) return 'REVIEW_REQUIRED';
  return last.state === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : 'APPROVED';
}

function tallyReviews(reviews: RawReview[], requested: number): ReviewTally {
  const latestPerUser: Map<string, string> = new Map();
  for (const review of reviews) {
    const login: string | undefined = review.user?.login;
    if (!login) continue;
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') {
      latestPerUser.set(login, review.state);
    } else if (review.state === 'COMMENTED' && !latestPerUser.has(login)) {
      latestPerUser.set(login, 'COMMENTED');
    }
  }
  let approved: number = 0;
  let changesRequested: number = 0;
  let commented: number = 0;
  for (const state of latestPerUser.values()) {
    if (state === 'APPROVED') approved++;
    else if (state === 'CHANGES_REQUESTED') changesRequested++;
    else if (state === 'COMMENTED') commented++;
  }
  return { requested, approved, changesRequested, commented };
}

async function latestReviewDecision(
  github: GithubConfig,
  repo: string,
  prNumber: number,
): Promise<PrReviewDecision> {
  const reviews: RawReview[] | null = await fetchReviews(github, repo, prNumber);
  if (reviews === null) return null;
  return decisionFromReviews(reviews);
}

async function searchAuthoredPrs(github: GithubConfig): Promise<GithubPr[]> {
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
        state: item.state === 'closed' ? 'closed' : 'open',
        mergedAt,
        createdAt: item.created_at,
        reviewDecision: mergedAt ? null : await latestReviewDecision(github, repo, item.number),
        repo,
      };
    }),
  );
}

const REPO_AUTHORED_CAP: number = 8;

async function repoAuthoredPrs(github: GithubConfig, repo: string): Promise<GithubPr[]> {
  const found: GithubPr[] = [];
  for (let page = 1; page <= OPEN_PR_PAGE_CAP && found.length < REPO_AUTHORED_CAP; page++) {
    const url: URL = new URL(`${API}/repos/${repo}/pulls`);
    url.searchParams.set('state', 'all');
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'desc');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const res: Response | null = await fetch(url, { headers: headers(github) }).catch((): null => null);
    if (!res || !res.ok) break;
    const items: PullListItem[] = await res.json().catch((): PullListItem[] => []);
    if (!Array.isArray(items) || items.length === 0) break;
    for (const item of items) {
      if (found.length >= REPO_AUTHORED_CAP) break;
      if (item.user?.login !== github.author) continue;
      const mergedAt: string | null = item.merged_at ?? null;
      found.push({
        number: item.number,
        title: item.title,
        headRef: item.head?.ref ?? '',
        authorLogin: github.author,
        state: item.state === 'closed' ? 'closed' : 'open',
        mergedAt,
        createdAt: item.created_at,
        reviewDecision: mergedAt ? null : await latestReviewDecision(github, repo, item.number).catch((): PrReviewDecision => 'REVIEW_REQUIRED'),
        repo,
      });
    }
    if (items.length < 100) break;
  }
  return found;
}

/**
 * The author's most-recent PRs. Merges the author issue-search (broad, but
 * blind to SSO-gated orgs the search index won't return for this token) with a
 * direct per-repo pulls scan of the configured repos (which reaches those
 * orgs), de-duped by repo#number and ordered most-recent first. The search is
 * the primary source and still throws on failure so the caller can degrade;
 * the direct scan is fail-soft.
 */
export async function fetchAuthoredPrs(github: GithubConfig, repos: string[] = []): Promise<GithubPr[]> {
  const searched: GithubPr[] = await searchAuthoredPrs(github);
  const direct: GithubPr[][] = await Promise.all(
    repos.map((repo) => repoAuthoredPrs(github, repo).catch((): GithubPr[] => [])),
  );
  const byKey: Map<string, GithubPr> = new Map();
  for (const pr of [...searched, ...direct.flat()]) byKey.set(`${pr.repo}#${pr.number}`, pr);
  const recency = (pr: GithubPr): number => Date.parse(pr.mergedAt ?? pr.createdAt);
  return [...byKey.values()].sort((a, b) => recency(b) - recency(a)).slice(0, 12);
}

interface PullListItem {
  number: number;
  title: string;
  draft?: boolean;
  state?: string;
  created_at: string;
  merged_at?: string | null;
  head?: { ref: string };
  user: { login: string } | null;
}

async function toOpenAuthoredPr(
  github: GithubConfig,
  repo: string,
  number: number,
  title: string,
  draft: boolean,
  createdAt: string,
): Promise<OpenAuthoredPr> {
  return {
    number,
    title,
    repo,
    draft,
    createdAt,
    reviewDecision: await latestReviewDecision(github, repo, number).catch(
      (): PrReviewDecision => 'REVIEW_REQUIRED',
    ),
  };
}

async function searchOpenAuthoredPrs(github: GithubConfig): Promise<OpenAuthoredPr[]> {
  const url: URL = new URL(`${API}/search/issues`);
  url.searchParams.set('q', `author:${github.author} type:pr state:open`);
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', '30');

  const res: Response = await fetch(url, { headers: headers(github) });
  if (!res.ok) return [];
  const body: { items?: SearchItem[] } = await res.json();
  const items: SearchItem[] = body.items ?? [];
  return Promise.all(
    items.map((item) =>
      toOpenAuthoredPr(github, repoFromUrl(item.repository_url), item.number, item.title, item.draft ?? false, item.created_at),
    ),
  );
}

const OPEN_PR_PAGE_CAP: number = 3;

async function repoOpenAuthoredPrs(github: GithubConfig, repo: string): Promise<OpenAuthoredPr[]> {
  const found: OpenAuthoredPr[] = [];
  for (let page = 1; page <= OPEN_PR_PAGE_CAP; page++) {
    const url: URL = new URL(`${API}/repos/${repo}/pulls`);
    url.searchParams.set('state', 'open');
    url.searchParams.set('sort', 'created');
    url.searchParams.set('direction', 'desc');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const res: Response | null = await fetch(url, { headers: headers(github) }).catch((): null => null);
    if (!res || !res.ok) break;
    const items: PullListItem[] = await res.json().catch((): PullListItem[] => []);
    if (!Array.isArray(items) || items.length === 0) break;
    for (const item of items) {
      if (item.user?.login === github.author) {
        found.push(await toOpenAuthoredPr(github, repo, item.number, item.title, item.draft ?? false, item.created_at));
      }
    }
    if (items.length < 100) break;
  }
  return found;
}

/**
 * Fetches the current author's OPEN pull requests. Combines the author-scoped
 * issue-search (broad, but blind to SSO-gated orgs whose search index the token
 * can't read) with a direct per-repo pulls scan of the configured `repos`
 * (which reaches those gated orgs), merged and de-duped. Fails soft: any source
 * that errors contributes nothing rather than throwing.
 */
export async function fetchOpenAuthoredPrs(
  github: GithubConfig,
  repos: string[] = [],
): Promise<OpenAuthoredPr[]> {
  const [searched, direct]: [OpenAuthoredPr[], OpenAuthoredPr[][]] = await Promise.all([
    searchOpenAuthoredPrs(github).catch((): OpenAuthoredPr[] => []),
    Promise.all(repos.map((repo) => repoOpenAuthoredPrs(github, repo).catch((): OpenAuthoredPr[] => []))),
  ]);
  const byKey: Map<string, OpenAuthoredPr> = new Map();
  for (const pr of [...searched, ...direct.flat()]) byKey.set(`${pr.repo}#${pr.number}`, pr);
  return [...byKey.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * Finds the PR number for a given branch on the given repo, or null if no
 * PR exists for that branch (or the lookup fails). Fails soft: never throws.
 */
export async function findPrNumberByBranch(
  github: GithubConfig,
  repo: string,
  branch: string,
): Promise<number | null> {
  const owner: string = repo.split('/')[0] ?? '';
  const params: URLSearchParams = new URLSearchParams({
    head: `${owner}:${branch}`,
    state: 'all',
    per_page: '1',
  });

  try {
    const res: Response = await fetch(`${API}/repos/${repo}/pulls?${params.toString()}`, {
      headers: headers(github),
    });
    if (!res.ok) return null;
    const prs: PullRequestItem[] = await res.json();
    return prs[0]?.number ?? null;
  } catch {
    return null;
  }
}

async function fetchCheckTally(
  github: GithubConfig,
  repo: string,
  headSha: string,
): Promise<{ passed: number; failed: number; pending: number }> {
  const empty: { passed: number; failed: number; pending: number } = { passed: 0, failed: 0, pending: 0 };
  try {
    const res: Response = await fetch(`${API}/repos/${repo}/commits/${headSha}/check-runs`, {
      headers: headers(github),
    });
    if (!res.ok) return empty;
    const body: CheckRunsResponse = await res.json();
    const passedConclusions: string[] = ['success', 'neutral', 'skipped'];
    const failedConclusions: string[] = [
      'failure',
      'timed_out',
      'cancelled',
      'action_required',
      'startup_failure',
    ];
    return body.check_runs.reduce(
      (tally, run: CheckRun) => {
        if (run.status !== 'completed' || run.conclusion === null) {
          return { ...tally, pending: tally.pending + 1 };
        }
        if (passedConclusions.includes(run.conclusion)) {
          return { ...tally, passed: tally.passed + 1 };
        }
        if (failedConclusions.includes(run.conclusion)) {
          return { ...tally, failed: tally.failed + 1 };
        }
        return { ...tally, pending: tally.pending + 1 };
      },
      empty,
    );
  } catch {
    return empty;
  }
}

/**
 * Fetches the full status of a PR: open/closed state, CI check tally, and
 * review decision. Fails soft: sub-fetches (checks, reviews) degrade to
 * zeros/REVIEW_REQUIRED rather than nulling the whole result, but a throw on
 * the primary pulls fetch returns null.
 */
export async function fetchPrStatus(
  github: GithubConfig,
  repo: string,
  prNumber: number,
): Promise<PrStatus | null> {
  try {
    const res: Response = await fetch(`${API}/repos/${repo}/pulls/${prNumber}`, {
      headers: headers(github),
    });
    if (!res.ok) return null;
    const body: PullRequestDetail = await res.json();

    const [checks, reviews]: [
      { passed: number; failed: number; pending: number },
      RawReview[] | null,
    ] = await Promise.all([
      fetchCheckTally(github, repo, body.head.sha),
      fetchReviews(github, repo, prNumber).catch(() => null),
    ]);

    const reviewList: RawReview[] = reviews ?? [];
    const reviewDecision: PrReviewDecision =
      reviews === null ? 'REVIEW_REQUIRED' : decisionFromReviews(reviewList);
    const requested: number =
      (body.requested_reviewers?.length ?? 0) + (body.requested_teams?.length ?? 0);

    return {
      number: prNumber,
      repo,
      state: body.state === 'closed' ? 'closed' : 'open',
      draft: body.draft ?? false,
      merged: body.merged ?? false,
      headRefName: body.head.ref,
      headSha: body.head.sha,
      reviewDecision,
      comments: body.comments ?? 0,
      checks,
      reviews: tallyReviews(reviewList, requested),
      url: body.html_url,
    };
  } catch {
    return null;
  }
}

/**
 * Submits a review on a PR. Fails soft: never throws, surfacing the GitHub
 * error message (or status code) on failure instead.
 */
export async function submitReview(
  github: GithubConfig,
  repo: string,
  prNumber: number,
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res: Response = await fetch(`${API}/repos/${repo}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      headers: { ...headers(github), 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, body }),
    });
    if (res.ok) return { ok: true };
    const errorBody: { message?: string } = await res.json().catch(() => ({}));
    return { ok: false, error: errorBody.message ?? `GitHub ${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const COPILOT_REVIEWER: string = 'copilot-pull-request-reviewer[bot]';

/**
 * Requests a GitHub Copilot code review on a PR by adding the Copilot bot as a
 * requested reviewer. Fails soft: a 422 when Copilot review is not enabled for
 * the repo (or the bot is not a valid reviewer) is surfaced, never thrown.
 */
export async function requestCopilotReview(
  github: GithubConfig,
  repo: string,
  prNumber: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res: Response = await fetch(`${API}/repos/${repo}/pulls/${prNumber}/requested_reviewers`, {
      method: 'POST',
      headers: { ...headers(github), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewers: [COPILOT_REVIEWER] }),
    });
    if (res.ok) return { ok: true };
    const errorBody: { message?: string } = await res.json().catch(() => ({}));
    return { ok: false, error: errorBody.message ?? `GitHub ${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
