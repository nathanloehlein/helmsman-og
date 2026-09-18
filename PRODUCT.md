# Helmsman — Product

## What it is

A **command center** for autonomous, Jira-backlog-driven coding agents. It both *watches* the loop (claim a ticket → explore → implement → run tests → open a PR → transition to review → next) and *drives* it: launch an agent on any ticket or a free-form task, watch it work live, stop it, review its PR (approve / request-changes / comment), re-run it on the PR branch with feedback, and edit runtime config — all from the browser. It is the UI + agent-management half of an internal dev-tooling pattern, not a customer-facing product and not a general orchestration framework.

The **Helm** page presents the fleet as a navigation bridge: graphite control panels, amber readouts, and a **Ship’s log** of recent activity. Startup uses a ship’s wheel, compass bearings, and a plotted course, with navigation and fleet-readiness messages leading into the dashboard.

## Who it's for

The engineer/operator running the agents. It must be **glanceable** — "what's running, what's queued, what shipped, what's waiting on me?" readable at a glance — *and* **operable**: the operator launches runs, stops them, and acts on PRs here, without dropping to a terminal or cross-checking Jira and GitHub by hand. It is the one screen an operator keeps open to supervise a fleet of unattended agents.

## Mode

**Operate.** Scanability, consistency, and honest live state outrank expression. The value is trust: an operator should believe what the panels say without cross-checking Jira and GitHub by hand.

## The loop it watches

- **State store = Jira.** Ticket status *is* the state machine (`Backlog → In Progress → In Review → Done`). No parallel database.
- **Single-flight per repo.** One ticket per codebase at a time; parallelize across repos, serialize within one.
- **The human gate is real.** PR opened + ticket → In Review *is* the gate. The agent never merges to main; merge is always a human action. Investigation (read/explore/test) is unrestricted; the only gated surface is writing — branch push and PR open.

## Panels

| Panel | Answers | Source |
| --- | --- | --- |
| Backlog queue | What's next, in priority order; **Launch** any of them | Jira JQL |
| New voyage | Launch any ticket by id, or a free-form task (no ticket) | operator input → Helmsman |
| Agents running | Live runs — ticket, repo, elapsed, attempt, cost; **Stop**; click → live log drawer | Helmsman run store (SSE) |
| Mine · underway | Assigned unfinished tickets; **Launch** against the selected repository | Shared Jira mine-open search |
| Recent voyages | Completed/failed/stopped runs; click → replayed log + PR link | SQLite run store |
| Open PRs (Helm) | Open PRs from every author in the selected repository | GitHub REST |
| Review requests / My open PRs (PR tab) | PRs awaiting the operator’s review and the operator’s authored open PRs; click → review controls | GitHub search |
| PR controls | Any PR's state/CI/review-decision; approve / request-changes / comment; re-run on the branch | GitHub REST (server-side token) |
| Config | Live-editable non-secret runtime config (adapter, caps, repo map, Jira/GitHub scope) | SQLite overrides over `.env` |
| Out to sea | What the agents opened for review | author's recent PRs across repos (GitHub issue-search) |
| Ship’s log / throughput | What just happened; completed today, awaiting review, avg cycle, 7-day throughput | Jira changelog + GitHub PR events |

## Data & runtime

- Browser loads navigation context locally. External dashboard data refreshes every five minutes only on visible Helm/PR views; hidden pages pause polling. Local run status and notifications update every 30 seconds while visible. Shared server caches coalesce duplicate GitHub reads. Credentials stay server-side.
- The endpoint composes config → fetch (Jira + GitHub REST) → assemble → `DashboardSnapshot`.
- **Degrades, never blanks.** Missing credentials or a failed source falls back to the mock payload for that slice, behind a "showing sample data" banner. A transient poll failure keeps the last-good render.
- Config is environment-driven (`.env`): `JIRA_BASE_URL/EMAIL/API_TOKEN/PROJECT/ASSIGNEE`, optional `JIRA_JQL`, `GITHUB_TOKEN/PR_AUTHOR`, optional `GITHUB_REPO`, and `REPO_PROJECT_MAP`. Shipped PRs come from author-scoped GitHub search (repo-agnostic), because repo-scoped search is SSO-gated on some private orgs and returns 422. `GITHUB_REPO` is only the default topbar label; when unset the label falls back to `@<author>`.
- **Repo selector re-scopes the whole dashboard.** `REPO_PROJECT_MAP` is a comma-separated `repo=JIRA_PROJECT` map (e.g. `gdcorp-enm/conversations-web=LEKA,gdcorp-partners/airo-app-builder=AIROBUILD`). The dashboard is Jira-project-scoped, not GitHub-repo-scoped, so this map is the bridge: selecting a repo re-fetches `/api/dashboard?repo=…`, filters GitHub to that repo and re-queries Jira with the mapped project. Unmapped repos still filter GitHub but leave Jira on the default project.

## Product truth to preserve

- The **human merge gate is absolute**: the agent never merges, and there is **no merge control in the UI** — merge is always a deliberate action on GitHub. This is the one hard invariant; every other write (claim/transition a ticket, open/review a PR, re-run) is allowed and operator- or agent-initiated.
- The topbar/Working-on `repo` label comes from `GITHUB_REPO`, or `@<author>` when unset. Because shipped PRs are now sourced by author across repos, this label is a scope hint (whose activity), not a guarantee that a given ticket lives in that repo.
- The permission note ("read/write scoped to this branch; merge requires human approval") is a load-bearing statement of the agent's contract, not decoration.
- Unsourceable metrics are omitted rather than faked (token/cost accounting lives in neither Jira nor GitHub, so it isn't shown).
