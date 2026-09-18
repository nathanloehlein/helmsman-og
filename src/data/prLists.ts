import type { OpenPr } from '../types';

export interface PrListResult {
  prs: OpenPr[];
  degraded: boolean;
  truncated: boolean;
}

export interface PrListState extends PrListResult {
  loading: boolean;
}

export interface PrInboxState {
  reviewRequests: PrListState;
  authored: PrListState;
}

function isOpenPr(value: unknown): value is OpenPr {
  if (!value || typeof value !== 'object') return false;
  const pr = value as Partial<OpenPr>;
  return typeof pr.number === 'number' && Number.isSafeInteger(pr.number) && pr.number > 0
    && typeof pr.title === 'string'
    && typeof pr.repo === 'string' && /^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(pr.repo) && !['.', '..'].includes(pr.repo.split('/')[1] ?? '')
    && typeof pr.reviewDecision === 'string'
    && typeof pr.draft === 'boolean'
    && typeof pr.createdAt === 'string' && Number.isFinite(Date.parse(pr.createdAt));
}

async function fetchPrList(path: string, repo: string | null): Promise<PrListResult> {
  const unavailable: PrListResult = { prs: [], degraded: true, truncated: false };
  try {
    const query: string = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    const response: Response = await fetch(`${path}${query}`);
    if (!response.ok) return unavailable;
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object') return unavailable;
    const data = payload as Partial<PrListResult>;
    if (!Array.isArray(data.prs)) return unavailable;
    const prs: OpenPr[] = data.prs.filter(isOpenPr);
    return {
      prs,
      degraded: data.degraded !== false || typeof data.truncated !== 'boolean' || prs.length !== data.prs.length,
      truncated: data.truncated === true,
    };
  } catch {
    return unavailable;
  }
}

export function fetchReviewRequests(repo: string | null = null): Promise<PrListResult> {
  return fetchPrList('/api/pr/review-requests', repo);
}

export function fetchRepoOpenPrs(repo: string): Promise<PrListResult> {
  return fetchPrList('/api/pr/open', repo);
}
