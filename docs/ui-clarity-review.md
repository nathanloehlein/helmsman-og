# UI clarity review

Reviewed 19 September 2026 with Impeccable clarify/operate guidance. Preserve the existing theme, navigation, galleon scope, and workflow behavior. Technical identifiers and user content are unchanged.

| Page | Improvement or review result |
|---|---|
| Helm | Persistent launch/model/effort labels; clearer ticket-start wording; custom instructions identified. |
| PRs | Labeled lookup and review fields; action copy distinguishes posting a review from asking an agent to update code. |
| Triage | Explains ticket selection and launch target; Jira failures include a recovery step. |
| Todos | “Start todos automatically” replaces “auto-claim”; explains eligible tasks and restart behavior; disabled-start reasons remain visible. |
| Terminal | Explains direct text/keyboard control; explicit Send + Enter; keyboard controls have accessible names; supports the configured terminal app. |
| Bugs | Explains purpose, resolution percentile and sample count; missing Jira data is an error rather than proof of an empty backlog. |
| Runs / Voyages | Explains logs and PR lookup; loading a PR explicitly does not start an agent; persistent input label. |
| Costs & Outcomes | Same intelligible name in both modes; partial spend and unknown costs explained; assessment progress distinguished from task outcome; optional details collapsed. |
| Campaigns | Explains create → phase → import → preview; phase actions state their consequences; uncommon setup collapsed; mobile overflow corrected. |
| Agent Questions | Existing answer-first UI retained; new-task link corrected to the scoped Helm launcher. |
| Config | Explains individual saves; runtime inputs have associated labels; local Git distinguishes preview, local refresh and remote fetch. |

Shared terminology retains galleon/voyage flavor but uses Tokens, Costs & Outcomes, and explicit ticket-start actions. Notifications explain their contents and distinguish automatic checks being off from failures.

## Verification

- TypeScript and production build passed.
- Full frontend suite: 64 files, 862 tests passed; final focused checks: 185 tests passed for the link, forms, actions, and responsive fixes.
- All 11 routes inspected at 1280×1000 and 390×844 in cmux using an isolated temporary database on port 8799. Jira-only pages used missing-credential states; loaded-data rendering is covered by existing fixtures/tests. No tasks, PR reviews, terminal commands, or external notifications were sent.
- Impeccable detector run once per changed target group. New typography advisories were corrected; existing theme palette/radius/type advisories were outside this refinement and left unchanged.
- Screenshots and browser state records are local test artifacts under `/tmp/helmsman-ui-clarity-review/`, not application assets.
