import type { GithubConfig } from './config';
import { cachedGithubRead } from './github-read-cache';
import { fetchPrListStats, type PrListStats } from './github';

export interface ListedPr extends PrListStats {
  number: number;
  title: string;
  repo: string;
  reviewDecision: string;
  draft: boolean;
  createdAt: string;
}

export interface PrListResponse {
  prs: ListedPr[];
  degraded: boolean;
  truncated: boolean;
}

interface RawListResponse {
  items: unknown[];
  degraded: boolean;
  truncated: boolean;
}

const API: string = 'https://api.github.com';
const PAGE_SIZE: number = 100;
const PAGE_CAP: number = 3;
const STATS_LIMIT = 30;
const STATS_CONCURRENCY = 4;

export function isGithubRepo(repo: string): boolean {
  return /^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repo) && !['.', '..'].includes(repo.split('/')[1] ?? '');
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toListedPr(value: unknown, repo: string, reviewDecision: string): ListedPr | null {
  const item = record(value);
  if (!item || typeof item.number !== 'number' || !Number.isInteger(item.number) || item.number < 1 ||
    typeof item.title !== 'string' || typeof item.created_at !== 'string' ||
    !Number.isFinite(Date.parse(item.created_at)) || !isGithubRepo(repo)) return null;
  return {
    number: item.number,
    title: item.title,
    repo,
    reviewDecision,
    draft: item.draft === true,
    createdAt: item.created_at,
  };
}

async function fetchPages(github: GithubConfig, url: URL, search: boolean): Promise<RawListResponse> {
  const result: RawListResponse = { items: [], degraded: false, truncated: false };
  for (let page = 1; page <= PAGE_CAP; page++) {
    url.searchParams.set('per_page', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    try {
      const response: Response = await cachedGithubRead(github, url);
      if (!response.ok) {
        result.degraded = true;
        break;
      }
      const body: unknown = await response.json();
      const searchBody = record(body);
      const items: unknown = search ? searchBody?.items : body;
      if (!Array.isArray(items)) {
        result.degraded = true;
        break;
      }
      result.items.push(...items);
      if (searchBody?.incomplete_results === true) result.degraded = true;
      const total: unknown = searchBody?.total_count;
      const link: string = response.headers.get('link') ?? '';
      const hasMore: boolean = /rel="next"/.test(link) ||
        (search && typeof total === 'number' && total > page * PAGE_SIZE);
      if (page === PAGE_CAP && (hasMore || (items.length === PAGE_SIZE && !link && typeof total !== 'number'))) {
        result.truncated = true;
      }
      if (!hasMore && (items.length < PAGE_SIZE || link || (search && typeof total === 'number'))) break;
    } catch {
      result.degraded = true;
      break;
    }
  }
  return result;
}

function pullsUrl(repo: string): URL {
  const url: URL = new URL(`${API}/repos/${repo}/pulls`);
  url.searchParams.set('state', 'open');
  url.searchParams.set('sort', 'created');
  url.searchParams.set('direction', 'desc');
  return url;
}

function emptyUnavailable(): PrListResponse {
  return { prs: [], degraded: true, truncated: false };
}

function sortedUnique(prs: ListedPr[]): ListedPr[] {
  const byKey: Map<string, ListedPr> = new Map();
  for (const pr of prs) byKey.set(`${pr.repo.toLowerCase()}#${pr.number}`, pr);
  return [...byKey.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export async function fetchRepoOpenPrs(github: GithubConfig | null, repo: string): Promise<PrListResponse> {
  if (!github?.token || !isGithubRepo(repo)) return emptyUnavailable();
  const raw: RawListResponse = await fetchPages(github, pullsUrl(repo), false);
  const result: PrListResponse = { prs: [], degraded: raw.degraded, truncated: raw.truncated };
  for (const item of raw.items) {
    const pr: ListedPr | null = toListedPr(item, repo, '');
    if (pr) result.prs.push(pr);
    else result.degraded = true;
  }
  result.prs = sortedUnique(result.prs);
  const pending = result.prs.slice(0, STATS_LIMIT);
  await Promise.all(Array.from({ length: Math.min(STATS_CONCURRENCY, pending.length) }, async () => {
    for (let pr = pending.shift(); pr; pr = pending.shift()) {
      Object.assign(pr, await fetchPrListStats(github, pr.repo, pr.number));
    }
  }));
  return result;
}

export async function fetchReviewRequestedPrs(
  github: GithubConfig | null,
  repos: string[] = [],
  selectedRepo: string | null = null,
): Promise<PrListResponse> {
  if (!github?.token || !github.author || (selectedRepo !== null && !isGithubRepo(selectedRepo))) return emptyUnavailable();
  const url: URL = new URL(`${API}/search/issues`);
  url.searchParams.set('q', `is:pr is:open review-requested:${github.author}${selectedRepo ? ` repo:${selectedRepo}` : ''}`);
  url.searchParams.set('sort', 'created');
  url.searchParams.set('order', 'desc');
  const configuredRepos: string[] = [...new Set(selectedRepo ? [selectedRepo] : repos)];
  const validRepos: string[] = configuredRepos.filter(isGithubRepo);
  const [searched, direct] = await Promise.all([
    fetchPages(github, url, true),
    Promise.all(validRepos.map(async (repo) => ({ repo, raw: await fetchPages(github, pullsUrl(repo), false) }))),
  ]);
  const result: PrListResponse = {
    prs: [],
    degraded: searched.degraded || validRepos.length !== configuredRepos.length,
    truncated: searched.truncated,
  };
  for (const value of searched.items) {
    const item = record(value);
    const repositoryUrl: unknown = item?.repository_url;
    const repo: string = typeof repositoryUrl === 'string' && repositoryUrl.startsWith(`${API}/repos/`)
      ? repositoryUrl.slice(`${API}/repos/`.length) : '';
    const pr: ListedPr | null = toListedPr(value, repo, 'REVIEW_REQUIRED');
    if (pr && (!selectedRepo || pr.repo.toLowerCase() === selectedRepo.toLowerCase())) result.prs.push(pr);
    else result.degraded = true;
  }
  for (const { repo, raw } of direct) {
    result.degraded ||= raw.degraded;
    result.truncated ||= raw.truncated;
    for (const value of raw.items) {
      const item = record(value);
      const pr: ListedPr | null = toListedPr(value, repo, 'REVIEW_REQUIRED');
      if (!pr || !Array.isArray(item?.requested_reviewers)) {
        result.degraded = true;
        continue;
      }
      const requested: boolean = item.requested_reviewers.some((reviewer: unknown) => {
        const login: unknown = record(reviewer)?.login;
        return typeof login === 'string' && login.toLowerCase() === github.author.toLowerCase();
      });
      if (requested) result.prs.push(pr);
    }
  }
  result.prs = sortedUnique(result.prs);
  return result;
}
