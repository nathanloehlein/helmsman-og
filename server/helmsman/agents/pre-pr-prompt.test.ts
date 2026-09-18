import { describe, expect, it } from 'vitest';
import type { AgentTask } from './adapter';
import { codexArgs } from './codex';
import { buildPrompt } from './prompt';

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
    if (runtime === 'codex') expect(prompt).toContain('Use $review-agent');
    else expect(prompt).not.toContain('$review-agent');
  });

  it('rejects a review without a pinned head instead of falling back to a publishing task', () => {
    expect(() => buildPrompt(task('review', { prePr: { stage: 'review', baseSha, reportPath } })))
      .toThrow('head revision is required');
  });

  it('enables Codex delegation for the independent review stage only', () => {
    expect(codexArgs(task('review'))).toContain('features.multi_agent=true');
    for (const stage of ['implement', 'fix'] as const) {
      expect(codexArgs(task(stage))).not.toContain('features.multi_agent=true');
    }
  });
});
