# Backlog Runner — Product

## What it is

A read-only dashboard that visualizes an **autonomous, Jira-backlog-driven coding agent** working its loop: claim a ticket → explore → implement → run tests → open a PR → transition the ticket to review → pick the next one. It is the UI half of an internal dev-tooling pattern, not a customer-facing product and not a general orchestration framework.

## Who it's for

The engineer/operator watching the agent. The dashboard is **glanceable**: it answers "what is the agent doing right now, what's queued, what shipped, is anything waiting on me?" at a glance, from across a room. It is not a place where work is done — every control that would mutate state lives elsewhere.

## Mode

**Operate.** Scanability, consistency, and honest live state outrank expression. The value is trust: an operator should believe what the panels say without cross-checking Jira and GitHub by hand.

## The loop it watches

- **State store = Jira.** Ticket status *is* the state machine (`Backlog → In Progress → In Review → Done`). No parallel database.
- **Single-flight per repo.** One ticket per codebase at a time; parallelize across repos, serialize within one.
- **The human gate is real.** PR opened + ticket → In Review *is* the gate. The agent never merges to main; merge is always a human action. Investigation (read/explore/test) is unrestricted; the only gated surface is writing — branch push and PR open.

## Panels

| Panel | Answers | Source |
| --- | --- | --- |
| Backlog queue | What's next, in priority order | Jira JQL |
| Working on | The current ticket + its step log | Jira In-Progress issue + changelog |
| Recently shipped | What the agent opened for review | The author's recent PRs across all repos (GitHub issue-search by author; each card shows its own repo) |
| Activity feed | What just happened, newest first | Jira changelog transitions + GitHub PR events |
| Today / throughput | Completed today, awaiting review, avg cycle, 7-day throughput | Jira counts + changelog deltas |

## Data & runtime

- Browser polls `GET /api/dashboard` every 30s (Vite dev-server plugin holds credentials server-side; nothing secret reaches the bundle).
- The endpoint composes config → fetch (Jira + GitHub REST) → assemble → `DashboardSnapshot`.
- **Degrades, never blanks.** Missing credentials or a failed source falls back to the mock payload for that slice, behind a "showing sample data" banner. A transient poll failure keeps the last-good render.
- Config is environment-driven (`.env`): `JIRA_BASE_URL/EMAIL/API_TOKEN/PROJECT/ASSIGNEE`, optional `JIRA_JQL`, `GITHUB_TOKEN/PR_AUTHOR`, optional `GITHUB_REPO`, and `REPO_PROJECT_MAP`. Shipped PRs come from author-scoped GitHub search (repo-agnostic), because repo-scoped search is SSO-gated on some private orgs and returns 422. `GITHUB_REPO` is only the default topbar label; when unset the label falls back to `@<author>`.
- **Repo selector re-scopes the whole dashboard.** `REPO_PROJECT_MAP` is a comma-separated `repo=JIRA_PROJECT` map (e.g. `gdcorp-enm/conversations-web=LEKA,gdcorp-partners/airo-app-builder=AIROBUILD`). The dashboard is Jira-project-scoped, not GitHub-repo-scoped, so this map is the bridge: selecting a repo re-fetches `/api/dashboard?repo=…`, filters GitHub to that repo and re-queries Jira with the mapped project. Unmapped repos still filter GitHub but leave Jira on the default project.

## Product truth to preserve

- Read-only. The dashboard observes; it never writes to Jira or GitHub.
- The topbar/Working-on `repo` label comes from `GITHUB_REPO`, or `@<author>` when unset. Because shipped PRs are now sourced by author across repos, this label is a scope hint (whose activity), not a guarantee that a given ticket lives in that repo.
- The permission note ("read/write scoped to this branch; merge requires human approval") is a load-bearing statement of the agent's contract, not decoration.
- Unsourceable metrics are omitted rather than faked (token/cost accounting lives in neither Jira nor GitHub, so it isn't shown).
