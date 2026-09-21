import type { GithubConfig } from '../config';

export const FEEDBACK_REPO = 'nloehlein-godaddy/helmsman';

export class FeedbackError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function createFeedback(github: GithubConfig | null, input: unknown, fetchImpl: typeof fetch = fetch): Promise<{ url: string }> {
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const title = typeof data?.title === 'string' ? data.title.trim() : '';
  const body = typeof data?.body === 'string' ? data.body.trim() : '';
  if (!title || title.length > 256 || !body || body.length > 10_000) {
    throw new FeedbackError('Enter a title (up to 256 characters) and description (up to 10,000 characters).', 400);
  }
  if (!github?.token) throw new FeedbackError('GitHub is not configured. Use Open in GitHub to submit feedback in your browser.', 503);
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${FEEDBACK_REPO}/issues`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${github.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ title, body }),
    });
  } catch {
    throw new FeedbackError('Could not confirm submission. Check Helmsman’s GitHub issues before trying again.', 502);
  }
  if (!response.ok) throw new FeedbackError(`GitHub rejected feedback (${response.status}). Use Open in GitHub, or check access to the Helmsman issue tracker.`, 502);
  let issue: { number?: unknown } | null;
  try { issue = await response.json() as { number?: unknown } | null; }
  catch { throw new FeedbackError('Feedback may have been created. Check Helmsman’s GitHub issues before trying again.', 502); }
  if (typeof issue?.number !== 'number' || !Number.isSafeInteger(issue.number) || issue.number < 1) {
    throw new FeedbackError('Feedback may have been created. Check Helmsman’s GitHub issues before trying again.', 502);
  }
  return { url: `https://github.com/${FEEDBACK_REPO}/issues/${issue.number}` };
}
