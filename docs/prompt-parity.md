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
