const FALLBACK = 'Verdict: Comment only — No explicit recommendation provided.';

function plainText(value: string): string {
  return value
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function reviewVerdictLine(body: string): string {
  if (typeof body !== 'string') return FALLBACK;
  let fence: string | undefined;
  let awaitingVerdict = false;

  for (const source of body.split(/\r?\n/)) {
    const marker = source.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker?.[1]) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2]?.trim()) fence = undefined;
      continue;
    }
    if (fence || /^(?: {4}|\t|\s*>)/.test(source)) continue;
    const line = source.trim().replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '').replace(/\*\*|__/g, '').trim();
    if (!line) continue;
    const label = line.match(/^(?:(?:final|review)\s+)?(?:verdict|recommendation)\s*(?::\s*(.*))?$/i);
    if (!label && !awaitingVerdict) continue;
    const verdict = label ? label[1]?.trim() : line;
    if (!verdict) {
      awaitingVerdict = true;
      continue;
    }
    const match = verdict.match(/^(APPROVE|REQUEST(?:_|[ -])CHANGES|COMMENT(?:[ _-]ONLY)?)\s*(?:—|–|-|:)\s*(.+)$/i);
    if (!match?.[1] || !match[2]) return FALLBACK;
    const reason = plainText(match[2]);
    if (!reason) return FALLBACK;
    const action = match[1].toUpperCase();
    const title = action === 'APPROVE' ? 'Approve' : action.startsWith('REQUEST') ? 'Request changes' : 'Comment only';
    const shortReason = reason.length > 140 ? `${reason.slice(0, 139).trimEnd()}…` : reason;
    return `Verdict: ${title} — ${shortReason}`;
  }
  return FALLBACK;
}
