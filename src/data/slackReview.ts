import { safeSlackUrl } from './slack';

export interface SlackReviewResult {
  channel: string;
  mention: string;
  permalink: string | null;
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
  return { channel: data.channel, mention: data.mention, permalink: safeSlackUrl(data.permalink) };
}
