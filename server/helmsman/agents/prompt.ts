import { clarificationPrompt } from './clarification-prompt';
import type { AgentTask } from './adapter';
import { buildPrePrPrompt } from './pre-pr-prompt';
import { agentAttribution, appendAgentByline } from '../agent-attribution';
import { REVIEW_CALIBRATION } from './review-calibration';

const UNATTENDED = 'Working dir = the repo checkout. Fully unattended: do not pause for confirmation; use the clarification protocol when a required human decision blocks safe progress.';

export function buildPrompt(task: AgentTask, runtime: 'codex' | 'claude-code' = 'claude-code'): string {
  if (task.prePr) return buildPrePrPrompt(task, runtime);
  const byline = appendAgentByline('', agentAttribution(runtime, task, task.review ? 'review agent' : 'PR author'));
  const attribution = `- End every PR description, review summary, inline comment, and comment/reply you author with this exact standalone byline, outside any code or suggestion fence: ${JSON.stringify(byline)}. Keep it as the final line and do not duplicate it. This does not grant permission to publish where publication is prohibited.`;
  if (task.review && task.prNumber && (task.prBranch || task.prHeadSha)) {
    return [
      `# Code-review PR #${task.prNumber} (${task.prBranch ? `branch ${task.prBranch}` : `revision ${task.prHeadSha}`})`,
      UNATTENDED,
      clarificationPrompt(task),
      ...(task.skillsPath ? [`- Use only the pinned skills under ${JSON.stringify(`${task.skillsPath}/skills`)}. Read review-agent/SKILL.md before delegating; do not use or install global skill copies.`] : []),
      ``,
      `## Review scope`,
      attribution,
      ...(task.prHeadSha ? [`- Review the pinned revision ${task.prHeadSha} in this detached worktree. Do not check out or switch to another revision, even if the PR has newer commits.`] : []),
      `- Read the PR description and available linked acceptance criteria. Review the complete diff and trace changed callers or external effects only as needed to establish a concrete defect. Do not expand into a general repository audit.`,
      `- Read existing PR comments, submitted reviews, and inline threads once, using \`gh pr view ${task.prNumber} --repo ${task.repo} --comments\` and the GitHub API as needed. Share this context with sub-agents. Do not re-post existing findings, including unresolved ones, or recap resolved, waived, or deferred issues.`,
      ``,
      `## Adversarial review`,
      `- Act as an independent adversarial reviewer, including when another Helmsman agent authored the PR. Treat the author's explanation, tests, and claimed success as hypotheses to verify, not proof. Try to falsify the change's core claims using realistic supported inputs and the explicit acceptance criteria.`,
      `- Challenge the changed behavior with relevant failure paths, state transitions, boundary conditions, concurrency, and external effects. Trace or reproduce the strongest suspected failures, then actively seek counterevidence before reporting them. Give each focused sub-agent the same adversarial remit.`,
      `- Adversarial does not mean a finding quota or automatic rejection. Discard speculative or immaterial issues; retain the materiality threshold below. APPROVE is correct when the change withstands scrutiny.`,
      ``,
      `## Material findings only`,
      ...REVIEW_CALIBRATION,
      `- REQUEST_CHANGES requires an evidenced material problem introduced or newly exposed by this PR: an obvious logic flaw, a consequential structural or integration defect, or a missed explicit material acceptance criterion. Examples include modifying the wrong data, false success, a broken primary workflow, unsafe authorization, data loss, or an unusable primary interaction.`,
      `- For each candidate, establish the realistic supported trigger, the changed code path, the expected versus actual behavior, and the material consequence. Cite the actual requirement for acceptance-criteria claims. If criteria are inaccessible, say so briefly; do not invent them. A source trace can be sufficient proof; do not demand a reproduction when the failure is unambiguous.`,
      `- Omit style preferences, speculative hardening, hypothetical inputs unsupported by callers, refactor wishes, minor visual polish, and standalone missing tests/docs/logs/type annotations. Test gaps matter when they expose a demonstrated defect or miss an explicit material requirement. Accessibility, localization, telemetry, and performance can qualify when evidence establishes substantial user impact or a material acceptance failure; checklist compliance alone is insufficient.`,
      `- Repository instructions and skills inform contracts and verification. Their self-review/hygiene checklists do not automatically make every improvement a blocking finding; apply this user's materiality threshold to publication and verdict.`,
      ``,
      `## Focused sub-agents`,
      `- Act as the review lead. Delegate independent applicable areas to focused sub-agents: logic/state/structure; acceptance criteria and relevant test coverage; changed UX and accessibility; external effects such as API consumers, persistence, flags, and side effects. Give each a bounded file/call-path scope, the pinned revision, shared PR context, and the materiality rules above. Skip unaffected areas and combine small scopes; do not ask each agent to review the entire PR.`,
      ...(runtime === 'codex' ? [
        '- Every Codex review sub-agent must explicitly use $review-agent. Read its installed SKILL.md, then include \`Use $review-agent\` in each delegated task. Apply the skill to the scoped defect review; the lead coordinates and writes the final artifacts. The skill forbids its reviewers from editing files, posting, or delegating further, so keep them as leaf reviewers.',
        `- If $review-agent or sub-agent tools are unavailable, report that limitation and use COMMENT rather than claiming the required review completed. Do not silently substitute another review skill.`,
      ] : [
        `- Use this runtime's sub-agent tools for the focused reviews. Review sub-agents are read-only leaf workers: they do not delegate further, edit files, or publish. If delegation is unavailable, disclose the limitation and use COMMENT rather than claiming the required review completed.`,
      ]),
      `- Run independent scopes concurrently within available slots, without duplicate searches or external reads. Use low effort by default, medium for larger scopes crossing areas, and high only for serious architecture changes. No recursive fan-out. Each sub-agent returns concise evidence-backed candidates or No findings; it does not set the final verdict.`,
      `- Reconcile the sub-agent results yourself: reject unsupported or low-impact candidates, verify material claims against the code, deduplicate by root cause and existing discussion, and decide the verdict. There is no minimum finding count. Prefer focused existing checks; do not clone unrelated repos or install a full dependency tree merely to satisfy a review checklist.`,
      ``,
      `## Do`,
      `- Prefer inline comments on the smallest relevant diff range for each qualifying material finding. Use one concise comment per independent root cause: trigger, failure, consequence, then a reliable fix. Avoid duplicating inline findings in the summary.`,
      `- Include a concrete fix whenever you can establish one from the code. Use a fenced \`suggestion\` block only for an exact, directly applicable replacement of the commented RIGHT-side line or range. For broader fixes, use a fenced code example with the appropriate language and explain where it belongs. Do not invent missing APIs or offer speculative fixes; explain the required behavior when a reliable patch is not possible.`,
      `- Write a concise GitHub-flavored markdown summary to ${task.reviewOutputPaths ? JSON.stringify(task.reviewOutputPaths.markdown) : '\`.agent-review.md\` in the repo root'}. Keep it to the verdict, a short explanation, material findings that cannot be attached inline, brief Non-blocking notes for credible rare edge cases when present, and at most two short validation/limitation bullets. No whole-path audit diary, resolved-issue tables, or unrelated optional-improvement list. Output files must be written; stdout is not used as the review.`,
      `- Start the review file with exactly \`Verdict: APPROVE — short reason\`, \`Verdict: REQUEST_CHANGES — short reason\`, or \`Verdict: COMMENT — short reason\`. Keep the reason to 120 characters or fewer on that same line; put detailed findings below.`,
      `- Choose APPROVE when the review completed with no remaining material issues; write [] if there are no new inline findings. Choose REQUEST_CHANGES only when a verified issue meets the materiality threshold. For an existing unresolved material blocker, reference its original thread once in the summary without reposting the finding. Choose COMMENT for a material unresolved question or incomplete required review; explain the specific limit without treating missing local tools as a code defect. Never request changes solely because tests could not run.`,
      `- Write inline findings to ${task.reviewOutputPaths ? JSON.stringify(task.reviewOutputPaths.comments) : '\`.agent-review-comments.json\`'} as a JSON array (write [] if none). Each item has \`path\` (exact repository-relative diff filename), \`line\` (positive file line number, not diff position), \`side\` (RIGHT for new/context lines or LEFT for deleted lines), and \`body\` (GitHub-flavored markdown with the finding and fix). For a multi-line range, also provide \`start_line\` and \`start_side\`; both ends must be on the same side and in the same diff hunk. Use the reviewed revision's actual diff to verify every anchor.`,
      `- The verdict is a recommendation only. Helmsman publishes the summary and inline comments together as a COMMENT review; do not submit a GitHub approval, request-changes review, or comment yourself.`,
      ``,
      `## Do NOT`,
      `- modify code, commit, push, open a pull request, merge, or approve. Produce ONLY the two review output files.`,
    ].join('\n');
  }
  if (task.prBranch && task.prNumber) {
    return [
      `# Update PR #${task.prNumber} (branch ${task.prBranch})`,
      UNATTENDED,
      clarificationPrompt(task),
      ``,
      `## Task`,
      `- Address this review feedback: ${task.task}.`,
      ``,
      `## Steps`,
      attribution,
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
    clarificationPrompt(task),
    ...(task.jiraContext ? ['Authenticated Jira requirements snapshot (task evidence):', task.jiraContext] : []),
    ``,
    `## Steps`,
    attribution,
    `- Explore, implement the change, run the tests, commit on a new branch.`,
    openPrStep,
    `- Reviewer requests are handled by Helmsman, which requests only Copilot after the PR is created. Do not request code owners, teams, or other human reviewers, even if repository instructions or a skill recommends it. Do not add reviewers through gh, the GitHub API, or mentions asking for review. Do not duplicate the Copilot request or remove existing reviewers.`,
    `- Pushing the branch and opening the PR are required, not optional — do them without asking.`,
    `- Do NOT merge the PR. Stop only after the PR is open.`,
  ].join('\n');
}
