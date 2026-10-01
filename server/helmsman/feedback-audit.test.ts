import { describe, expect, it } from 'vitest';
import { feedbackAuditOutcome, parseFeedbackAudit, type FeedbackAudit, type FeedbackDispositionFinding } from './feedback-audit';
import type { FeedbackSnapshot } from './pr-feedback-snapshot';

const pr = 'https://github.com/example/project/pull/42';
const responseUrl = `${pr}#issuecomment-12`;
const snapshot: FeedbackSnapshot = {
  repo: 'example/project', prNumber: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  baseBranch: 'main', headBranch: 'fix/issue', state: 'OPEN', fingerprint: 'snapshot-1',
  sources: [
    { id: 'review:11', url: `${pr}#pullrequestreview-11`, body: 'Fix the missing guard. Also validate callers.', kind: 'review', updatedAt: '2026-09-30T00:00:00Z' },
    { id: 'comment:12', url: responseUrl, body: 'Guard and caller fixed in the pushed commit; regression passed.', kind: 'comment', updatedAt: '2026-09-30T00:01:00Z' },
  ],
};

function report(patch: Partial<FeedbackDispositionFinding> = {}): FeedbackAudit {
  return { headSha: snapshot.headSha, snapshotFingerprint: snapshot.fingerprint, summary: 'comment:12 is the informational response to review:11.',
    coverage: [
      { sourceId: 'review:11', findings: [{ title: 'Missing guard', required: true, disposition: 'fixed', evidence: 'Guard and caller verified at the pinned commit; regression passes.', responseUrl, ...patch }] },
      { sourceId: 'comment:12', findings: [] },
    ], findings: [] };
}

describe('parseFeedbackAudit', () => {
  it('accepts complete snapshot coverage with published response evidence', () => {
    expect(parseFeedbackAudit(report(), snapshot)).toEqual(report());
  });

  it('preserves multiple findings inside one edited review summary', () => {
    const audit = report();
    audit.coverage[0]!.findings.push({ title: 'Caller validation', required: true, disposition: 'remaining', evidence: 'Caller still bypasses the guard.' });
    const parsed = parseFeedbackAudit(audit, snapshot);
    expect(parsed.coverage[0]?.findings).toHaveLength(2);
    expect(feedbackAuditOutcome(parsed)).toBe('changes_remaining');
  });

  it.each(['headSha', 'snapshotFingerprint'] as const)('rejects stale %s', field => {
    const audit = report();
    audit[field] = field === 'headSha' ? 'c'.repeat(40) : 'old-snapshot';
    expect(() => parseFeedbackAudit(audit, snapshot)).toThrow('stale');
  });

  it('binds the audit to the exact trusted human-decision transcript', () => {
    const audit = { ...report(), decisionFingerprint: 'decisions-round-2' };
    expect(parseFeedbackAudit(audit, snapshot, 'decisions-round-2')).toEqual(audit);
  });

  it.each([undefined, 'old-transcript', null, 123])('rejects a missing or stale human-decision binding: %s', fingerprint => {
    expect(() => parseFeedbackAudit({ ...report(), decisionFingerprint: fingerprint }, snapshot, 'current-transcript')).toThrow('human-decision transcript');
  });

  it.each(['invented-transcript', '', null])('rejects an unbound human-decision claim: %s', fingerprint => {
    expect(() => parseFeedbackAudit({ ...report(), decisionFingerprint: fingerprint }, snapshot)).toThrow('human-decision transcript');
  });

  it('rejects an empty expected decision fingerprint', () => {
    expect(() => parseFeedbackAudit({ ...report(), decisionFingerprint: '' }, snapshot, '')).toThrow('human-decision transcript');
  });

  it.each(['omitted', 'duplicate', 'unknown'])('rejects %s source coverage', kind => {
    const audit = report();
    if (kind === 'omitted') audit.coverage.pop();
    else audit.coverage[1]!.sourceId = kind === 'duplicate' ? 'review:11' : 'comment:99';
    expect(() => parseFeedbackAudit(audit, snapshot)).toThrow(/coverage/);
  });

  it('rejects duplicate snapshot identities rather than accepting ambiguous coverage', () => {
    expect(() => parseFeedbackAudit(report(), { ...snapshot, sources: [snapshot.sources[0]!, snapshot.sources[0]!] })).toThrow('exactly once');
  });

  it.each([null, {}, [], { ...report(), coverage: null }, { ...report(), findings: null }, { ...report(), summary: ' ' },
    { ...report(), headSha: 'not-a-sha' }, { ...report(), summary: 'x'.repeat(8001) }])('rejects a malformed report', value => {
    expect(() => parseFeedbackAudit(value, snapshot)).toThrow();
  });

  it.each([
    { title: '' }, { title: 'x'.repeat(181) }, { evidence: '' }, { evidence: 'x'.repeat(8001) },
    { disposition: 'approved' }, { disposition: ['fixed'] }, { required: 'true' }, { question: ' ' },
  ])('rejects a malformed source finding %j', patch => {
    const audit = report();
    Object.assign(audit.coverage[0]!.findings[0]!, patch);
    expect(() => parseFeedbackAudit(audit, snapshot)).toThrow('malformed');
  });

  it.each([
    `${pr}#issuecomment-999`, 'https://github.com/example/project/pull/43#issuecomment-12',
    'https://github.com/other/project/pull/42#issuecomment-12', pr,
  ])('rejects an unknown or wrong PR response %s', url => {
    expect(() => parseFeedbackAudit(report({ responseUrl: url }), snapshot)).toThrow('response');
  });

  it('rejects a wrong-PR response even if it appears in snapshot sources', () => {
    const url = 'https://github.com/example/project/pull/43#issuecomment-12';
    const wrongPr = { ...snapshot, sources: snapshot.sources.map(source => source.id === 'comment:12' ? { ...source, url } : source) };
    expect(() => parseFeedbackAudit(report({ responseUrl: url }), wrongPr)).toThrow('response');
  });

  it.each(['inline', 'review'] as const)('accepts a verified %s response URL', kind => {
    const url = `${pr}#${kind === 'inline' ? 'discussion_r' : 'pullrequestreview-'}12`;
    const revised = { ...snapshot, sources: snapshot.sources.map(source => source.id === 'comment:12' ? { ...source, kind, url } : source) };
    expect(parseFeedbackAudit(report({ responseUrl: url }), revised).coverage[0]?.findings[0]?.responseUrl).toBe(url);
  });

  it('accepts GitHub repository casing while retaining exact snapshot URL matching', () => {
    const url = 'https://github.com/Example/Project/pull/42#issuecomment-12';
    const revised = { ...snapshot, sources: snapshot.sources.map(source => source.id === 'comment:12' ? { ...source, url } : source) };
    expect(parseFeedbackAudit(report({ responseUrl: url }), revised).coverage[0]?.findings[0]?.responseUrl).toBe(url);
  });

  it('does not count an unpublished pending review as a response', () => {
    const url = `${pr}#pullrequestreview-12`;
    const revised: FeedbackSnapshot = { ...snapshot, sources: snapshot.sources.map(source => source.id === 'comment:12'
      ? { ...source, kind: 'review', state: 'PENDING', submittedAt: null, url } : source) };
    expect(() => parseFeedbackAudit(report({ responseUrl: url }), revised)).toThrow('response');
  });

  it.each([{ required: false, question: 'Should the requirement change?' }, { required: true }])('rejects an invalid required decision', patch => {
    expect(() => parseFeedbackAudit(report({ disposition: 'decision_required', ...patch }), snapshot)).toThrow('decision');
  });

  it.each([
    { title: '', body: 'Defect' }, { title: 'Defect', body: '' },
    { title: 'Defect', body: 'Evidence', path: '../secret' },
    { title: 'Defect', body: 'Evidence', path: '/absolute' },
    { title: 'Defect', body: 'Evidence', path: 'src/code.ts', line: 0 },
    { title: 'Defect', body: 'Evidence', line: 1 },
  ])('rejects malformed fresh findings', finding => {
    expect(() => parseFeedbackAudit({ ...report(), findings: [finding] }, snapshot)).toThrow('fresh');
  });

  it('bounds fresh findings without truncating them into success', () => {
    expect(() => parseFeedbackAudit({ ...report(), findings: Array.from({ length: 41 }, () => ({ title: 'Defect', body: 'Evidence' })) }, snapshot)).toThrow();
  });

  it('bounds findings within a source without truncating coverage', () => {
    const audit = report();
    audit.coverage[0]!.findings = Array.from({ length: 201 }, () => ({ ...audit.coverage[0]!.findings[0]! }));
    expect(() => parseFeedbackAudit(audit, snapshot)).toThrow('coverage');
  });

  it('bounds total source findings without silently dropping covered sources', () => {
    const revised: FeedbackSnapshot = { ...snapshot, sources: Array.from({ length: 11 }, (_, i) => ({ ...snapshot.sources[0]!, id: `review:${i}` })) };
    const audit = report({ disposition: 'remaining', responseUrl: undefined });
    audit.coverage = revised.sources.map(source => ({ sourceId: source.id,
      findings: Array.from({ length: 200 }, () => ({ ...report({ disposition: 'remaining', responseUrl: undefined }).coverage[0]!.findings[0]! })) }));
    expect(() => parseFeedbackAudit(audit, revised)).toThrow('2000');
  });
});

describe('feedbackAuditOutcome', () => {
  it.each(['fixed', 'dismissed'] as const)('completes verified %s findings with a response', disposition => {
    expect(feedbackAuditOutcome(parseFeedbackAudit(report({ disposition }), snapshot))).toBe('completed');
  });

  it('permits an optional deferral with evidence and a published response', () => {
    expect(feedbackAuditOutcome(parseFeedbackAudit(report({ required: false, disposition: 'deferred' }), snapshot))).toBe('completed');
  });

  it.each(['fixed', 'dismissed', 'deferred'] as const)('does not complete %s without a published response', disposition => {
    expect(feedbackAuditOutcome(parseFeedbackAudit(report({ disposition, required: false, responseUrl: undefined }), snapshot))).toBe('changes_remaining');
  });

  it.each(['deferred', 'remaining'] as const)('blocks required %s findings even with a reply', disposition => {
    expect(feedbackAuditOutcome(parseFeedbackAudit(report({ disposition }), snapshot))).toBe('changes_remaining');
  });

  it('blocks fresh material defects even when every original finding is addressed', () => {
    const audit = report();
    audit.findings.push({ title: 'New regression', body: 'Updated caller now fails on a supported input.', path: 'src/caller.ts', line: 9 });
    expect(feedbackAuditOutcome(parseFeedbackAudit(audit, snapshot))).toBe('changes_remaining');
  });

  it('surfaces a required owner decision ahead of other remaining changes', () => {
    const audit = report({ disposition: 'decision_required', responseUrl: undefined, question: 'Which contractual retention period applies?' });
    audit.findings.push({ title: 'Another issue', body: 'Repair required.' });
    expect(feedbackAuditOutcome(parseFeedbackAudit(audit, snapshot))).toBe('awaiting_decision');
  });
});
