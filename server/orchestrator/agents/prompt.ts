import type { AgentTask } from './adapter';

const UNATTENDED = 'Working dir = the repo checkout. Fully unattended: no human to ask — never pause for confirmation, do every step yourself.';

export function buildPrompt(task: AgentTask): string {
  if (task.review && task.prBranch && task.prNumber) {
    return [
      `# Code-review PR #${task.prNumber} (branch ${task.prBranch})`,
      UNATTENDED,
      ``,
      `## Do`,
      `- Do a thorough code-review. Review the whole change path, not just the diff: caller contracts, feature-flag states, error paths, observability, tests, migrations, deletion fallout.`,
      `- First read the existing comments and review threads on the PR: \`gh pr view ${task.prNumber} --comments\`, \`gh api repos/{owner}/{repo}/pulls/${task.prNumber}/comments\`. Don't repeat findings already raised; note ones now resolved or outdated; focus on what isn't covered.`,
      `- Write the review as GitHub-flavored markdown to \`.agent-review.md\` in the repo root — the ONLY output used, so it must be written (never just stdout).`,
      ``,
      `## Do NOT`,
      `- modify code, commit, push, open a pull request, merge, or approve. Produce ONLY the review file.`,
    ].join('\n');
  }
  if (task.prBranch && task.prNumber) {
    return [
      `# Update PR #${task.prNumber} (branch ${task.prBranch})`,
      UNATTENDED,
      ``,
      `## Task`,
      `- Address this review feedback: ${task.task}.`,
      ``,
      `## Steps`,
      `- Run the tests, commit, and push to the same branch.`,
      `- Same branch only — do NOT open a new pull request and do NOT merge.`,
    ].join('\n');
  }
  const isFreeform: boolean = Boolean(task.task && task.task.length > 0);
  const heading: string = isFreeform ? `# Task: ${task.task}` : `# Work Jira ticket ${task.ticketId}: ${task.title}`;
  const openPrStep: string = isFreeform
    ? `- Then push it and open a pull request using the gh CLI.`
    : `- Then push it and open a pull request with the ticket id in the title using the gh CLI.`;
  return [
    heading,
    UNATTENDED,
    ``,
    `## Steps`,
    `- Explore, implement the change, run the tests, commit on a new branch.`,
    openPrStep,
    `- Pushing the branch and opening the PR are required, not optional — do them without asking.`,
    `- Do NOT merge the PR. Stop only after the PR is open.`,
  ].join('\n');
}
