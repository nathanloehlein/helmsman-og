import type { AgentTask } from './agents/adapter';

export type PrePrReviewerId = 'codex' | 'claude-code';

export interface PrePrSnapshot {
  baseSha: string;
  headSha: string;
  branch: string;
  clean: boolean;
}

export interface PrePrFinding {
  title: string;
  body: string;
  path?: string;
  line?: number;
}

export interface PrePrReview {
  baseSha: string;
  headSha: string;
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  summary: string;
  findings: PrePrFinding[];
}

export interface PrePrOptions {
  writerId: PrePrReviewerId;
  reviewerIds: string[];
  maxRounds?: number;
  snapshot(): Promise<PrePrSnapshot>;
  runAuthor(stage: 'implement' | 'fix', context: { baseSha: string; feedback?: string; round: number }): Promise<void>;
  review(reviewerId: string, context: { baseSha: string; headSha: string; round: number }): Promise<unknown>;
  publish(context: { baseSha: string; headSha: string; branch: string }): Promise<number>;
  onPhase(text: string): void;
  isStopped?(): boolean;
}

export class PrePrGateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Pre-PR gate: ${message}`, options);
    this.name = 'PrePrGateError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function validSha(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function validPath(value: unknown): value is string {
  return validText(value, 1024) && !/^[\\/]|^[a-z]:|[\r\n\\]/i.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}

export function parsePrePrReview(value: unknown, expected: { baseSha: string; headSha: string }): PrePrReview {
  if (!record(value) || !validSha(value.baseSha) || !validSha(value.headSha)
    || typeof value.verdict !== 'string' || !['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(value.verdict)
    || !validText(value.summary, 2000) || !Array.isArray(value.findings) || value.findings.length > 40) {
    throw new PrePrGateError('review report is missing or malformed; publication blocked.');
  }
  if (value.baseSha !== expected.baseSha || value.headSha !== expected.headSha) {
    throw new PrePrGateError('review report refers to a stale or different revision; publication blocked.');
  }
  const findings: PrePrFinding[] = value.findings.map((finding: unknown) => {
    if (!record(finding) || !validText(finding.title, 180) || !validText(finding.body, 4000)
      || (finding.path !== undefined && !validPath(finding.path))
      || (finding.line !== undefined && (!Number.isSafeInteger(finding.line) || Number(finding.line) < 1 || !finding.path))) {
      throw new PrePrGateError('review finding is malformed; publication blocked.');
    }
    return { title: finding.title.trim(), body: finding.body.trim(),
      ...(finding.path !== undefined ? { path: finding.path as string } : {}),
      ...(finding.line !== undefined ? { line: finding.line as number } : {}) };
  });
  if ((value.verdict === 'APPROVE' && findings.length > 0)
    || (value.verdict === 'REQUEST_CHANGES' && findings.length === 0)) {
    throw new PrePrGateError('review verdict contradicts its findings; publication blocked.');
  }
  return { baseSha: value.baseSha, headSha: value.headSha, verdict: value.verdict as PrePrReview['verdict'],
    summary: value.summary.trim(), findings };
}

function feedbackFor(reviews: Array<{ reviewer: string; report: PrePrReview }>): string {
  const unique = new Map<string, { finding: PrePrFinding; reviewers: string[] }>();
  for (const { reviewer, report } of reviews) {
    for (const finding of report.findings) {
      const key = JSON.stringify([finding.path ?? '', finding.line ?? 0, finding.title.toLowerCase(), finding.body.toLowerCase()]);
      const existing = unique.get(key);
      if (existing) existing.reviewers.push(reviewer);
      else unique.set(key, { finding, reviewers: [reviewer] });
    }
  }
  return [...unique.values()].map(({ finding, reviewers }, index) => {
    const location = finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ''})` : '';
    return `${index + 1}. ${finding.title}${location} [${reviewers.join(', ')}]\n${finding.body}`;
  }).join('\n\n');
}

export async function runPrePrWorkflow(task: AgentTask, options: PrePrOptions): Promise<number> {
  const maxRounds = options.maxRounds ?? 3;
  if (task.review) throw new PrePrGateError('review voyages cannot create a PR.');
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5) {
    throw new PrePrGateError('review round limit must be between 1 and 5.');
  }
  if (!['codex', 'claude-code'].includes(options.writerId) || !Array.isArray(options.reviewerIds)
    || options.reviewerIds.length < 1 || options.reviewerIds.length > 2
    || new Set(options.reviewerIds).size !== options.reviewerIds.length
    || !options.reviewerIds.includes(options.writerId)
    || options.reviewerIds.some(id => !['codex', 'claude-code'].includes(id))) {
    throw new PrePrGateError('reviewers must include the writer CLI and each selected alternate exactly once.');
  }
  const checkStopped = () => {
    if (options.isStopped?.()) throw new PrePrGateError('voyage stopped; publication blocked.');
  };
  const invoke = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
    checkStopped();
    try {
      const result = await action();
      checkStopped();
      return result;
    } catch (error) {
      if (error instanceof PrePrGateError) throw error;
      throw new PrePrGateError(`${label} failed; publication blocked. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  const snapshot = async (): Promise<PrePrSnapshot> => {
    const state = await invoke('revision inspection', () => options.snapshot());
    if (!state || !validSha(state.baseSha) || !validSha(state.headSha) || !validText(state.branch, 255) || state.clean !== true) {
      throw new PrePrGateError('worktree must have a clean committed revision on a named branch.');
    }
    return state;
  };
  const initial = await snapshot();
  const assertBranch = (state: PrePrSnapshot) => {
    if (state.baseSha !== initial.baseSha || state.branch !== initial.branch) {
      throw new PrePrGateError('base revision or branch changed during the voyage; publication blocked.');
    }
  };
  const assertUnchanged = async (expected: PrePrSnapshot) => {
    const current = await snapshot();
    assertBranch(current);
    if (current.headSha !== expected.headSha) throw new PrePrGateError('code changed after review started; publication blocked.');
  };
  options.onPhase('Implementing changes before adversarial review');
  await invoke('implementation', () => options.runAuthor('implement', { baseSha: initial.baseSha, round: 0 }));
  let revision = await snapshot();
  assertBranch(revision);
  if (revision.headSha === initial.headSha || revision.headSha === initial.baseSha) {
    throw new PrePrGateError('implementation produced no new committed changes.');
  }
  for (let round = 1; round <= maxRounds; round++) {
    const reviews: Array<{ reviewer: string; report: PrePrReview }> = [];
    for (const reviewer of options.reviewerIds) {
      checkStopped();
      options.onPhase(`Adversarial review ${round}/${maxRounds}: ${reviewer}`);
      const report = parsePrePrReview(await invoke(`${reviewer} review`, () => options.review(reviewer,
        { baseSha: initial.baseSha, headSha: revision.headSha, round })), revision);
      await assertUnchanged(revision);
      if (report.verdict === 'COMMENT') throw new PrePrGateError(`${reviewer} did not approve or provide actionable change requests; publication blocked.`);
      reviews.push({ reviewer, report });
    }
    if (reviews.every(({ report }) => report.verdict === 'APPROVE' && report.findings.length === 0)) {
      options.onPhase('All adversarial reviewers approved; publishing PR');
      await assertUnchanged(revision);
      const prNumber = await invoke('PR publication', () => options.publish({ baseSha: initial.baseSha, headSha: revision.headSha, branch: revision.branch }));
      if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new PrePrGateError('publisher did not return a valid PR number.');
      return prNumber;
    }
    if (round === maxRounds) throw new PrePrGateError(`unresolved material findings after ${maxRounds} review rounds; work preserved without publishing a PR.`);
    options.onPhase(`Resolving adversarial findings from round ${round}`);
    await invoke('finding remediation', () => options.runAuthor('fix', { baseSha: initial.baseSha, feedback: feedbackFor(reviews), round }));
    const repaired = await snapshot();
    assertBranch(repaired);
    if (repaired.headSha === revision.headSha || repaired.headSha === initial.baseSha) {
      throw new PrePrGateError('remediation produced no new committed changes; publication blocked.');
    }
    revision = repaired;
  }
  throw new PrePrGateError('review did not complete; publication blocked.');
}
