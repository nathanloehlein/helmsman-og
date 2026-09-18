import { describe, expect, it } from 'vitest';
import { reviewVerdictLine } from './review-verdict';

describe('reviewVerdictLine', () => {
  it.each([
    ['APPROVE', 'Approve'],
    ['REQUEST_CHANGES', 'Request changes'],
    ['COMMENT', 'Comment only'],
    ['Request changes', 'Request changes'],
    ['Comment only', 'Comment only'],
  ])('formats an explicit %s recommendation', (verdict, title) => {
    expect(reviewVerdictLine(`Verdict: ${verdict} — Tests cover the changed paths.\n\n## Findings\nDetails`))
      .toBe(`Verdict: ${title} — Tests cover the changed paths.`);
  });

  it.each([
    '**Verdict: Request changes** — Fix the retry loop.',
    '## **Verdict:** **REQUEST_CHANGES** — Fix the retry loop.',
    '## Verdict\n\nREQUEST_CHANGES — Fix the retry loop.',
    '### Review verdict\nREQUEST_CHANGES — Fix the retry loop.',
    'Recommendation: REQUEST_CHANGES — Fix the retry loop.',
  ])('handles labeled markdown: %s', body => {
    expect(reviewVerdictLine(body)).toBe('Verdict: Request changes — Fix the retry loop.');
  });

  it.each([
    '',
    'Looks good. I approve this change.',
    'Verdict: MAYBE — Needs another pass.',
    'Verdict: APPROVE',
    'Verdict: APPROVE — ** **',
    '> Verdict: APPROVE — Quoted recommendation.',
    '    Verdict: APPROVE — Indented code.',
    '\tVerdict: APPROVE — Indented code.',
    '```markdown\nVerdict: APPROVE — Example.\n```',
    '~~~markdown\nVerdict: APPROVE — Example.\n~~~',
    '````markdown\n```\nVerdict: APPROVE — Nested example.\n```\n````',
  ])('does not invent a recommendation from missing, malformed, or quoted output: %s', body => {
    expect(reviewVerdictLine(body)).toBe('Verdict: Comment only — No explicit recommendation provided.');
  });

  it('ignores quoted examples before the actual verdict', () => {
    expect(reviewVerdictLine('```\nVerdict: APPROVE — Example.\n```\n> Verdict: APPROVE — Quote.\nVerdict: COMMENT — Follow-up tests would help.'))
      .toBe('Verdict: Comment only — Follow-up tests would help.');
  });

  it('keeps reasons plain, single-line, and short', () => {
    expect(reviewVerdictLine('Verdict: REQUEST_CHANGES — Fix **retries** in [`worker`](https://example.com/worker) <b>before</b>\tshipping.'))
      .toBe('Verdict: Request changes — Fix retries in worker before shipping.');
    const prefix = 'Verdict: Comment only — ';
    const result = reviewVerdictLine(`Verdict: COMMENT — ${'a'.repeat(200)}`);
    expect(result.length).toBe(prefix.length + 140);
    expect(result.endsWith('…')).toBe(true);
  });

  it('guards invalid runtime input', () => {
    expect(reviewVerdictLine(null as unknown as string)).toBe('Verdict: Comment only — No explicit recommendation provided.');
  });
});
