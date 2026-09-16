import type { AgentTask } from './adapter';

export function buildPrompt(task: AgentTask): string {
  if (task.review && task.prBranch && task.prNumber) {
    return [
      `You are code-reviewing open pull request #${task.prNumber} on the current branch (${task.prBranch}).`,
      `The repository checkout is your current working directory.`,
      `You are running fully unattended: there is no human to ask, so never pause for confirmation or approval — carry out every step yourself.`,
      `Do a thorough code review of this PR.`,
      `Review the whole change path, not just the diff: caller contracts, feature-flag states, error paths, observability, tests, migrations, and deletion fallout.`,
      `First read the existing review comments and review threads already on the PR (use the gh CLI, e.g. "gh pr view ${task.prNumber} --comments" and "gh api repos/{owner}/{repo}/pulls/${task.prNumber}/comments"). Take them into account: do not repeat findings that have already been raised, note when a prior comment is now resolved or outdated, and focus your new findings on issues not already covered.`,
      `Write your review as GitHub-flavored markdown to a file named .agent-review.md in the repo root — this file is the only output that is used, so it must be written; do not print the review to stdout instead.`,
      `Do NOT modify code, commit, push, open a pull request, merge, or approve — produce ONLY the review file.`,
    ].join(' ');
  }
  if (task.prBranch && task.prNumber) {
    return [
      `You are updating open pull request #${task.prNumber} on the current branch (${task.prBranch}).`,
      `The repository checkout is your current working directory.`,
      `You are running fully unattended: there is no human to ask, so never pause for confirmation or approval — carry out every step yourself.`,
      `Address this review feedback: ${task.task}.`,
      `Run the tests, commit, and push to the same branch, and do NOT open a new pull request and do NOT merge.`,
    ].join(' ');
  }
  const openPr: string =
    task.task && task.task.length > 0
      ? `Task: ${task.task}.`
      : `Work Jira ticket ${task.ticketId}: ${task.title}.`;
  const pushAndOpenPr: string =
    task.task && task.task.length > 0
      ? `Explore, implement the change, run the tests, commit on a new branch, then push it and open a pull request using the gh CLI.`
      : `Explore, implement the change, run the tests, commit on a new branch, then push it and open a pull request with the ticket id in the title using the gh CLI.`;
  return [
    openPr,
    `The repository checkout is your current working directory.`,
    `You are running fully unattended: there is no human to ask, so never pause for confirmation or approval — carry out every step yourself.`,
    pushAndOpenPr,
    `Pushing the branch and opening the PR are required steps, not optional — do them without asking.`,
    `Do NOT merge the PR. Stop only after the PR is open.`,
  ].join(' ');
}
