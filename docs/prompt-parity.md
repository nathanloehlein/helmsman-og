# Coder and reviewer prompt parity

Pre-rewrite and post-rewrite share calibration guidance for coding, scoped repairs,
independent review, review corrections, existing-PR feedback and feedback audits.
This includes acceptance evidence, report formats and limits, inline anchors,
author replies, publication restrictions and the clarification protocol.

Pre-rewrite also requires local review leads to prepare missing dependencies for
relevant checks before handing work to read-only leaf reviewers. It permits ignored
dependency, build, and cache outputs while preserving tracked files and Git state.
This applies to standalone reviews, first and continued pre-PR reviews, and feedback
audits. Summary-only corrections and restricted Docker reviews retain their narrower
write scope. This dependency-setup guidance has not been ported to post-rewrite.

Reviewers block on demonstrated material defects or missed material requirements.
Suggestions stay within ticket scope; necessary expansion must explain the customer
impact and smallest sufficient fix. Rare, low-impact edge cases remain non-blocking
notes. Repair agents follow the same scope rules, and authors must verify published
changes and responses without claiming missing approvals or authority.

Both shipped Codex and Claude configurations pin the required `review-agent` skill
for new coding/review runs. Claude still uses native subagents; Codex uses skill-based
review delegation. Missing required skills fail preparation. Existing runs retain
their frozen prompts, provider artifacts and skill snapshots; updating installed
packages does not rewrite historical execution evidence.

## Acceptance property and bounded parsing

These prompt instructions incorporate the supplied lessons from PR #11104
(AIROBUILD-6842), “Pin the property, contain the parser.”

Before changing code, authors derive one observable acceptance property and explicit
Non-goals from the requirements. Before the first implementation commit, they draft
these at the top of the PR description; staged authors use the existing external
PR metadata file and carry the scope into its final body. Requirements remain
authoritative: Non-goals cannot waive material criteria or excuse material
regressions introduced or newly exposed by the change. Scope stays stable across
rounds unless verified requirement clarification or correction justifies a recorded
change. Reviewers verify the property against the requirements. The host carries bounded author context into later staged prompts. When prior
metadata is unavailable, reviewers reconstruct scope from available requirements;
missing prose alone is not a blocker.

Authors compare the ticket's alternatives and prefer the smallest effective
structural control, such as serving policy, response headers or sandboxing. They
trace actual consumer behavior, effective Content-Type, origin and execution paths;
a file extension or metadata alone does not establish safety. Tests exercise this
observable boundary, legitimate inputs and relevant failure paths. Existing tests
of a stronger proxy invariant do not automatically make that invariant required.

If a defense must parse hostile input, prompts call for enforceable wall-clock and
memory limits, termination and rejection on breach, and bounded verification of
cleanup. Same-thread timers cannot interrupt synchronous parsing; worker heap
limits may exclude native and external allocations. Isolation and limits must fit
the runtime. Byte caps and hand-written pre-scanners do not prove bounded parser
cost and should not grow into a second parser enumerating pathological inputs.

Authors and reviewers triage findings against the property, actual requirements
and material regressions. Optional tangential work becomes a proposed follow-up,
not an automatic repair or external ticket. Feedback audits still account for every
source and require accurate published explanations; optional suggestions can be
deferred with `required:false`, while missing required responses remain unresolved.
Conflicting reviews or disproportionate diff growth prompt design reassessment,
not weaker acceptance criteria or skipped repairs. Authors batch verified repairs
within the current authorized round; Helmsman continues to own review scheduling,
publication permissions and required gates.

## Shared context and focused verification

Staged author metadata now includes an optional structured `brief`: `property`,
`nonGoals`, `boundaries`, `verification`, and `decisions`. New author prompts request
it; legacy metadata without a brief falls back to bounded PR-body prose. The host
validates and bounds the brief, preserves the initial scope and latest author
claims, and passes them through the existing `prePr.feedback` context. This does
not change public plugin interfaces.

A sidecar beside the PR metadata retains intermediate author decisions and check
claims alongside compact completed review-round evidence, and restores that history
on explicit continuation. Later rounds see that history; reviewers
within the same round do not see peer reports. Full original report artifacts
remain available. Truncated or missing history proves nothing was settled. Briefs,
author dispositions and old verdicts are untrusted evidence, not requirements,
security-owner approval or approval of the current revision. The final exact-revision
review and publication gates remain binding.

Instructions are selected by role: authors receive implementation guidance,
reviewers receive evidence and verdict rules, and feedback authors receive repair
and response guidance. Publication and security boundaries remain universal. A
short hostile-parser containment rule applies to every relevant role; detailed
containment guidance is added when task title, task text, Jira context or feedback
suggest parsing is relevant. A missed keyword never waives the safety rule.

Before reporting a defect, reviewers check the strongest counterargument: existing
guards, supported caller constraints, configuration and actual runtime behavior.
They report decisive evidence or discard the candidate. An inaccessible essential
fact is a specific limitation, not an invented defect or automatic approval.

Authors and reviewers plan the smallest checks establishing acceptance and affected
behavior while honoring required repository checks. They record commands, revision,
outcomes and limitations, and reuse only evidence still applicable to the current
code and environment. Relevant changes, failures and invalidated assumptions require
fresh verification. Settled findings reopen for changed code, requirements, evidence
or a specific error in prior reasoning; explain the reason. Prior approval never
replaces required review of the complete final diff.

## Evaluating decisions

The [prompt evaluation guide](prompt-evaluation.md) provides eight synthetic review
cases drawn from the supplied retrospective. Export blinded exercises using the
current Codex and Claude prompts, collect predictions through authorized GoCaaS, and
score verdict accuracy, critical misses, overblocking and context/token budgets.
Local fixture and scorer tests check the framework, not model quality. No live
model run is required or performed by these commands. Compare saved baseline and
changed-prompt predictions with the same actual model settings; inspect rationales
as well as verdicts. Existing execution snapshots remain frozen.

## Checking parity

Run from the post-rewrite checkout, with dependencies installed in both checkouts:

```sh
npm run check:prompt-parity -- ../helmsman-pre-rewrite
# Equivalent direct command:
node --import tsx scripts/check-prompt-parity.mjs ../helmsman-pre-rewrite
```

Omit the path to use the sibling `helmsman-pre-rewrite` checkout. The checker compares
full generated prompt text for matching Codex and Claude fixtures across legacy
builders and active workflow plugins. It also compares feedback-author context,
feedback audits with and without decision evidence, and clarification instructions.
It reports mismatches and exits nonzero on failure. It renders prompts locally;
it does not launch agents or publish reviews.

The post-rewrite workflow packages retain their public plugin interfaces and
metadata-driven provider selection. Runtime evidence such as captured discussion
paths, revisions and fingerprints comes from each version's execution context.
Parity checks supply matching evidence and compare shared instructions exactly;
provider-specific delegation mechanics remain deliberate differences.
