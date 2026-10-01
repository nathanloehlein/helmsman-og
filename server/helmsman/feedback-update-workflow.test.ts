import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { runFeedbackUpdateWorkflow, type FeedbackUpdateOptions } from './feedback-update-workflow';
import type { FeedbackSnapshot } from './pr-feedback-snapshot';
import type { FeedbackAudit } from './feedback-audit';

const snapshot: FeedbackSnapshot = {
  repo: 'o/r', prNumber: 11104, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), headBranch: 'fix/svg', baseBranch: 'main', state: 'OPEN', fingerprint: 'c'.repeat(64),
  sources: [
    { id: 'review:1', kind: 'review', url: 'https://github.com/o/r/pull/11104#pullrequestreview-1', body: 'Fix MIME mismatch', updatedAt: '2026-09-30T00:00:00Z' },
    { id: 'comment:2', kind: 'comment', url: 'https://github.com/o/r/pull/11104#issuecomment-2', body: 'Fixed and tested', updatedAt: '2026-09-30T01:00:00Z' },
  ],
};

function report(source = snapshot): FeedbackAudit {
  return { headSha: source.headSha, snapshotFingerprint: source.fingerprint, summary: 'Verified source and caller behavior', findings: [],
    coverage: source.sources.map(item => ({ sourceId: item.id, findings: item.id === 'review:1' ? [{ title: 'Favicon MIME', required: true,
      disposition: 'fixed', evidence: 'Normalized SVG type is preserved through self-hosting.', responseUrl: snapshot.sources[1]!.url }] : [] })) };
}

function options(overrides: Partial<FeedbackUpdateOptions> = {}) {
  return {
    maxRounds: 3, collect: vi.fn(async () => snapshot), author: vi.fn(async () => undefined),
    audit: vi.fn(async () => [report()]), decide: vi.fn(async () => 'Security owner: remediate historical assets before merge.'),
    outcome: vi.fn(), assertRevision: vi.fn(async () => undefined), isStopped: () => false, ...overrides,
  };
}

describe('feedback completion workflow', () => {
  it('requires independent reports and a fresh discussion read for response-only completion', async () => {
    const calls: string[] = [];
    const deps = options({ collect: async () => { calls.push('collect'); return snapshot; },
      author: async () => { calls.push('author'); }, audit: async () => { calls.push('audit'); return [report()]; } });
    await runFeedbackUpdateWorkflow(deps);
    expect(calls).toEqual(['collect', 'author', 'collect', 'audit', 'collect']);
    expect(deps.outcome).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'completed', headSha: snapshot.headSha }));
  });

  it('repairs newly found defects and rechecks them before completing', async () => {
    const failed = report();
    failed.findings = [{ title: 'Caller keeps stale MIME', body: 'Self-hosting prefers scraped PNG over normalized SVG.' }];
    const deps = options({ audit: vi.fn().mockResolvedValueOnce([failed]).mockResolvedValueOnce([report()]) });
    await runFeedbackUpdateWorkflow(deps);
    expect(deps.author).toHaveBeenCalledTimes(2);
    expect(deps.author).toHaveBeenLastCalledWith(snapshot, expect.stringContaining('Caller keeps stale MIME'), 2);
    expect(deps.outcome).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'completed' }));
  });

  it('does not treat an author exit or missing independent report as completion', async () => {
    const deps = options({ audit: async () => [] });
    await expect(runFeedbackUpdateWorkflow(deps)).rejects.toThrow('did not produce a report');
    expect(deps.outcome).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'changes_remaining' }));
  });

  it.each(['missing source', 'stale head', 'stale snapshot'])('rejects incomplete verification: %s', async defect => {
    const invalid = report();
    if (defect === 'missing source') invalid.coverage.pop();
    if (defect === 'stale head') invalid.headSha = 'e'.repeat(40);
    if (defect === 'stale snapshot') invalid.snapshotFingerprint = 'f'.repeat(64);
    const deps = options({ audit: async () => [invalid] });
    await expect(runFeedbackUpdateWorkflow(deps)).rejects.toThrow('Feedback audit');
    expect(deps.outcome).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'completed' }));
  });

  it('does not complete while any independent reviewer finds missing response evidence', async () => {
    const incomplete = report();
    delete incomplete.coverage[0]!.findings[0]!.responseUrl;
    const deps = options({ maxRounds: 1, audit: async () => [report(), incomplete] });
    await expect(runFeedbackUpdateWorkflow(deps)).rejects.toThrow('Feedback remains');
    expect(deps.outcome).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'changes_remaining' }));
  });

  it('reconciles an edited summary arriving during audit even when head is unchanged', async () => {
    const edited = { ...snapshot, fingerprint: 'd'.repeat(64), sources: snapshot.sources.map(item => ({ ...item, body: `${item.body}\nNew attribute complexity concern` })) };
    const deps = options({ collect: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(snapshot).mockResolvedValue(edited),
      audit: vi.fn().mockResolvedValueOnce([report()]).mockResolvedValueOnce([report(edited)]) });
    await runFeedbackUpdateWorkflow(deps);
    expect(deps.author).toHaveBeenCalledTimes(2);
    expect(deps.author).toHaveBeenLastCalledWith(edited, expect.stringContaining('changed during independent review'), 2);
  });

  it('fails after the repair limit instead of marking deferred required findings successful', async () => {
    const deferred = report();
    deferred.coverage[0]!.findings[0]!.disposition = 'deferred';
    const deps = options({ audit: async () => [deferred] });
    await expect(runFeedbackUpdateWorkflow(deps)).rejects.toThrow('after 3 review rounds');
    expect(deps.author).toHaveBeenCalledTimes(3);
    expect(deps.outcome).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'completed' }));
  });

  it('keeps an owner decision pending, then repairs and independently verifies the answer', async () => {
    const blocked = report();
    blocked.coverage[0]!.findings[0] = { title: 'Historical exposure', required: true, disposition: 'decision_required',
      evidence: 'Review requires security-owner decision', question: 'Must existing SVGs be remediated before merge?' };
    const deps = options({ maxRounds: 1, audit: vi.fn().mockResolvedValueOnce([blocked, blocked]).mockImplementation(async (_snapshot, _round, decisions: string) => [{ ...report(), decisionFingerprint: createHash('sha256').update(decisions).digest('hex') }]) });
    await runFeedbackUpdateWorkflow(deps);
    expect(deps.decide).toHaveBeenCalledOnce();
    expect(deps.decide).toHaveBeenCalledWith([{ sourceUrl: snapshot.sources[0]!.url, question: 'Must existing SVGs be remediated before merge?' }]);
    expect(deps.outcome).toHaveBeenCalledWith(expect.objectContaining({ state: 'awaiting_decision' }));
    expect(deps.author).toHaveBeenLastCalledWith(snapshot, expect.stringContaining('Security owner: remediate historical assets'), 2);
    expect(deps.outcome).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'completed' }));
  });

  it('binds answers requested by the author into the independent audit', async () => {
    const evidence = 'Local operator answered author question: apply historical remediation before merge.';
    const decisionFingerprint = createHash('sha256').update(evidence).digest('hex');
    const audit = vi.fn(async () => [{ ...report(), decisionFingerprint }]);
    const deps = options({ clarificationEvidence: async () => evidence, audit });
    await runFeedbackUpdateWorkflow(deps);
    expect(audit).toHaveBeenCalledWith(snapshot, 1, evidence);
    expect(deps.decide).not.toHaveBeenCalled();
    expect(deps.outcome).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'completed' }));
  });

  it('reaudits when authoritative clarification evidence changes during review', async () => {
    const evidence = vi.fn().mockResolvedValueOnce('Initial answer').mockResolvedValue('Updated authority evidence');
    const audit = vi.fn(async (_snapshot: FeedbackSnapshot, _round: number, decisions: string) => [{
      ...report(), decisionFingerprint: createHash('sha256').update(decisions).digest('hex'),
    }]);
    const deps = options({ clarificationEvidence: evidence, audit });
    await runFeedbackUpdateWorkflow(deps);
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenLastCalledWith(snapshot, 2, 'Updated authority evidence');
    expect(deps.author).toHaveBeenLastCalledWith(snapshot, expect.stringContaining('Updated authority evidence'), 2);
  });

  it('cannot complete if an author exits with an unanswered required question', async () => {
    const deps = options({ clarificationEvidence: async () => { throw new Error('Required clarification is unanswered'); } });
    await expect(runFeedbackUpdateWorkflow(deps)).rejects.toThrow('unanswered');
    expect(deps.audit).not.toHaveBeenCalled();
    expect(deps.outcome).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'changes_remaining' }));
  });

  it('does not accept a missing answer or expired decision', async () => {
    const blocked = report();
    blocked.coverage[0]!.findings[0] = { title: 'Historical exposure', required: true, disposition: 'decision_required',
      evidence: 'Review requires security-owner decision', question: 'Remediate existing SVGs?' };
    const deps = options({ audit: async () => [blocked], decide: async () => '' });
    await expect(runFeedbackUpdateWorkflow(deps)).rejects.toThrow('no answer');
    expect(deps.author).toHaveBeenCalledOnce();
    expect(deps.outcome).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'changes_remaining' }));
  });

  it.each(['baseBranch', 'headBranch', 'state', 'repo', 'prNumber'])('rejects concurrent PR identity changes: %s', async field => {
    const changed = { ...snapshot, [field]: field === 'prNumber' ? 999 : 'changed' } as FeedbackSnapshot;
    const deps = options({ collect: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValue(changed) });
    await expect(runFeedbackUpdateWorkflow(deps)).rejects.toThrow('changed during feedback update');
    expect(deps.outcome).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'completed' }));
  });

  it('fails safely if the checked-out revision differs from the published PR', async () => {
    const deps = options({ assertRevision: async () => { throw new Error('revision mismatch'); } });
    await expect(runFeedbackUpdateWorkflow(deps)).rejects.toThrow('revision mismatch');
    expect(deps.author).not.toHaveBeenCalled();
  });
});
