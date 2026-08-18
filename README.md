# Backlog Runner

This repo ships a live agent dashboard — run `npm run dev` and it renders in the
browser (mock data for now).

Dashboard prototype for a Jira-backlog-driven coding agent: current task, priority
queue, PR history, and a live activity feed. Built to visualize the "agent claims
a ticket, implements it, opens a PR, picks the next one" loop with a human
approval gate before merge.

## Stack

TypeScript (strict) + Vite, no runtime framework. Logic (`src/logic/`) is pure and
unit-tested with Vitest; `src/render.ts` is the only thing that touches the DOM.

## Data

`src/data/mock.ts` is the seam. It returns a `DashboardSnapshot` from static mock
data today — swap its implementation for real calls against the Jira and GitHub
REST APIs and the rest of the app is unchanged.

## Commands

```bash
npm install
npm run dev      # dev server
npm run build    # production build to dist/
npm test         # vitest
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

### Wiring this dashboard to the real thing

`src/data/mock.ts` is the seam — replace `loadDashboard()` with real calls and
nothing else in the app changes:

- **Queue panel** ← Jira JQL, filtered `assignee = bot AND status = Backlog`
- **Working-on panel** ← the agent's own current-ticket state + step log
- **Shipped panel** ← GitHub PR list, filtered by branch prefix or label
- **Activity feed** ← the agent's structured log output, tailed

Cheapest real version: a small read-only page polling the Jira and GitHub
REST APIs on an interval (30s is plenty) — no new state store, because Jira
and GitHub already are the state. Only reach for a websocket push or a
dedicated DB if you need updates faster than a poll can deliver.
