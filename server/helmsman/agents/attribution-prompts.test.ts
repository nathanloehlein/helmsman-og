import { describe, expect, it } from 'vitest';
import type { AgentTask } from './adapter';
import { buildPrompt } from './prompt';

const task: AgentTask = { ticketId: 'TEST-1', title: 'Fix the issue', repo: 'owner/repo', jiraBaseUrl: '' };

describe('agent attribution in prompts', () => {
  it.each([
    ['new PR', {}],
    ['free-form PR', { task: 'Fix the issue' }],
    ['PR feedback', { prNumber: 7, prBranch: 'fix-issue', task: 'Address feedback' }],
  ])('requires author bylines for %s comments and replies', (_name, extra) => {
    const prompt = buildPrompt({ ...task, ...extra }, 'codex');
    expect(prompt).toContain('_Helmsman PR author · model: gpt-6-astra · effort: medium_');
    expect(prompt).toContain('comment/reply');
    expect(prompt).toContain('outside any code or suggestion fence');
  });

  it('uses the reviewer role and selected runtime settings', () => {
    const prompt = buildPrompt({ ...task, review: true, prNumber: 7, prBranch: 'fix-issue', model: 'sonnet', effort: 'low' }, 'claude-code');
    expect(prompt).toContain('_Helmsman review agent · model: sonnet · effort: low_');
    expect(prompt).toContain('do not submit a GitHub approval, request-changes review, or comment yourself');
  });

  it.each(['implement', 'fix', 'review'] as const)('preserves pre-PR publication boundaries for %s', stage => {
    const prompt = buildPrompt({ ...task, model: 'gpt-5.6-sol', effort: 'high', prePr: {
      stage, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), reportPath: '/tmp/report.json',
    } }, 'codex');
    expect(prompt).toContain(`_Helmsman ${stage === 'review' ? 'review agent' : 'PR author'} · model: gpt-5.6-sol · effort: high_`);
    expect(prompt).toContain('Publication restrictions below still apply');
    expect(prompt).toContain(stage === 'review' ? 'publish GitHub comments/reviews' : 'NEVER push');
  });
});
