# Helmsman voyage flow

Open [helmsman-process.html](helmsman-process.html) for the standalone diagram. It works offline and can be printed or saved as a PDF from a browser.

```mermaid
flowchart TD
    User([User]) --> Galleon[Select galleon]
    Galleon --> Jira[Jira ticket<br/>Jira enabled]
    Galleon --> Freeform[Freeform task]
    Galleon --> Todo[Local todo<br/>Jira disabled]
    Jira --> Launch[Launch voyage]
    Freeform --> Launch
    Todo --> Launch
    Launch --> Context[Load task context<br/>Create managed branch and worktree<br/>Validate clean checkout, base, remote and writer CLI]
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
    Gate -->|Yes| Push[Recheck approved revision<br/>Push exact approved commit]
    Push --> Verify[Verify remote SHA and PR base/head]
    Verify --> PR[Create and verify PR<br/>Or reuse matching existing PR<br/>Apply author byline]
    PR --> Queue[Queue a separate Helmsman PR review]
    Queue --> Success[Record successful voyage]
    Success --> JiraState[Eligible Jira ticket → configured review status]
    JiraState --> Copilot[Request Copilot review]
    Copilot --> Complete[Complete parent voyage and release capacity]
    Complete --> Followup[Queued Helmsman review launches when eligible<br/>Open, non-draft PR; pin current head<br/>Reuse an existing matching review when available]
    Resume[Optional valid saved checkpoint<br/>Exact branch/base/head and original reports] -.-> Reports
```

## Defaults and boundaries

- **Defaults:** 2 desired reviewer CLIs, 3 review rounds, 45 minutes per agent session. Configuration allows 1–2 reviewers, 1–5 rounds, and 5–180 minutes. These are defaults, not a statement of current live settings.
- The writer CLI is required. An unavailable alternate CLI permits a single reviewer, even when 2 are configured. The writer's review is a fresh session in a detached worktree.
- Reviewer leads run sequentially. Their prompts request concurrent, bounded sub-agents; the runtime does not verify that delegation happened.
- Each reviewer examines the same complete committed diff. After a fix commit, every selected reviewer reviews the new revision. A `COMMENT` verdict blocks; it does not enter the fix loop.
- Summary correction applies only to an otherwise valid report. It gets one additional session per report, with its own timeout, and does not consume another review round. The 2,000-character limit uses JavaScript string length, including whitespace and any byline.
- Preflight, agent, report, revision, and publication failures stop the flow. Pre-PR voyages have one outer attempt; the runtime does not automatically restart the entire voyage. Work is retained on failure. A push may already have occurred if a later publication check fails.
- A valid saved checkpoint skips implementation and reuses the original reports for its saved review round. It must match the current branch, base, head, and complete selected reviewer set. Oversized saved summaries can use the same correction step.
- After publication, Helmsman queues its own PR review and requests Copilot. Jira transitions apply to eligible Jira tasks, not local todos or freeform tasks. Queue and Copilot request failures do not change the successful creation voyage to failed.
- The queued Helmsman review waits for the parent to finish, available capacity, and GitHub configuration. Closed, merged, or draft PRs are blocked. A matching running or successful review for the current head can be reused. The flow does not auto-merge the PR.
