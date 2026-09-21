# Helmsman voyage flow

Open [helmsman-process.html](helmsman-process.html) for the standalone diagrams. They work offline and can be printed or saved as a PDF from a browser.

This describes Helmsman **0.3.0**: manual and automated intake, frozen execution settings, isolated agent stages, Agent Questions, durable evidence and recovery, and Costs & Outcomes. New coding tasks use the exact-revision PR review gate. Existing-PR reviews and feedback reruns follow separate paths.

## Intake and execution preparation

```mermaid
flowchart TD
    Manual[Operator selects a galleon<br/>Jira ticket, custom task, local todo<br/>Existing PR review or feedback rerun] --> Dispatch
    AutoClaim[Auto-claim enabled per galleon<br/>Next Jira backlog ticket<br/>Or local todo when Jira is disabled] --> Dispatch
    Campaign[Campaign: create phases<br/>CSV/JSONL preview → confirm → start phase<br/>Import and task deduplication] --> Dispatch
    Webhook[GitHub webhook, when configured<br/>Raw-body HMAC + explicit event/action/workflow mapping<br/>Persistent delivery deduplication] --> Dispatch
    Slack[Slack bounty watcher, when enabled<br/>Poll configured channel through authenticated browser<br/>Persist and deduplicate PR notifications] --> Dispatch
    GitHub[GitHub requested-review watcher, when enabled<br/>Poll requested reviews and deduplicate by PR head<br/>Reuse a matching existing review] --> Dispatch
    Dispatch[Check scope and capacity<br/>One active writer per galleon<br/>Campaigns, webhooks and watchers persist dispatch state] --> Snapshot[Freeze workflow version, prompts, skills and settings<br/>Verify required skills and provision private copies<br/>Retry/resume must match the saved snapshot]
    Snapshot --> Host{Configured execution host}
    Host --> Local[Trusted local execution<br/>Default host]
    Host --> Docker[Docker agent stages<br/>Pinned image; private workspace and runtime<br/>Run-scoped gateway; host keeps upstream credentials]
    Local --> Workflow{Task workflow}
    Docker --> Workflow
    Workflow -->|New coding task| Coding[Implementation and exact-revision review loop below]
    Workflow -->|Existing PR review| Review[Pin PR head and run standalone review<br/>Host verifies result and required answers before posting]
    Workflow -->|Existing PR feedback rerun| Rerun[Trusted local execution only<br/>Agent updates, tests, commits and pushes same branch<br/>Bypasses the new-code pre-PR review gate]
    Snapshot -.->|Missing skills / drift / unavailable host| Block[Fail preflight; no unisolated fallback]
```

Manual launches inherit the header galleon unless a panel explicitly selects another. Auto-claim selects the next Jira backlog ticket, or a local todo when Jira is disabled, while capacity is available. Campaign record overrides are shown in the import preview; webhook targets and workflows come only from configured mappings. Campaign phases control dispatch and concurrency; durable claims and stable run IDs allow reconciliation after uncertain launches.

Slack bounty and GitHub requested-review watchers poll every five minutes when enabled, queue reviews for configured galleons, and wait for capacity. Slack reads PR links through an authenticated browser; GitHub requested reviews are deduplicated by PR head and may reuse a matching review. These polling sources do not require webhook ingress. Both launch the standalone review path.

In Docker mode the host supervises, verifies artifacts, and publishes; only writer/reviewer stages enter containers. Agent containers reach approved provider operations and restricted GitHub reads through a capability-scoped gateway. They receive no long-lived host credentials, unrestricted internet access, or Docker socket. Trusted local execution retains its existing host permissions.

## New coding tasks and PR publication

```mermaid
flowchart TD
    Prepared([Coding workflow prepared]) --> Context[Load task context and prepare workspace<br/>Managed branch; validate base, remote and clean checkout<br/>Writer CLI available in selected execution environment]
    Context --> Writer[Writer implements and runs checks<br/>Commits locally and writes PR metadata]
    Writer --> Review[Review round: sequential CLI leads<br/>Writer CLI first, then installed alternate<br/>Each lead is prompted to delegate focused sub-agents]
    Review --> Reports{Reports valid for the pinned SHA?}
    Reports -->|Otherwise valid; summary over 2,000 characters| Correction[One summary-only correction attempt per report<br/>Revalidate; preserve verdict and findings<br/>Keep original report]
    Correction -->|Valid| Gate{Every selected reviewer approves<br/>with no findings?}
    Correction -->|Invalid or failed| Stop[Block publication<br/>Preserve work and report artifacts]
    Reports -->|Valid| Gate
    Reports -->|Malformed, stale or changed worktree| Stop
    Gate -->|COMMENT / incomplete review| Stop
    Gate -->|REQUEST_CHANGES; rounds remain| Fix[Writer fixes deduplicated findings<br/>Runs checks and commits a new revision]
    Fix --> Review
    Gate -->|Findings at final round| Stop
    Gate -->|Yes| Answers{Required Agent Questions answered?}
    Answers -->|No / gate unavailable| Stop
    Answers -->|Yes| Push[Host rechecks approved revision<br/>Push exact approved commit]
    Push --> Verify[Verify remote SHA and PR base/head]
    Verify --> Publication[Recheck required answers before PR write]
    Publication --> PR[Create and verify PR<br/>Or reuse matching existing PR<br/>Apply author byline]
    PR --> Queue[Queue a separate Helmsman PR review]
    Queue --> Success[Record successful voyage]
    Success --> JiraState[Eligible Jira ticket → configured review status]
    JiraState --> Copilot[Request Copilot review]
    Copilot --> Complete[Complete parent voyage and release capacity]
    Complete --> Followup[Queued Helmsman review launches when eligible<br/>Open, non-draft PR; pin current head<br/>Reuse an existing matching review when available]
    Resume[Optional valid saved checkpoint<br/>Verified artifact hashes and frozen snapshot<br/>Exact branch/base/head and original reports] -.-> Reports
```

## Existing-PR feedback reruns

```mermaid
flowchart LR
    Feedback[Operator submits feedback<br/>for an existing PR] --> Prepare[Resolve PR branch<br/>Freeze settings; prepare branch worktree<br/>Trusted local execution only]
    Prepare --> Agent[Agent addresses feedback<br/>Runs tests, commits and pushes<br/>to the same branch]
    Agent --> Finish[Host checks required answers<br/>and records completion]
```

Feedback reruns use the agent's normal update prompt, not the new-code pre-PR adapter. The agent publishes branch updates directly; the host does not apply the exact-revision review gate or recheck required answers immediately before that push. The prompt requires the agent to wait for required answers before dependent work, and unanswered required questions block successful completion. No new PR is created, and this path does not enqueue the post-creation Helmsman review, transition Jira, or request Copilot. Docker feedback reruns fail preflight; select trusted local execution.

## Services throughout a voyage

```mermaid
flowchart LR
    Stage[Agent stages] --> Question[Agent asks a question<br/>Run-bound question and deadline saved]
    Question --> Human[Agent Questions page<br/>Operator sends an answer to that agent]
    Human --> Continue[Agent reads answer and continues]
    Question -->|Required answer missing, expired or cancelled| Block[Block successful completion<br/>Host publication gates block new PRs and reviews<br/>Timeout is never an answer]
    Stage --> Evidence[Host validates reports<br/>Immutable artifacts + content hashes]
    Evidence --> Recovery[Restart: reattach durable process/container identity<br/>Checkpoint: verify snapshot, hashes and pinned revision]
    Stage --> Usage[Structured provider events + lifecycle ledger<br/>Idempotent replay; no double-counted usage]
    Usage --> Outcomes[Costs & Outcomes<br/>Reported spend + separate Codex API estimates<br/>Usage coverage, tokens, duration, PR outcomes<br/>Separate task assessment with evidence]
```

- **Questions:** agents ask; the operator replies. Waiting retains capacity. Required-answer checks run again immediately before host publication of new PRs and standalone reviews; feedback reruns have the boundary described above. Contacts are optional suggested respondents, not an outbound notification system.
- **Evidence and recovery:** validated reports are recorded with immutable identities and hashes. A checkpoint continuation revalidates saved evidence before reusing it; legacy checkpoints without manifests follow an explicit compatibility path. A fresh retry preserves the original task/provider, workflow snapshot and Docker image pin; changed prompts or skills fail preflight. Restart reattachment and checkpoint continuation are different from restarting an entire failed voyage.
- **Costs and outcomes:** provider token/cost events and stage timing feed a persistent ledger. Reported spend can be partial; unreported billed costs stay unknown. Eligible unpriced Codex usage receives a separate Standard short-context API baseline estimate, using published rates checked September 19, 2026. The UI exposes estimated/unpriced record coverage and runs without usage records. Missing model/token data remains unknown; service tier, per-request context and cache-write usage are unavailable, and subscription charges may differ. Estimates do not affect budget caps or cost-per-PR metrics, which use fully priced runs. Process success does not itself establish task completion: assessment state (complete/partial/failed/not-assessed) is separate from task outcome (achieved/partial/not-achieved/unknown), with supporting evidence. PR visibility is best-effort with explicit stale/unavailable status.

## Defaults and boundaries

- **Defaults:** 2 desired reviewer CLIs, 3 review rounds, 45 minutes per agent session. Configuration allows 1–2 reviewers, 1–5 rounds, and 5–180 minutes. These are defaults, not a statement of current live settings.
- The writer CLI is required in the selected execution environment. An unavailable alternate CLI permits a single reviewer, even when 2 are configured. The writer's review is a fresh session, using a detached worktree locally or an isolated review workspace in Docker.
- Reviewer leads run sequentially. Their prompts request concurrent, bounded sub-agents; the runtime does not verify that delegation happened.
- Each reviewer examines the same complete committed diff. After a fix commit, every selected reviewer reviews the new revision. A `COMMENT` verdict blocks; it does not enter the fix loop.
- Summary correction applies only to an otherwise valid report. It gets one additional session per report, with its own timeout, and does not consume another review round. The 2,000-character limit uses JavaScript string length, including whitespace and any byline.
- Preflight, agent, report, revision, and publication failures stop the flow. Pre-PR voyages have one outer attempt; the runtime does not automatically restart the entire voyage. Work is retained on failure. A push may already have occurred if a later publication check fails.
- A valid saved checkpoint skips implementation and reuses the original reports for its saved review round. It must match the current branch, base, head, and complete selected reviewer set. Oversized saved summaries can use the same correction step.
- After publication, Helmsman queues its own PR review and requests Copilot. Jira transitions apply to eligible Jira tasks, not local todos or freeform tasks. Queue and Copilot request failures do not change the successful creation voyage to failed.
- The queued Helmsman review waits for the parent to finish, available capacity, and GitHub configuration. Closed, merged, or draft PRs are blocked. A matching running or successful review for the current head can be reused. The flow does not auto-merge the PR.

## Setup and current limits

- Webhooks are disabled until a secret and explicit routes are configured; public ingress is a separate deployment choice. See [webhook setup](webhooks.md).
- Slack bounty and GitHub requested-review watchers are independently opt-in. Slack also needs its configured channel and an authenticated browser session; GitHub needs configured credentials and galleons. Auto-claim is enabled separately per galleon.
- Docker requires a built runtime image and host provider credentials. Dependencies/cache must be supplied in the image because agent stages have no unrestricted network access. Docker branch-update reruns currently fail preflight; the operator must select trusted local execution for that mode. See [Docker execution](docker-run-host.md).
- Offline Docker lifecycle and mocked provider gateway flows were verified during adoption. A real provider-backed Docker coding/review run still requires configured host API keys; the adoption validation did not make paid provider calls.
- No path auto-merges a PR. Merging remains a human action on GitHub.

Implementation references under `server/helmsman/`: `main.ts`, `scheduler.ts`, `slack/watcher.ts`, `github-review-watcher.ts`, `prepare-run.ts`, `workflow-snapshots.ts`, `campaign-dispatcher.ts`, `webhooks.ts`, `docker-stage.ts`, `scoped-gateway.ts`, `clarification-runtime.ts`, `pre-pr-runtime.ts`, `agents/prompt.ts`, `runner.ts`, `artifacts.ts`, `run-telemetry.ts`, and `outcome-service.ts`. See [adoption evidence](moonunit-adoption.md).
