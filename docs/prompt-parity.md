# Coder and reviewer prompt parity

Pre-rewrite and post-rewrite share the same instructions for coding, scoped repairs,
independent review, review corrections, existing-PR feedback and feedback audits.
This includes acceptance evidence, report formats and limits, inline anchors,
author replies, publication restrictions and the clarification protocol.

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
change. Reviewers verify the property against the requirements. When prior metadata
is unavailable, including in isolated stages, they reconstruct it from available
requirements; missing prose alone is not a blocker.

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

This is prompt guidance, not new runtime enforcement. It adds no invariant storage,
metadata fields or acceptance gate, and does not change review scheduling or parser
execution inside Helmsman. Existing run snapshots remain unchanged.

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
