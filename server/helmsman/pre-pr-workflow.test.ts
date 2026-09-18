import { describe, expect, it, vi } from 'vitest';
import type { AgentTask } from './agents/adapter';
import { parsePrePrReview, runPrePrWorkflow, type PrePrOptions, type PrePrSnapshot } from './pre-pr-workflow';

const baseSha = 'a'.repeat(40);
const firstHead = 'b'.repeat(40);
const repairedHead = 'c'.repeat(40);
const task: AgentTask = { ticketId: 'TEST-1', title: 'Implement task', repo: 'org/repo', jiraBaseUrl: 'https://jira.example.com' };
const finding = { title: 'Reject invalid quantities', body: 'A negative quantity increases inventory. Reject it before updating inventory.', path: 'src/inventory.ts', line: 42 };
function report(headSha = firstHead, verdict = 'APPROVE', findings: unknown[] = []) {
  return { baseSha, headSha, verdict, summary: 'Reviewed full implementation and acceptance criteria.', findings };
}
function setup() {
  const order: string[] = [];
  let state: PrePrSnapshot = { baseSha, headSha: baseSha, branch: 'agent/test-1', clean: true };
  const snapshot = vi.fn(async () => ({ ...state }));
  const runAuthor = vi.fn<PrePrOptions['runAuthor']>(async stage => {
    order.push(stage);
    state.headSha = stage === 'implement' ? firstHead : repairedHead;
  });
  const review = vi.fn<PrePrOptions['review']>(async reviewer => {
    order.push(`review:${reviewer}`);
    return report(state.headSha);
  });
  const publish = vi.fn<PrePrOptions['publish']>(async () => { order.push('publish'); return 123; });
  const options: PrePrOptions = { writerId: 'codex', reviewerIds: ['codex', 'claude-code'], snapshot, runAuthor, review, publish, onPhase: vi.fn() };
  return { options, state, order, snapshot, runAuthor, review, publish };
}

describe('pre-PR adversarial workflow', () => {
  it('publishes once only after independent writer and alternate approvals on the exact committed revision', async () => {
    const { options, order, review, publish } = setup();
    await expect(runPrePrWorkflow(task, options)).resolves.toBe(123);
    expect(order).toEqual(['implement', 'review:codex', 'review:claude-code', 'publish']);
    expect(review).toHaveBeenNthCalledWith(1, 'codex', { baseSha, headSha: firstHead, round: 1 });
    expect(review).toHaveBeenNthCalledWith(2, 'claude-code', { baseSha, headSha: firstHead, round: 1 });
    expect(publish).toHaveBeenCalledExactlyOnceWith({ baseSha, headSha: firstHead, branch: 'agent/test-1' });
  });

  it('uses the same CLI reviewer when it is the only installed provider', async () => {
    const { options, review } = setup();
    options.writerId = 'claude-code';
    options.reviewerIds = ['claude-code'];
    await runPrePrWorkflow(task, options);
    expect(review).toHaveBeenCalledExactlyOnceWith('claude-code', { baseSha, headSha: firstHead, round: 1 });
  });

  it.each([[], ['claude-code'], ['codex', 'codex'], ['codex', 'unknown'], ['codex', 'claude-code', 'other']])('rejects invalid reviewer selection %j', async (...ids) => {
    const { options, runAuthor, publish } = setup();
    options.reviewerIds = ids as string[];
    await expect(runPrePrWorkflow(task, options)).rejects.toThrow('reviewers must include');
    expect(runAuthor).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('repairs deduplicated findings and reviews the entire new revision with both providers', async () => {
    const { options, review, runAuthor, order, publish } = setup();
    review.mockImplementation(async (reviewer, context) => {
      order.push(`review:${reviewer}:${context.round}`);
      return context.round === 1 ? report(context.headSha, 'REQUEST_CHANGES', [finding]) : report(context.headSha);
    });
    await runPrePrWorkflow(task, options);
    expect(order).toEqual(['implement', 'review:codex:1', 'review:claude-code:1', 'fix', 'review:codex:2', 'review:claude-code:2', 'publish']);
    expect(runAuthor.mock.calls[1]?.[1]).toMatchObject({ baseSha, round: 1 });
    const feedback = runAuthor.mock.calls[1]?.[1].feedback ?? '';
    expect(feedback).toContain('[codex, claude-code]');
    expect(feedback.match(/Reject invalid quantities/g)).toHaveLength(1);
    expect(review).toHaveBeenNthCalledWith(3, 'codex', { baseSha, headSha: repairedHead, round: 2 });
    expect(publish).toHaveBeenCalledExactlyOnceWith({ baseSha, headSha: repairedHead, branch: 'agent/test-1' });
  });

  it('reruns even a previously approving reviewer after another reviewer requests changes', async () => {
    const { options, review } = setup();
    review.mockImplementation(async (reviewer, context) => report(context.headSha,
      reviewer === 'claude-code' && context.round === 1 ? 'REQUEST_CHANGES' : 'APPROVE',
      reviewer === 'claude-code' && context.round === 1 ? [finding] : []));
    await runPrePrWorkflow(task, options);
    expect(review.mock.calls.filter(([id]) => id === 'codex')).toHaveLength(2);
  });

  it.each([
    ['missing', undefined], ['invalid JSON', 'not JSON'], ['stale head', report(repairedHead)],
    ['stale base', { ...report(), baseSha: 'd'.repeat(40) }], ['comment', report(firstHead, 'COMMENT')],
    ['contradictory approval', report(firstHead, 'APPROVE', [finding])],
    ['empty request', report(firstHead, 'REQUEST_CHANGES')],
  ])('blocks publication on %s reports', async (_name, artifact) => {
    const { options, review, publish, runAuthor } = setup();
    review.mockResolvedValue(artifact);
    await expect(runPrePrWorkflow(task, options)).rejects.toThrow('Pre-PR gate');
    expect(publish).not.toHaveBeenCalled();
    expect(runAuthor).toHaveBeenCalledTimes(1);
  });

  it.each(['headSha', 'baseSha', 'branch', 'clean'] as const)('blocks a worktree %s mutation during review', async field => {
    const { options, review, state, publish } = setup();
    review.mockImplementation(async () => {
      if (field === 'clean') state.clean = false;
      else state[field] = field === 'branch' ? 'other-branch' : repairedHead;
      return report();
    });
    await expect(runPrePrWorkflow(task, options)).rejects.toThrow('Pre-PR gate');
    expect(publish).not.toHaveBeenCalled();
  });

  it('checks the revision again immediately before publication', async () => {
    const { options, state, publish } = setup();
    options.onPhase = text => { if (text.includes('publishing PR')) state.headSha = repairedHead; };
    await expect(runPrePrWorkflow(task, options)).rejects.toThrow('code changed');
    expect(publish).not.toHaveBeenCalled();
  });

  it('bounds review rounds and does not make an unreviewed fix after the final round', async () => {
    const { options, review, runAuthor, state, publish } = setup();
    runAuthor.mockImplementation(async (_stage, context) => { state.headSha = String(context.round + 1).repeat(40); });
    review.mockImplementation(async (_reviewer, context) => report(context.headSha, 'REQUEST_CHANGES', [finding]));
    await expect(runPrePrWorkflow(task, options)).rejects.toThrow('unresolved material findings after 3 review rounds');
    expect(runAuthor.mock.calls.map(([stage]) => stage)).toEqual(['implement', 'fix', 'fix']);
    expect(review).toHaveBeenCalledTimes(6);
    expect(publish).not.toHaveBeenCalled();
  });

  it('stops remediation that made no committed change', async () => {
    const { options, review, runAuthor, state, publish } = setup();
    runAuthor.mockImplementation(async () => { state.headSha = firstHead; });
    review.mockResolvedValue(report(firstHead, 'REQUEST_CHANGES', [finding]));
    await expect(runPrePrWorkflow(task, options)).rejects.toThrow('remediation produced no new');
    expect(review).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not review or publish an empty implementation', async () => {
    const { options, runAuthor, review, publish } = setup();
    runAuthor.mockResolvedValue(undefined);
    await expect(runPrePrWorkflow(task, options)).rejects.toThrow('no new committed changes');
    expect(review).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('requires a clean initial worktree', async () => {
    const { options, state, runAuthor } = setup();
    state.clean = false;
    await expect(runPrePrWorkflow(task, options)).rejects.toThrow('clean committed revision');
    expect(runAuthor).not.toHaveBeenCalled();
  });

  it.each(['initial', 'during review', 'before publish'])('honors cancellation %s', async when => {
    const { options, review, publish } = setup();
    let stopped = when === 'initial';
    options.isStopped = () => stopped;
    if (when === 'during review') review.mockImplementation(async () => { stopped = true; return report(); });
    if (when === 'before publish') options.onPhase = text => { if (text.includes('publishing PR')) stopped = true; };
    await expect(runPrePrWorkflow(task, options)).rejects.toThrow('voyage stopped');
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not waive a selected alternate when its CLI fails', async () => {
    const { options, review, publish } = setup();
    review.mockResolvedValueOnce(report()).mockRejectedValueOnce(new Error('not authenticated'));
    await expect(runPrePrWorkflow(task, options)).rejects.toThrow('claude-code review failed; publication blocked. not authenticated');
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not retry publication after publisher failure', async () => {
    const { options, publish } = setup();
    publish.mockRejectedValue(new Error('network unavailable'));
    await expect(runPrePrWorkflow(task, options)).rejects.toThrow('PR publication failed');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each([0, 6, 1.5, NaN])('rejects unsafe review round limit %s', async maxRounds => {
    const { options, runAuthor } = setup();
    options.maxRounds = maxRounds;
    await expect(runPrePrWorkflow(task, options)).rejects.toThrow('round limit');
    expect(runAuthor).not.toHaveBeenCalled();
  });
});

describe('pre-PR report validation', () => {
  it.each([
    { ...finding, title: '' }, { ...finding, body: '' }, { ...finding, path: '../outside.ts' },
    { ...finding, path: '/absolute.ts' }, { ...finding, path: 'C:\\outside.ts' },
    { ...finding, path: 'src/../secret.ts' }, { ...finding, line: 0 }, { ...finding, line: 1.2 },
    { ...finding, path: undefined, line: 2 }, null,
  ])('rejects malformed or unsafe findings %j', invalid => {
    expect(() => parsePrePrReview(report(firstHead, 'REQUEST_CHANGES', [invalid]), { baseSha, headSha: firstHead })).toThrow('finding is malformed');
  });

  it('accepts a material structural finding without a specific line', () => {
    expect(parsePrePrReview(report(firstHead, 'REQUEST_CHANGES', [{ title: 'Authorization missing', body: 'Both mutation routes accept unauthenticated callers.' }]), { baseSha, headSha: firstHead }).findings).toHaveLength(1);
  });
});
