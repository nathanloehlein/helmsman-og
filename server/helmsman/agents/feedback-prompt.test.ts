import { describe, expect, it } from 'vitest';
import type { AgentTask } from './adapter';
import { buildPrompt } from './prompt';

const task: AgentTask = {
  ticketId: 'rerun', title: '', repo: 'owner/repo', jiraBaseUrl: '',
  prNumber: 42, prBranch: 'fix/checkout', task: 'Address the review feedback',
};

describe.each(['codex', 'claude-code'] as const)('%s PR feedback prompt', runtime => {
  it('requires complete feedback discovery and a GitHub disposition for every finding', () => {
    const prompt = buildPrompt(task, runtime);
    expect(prompt).toContain('including paginated GitHub API results');
    expect(prompt).toContain('every actionable finding: blockers, requested changes, and non-blocking suggestions');
    expect(prompt).toContain('findings written only in review summaries');
    expect(prompt).toContain('Include resolved and outdated threads; a resolved flag is not an explanatory response');
    expect(prompt).toContain('Any finding without an accurate GitHub response explaining its current disposition still needs a response');
    expect(prompt).toContain('reply in the original review thread');
    expect(prompt).toContain('linking to the original review/comment');
    expect(prompt).toContain('A local report or final agent message is not a substitute');
    expect(prompt).toContain('explain what changed, link the pushed commit');
    expect(prompt).toContain('state the relevant validation result and any limitations');
    expect(prompt).toContain('unchanged, already addressed, declined, deferred, or blocked');
    expect(prompt).toContain('explain the specific reason with evidence');
    expect(prompt).toContain('comment accounting for every finding and linking its response');
  });

  it('keeps fixes scoped and reports response-only or incomplete outcomes honestly', () => {
    const prompt = buildPrompt(task, runtime);
    expect(prompt).toContain('Keep changes within the ticket scope');
    expect(prompt).toContain('Rare edge cases and optional improvements do not automatically require code changes');
    expect(prompt).toContain('Do not create an empty commit for a response-only outcome');
    expect(prompt).toContain('Leave disputed, deferred, and blocked threads unresolved');
    expect(prompt).toContain('link it in your coverage summary instead of duplicating it');
    expect(prompt).toContain('Verify that the responses were published on the correct PR');
    expect(prompt).toContain('which findings still lack a response');
    expect(prompt).toContain('do NOT open a new pull request and do NOT merge');
    expect(prompt).toContain('End every PR description, review summary, inline comment, and comment/reply');
  });

  it('does not grant feedback publication permissions to read-only or pre-PR reviews', () => {
    const reviewPrompt = buildPrompt({ ...task, review: true }, runtime);
    expect(reviewPrompt).not.toContain('## Respond to every finding on GitHub');
    expect(reviewPrompt).toContain('do not submit a GitHub approval, request-changes review, or comment yourself');
    const prePrPrompt = buildPrompt({ ...task, prePr: {
      stage: 'fix', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), reportPath: '/tmp/report.json',
    } }, runtime);
    expect(prePrPrompt).not.toContain('## Respond to every finding on GitHub');
    expect(prePrPrompt).toContain('NEVER push');
  });
});
