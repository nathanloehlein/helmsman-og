export interface PrStatusView {
  number: number;
  repo: string;
  state: string;
  draft: boolean;
  merged: boolean;
  headRefName: string;
  reviewDecision: string;
  comments: number;
  checks: { passed: number; failed: number; pending: number };
  url: string;
}

export async function getPrStatus(repo: string, prNumber: number): Promise<PrStatusView | null> {
  try {
    const res: Response = await fetch(`/api/pr?repo=${encodeURIComponent(repo)}&number=${prNumber}`);
    if (!res.ok) return null;
    return (await res.json()) as PrStatusView;
  } catch {
    return null;
  }
}

export async function submitReview(
  repo: string,
  prNumber: number,
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res: Response = await fetch('/api/pr/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, number: prNumber, event, body }),
    });
    if (!res.ok) {
      const errBody: { error?: string } = await res.json().catch((): { error?: string } => ({}));
      return { ok: false, error: errBody.error };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function parsePrUrl(input: string): { repo: string; number: number } | null {
  const trimmed: string = input.trim();
  const urlMatch: RegExpMatchArray | null = trimmed.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i);
  if (urlMatch) return { repo: urlMatch[1], number: Number(urlMatch[2]) };
  const shortMatch: RegExpMatchArray | null = trimmed.match(/^([^/\s]+\/[^/\s]+)#(\d+)$/);
  if (shortMatch) return { repo: shortMatch[1], number: Number(shortMatch[2]) };
  return null;
}
