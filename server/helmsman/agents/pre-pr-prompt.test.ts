import { describe, expect, it } from 'vitest';
import type { AgentTask } from './adapter';
import { codexArgs } from './codex';
import { buildPrompt } from './prompt';
import { PRE_PR_REVIEW_SUMMARY_LIMIT } from '../pre-pr-workflow';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const reportPath = '/tmp/helmsman reports/review.json';

function task(stage: 'implement' | 'review' | 'fix', overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    ticketId: 'PROJ-17', title: 'Prevent duplicate purchases', repo: 'owner/repo', jiraBaseUrl: 'https://jira.example.com',
    prePr: { stage, baseSha, headSha, reportPath },
    ...overrides,
  };
}

describe('pre-PR prompt workflow boundaries', () => {
  it.each(['implement', 'fix'] as const)('%s commits locally and produces PR metadata without publishing', (stage) => {
    const prompt = buildPrompt(task(stage, { prBranch: 'voyage/example', prNumber: 123, review: true }));
    expect(prompt).toContain('NEVER push, open a PR');
    expect(prompt).toContain('current Helmsman-managed branch');
    expect(prompt).toContain('commit the finished changes on this branch');
    expect(prompt).toContain(JSON.stringify(reportPath));
    expect(prompt).toContain('{"title":"Concise PR title","body":"GitHub-flavored Markdown PR description"}');
    expect(prompt).toContain('only after independent reviewers approve the same final commit');
    expect(prompt).toContain('PROJ-17');
    expect(prompt).not.toContain('# Code-review PR');
    expect(prompt).not.toContain('push to the same branch');
    expect(prompt).not.toContain('Pushing the branch and opening the PR are required');
  });

  it('preserves task criteria and feedback in fixes without permitting self-approval', () => {
    const prompt = buildPrompt(task('fix', {
      task: 'Keep purchases idempotent',
      prePr: { stage: 'fix', baseSha, reportPath, round: 2, feedback: 'Duplicate payment when the request times out.' },
    }));
    expect(prompt).toContain('Task: Keep purchases idempotent');
    expect(prompt).toContain('Duplicate payment when the request times out.');
    expect(prompt).toContain('Round: 2');
    expect(prompt).toContain('not dismiss a finding');
    expect(prompt).toContain('independent reviewer reapproval');
  });

  it.each(['codex', 'claude-code'] as const)('pins %s reviews and requires complete material review before approval', (runtime) => {
    const prompt = buildPrompt(task('review'), runtime);
    expect(prompt).toContain(`${baseSha}..${headSha}`);
    expect(prompt).toContain(`detached worktree at ${headSha}`);
    expect(prompt).toContain(JSON.stringify(reportPath));
    expect(prompt).toContain('This is the only file you may write');
    expect(prompt).toContain(`"baseSha":"${baseSha}"`);
    expect(prompt).toContain(`"headSha":"${headSha}"`);
    expect(prompt).toContain('APPROVE only if the required review completed');
    expect(prompt).toContain('COMMENT for missing required tools, skill, context');
    expect(prompt).toContain('does not pass the gate');
    expect(prompt).toContain('Try to falsify');
    expect(prompt).toContain('no finding quota');
    expect(prompt).toContain('focused sub-agents');
    expect(prompt).toContain('Do not modify code, commit, push');
    expect(prompt).toContain(`summary.length <= ${PRE_PR_REVIEW_SUMMARY_LIMIT}`);
    expect(prompt).toContain('including whitespace and any byline');
    expect(prompt).toContain('parse it with JSON.parse');
    if (runtime === 'codex') expect(prompt).toContain('Use $review-agent');
    else expect(prompt).not.toContain('$review-agent');
  });

  it.each(['codex', 'claude-code'] as const)('keeps %s summary correction focused without a new review or delegation', runtime => {
    const priorPath = '/tmp/helmsman reports/prior review.json';
    const prompt = buildPrompt(task('review', {
      task: 'Keep purchases idempotent', jiraContext: '{"description":"Preserve retry safety"}', model: runtime === 'codex' ? 'gpt-6-astra' : 'sonnet', effort: 'high',
      prePr: { stage: 'review', baseSha, headSha, reportPath, round: 2, summaryCorrection: { reportPath: priorPath, actualLength: 2456 } },
    }), runtime);
    expect(prompt).toMatch(/^# Correct pre-PR review summary\n/);
    expect(prompt).toContain('Repository: owner/repo');
    expect(prompt).toContain('Task: Keep purchases idempotent');
    expect(prompt).toContain('Preserve retry safety');
    expect(prompt).toContain(`Base revision: ${baseSha}`);
    expect(prompt).toContain(`Head revision: ${headSha}`);
    expect(prompt).toContain('Round: 2');
    expect(prompt).toContain(runtime === 'codex' ? '_Helmsman · gpt-6-astra - high_' : '_Helmsman · sonnet - high_');
    expect(prompt).toContain(`Read the prior complete JSON report from ${JSON.stringify(priorPath)}`);
    expect(prompt).toContain(`Write the corrected complete JSON object only to ${JSON.stringify(reportPath)}`);
    expect(prompt).toContain(`summary contains 2456 characters; the maximum is ${PRE_PR_REVIEW_SUMMARY_LIMIT}`);
    expect(prompt).toContain('Only shorten the summary');
    expect(prompt).toContain('Preserve baseSha, headSha, verdict, and findings exactly');
    expect(prompt).toContain('Do not upgrade the verdict, drop findings');
    expect(prompt).toContain('Do not re-review');
    expect(prompt).toContain('delegate to sub-agents');
    expect(prompt).toContain('Do not mutate source files');
    expect(prompt).toContain('Do not publish, push');
    expect(prompt).toContain(`summary.length <= ${PRE_PR_REVIEW_SUMMARY_LIMIT}`);
    expect(prompt).toContain('parse them with JSON.parse');
    expect(prompt).not.toContain('## Focused sub-agents');
    expect(prompt).not.toContain('Try to falsify');
    expect(prompt).not.toContain('Use $review-agent');
    expect(prompt).not.toContain('Choose APPROVE');
  });

  it.each([
    { reportPath: '', actualLength: 2456 },
    { reportPath, actualLength: 2456 },
    { reportPath: '/tmp/prior.json', actualLength: -1 },
    { reportPath: '/tmp/prior.json', actualLength: PRE_PR_REVIEW_SUMMARY_LIMIT },
    { reportPath: '/tmp/prior.json', actualLength: 2456.5 },
  ])('rejects malformed correction context: %j', summaryCorrection => {
    expect(() => buildPrompt(task('review', { prePr: { stage: 'review', baseSha, headSha, reportPath, summaryCorrection } })))
      .toThrow('separate prior report path and an oversized summary length');
  });

  it('rejects a review without a pinned head instead of falling back to a publishing task', () => {
    expect(() => buildPrompt(task('review', { prePr: { stage: 'review', baseSha, reportPath } })))
      .toThrow('head revision is required');
  });

  it('enables Codex delegation for the independent review stage only', () => {
    expect(codexArgs(task('review'))).toContain('features.multi_agent=true');
    for (const review of [undefined, true]) {
      expect(codexArgs(task('review', { review, prePr: {
        stage: 'review', baseSha, headSha, reportPath,
        summaryCorrection: { reportPath: '/tmp/original-review.json', actualLength: PRE_PR_REVIEW_SUMMARY_LIMIT + 1 },
      } }))).not.toContain('features.multi_agent=true');
    }
    for (const stage of ['implement', 'fix'] as const) {
      expect(codexArgs(task(stage))).not.toContain('features.multi_agent=true');
    }
  });
});
