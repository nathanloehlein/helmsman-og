# Backlog Runner

A control plane for Jira-backlog-driven coding agents. Launch a CLI agent against a
ticket, watch it work live (explore → implement → test → open a PR), and keep a human
approval gate before anything merges — running multiple agents across repos, one at a
time per repo. The dashboard (backlog queue, current run, activity feed, shipped PRs)
is the view; the **orchestrator** behind it spawns and supervises the agents.

## Status

- **Built (P0–P4):** the orchestrator, SQLite run store, dashboard API, and a
  Claude Code agent adapter — launch a ticket, run it in an isolated git worktree,
  stream its events to a live log drawer, and record the run (P0–P1); Jira status
  writes with an In-Review gate (P2); a multi-agent running view with per-run stop
  and live logs (P3); and an opt-in per-repo auto-claim scheduler (P4). The agent
  opens a PR and **never merges**.
- **Planned:** a generic-command adapter + hardening (P5). See `docs/superpowers/plans/`.

## Stack

TypeScript (strict). A **Vite** front end (pure logic in `src/logic/`, unit-tested with
Vitest; `src/render.ts` owns the DOM) plus a persistent **Node orchestrator**
(`server/orchestrator/`, `node:http` + `node:child_process`) that serves the API, owns a
**SQLite** run store (better-sqlite3), and spawns agents in per-run git worktrees. No
runtime framework.

## Data

`GET /api/dashboard` is served by the **orchestrator** (`server/orchestrator/`), which
queries Jira + GitHub and assembles a `DashboardSnapshot`; in dev, Vite proxies `/api`
to it. `src/data/mock.ts` is the server-side fallback payload the endpoint substitutes
per-source when a live source can't be reached (see [Degraded mode](#degraded-mode)).

## Commands

```bash
npm install
npm run dev          # orchestrator (:8787) + Vite dev server (proxies /api)
npm run orchestrator # orchestrator only
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

## Setup

1. `cp .env.example .env`
2. Fill in `.env`:
   - `JIRA_API_TOKEN` — an [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens)
     for the `JIRA_EMAIL` account
   - `GITHUB_TOKEN` — a GitHub PAT with read access to your repos
   - `AGENTS_ROOT` — a local directory holding a checkout of each repo agents work in
     (the orchestrator creates a git worktree per run under `<AGENTS_ROOT>/<repo>`)
3. `npm run dev`, then open the printed Vite URL.

The client (`src/main.ts`) calls `loadDashboard()` from `src/data/live.ts` on load and
every 30s (`POLL_MS`), re-rendering in place; a transient poll failure keeps the last
good render.

## Running agents

Click **Launch** on a backlog ticket (or `POST /api/agents/launch {ticketId,title,repo}`).
The orchestrator creates a git worktree under `AGENTS_ROOT`, spawns a Claude Code agent
(`claude -p --output-format stream-json`) in it, streams the agent's events to a live log
drawer over SSE (`GET /api/agents/:id/log`), records the run in SQLite, and removes the
worktree when it finishes. `POST /api/agents/:id/stop` SIGTERMs a run. One run per repo at
a time; global concurrency is capped by `AGENT_MAX_CONCURRENCY`. The agent opens a PR and
never merges — the human review gate is real.

### Auto-claim

Scope the dashboard to a single repo and flip the **Auto-claim** toggle to let the
orchestrator work that repo's backlog unattended. Every `AUTO_CLAIM_INTERVAL_MS` a
per-repo heartbeat pulls the top backlog ticket for the repo's mapped Jira project
(`REPO_PROJECT_MAP`) and launches an agent — but only while that repo is idle, so it
never double-claims (it defers to the same single-flight gate as manual Launch). One
ticket per tick; off by default; toggling off stops further claims. A repo with no
`REPO_PROJECT_MAP` entry can't be auto-claimed. Toggle state is held in memory
(`POST /api/repos/:repo/auto-claim {enabled}`), so it resets when the orchestrator restarts.

## Configuration

| Var | Purpose |
| --- | --- |
| `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` | Jira Cloud REST auth (read) |
| `JIRA_PROJECT` / `JIRA_ASSIGNEE` / `JIRA_JQL` | queue scope (JQL, or project+assignee) |
| `GITHUB_TOKEN` / `GITHUB_PR_AUTHOR` / `GITHUB_REPO` | GitHub auth + shipped-PR/label defaults |
| `REPO_PROJECT_MAP` | `repo=JIRA_PROJECT` pairs; the repo selector re-scopes the whole dashboard |
| `AGENTS_ROOT` | directory of per-repo checkouts the orchestrator worktrees from |
| `ORCHESTRATOR_PORT` | orchestrator port (default `8787`) |
| `AGENT_MAX_CONCURRENCY` | max simultaneous runs (default `3`) |
| `AUTO_CLAIM_INTERVAL_MS` | auto-claim heartbeat interval in ms (default `60000`) |

> **Security:** the agent is spawned with `--dangerously-skip-permissions`, so it edits,
> commits, and opens a PR with full, unattended tool access on the host — a per-run git
> worktree is a working directory, not a sandbox (it shares the repo's git object store and
> the agent has the same host, shell, and filesystem access as the orchestrator process).
> It inherits `GITHUB_TOKEN` to open its PR; `JIRA_API_TOKEN` and `JIRA_EMAIL` are withheld
> since the orchestrator makes all Jira writes itself. Only point `AGENTS_ROOT` at repos,
> and only launch tickets, you're willing to let an autonomous agent modify on this machine.

### Degraded mode

If `.env` is missing or a token is invalid, the orchestrator falls back per-source to
`src/data/mock.ts` for whichever of Jira/GitHub it couldn't reach, and the response's
`degraded` array names which sources are mocked (e.g. `["jira","github"]` with no `.env`).
The dashboard renders a banner naming the degraded sources so it never shows fake data as
real.
