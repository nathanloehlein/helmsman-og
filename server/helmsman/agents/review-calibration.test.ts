import { describe, expect, it } from 'vitest';
import { implementationGuidance, reviewGuidance } from './review-calibration';
import { buildPrompt } from './prompt';
import type { AgentTask } from './adapter';

describe('role-specific prompt guidance', () => {
  it('keeps a safety baseline for ordinary tasks without detailed parser instructions', () => {
    for (const render of [implementationGuidance, reviewGuidance]) {
      const value = render({ title: 'Correct button alignment' }).join('\n');
      expect(value).toContain('verify effective time/memory bounds');
      expect(value).not.toContain('Parser containment:');
      expect(value).toContain('honor required repository checks');
      expect(value).toContain('Repeat only after relevant code/environment changes');
      expect(value).toContain('Prior approval never replaces required review');
    }
  });
  it.each([
    [{ title: 'Sanitize uploads' }, undefined],
    [{ title: 'Fix import', jiraContext: 'Parse attacker-controlled XML' }, undefined],
    [{ task: 'Contain resource exhaustion' }, undefined],
    [{ title: 'Fix regression' }, 'The SVG parser is unbounded'],
  ])('includes parser containment when relevant task evidence is supplied', (task, feedback) => {
    for (const render of [implementationGuidance, reviewGuidance]) {
      const value = render(task, feedback).join('\n');
      expect(value).toContain('Parser containment:');
      expect(value).toContain('Same-thread timers cannot interrupt synchronous parsing');
      expect(value).toContain('worker heap limits may exclude native/external allocations');
      expect(value).toContain('reject input and clean up on breach');
    }
  });
  it('assigns defect falsification to reviewers and implementation planning to authors', () => {
    const author = implementationGuidance({}).join('\n');
    const reviewer = reviewGuidance({}).join('\n');
    expect(author).toContain('Before changing code');
    expect(author).not.toContain('Before reporting a defect');
    expect(reviewer).not.toContain('Before changing code');
    expect(reviewer).toContain('test the strongest counterargument');
    expect(reviewer).toContain('existing guards, caller constraints, configuration and runtime behavior');
    expect(reviewer).toContain('specific error in prior reasoning');
    expect(reviewer).toContain('Missing/truncated history proves nothing was settled');
  });
});

const reviewRoles = ['standalone', 'pre-pr', 'continued', 'feedback'] as const;
function reviewTask(role: typeof reviewRoles[number], docker = false): AgentTask {
  const headSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  const task: AgentTask = { ticketId: 'TEST-1', title: 'Review changed behavior', repo: 'owner/repo', jiraBaseUrl: '',
    prNumber: 42, prHeadSha: headSha, review: true,
    ...(docker ? { dockerExecution: { runId: 'review-1', image: 'runtime:1', gatewayUrl: 'http://host.docker.internal:8790', capability: 'c'.repeat(64) } } : {}) };
  if (role === 'pre-pr' || role === 'continued') task.prePr = { stage: 'review', headSha, baseSha, reportPath: '/reports/review.json',
    ...(role === 'continued' ? { incompleteReview: { reportPath: '/reports/prior.json', summary: 'Missing test executable' } } : {}) };
  if (role === 'feedback') task.feedbackAudit = { snapshotPath: '/snapshots/pr.json', reportPath: '/reports/audit.json',
    snapshot: { repo: task.repo, prNumber: 42, headSha, baseSha, fingerprint: 'snapshot-1' } };
  return task;
}

describe.each(['codex', 'claude-code'] as const)('%s review dependency preparation', runtime => {
  it.each(reviewRoles)('requires the %s lead to resolve package-scoped tools before reporting them missing', role => {
    const prompt = buildPrompt(reviewTask(role), runtime);
    expect(prompt).toContain('Before delegating verification to read-only leaf reviewers, the review lead must resolve the relevant test tools');
    expect(prompt).toContain('owning package manifest, workspace membership, applicable lockfile, package-manager version');
    expect(prompt).toContain('A nested package excluded from the workspace is not governed by the root lockfile');
    expect(prompt).toContain('attempt the minimal required development-dependency setup');
    expect(prompt).toContain('Use frozen/immutable installation when a committed lockfile governs that package');
    expect(prompt).toContain('When no governing lockfile exists, follow the documented package setup with lockfile creation disabled');
    expect(prompt).toContain('do not invent pinned-version assurance');
    expect(prompt).toContain('Do not use unpinned npx downloads, substitute global test tools, or share another worktree\'s node_modules');
    expect(prompt).toContain('Keep dependency installations isolated to this checkout');
    expect(prompt).toContain('Before claiming dependencies unavailable, attempt the permitted targeted setup and check command');
    expect(prompt).toContain('exact attempted command and specific blocker without secrets');
    expect(prompt).toContain('only git-ignored dependency/build/cache files');
    expect(prompt).toContain('Verify output paths are ignored before writing');
    expect(prompt).toContain('Never change tracked files, source, manifests, lockfiles, index, refs, Git configuration, snapshots or prior reports');
    expect(prompt).toContain('verify the same HEAD with git rev-parse HEAD');
    expect(prompt).toContain('git diff --exit-code, git diff --cached --exit-code and git status --porcelain --untracked-files=all');
    expect(prompt).toContain('Do not hide changes with reset, checkout or stash');
    expect(prompt).toContain('Keep leaf reviewers read-only');
    expect(prompt).not.toContain('Produce ONLY the two review output files');
    expect(prompt).not.toContain('Do not edit the worktree');
    expect(prompt).not.toContain('or mutate the worktree');
    expect(prompt).not.toContain('checks that do not modify the worktree');
  });

  it.each(reviewRoles)('preserves read-only Docker boundaries for %s', role => {
    const prompt = buildPrompt(reviewTask(role, true), runtime);
    expect(prompt).toContain('This Docker review has a read-only checkout');
    expect(prompt).toContain('Use only tooling already available in the runtime image');
    expect(prompt).toContain('Do not install dependencies on the host');
    expect(prompt).toContain('or bypass network restrictions');
    expect(prompt).toContain('attempt the permitted relevant checks before reporting');
    expect(prompt).not.toContain('attempt the minimal required development-dependency setup');
    expect(prompt).not.toContain('git-ignored dependency/build/cache outputs allowed above');
    expect(prompt).not.toContain('may write only git-ignored dependency/build/cache');
  });
});
