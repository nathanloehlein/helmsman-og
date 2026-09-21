import { safeSlackUrl } from './slack';

export interface SlackReviewResult {
  channel: string;
  mention: string;
  permalink: string | null;
  sentAt?: string | null;
}

export interface SlackReviewRequestState {
  requestId: string;
  repo: string;
  prNumber: number;
  status: 'pending' | 'sent' | 'failed' | 'uncertain';
  lastRequestedAt: string;
  lastSentAt: string | null;
  permalink: string | null;
  error: string | null;
}

export async function fetchSlackReviewRequests(repo: string | null = null): Promise<SlackReviewRequestState[] | null> {
  try {
    const response = await fetch(`/api/slack/review-requests${repo === null ? '' : `?repo=${encodeURIComponent(repo)}`}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('requests' in payload) || !Array.isArray(payload.requests)) return null;
    const requests: SlackReviewRequestState[] = [];
    for (const value of payload.requests) {
      if (!value || typeof value !== 'object' || typeof value.requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value.requestId)
        || typeof value.repo !== 'string' || !/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(value.repo)
        || repo !== null && value.repo.toLowerCase() !== repo.toLowerCase()
        || !Number.isSafeInteger(value.prNumber) || value.prNumber < 1 || !['pending', 'sent', 'failed', 'uncertain'].includes(value.status)
        || typeof value.lastRequestedAt !== 'string' || !Number.isFinite(Date.parse(value.lastRequestedAt))
        || value.lastSentAt !== null && (typeof value.lastSentAt !== 'string' || !Number.isFinite(Date.parse(value.lastSentAt)))
        || value.error !== null && typeof value.error !== 'string') return null;
      requests.push({ requestId: value.requestId, repo: value.repo, prNumber: value.prNumber, status: value.status, lastRequestedAt: value.lastRequestedAt,
        lastSentAt: value.lastSentAt, permalink: safeSlackUrl(value.permalink), error: value.error });
    }
    return requests;
  } catch { return null; }
}

export class SlackReviewRequestError extends Error {
  readonly uncertain: boolean;
  constructor(message: string, uncertain: boolean) {
    super(message);
    this.uncertain = uncertain;
  }
}

export async function requestSlackReview(repo: string, prNumber: number, requestId: string): Promise<SlackReviewResult> {
  const response = await fetch('/api/slack/review-request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo, prNumber, requestId }),
  });
  const data = await response.json().catch(() => null) as Partial<SlackReviewResult> & { ok?: boolean; error?: unknown; uncertain?: boolean } | null;
  if (!response.ok || data?.ok !== true) {
    throw new SlackReviewRequestError(typeof data?.error === 'string' ? data.error : 'Unable to confirm the Slack request. Check the channel before retrying.', data?.uncertain !== false);
  }
  if (typeof data.channel !== 'string' || typeof data.mention !== 'string') {
    throw new Error('Unable to confirm the Slack destination. Check the channel before retrying.');
  }
  const sentAt = data.sentAt === null || typeof data.sentAt === 'string' && Number.isFinite(Date.parse(data.sentAt)) ? data.sentAt : undefined;
  return { channel: data.channel, mention: data.mention, permalink: safeSlackUrl(data.permalink), ...(sentAt === undefined ? {} : { sentAt }) };
}
