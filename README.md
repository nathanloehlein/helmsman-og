# Helmsman

A control plane for Jira-backlog-driven coding agents. Launch a CLI agent against a
ticket, watch it work live (explore → implement → test → open a PR), and keep a human
approval gate before anything merges — running multiple agents across repos, one at a
time per repo. The dashboard (backlog queue, current run, Ship’s log, shipped PRs)
is the view; the **Helmsman server** behind it spawns and supervises the agents.

The **Helm** dashboard defaults to Quarterdeck: sea-blue panels, wood-brown trim, brass
fleet readouts, and a ship-wheel startup animation with compass bearings and course plotting.

## Status

- **Built (P0–P6):** the Helmsman server, SQLite run store, dashboard API, and a
  Claude Code agent adapter — launch a ticket, run it in an isolated git worktree,
  stream its events to a live log drawer, and record the run (P0–P1); Jira status
  writes with an In-Review gate (P2); a multi-agent running view with per-run stop
  and live logs (P3); an opt-in per-repo auto-claim scheduler (P4); a generic-command
  adapter plus hardening — crash recovery, orphaned-worktree sweep, and cost/attempt
  caps (P5); and a full UI control plane — launch any ticket or a free-form task, a
  recent-runs history, and a live non-secret config editor (P6); and PR controls —
  view any PR's status/CI/review decision, approve / request-changes / comment, and
  re-run the agent on an existing PR branch with feedback (P7). The agent opens a PR
  and **never merges**.

## Stack

TypeScript (strict). A **Vite** front end (pure logic in `src/logic/`, unit-tested with
Vitest; `src/render.ts` owns the DOM) plus a persistent **Helmsman Node server**
(`server/helmsman/`, `node:http` + `node:child_process`) that serves the API, owns a
**SQLite** run store (better-sqlite3), and spawns agents in per-run git worktrees. No
runtime framework.

## Data

`GET /api/dashboard` is served by the **Helmsman server** (`server/helmsman/`), which
queries Jira + GitHub and assembles a `DashboardSnapshot`; in dev, Vite proxies `/api`
to it. `src/data/mock.ts` is the server-side fallback payload the endpoint substitutes
per-source when a live source can't be reached (see [Degraded mode](#degraded-mode)).

## Commands

```bash
npm install
npm run dev          # Helmsman (:8787) + Vite dev server (proxies /api)
npm run helmsman     # Helmsman server only
npm run build        # production build to dist/
npm test             # vitest
```

## Background: the agent this dashboard watches

This is the UI half of a pattern for autonomous internal-dev-tooling agents —
not a customer-facing product, not a general orchestration framework. The
target use case: a coding agent that works a Jira backlog unattended, opens a
PR per ticket, and hands off to a human at the review gate before anything
merges.

### Why not LangGraph / Temporal / CrewAI / an agent framework

Those solve problems this doesn't have. Internal tooling failures are cheap —
a bad run gets retried, nobody's paged. There's no multi-tenant state to
coordinate, no cross-service durability requirement, no need for crash-safe
mid-task resume unless a single ticket routinely spans many hours. Bringing in
a framework's checkpointing/replay machinery here would be solving for
durability nobody asked for. The right amount of infrastructure is closer to
"a scheduled job plus two APIs that already track state" than "a new
distributed system."

### The actual loop

**State store = Jira, not a new database.** Ticket status *is* the state
machine — `Backlog → In Progress → In Review → Done` — and it's already the
view your human reviewers use. Don't shadow it with a parallel SQLite/Postgres
tracker; that's a second source of truth to keep in sync for no benefit.

```
heartbeat wakes (cron / Claude Code /schedule, not a standing daemon) →
  any ticket assigned to the bot still "In Progress"?
    yes → resume/retry it (never double-claim)
    no  → query the backlog (JQL, priority order, label-gated to
          "agent-eligible" so nothing sensitive gets auto-picked)
        → claim the top one, assign to bot, transition → "In Progress"
  work it: explore the repo → implement → run tests → open a PR,
  link the PR back to the ticket
  transition ticket → "In Review"
  loop back to the top, claim the next one
```

**Single-flight per repo.** Multiple tickets against the same codebase in
parallel just means merge conflicts and wasted work. Parallelize across
repos if you need throughput; serialize within one.

**The human gate is real, not cosmetic.** PR opened + ticket → "In Review" *is*
the gate — the agent never merges to main. Same read/write split this
dashboard's "Working on" panel calls out: investigation (explore, read, run
tests) is unrestricted; anything that writes — branch push, PR open — is the
only gated surface, and merge itself is always a human action.

**When this would earn a heavier framework**: tickets start requiring
multi-session work with real crash-safe resume, or you need explicit
dependency ordering between tickets (ticket B can't start until ticket A
merges — that's a dependency graph, not a queue). Until then, Jira-as-state +
a bounded per-ticket agent session is the whole architecture.

## First-time setup

1. Install **Node.js 22.12+ on the 22 release line, or Node.js 24+**, npm, and Git.
   These versions satisfy the current Vite and `better-sqlite3` requirements. If npm cannot use a prebuilt
   SQLite binary, install your platform's native build tools (Xcode Command Line Tools
   on macOS). Install and sign in to the agent CLI you intend to use: `codex` (default),
   `claude`, or the executable for the `command` adapter. It must be available on the
   Helmsman server's `PATH`. Install and authenticate GitHub CLI (`gh auth login`) for
   coding agents that open or update PRs. Git must also be able to fetch your private
   repositories using your SSH key or HTTPS credential helper.
2. From the Helmsman checkout, run:

   ```bash
   npm install
   cp .env.example .env
   ```

   Keep `.env` local. It is required by the server, even if you leave credentials blank
   to explore the degraded/demo dashboard. Run subsequent npm commands from this directory.
3. Create a parent directory for the repositories Helmsman will work in, and clone each
   repository into a directory matching its **repository name**, without the owner:

   ```bash
   mkdir -p /absolute/path/to/agent-repos
   git clone git@github.com:your-org/your-repo.git /absolute/path/to/agent-repos/your-repo
   ```

   Set `AGENTS_ROOT=/absolute/path/to/agent-repos` in `.env`. A configured repository
   `your-org/your-repo` resolves to `<AGENTS_ROOT>/your-repo`; its agent worktrees live
   under `<AGENTS_ROOT>/your-repo/.worktrees/<run-id>`. Helmsman does not clone missing
   repositories. Use an ordinary checkout with an `origin` pointing to that GitHub
   repository. Repositories with the same name under different owners cannot share
   this directory layout. Install each target project's dependencies as its own README
   requires, and verify its build/test commands before launching a voyage.
4. Configure GitHub in `.env`. Create a [personal access token](https://github.com/settings/tokens)
   that can access the selected repositories, including organization approval or SSO
   authorization where required. Dashboard reads need repository, PR, and CI-status
   read access; publishing reviews needs pull-request write access. Coding agents that
   push changes need repository-content write access through their Git credentials.
   For a fine-grained token, choose the repository owner/repositories and the relevant
   Contents, Pull requests, Checks, and Commit statuses permissions. Set:

   ```dotenv
   GITHUB_TOKEN=your-token
   GITHUB_PR_AUTHOR=your-github-login
   GITHUB_REPO=your-org/your-repo
   ```

   `GITHUB_PR_AUTHOR` is a login, not an email; it scopes authored PRs and requested
   reviews. Both it and the token are required to enable the GitHub integration.
   The server currently targets `api.github.com`.
5. For Jira-backed work, set `JIRA_BASE_URL` to your Jira Cloud site, `JIRA_EMAIL` to
   the authenticating account, and `JIRA_API_TOKEN` to that account's
   [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens).
   The account needs permission to browse the project and, for ticket voyages, assign
   issues and transition them. Helmsman uses email/token Basic authentication against
   the site's `/rest/api/3` endpoints. Set `JIRA_PROJECT` and, if needed,
   `JIRA_ASSIGNEE`. To assign ticket work to a bot, obtain its Jira `accountId` from
   the account's profile or Jira user API and set `BOT_ACCOUNT_ID`; this is not its
   email address. Match the `JIRA_STATUS_*` values to your workflow's actual status
   names. Map each tracked repository to its Jira project:

   ```dotenv
   REPO_PROJECT_MAP=your-org/your-repo=PROJECT,your-org/another-repo=OTHER
   ```

   Replace the organization-specific examples in `.env.example` with your values.
   Jira is optional for PR reviews and free-form voyages. Leave its credentials blank
   if you do not use it; Jira panels will identify their data as degraded.
6. Leave both review watchers disabled for the initial check. Run `npm run dev` and open
   the printed Vite URL (normally `http://localhost:5173`). The API listens on
   `127.0.0.1:8787` by default. Open **Config**, select a repository, and verify the
   **Local branches & worktrees** card resolves the expected checkout. Check Helm/PR
   for live data and source-error banners. Resolve credential, checkout, and agent CLI
   errors before enabling automatic work. Saving a Config row applies only that row.
7. When ready, launch a deliberate manual voyage or PR review, then follow
   [Automatic PR reviews](#automatic-pr-reviews) to enable either optional watcher.

For a production build on the same machine, run `npm run build` followed by
`npm run helmsman`, then open `http://127.0.0.1:8787` (or your `HELMSMAN_PORT`).
The server serves `dist/` and the API together; `npm run preview` alone is not the
Helmsman backend. To apply server source or `.env` changes during development,
stop and restart `npm run dev`; the server process is not a file watcher.

### Polling and external requests

The client loads repository metadata from the local `/api/context` endpoint.
GitHub lists refresh at most every five minutes while Helm or PR is visible. Hidden pages
pause polling; returning to a page refreshes only data that is due. Local run status
and notifications update every 30 seconds while visible. Config does not repeatedly
reload settings or scan local worktrees. The selected cmux screen refreshes every two
seconds only while its page is visible.

The server shares GitHub list and review-history reads across tabs for five minutes,
coalesces concurrent requests, and pauses rate-limited reads until GitHub's reset.
Review preflight, PR details, diffs, and publication checks always use fresh requests.
Enabled Slack and GitHub requested-review watchers run every five minutes independently
of browser visibility. These polling/cache periods are fixed in code, not `.env`
settings. `AUTO_CLAIM_INTERVAL_MS` controls only the separate opt-in ticket scheduler.

## Running agents

Click **Launch** on a backlog ticket (or `POST /api/agents/launch {ticketId,title,repo}`).
Helmsman creates a git worktree under `AGENTS_ROOT`, spawns the configured agent
(default: Codex) in it, streams the agent's events to a live log
drawer over SSE (`GET /api/agents/:id/log`), records the run in SQLite, and removes the
worktree when it finishes. `POST /api/agents/:id/stop` SIGTERMs a run. One run per repo at
a time; global concurrency is capped by `AGENT_MAX_CONCURRENCY`. The agent opens a PR and
never merges — the human review gate is real.

### New voyage (any ticket / free-form)

The **New voyage** panel launches beyond the auto-fetched backlog: in **Ticket** mode, type any
Jira key + pick a repo (Helmsman fetches the summary for the title, fail-soft); in
**Free-form** mode, give a task prompt + repo and no Jira ticket is touched (no claim, no
transition — the run row is labelled `freeform`). Both stream into the same live drawer.

### Review before PR creation

Every new coding voyage implements and commits locally, then passes an adversarial
review before Helmsman pushes the branch or opens a PR. A fresh reviewer session
uses the writer's CLI; by default, if the other supported CLI is installed, a second
session uses it too. **Config → Pre-PR review** controls reviewers per round (1–2),
maximum rounds (1–5), and the timeout for each session (5–180 minutes). Settings are
captured when a voyage launches; changes do not affect running voyages. One reviewer
means a fresh session of the writer's CLI; two adds the other supported CLI when
installed. With only one installed, one reviewer runs. Currently supported CLIs are
Codex and Claude Code. Authenticate both when using two reviewers: an installed but
broken alternate reviewer blocks publication rather than silently reducing the gate.

Reviewers inspect the same pinned commit in separate detached worktrees and focus
on material logic, structure, acceptance criteria, UX, and external effects. Codex
reviewers require the installed `$review-agent` skill; each CLI delegates relevant
areas to focused leaf agents. Reviews default to low effort and use medium for
larger changes across areas. The author fixes verified findings, then **all**
reviewers review the new commit again. By default there are at most three review
rounds (two remediation rounds); setting one round permits no fix-and-review cycle.
Every reviewer must approve with no findings; incomplete
reviews, missing tools, changed revisions, and exhausted rounds block publication.

Helmsman publishes the reviewed commit itself, targeting the repository's default
branch. It selects a remote whose fetch and push URLs match the voyage repository
(prefer `origin`, otherwise require one matching remote), then verifies the pushed
SHA. The voyage log shows each stage. Failed or stopped voyages retain the author
worktree for inspection and repair; review reports and PR metadata live under the
run directory in a `.pre-pr` artifact folder. These worktrees survive restart sweeps
and can be removed from the local branches/worktrees page when no longer needed.
The workflow runs in the existing durable run host and survives server restarts.

This gate applies to new coding voyages, not existing-PR feedback reruns. The generic
`command` adapter cannot launch a new coding voyage because it cannot provide this
review contract. `AGENT_MAX_ATTEMPTS` does not multiply `PRE_PR_MAX_ROUNDS`.
Each author, fix, or reviewer session has a 45-minute timeout by default. The existing post-PR review
and Copilot request still run after successful publication.

### Recent voyages

After a successful coding voyage opens a PR, Helmsman requests Copilot and queues
its own independent adversarial review as a separate voyage. The durable queue
waits for repository capacity, survives restarts, and reuses a running or successful
review of the same revision. It runs on completion and retries pending work on the
existing five-minute cadence, with no external reads when idle or busy. This does
not require either Slack or requested-review polling to be enabled. Closed, merged,
or draft PRs are blocked with a notification; transient lookup failures stay queued.
Review failures are visible and do not trigger an automatic retry loop.

The review challenges the author's claims and checks realistic failure paths while
retaining the material-defect threshold, inline findings, complexity-based model
selection, and COMMENT-only publication. Persistent notifications link the review
and original coding voyage. Review voyages and feedback reruns do not recursively
queue more reviews. Existing historical PRs are not backfilled.

The PR-creation agent must not request code owners, teams, or human reviewers,
including through review mentions. GitHub's automatic CODEOWNERS rules can still
add reviewers.

Opening a voyage shows a bounded preview of its latest 300 log entries. Updates
are batched to keep the browser responsive; long entries are shortened in the
preview. **Download full log** retrieves all persisted output, including earlier
entries and full-length lines. For an active run, the download is a snapshot at
the time it is requested. Completed voyages close their log streams.

Output uses the selected theme's background, text, and syntax colors. Commands,
JSON, code snippets, and diffs receive lightweight highlighting; errors keep a
distinct colored edge. The log has no grid or text glow. Highlighting changes
presentation only; full log downloads retain the original output.

The **Recent voyages** panel lists completed/failed/stopped runs. Click any to re-open its
stored log (replayed from SQLite), final status, cost, and PR link — the same drawer used
for live runs.

Voyage rows and log tabs show a stable short ID derived from the persisted run ID.
UUIDs use their first 12 hexadecimal characters; automatic reviews retain their
`slack-`, `github-`, or `created-` prefix followed by 12 hexadecimal characters. Hover the ID
to see the full value. Links and log downloads continue to use the full run ID.

### PR controls

PR panes show the title, author, overall state, checks, and your submitted review
status. Approval progress shows the two required distinct reviewers (for example,
`1/2 approvals · 1 needed`). Dismissed approvals do not count, and outstanding
change requests remain visible even when two approvals have been received. This
counts reviews; GitHub still enforces other merge requirements. Ownership and
personal review status use `GITHUB_PR_AUTHOR`. Relaunch with
feedback is available only for your own PRs in a configured local repository;
crew code review remains available for other authors' PRs. A later comment does
not clear an existing approval or change request.

The **PR** tab lists **Review requests** and **My open PRs** above the review controls. Select a row to load its details and diff. The **Helm** page keeps **Open PRs** for the selected repository, including every author; select a repository to populate it. Lists report loading, unavailable, empty, and partial-result states independently.

**Recent PR voyages** shows the latest 10 PR-related runs in the selected repository
from the local run history, with status and saved review results. Select a voyage to
open its output, or **All voyages** for the full list. It uses the existing local
refresh and preserves any unsent review while updating.

A run with a PR shows a **PR panel** in its drawer (state, CI checks, review decision,
comments, link); a **Review a PR** panel takes any PR (paste a URL or `owner/repo#number`)
so you can act on PRs that aren't from a run. From the panel you can **Approve /
Request changes / Comment** (`POST /api/pr/review`, server-side token) and — when the PR's
repo is checked out under `AGENTS_ROOT` — **Relaunch with feedback**: the agent checks out the
existing PR branch, addresses the feedback, and pushes the **same** branch so the PR updates
(no new PR, no Jira claim). GitHub reads/writes go through Helmsman (`GET /api/pr`,
`POST /api/pr/review`); the token never reaches the browser. **There is no Merge button** —
merge stays a deliberate action on GitHub, and the agent never merges.

### Direct links

Each tab has a page URL: `/helm`, `/triage`, `/todos`, `/terminal`, `/bugs`, `/prs`, `/config`, and
`/runs`. `/` opens Helm, and `/pr` is an alias for `/prs`. Links can include a pane
and the context needed to open a PR, inspect a voyage, or prepare a new voyage.

| Destination | Example URL |
| --- | --- |
| Repository's open PRs on Helm | `/helm?repo=gdcorp-partners/airo-app-builder&pane=repoprs` |
| Requested reviews | `/prs?pane=review-requests` |
| PR details and diff | `/prs?repo=gdcorp-partners/airo-app-builder&pr=10280&pane=diff` |
| Prepare a crew PR review | `/runs?repo=gdcorp-partners/airo-app-builder&pr=10280&mode=review&pane=newrun` |
| Prepare a PR relaunch | `/runs?repo=gdcorp-partners/airo-app-builder&pr=10280&mode=rerun&pane=newrun` |
| Existing voyage's log | `/runs?run=99723f3e-ff89-433a-8621-f30a48b96fd4` |
| Prepare a ticket voyage | `/helm?repo=gdcorp-partners/airo-app-builder&ticket=AIRO-123&pane=newrun` |
| Local branches and worktrees | `/config?repo=gdcorp-partners/airo-app-builder&pane=local-git` |
| Selected terminal | `/terminal?surface=surface:15&pane=screen` |

Voyage links only prefill the form; opening a link never launches an agent or submits
a review. A PR number requires its `repo=owner/name`. On Helm, `repo` selects a tracked
repository; PR and voyage links can name repositories outside the tracked list.
Malformed parameters and panes belonging to another tab are ignored.

The header, page tabs, notification center, and footer form a persistent shell across
all views. Only the page content scrolls and changes on navigation. Fleet counts
stay scoped to the selected repository; unavailable queue/review counts show an
em dash until a Jira snapshot is loaded, without fetching solely for the header.

Available panes are `newrun`, `backlog`, `underway`, `running`, `recent`, `repoprs`, `shipped`, and
`activity` on Helm; `backlog`, `todo`, and `mine` on Triage; `tabs` and `screen` on Terminal;
`review-requests`, `authored`, `lookup`, and `diff` on PRs; and `recent`, `newrun`, and
`tasks` on Voyages. Terminal contains the terminal controls, currently backed by cmux; existing `/cmux` links still work. Bugs and Config link directly to their page.

### Triage filters

Triage has one shared filter bar for all three columns. Combine the P0–P4 checkboxes
and choose tickets last updated within 30 days, 7 days, or 1 day, or select Any time.
Selections are remembered in this browser. Filtering uses loaded tickets without
additional requests; a notice appears when a column reaches Jira's 100-ticket limit.
Tickets without an update timestamp appear only under Any time.
The shared **Per column** selector shows 5, 10, 25, 50, or 100 tickets per page
(default 10) and is remembered in this browser. Each column has its own matching
count, visible range, and Previous/Next controls. Changing filters, page size, or
repository returns all columns to page 1; paging never fetches more tickets.

### Config editor

The Config tab edits supported runtime values and offers a write-only Jira token
update. See [Configuration](#configuration) for every field, its default, storage,
and restart behavior. UI customization and local Git controls are on the same page.

### Local todos

In Config → Voyage source, disable Jira to use a local backlog. The change is live
and persisted: Todos replaces the Jira-specific Triage and Bugs tabs, and Helm's
queue uses local todos. Re-enabling Jira keeps your todos and saved credentials.
Helmsman stops issuing Jira requests while disabled; already running agents keep
their original task context.

Each todo has a title, repository (`owner/name`), priority P0–P4, description,
acceptance criteria, state, timestamps, and a link to its latest voyage. Repositories
must already be cloned under `AGENTS_ROOT` as described in setup. Save title-only
drafts, then add a description to make them launchable. Use acceptance criteria for
tests, edge cases, and constraints the crew must satisfy. The list supports search,
state filters, and repository scope.

Launching atomically claims a To do item and sends its saved details to the agent.
In progress items cannot be edited or deleted. Successful voyages move to In review;
failed or stopped voyages move to Blocked. Review the output before marking Done,
or return the todo to To do to retry. No completion state automatically merges a PR.
Todo state and run links survive server restarts; interrupted claims are reconciled
against persisted voyages. Todos are stored in the same SQLite database as voyages.

### Auto-claim

The Todos tab offers opt-in auto-claim for the selected repository. The backend API
is also available for either source. Every `AUTO_CLAIM_INTERVAL_MS` a
per-repo heartbeat pulls the top backlog ticket for the repo's mapped Jira project
(`REPO_PROJECT_MAP`) and launches an agent — but only while that repo is idle, so it
never double-claims (it defers to the same single-flight gate as manual Launch). One
ticket per tick; off by default; toggling off stops further claims. With Jira disabled,
it selects described To do items by priority (P0 first), then creation order; no Jira
project mapping is required. In Jira mode, a repo needs a `REPO_PROJECT_MAP` entry.
Toggle state is held in memory
(`POST /api/repos/:repo/auto-claim {enabled}`), so it resets when Helmsman restarts.

### Agent backends

Three adapters implement the same `AgentAdapter` contract, selected by `AGENT_ADAPTER`:

- `codex` (default) runs `codex exec`. Ordinary coding voyages default to
  `gpt-6-astra` at medium effort; PR reviews use the complexity policy below.
- `claude-code` runs `claude -p --output-format stream-json` and parses tool uses,
  text, and final cost. The CLI's defaults apply unless a launch supplies tuning.
- `command` runs `AGENT_CMD` and streams each stdout line as a log event. Use
  `{ticket}`, `{repo}`, and `{title}` placeholders, for example
  `my-agent --ticket {ticket} --repo {repo}`.
  The current tokenizer splits on whitespace before and after placeholder expansion;
  quotes do not preserve spaces as one argument, including in `{title}`. Pipes,
  redirects, and shell expansion are not supported. An empty command currently
  falls back to Codex at launch.

### Caps

`AGENT_MAX_ATTEMPTS` bounds retries for existing-PR voyages; new coding voyages use
one gated workflow with the bounded review loop above. `AGENT_MAX_COST_USD` (opt-in)
stops work once reported cost reaches the cap. Pre-PR voyages aggregate reported
cost across author and reviewer sessions; Codex sessions currently provide no cost
data, so the cap cannot bound their spend. Both, and the live attempt/cost of
each run, show on the running-agent rows (`×attempt/max`, `$cost/$cap`).

### Resilience

On startup Helmsman reattaches to surviving run hosts and marks interrupted runs
failed when their host is gone. It sweeps orphaned agent worktrees under each repo's
`.worktrees/`, except failed or stopped pre-PR voyages retained for recovery. These
checks are fail-soft: a failure is logged and never blocks the server from listening.

## Configuration

The tables describe **runtime defaults when unset**, which can differ from the
example values in `.env.example`. Use positive integers for intervals, attempt limits,
and concurrency; use a positive number for an optional cost cap. Blank optional
values mean unset unless a row says otherwise.

At startup, Node loads `.env` without replacing variables already exported by the
parent shell. SQLite overrides saved through Config then take precedence over both.
Editing `.env` does not erase a saved override, including a saved empty string, and
there is currently no UI action to remove an override. Use Config to update an
already-overridden setting. Overrides, runs, watcher checkpoints, and notifications
persist in `HELMSMAN_DB`; a browser reload does not reset them.

**Live** below means editable in Config (`GET/PUT /api/config`) and used by subsequent
requests, launches, or watcher scans. Existing runs keep their launch configuration.
**Restart** means configure in `.env` or the parent environment and restart the
server; restart Vite too when changing `HELMSMAN_PORT`. Even Live keys changed in
`.env` require a restart to be loaded. The auto-claim interval is UI-editable, but its
timer length changes only after restart. Watcher enable changes saved in Config
request an immediate poll, followed by the normal five-minute interval.

### Jira

| Value | Default | Where it applies / how to set it | Change |
| --- | --- | --- | --- |
| `JIRA_ENABLED` | `true` | Config → Voyage source. Disable to use persistent local Todos for the backlog and auto-claim, without Jira requests. Saved Jira credentials remain available when re-enabled. | Live |
| `JIRA_BASE_URL` | Empty | Jira Cloud site URL, e.g. `https://your-team.atlassian.net`, without an issue/API path. Required with email and token to enable Jira. | Restart |
| `JIRA_EMAIL` | Empty | Email of the account that owns the API token. Never returned to the UI. | Restart |
| `JIRA_API_TOKEN` | Empty | Atlassian API token for that account; see setup for read/write permissions. Config accepts a replacement without revealing the existing token and stores it in SQLite. Empty token updates are rejected. | Live, write-only |
| `JIRA_PROJECT` | `AIROBUILD` | Default Jira project key. Selecting a mapped repository substitutes its project from `REPO_PROJECT_MAP`. | Live |
| `JIRA_ASSIGNEE` | `currentUser()` | Assignee for the queue, active-work, and My issues queries. Use a Jira account ID or JQL function such as `currentUser()`. | Live |
| `JIRA_JQL` | Empty | Full override of the backlog queue query, e.g. `project = PROJECT AND status = Backlog ORDER BY priority`. Also affects auto-claim; a custom query must apply its own project/assignee scope. Other panels retain their own queries. | Live |
| `BOT_ACCOUNT_ID` | Empty | Jira account ID to assign ticket voyages to. Without it, the initial bot-assignment/claim step is skipped. Free-form and PR tasks do not claim Jira tickets. | Restart |
| `JIRA_STATUS_IN_PROGRESS` | `In Progress` | Destination status when claiming a ticket; must be reachable through an available Jira transition. | Restart |
| `JIRA_STATUS_IN_REVIEW` | `In Review` | Destination status after successful ticket work reaches its review gate. | Restart |
| `JIRA_STATUS_BACKLOG` | `Backlog` | Actual Jira status for Triage's unassigned Backlog column. | Restart |
| `JIRA_STATUS_TODO` | `To Do` | Actual Jira status for Triage's unassigned To Do column; use the status name rather than a board-column label. | Restart |

The default queue JQL still uses literal `Backlog`; use `JIRA_JQL` for a different
queue status. The active-work query still uses `In Progress`, `In Review`, and `Done`.
Changing `JIRA_STATUS_*` does not rewrite those dashboard queries.

### GitHub and repository scope

| Value | Default | Where it applies / how to set it | Change |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | Empty | GitHub token used by the server for API reads and review publication. See setup for repository access and permissions. Never displayed or editable in Config. | Restart |
| `GITHUB_PR_AUTHOR` | Empty | GitHub login used for authored PRs and review requests. Both this and `GITHUB_TOKEN` must be nonempty for GitHub to be configured. | Live |
| `GITHUB_REPO` | Empty | Optional `owner/name` repository added to tracked repositories and automatic-review eligibility; also supplies the default repository label. With no repo, the label falls back to `@<author>`. | Live |
| `REPO_PROJECT_MAP` | Empty | Comma-separated `owner/name=PROJECT` pairs. Populates the repo selector, maps dashboard/auto-claim Jira scope, and permits automatic reviews for those repos. | Live |
| `GITHUB_REVIEW_WATCH_ENABLED` | `false` | Set exactly `true` to poll pending review requests for `GITHUB_PR_AUTHOR`. Existing requests can launch immediately when enabled. Requires GitHub access, configured repositories, local checkouts, and an authenticated agent CLI. | Live |

### Slack browser reader

| Value | Default | Where it applies / how to set it | Change |
| --- | --- | --- | --- |
| `SLACK_WATCH_ENABLED` | `false` | Set exactly `true` after filling the channel fields and opening signed-in Slack in cmux. No Slack app/token or Slack MCP is used. | Live |
| `SLACK_CLIENT_ID` | Empty | First identifier after `/client/` in the open Slack URL. This is the browser client/workspace identifier, not an OAuth app client ID. | Live |
| `SLACK_CHANNEL_ID` | Empty | Channel identifier beginning with `C`, from the Slack channel URL. Must match the channel being watched. | Live |
| `SLACK_CHANNEL_NAME` | Empty | Channel name without `#`, using lowercase letters, digits, `_`, or `-`; used to scope Slack search. | Live |
| `SLACK_BROWSER_SURFACE` | Empty | Optional cmux browser reference, e.g. `surface:24` or its UUID. Leave empty to discover the matching signed-in Slack tab. Useful when multiple tabs match. | Live |

Slack text fields are blank by default and the watcher is off. See
[Automatic PR reviews](#automatic-pr-reviews) for first-time browser setup and triggers.

### Requesting reviews in Slack

Your open PRs have a **Request review in Slack** button, also available in an owned
open PR's details. It posts the canonical PR link and mentions the configured Slack
user group. Sending is manual; the button reports delivery or an actionable error
and links to the message when Slack provides a permalink.

In **Config → Slack review requests**, set the destination channel and review group.
Defaults are `airo-editing` and `airo-editing-squad`. Names or Slack IDs are accepted;
private channels require their channel ID. Install a Slack app with `chat:write`,
`channels:read`, and `usergroups:read` scopes (`groups:read` for private channels),
invite its bot to the destination, and save its bot token in the write-only field.
The outbound sender uses Slack's official API and is independent of the browser reader.

| Value | Default | Purpose |
| --- | --- | --- |
| `SLACK_REVIEW_CHANNEL` | `airo-editing` | Destination channel name or ID; live-editable. |
| `SLACK_REVIEW_MENTION` | `airo-editing-squad` | User group handle or ID; resolved to an actual Slack mention. |
| `SLACK_BOT_TOKEN` | Empty | Slack bot token; Config stores it in SQLite and never returns its value. |

The server verifies that the PR is open and authored by the configured GitHub user.
Persisted request receipts prevent repeated delivery for the same request ID, and a
short per-PR cooldown protects against double-clicks and concurrent tabs. If delivery
cannot be confirmed, check Slack before attempting another request.

### Agent execution and server storage

| Value | Default | Where it applies / how to set it | Change |
| --- | --- | --- | --- |
| `AGENT_ADAPTER` | `codex` | `codex`, `claude-code`, or `command`; install/sign in to that CLI on the server machine. Unknown values fall back to Codex. | Live |
| `AGENT_CMD` | Empty | Executable and argument template for the command adapter; see [Agent backends](#agent-backends). Does not invoke a shell. | Live |
| `AGENT_MAX_ATTEMPTS` | `1` | Total attempts for existing-PR voyages, including the initial attempt; `1` means no retry. New coding voyages use one workflow, with review rounds controlled by `PRE_PR_MAX_ROUNDS`. | Live |
| `AGENT_MAX_COST_USD` | Empty (no cap) | Cost limit in USD across attempts, enforced when the adapter reports cost. It cannot bound spend for adapters that do not report cost, including the current Codex and command adapters. | Live |
| `PRE_PR_REVIEWER_COUNT` | `2` | Integer `1`–`2`. Independent reviewer sessions per round: `1` uses the writer's CLI, `2` adds the other supported CLI if installed. Only Codex and Claude Code are supported. One installed CLI means one reviewer; an installed reviewer that fails blocks publication. Set in **Config → Pre-PR review**. | Live; new voyages only |
| `PRE_PR_MAX_ROUNDS` | `3` | Integer `1`–`5`. Total review rounds, including the initial round. `3` permits up to two fix-and-review cycles; `1` permits none. Every reviewer must approve the final commit; unresolved findings block publication when rounds are exhausted. | Live; new voyages only |
| `PRE_PR_STAGE_TIMEOUT_MINUTES` | `45` | Integer `5`–`180`. Timeout for each implementation, fix, or reviewer session, not the whole voyage. Timeout blocks publication and preserves the author worktree. | Live; new voyages only |
| `AGENT_MAX_CONCURRENCY` | `3` | Maximum simultaneous runs across repositories. The separate one-run-per-repository limit still applies. | Restart |
| `AUTO_CLAIM_INTERVAL_MS` | `60000` | Interval in milliseconds for the optional ticket auto-claim scheduler. Does not enable auto-claim or control either PR watcher. | Config-editable; restart timer |
| `AGENTS_ROOT` | Server working directory | Parent directory of target repo checkouts, e.g. `/absolute/path/to/agent-repos`; not the path to a single checkout. | Restart |
| `RUNS_DIR` | `<AGENTS_ROOT>/.helmsman-runs` | Directory for detached-run specifications, logs, and exit records. Created on startup; use a writable absolute path. | Restart |
| `RUN_HOST` | Detached process | Set `cmux` to prefer new cmux workspaces for runs. Falls back to detached processes when cmux is unavailable. Slack reading can use cmux regardless of this setting. | Restart |
| `HELMSMAN_DB` | `<server working directory>/.helmsman.sqlite` | SQLite file for runs, config overrides, watcher state, and notifications. Use a writable path and retain it across restarts. A Config-saved Jira token is stored here, so treat this file as sensitive. | Restart |
| `HELMSMAN_PORT` | `8787` | Local API/static-server port, bound to `127.0.0.1`; the Vite API proxy uses the same value. | Restart server and Vite |

### Browser preferences

Config's **UI customization → Theme** selector applies immediately and persists in
that browser's local storage (default: Amber). The selected repository, dashboard
panel layout/stacking, and collapsed panels also persist locally. These preferences
have no `.env` keys, do not change server behavior, and are not shared with another
browser. Per-voyage model/effort choices belong to the launch form; there are no
global model/effort environment variables in the app's config parser.

Dark presets include Quarterdeck (sea blue/wood brown/brass), Abyss (navy/cyan), Forest (green/mint), Ember (brown/coral),
Aubergine (wine/rose), Graphite (near-black/white), and Phosphor (black/lime).
Themes color the full interface, including panels, text, and scrollbars.
The selected theme's palette and sample status chips appear below the selector,
updating immediately so you can compare surface, text, and status colors.
Page panels use the full content width or two equal columns, stacking on smaller screens.

Helm's **Mine · underway** panel mirrors your unfinished Jira tickets from Triage.
Select a repository to enable each ticket's **Launch** button. These tickets are
separate from the active agent voyages in **Active crew**. The ticket query shares
a five-minute cache with Triage; an unavailable Jira response shows no sample tickets.

> **Security:** Codex uses `--dangerously-bypass-approvals-and-sandbox`; Claude Code uses
> `--dangerously-skip-permissions`. Coding agents can edit,
> commit, and open a PR with full, unattended tool access on the host — a per-run git
> worktree is a working directory, not a sandbox (it shares the repo's git object store and
> the agent has the same host, shell, and filesystem access as the Helmsman process).
> The default detached host inherits `GITHUB_TOKEN` and removes `JIRA_API_TOKEN` and
> `JIRA_EMAIL` from the child environment; cmux workspaces use their own terminal environment.
> Helmsman makes Jira writes itself. Only point `AGENTS_ROOT` at repos,
> and only launch tickets, you're willing to let an autonomous agent modify on this machine.

### Degraded mode

With `.env` present but credentials missing or invalid, Helmsman falls back per-source to
`src/data/mock.ts` for whichever of Jira/GitHub it couldn't reach, and the response's
`degraded` array names which sources are mocked (e.g. `["jira","github"]` with neither integration configured).
The dashboard renders a banner naming the degraded sources so it never shows fake data as
real.

The Config tab’s Local branches & worktrees card reads the selected repository’s
configured checkout under `AGENTS_ROOT`. It shows the checkout path, local branches
and upstreams, and registered worktrees. Refresh stays local. Check remotes explicitly
fetches and prunes remote-tracking branches so deleted upstreams can be identified;
it does not prune local branches or tags.

Delete branch and Delete worktree require confirmation of the named target. Unmerged
branch deletion requires an additional explicit checkbox. Current/default branches,
primary/locked/active worktrees, changed commits, and mismatched checkouts are
protected. Worktrees containing uncommitted, untracked, or ignored files cannot be
removed through this control. No cleanup runs automatically.

**Clean up branches** previews local branches with no configured upstream or a deleted
upstream. By default, only branches already merged into the current HEAD are eligible.
Select **Include unmerged branches** to also remove branches with unmerged commits;
the preview warns before this destructive option is confirmed. The preview
lists each candidate and explains protected skips; confirmation deletes
the exact reviewed names and commits atomically. Any changed branch or HEAD requires a
new preview. Use **Check remotes** first to refresh deleted-upstream information.
Current, default, and checked-out branches remain protected in either mode.

`GET /api/usage/external` exposes actual server HTTP request counts by service,
including lifetime and rolling five-minute totals, errors, and rate-limit responses.
Counters exclude cache hits and local requests, reset on server restart, and retain
no credentials or request bodies. Slack browser traffic, Git subprocesses, and
review-agent/model traffic are separate and are not counted by this endpoint.

## Automatic PR reviews

Helmsman can discover PRs every five minutes from two sources:

- Slack: full GitHub PR URLs posted in one configured channel, including thread replies. No mention or review wording is required. Each source message/PR pair runs once; posting the URL again is a new trigger. History before activation is ignored.
- GitHub: pending requests for `GITHUB_PR_AUTHOR`, once per repository/PR/head SHA. Existing pending requests are eligible when enabled; a new revision can trigger another review. A running or successful review of that revision can satisfy the request.

Both sources persist their queues and notifications in the Helmsman SQLite database. The header notification bell shows source health, queued/started/failed/blocked reviews, links to the source and run, and the selected model/effort. Marking a notification read persists across reloads and restarts. Existing concurrency limits apply; repositories must be configured in `GITHUB_REPO` or `REPO_PROJECT_MAP`. Requests for unconfigured repositories remain visible as blocked.

Both watchers start disabled. For Slack, install/open cmux with its `cmux` command
available to Helmsman, and open Slack in a **cmux browser tab**. Sign in and navigate
to the one channel you want to watch. Its URL has this shape:

```text
https://app.slack.com/client/<client-id>/<channel-id>
```

Copy those two identifiers into `SLACK_CLIENT_ID` and `SLACK_CHANNEL_ID`, and set
`SLACK_CHANNEL_NAME` to the channel name without `#`. Fill and save those fields
before enabling the watcher. A normal browser tab outside cmux is not discoverable.
Leave `SLACK_BROWSER_SURFACE` empty unless you need to pin a particular tab; use
`cmux tree --json` to find that browser's `surface_ref` when needed.

The initial `.env` values are deliberately empty/disabled:

```dotenv
SLACK_WATCH_ENABLED=false
SLACK_CLIENT_ID=
SLACK_CHANNEL_ID=
SLACK_CHANNEL_NAME=
SLACK_BROWSER_SURFACE=
GITHUB_REVIEW_WATCH_ENABLED=false
```

After checking the channel values, GitHub configuration, and local checkout, set
`SLACK_WATCH_ENABLED=true` in Config and check the notification bell's source health.
Only new Slack history after activation is eligible; a full URL such as
`https://github.com/your-org/your-repo/pull/123` is a trigger. For GitHub-only discovery,
set `GITHUB_REVIEW_WATCH_ENABLED=true`; no Slack fields or browser are needed. This
can immediately launch reviews for existing pending requests. Automatic reviews
publish their findings to GitHub, so enable a source only when ready for that behavior.

Keep one signed-in Slack browser tab open in cmux for the configured channel/client. The reader discovers that tab on each scan; set `SLACK_BROWSER_SURFACE` only when multiple matching tabs exist. It briefly selects its Slack browser tab and restores the previous tab and focus unless the user changes them during the scan. It uses browser UI searches and rendered message anchors, without Slack MCP or extracted session tokens. Browser closure, sign-out, or incomplete search results appear in source health. Catch-up resumes from the last successful scan with an overlapping search window. Five minutes is a target while the machine, browser, and server are running; Slack search indexing may add delay. Reading Slack views can affect unread state.

Review model selection defaults to these tiers for Codex:

| Complexity | Model | Effort | Signals |
| --- | --- | --- | --- |
| Low | `gpt-5.6-terra` | low | Default, including large changes confined to one area or unavailable scope |
| Medium | `gpt-5.6-sol` | medium | More than 5 files or 300 changed lines, spanning multiple areas |
| High | `gpt-6-astra` | high | Explicit selection for serious architecture changes; never selected automatically |

Automatic routing is limited to low and medium. File size, sensitive paths, and unavailable diffs do not trigger high effort. Claude Code uses Sonnet for low/medium and Opus for high; the command adapter keeps its own model behavior. Explicit selections in PR controls override automatic tuning. The assessed revision, model, effort, complexity, and reason are saved with the run; review checkouts are pinned to that revision.

Reviewers reserve request-changes recommendations for demonstrated material logic,
structural/integration defects, or missed explicit acceptance criteria. They omit
standalone test/doc/style suggestions and speculative hardening. A lead delegates
applicable logic, acceptance/tests, UX, and external-effects scopes, then verifies
and deduplicates findings. Codex review runs enable multi-agent support and require
an installed `$review-agent` skill for each read-only leaf reviewer. The lead alone
writes the output files. Missing required skills or delegation tools produce a
COMMENT limitation. Low effort remains the default for scoped workers; high effort
is reserved for serious architecture changes. See the [five-review calibration
audit](docs/reviewer-calibration-2026-09-17.md) for examples and rationale.

Reviews prefer inline findings on the relevant diff lines, with concrete fixes when supported by the code. Exact replacements use GitHub suggestion blocks; broader changes use code examples. The agent writes a concise summary to `.agent-review.md` and a JSON array of inline findings to `.agent-review-comments.json`. Helmsman validates the anchors against the reviewed revision and submits the summary and inline findings together as one COMMENT review. Findings that cannot be safely anchored remain in the summary. If the PR head changed, inline publication fails rather than attaching stale findings to new code. Existing summary-only output remains supported. Reviews do not push code or approve/merge PRs.

Model roles and effort guidance: [official OpenAI model documentation](https://developers.openai.com/codex/models/). Model availability depends on the account/provider.
