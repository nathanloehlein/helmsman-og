# Backlog Runner — Live Jira + GitHub wiring

**Date:** 2026-08-16
**Status:** Approved design

## Goal

Replace the static `loadDashboard()` mock (`src/data/mock.ts`) with real data from
the Jira and GitHub REST APIs, keeping the `DashboardSnapshot` shape as the seam so
the pure logic (`src/logic/`) and view (`src/render.ts`) are essentially unchanged.

The dashboard becomes a read-only page that polls a local `/api/dashboard` endpoint
every 30 seconds. Tokens live server-side only; nothing secret ships in the browser
bundle.

## Constraints that shaped the design

- **Browser cannot call Jira Cloud directly** — CORS blocks cross-origin requests to
  `*.atlassian.net`.
- **Browser cannot hold API tokens** — anything in the client bundle is public. Jira
  basic-auth credentials and the GitHub token must stay server-side.
- **Three snapshot fields have no Jira/GitHub source.** `steps` and `activity` come
  from "the agent's own structured log" (per the README) which does not exist as a
  data source here; `stats.tokensSpent` and `stats.estCostUsd` are LLM accounting that
  lives in neither API. Resolution: synthesize `steps`/`activity` from Jira changelog +
  GitHub PR events (real, derivable), and **drop** the token/cost fields entirely.

## Architecture

A small server-side fetch layer, exposed to the browser as one JSON endpoint via a
Vite dev-server plugin. The browser polls it.

```
src/data/mock.ts          kept — the fallback payload used in degraded mode
src/data/live.ts          loadDashboard(): fetch('/api/dashboard'); 30s poll from main.ts
server/config.ts          parse + validate env; report which sources are configured
server/jira.ts            JQL search + issue changelog (Jira Cloud REST v3, basic auth)
server/github.ts          PR list by author (GitHub REST v3)
server/snapshot.ts        pure assemblers: raw API shapes -> DashboardSnapshot
vite-plugin-dashboard.ts  dev-only configureServer middleware serving GET /api/dashboard
```

- `main.ts` calls `loadDashboard()`, renders, then re-polls every 30s with a fresh
  `new Date()` so relative times stay current.
- `server/snapshot.ts` holds no I/O — it takes already-fetched raw Jira/GitHub payloads
  and returns a `DashboardSnapshot`. This is the unit-tested seam and the piece a future
  serverless deploy handler reuses. Fetching (`jira.ts`, `github.ts`) is isolated from
  assembling (`snapshot.ts`).
- The Vite plugin is the only place that wires env → fetch → assemble → HTTP response.
  Deploying for real later means calling the same `snapshot.ts` from a serverless
  function; that is out of scope for this change.

## Data mapping

| Snapshot field | Source | Notes |
| --- | --- | --- |
| `repo` | `GITHUB_REPO` env | display string |
| `queue` | Jira `JIRA_JQL` | default `project = <JIRA_PROJECT> AND assignee = <JIRA_ASSIGNEE> AND status = Backlog ORDER BY priority` |
| `currentTicket` | Jira, same JQL base with `status = "In Progress"` | first match; if none, a synthetic idle ticket |
| `steps` | changelog of `currentTicket` + its linked PR status | status transitions + "opened PR #N" become steps; last is `active` if ticket still In Progress |
| `shipped` | GitHub PRs authored by `GITHUB_PR_AUTHOR` in `GITHUB_REPO` | ticket id parsed from PR title or head branch (`/[A-Z]+-\d+/`); PR state → `PrStatus` |
| `activity` | merge(Jira changelog transitions, GitHub PR opened/merged/review events) | sorted newest-first; `accent` on status transitions + merges |
| `stats.completedToday` | Jira count `status = Done` resolved today | |
| `stats.awaitingReview` | Jira count `status = "In Review"` | |
| `stats.avgCycleMinutes` | mean(Done timestamp − In Progress timestamp) from changelog | over recently-Done tickets; 0 if none |
| `throughput7d` | Jira Done-per-day for the last 7 days | array length 7, oldest→newest |

### Priority mapping

Jira priority name → `Priority`:
- starts with `P1` / equals `Highest` or `High` → `P1`
- starts with `P2` / equals `Medium` → `P2`
- starts with `P3` / equals `Low` or `Lowest` → `P3`
- anything else → `P3` (safe default)

### Status mapping

Jira status category / name → `TicketStatus`: `Backlog`/`To Do` → `backlog`,
`In Progress` → `in-progress`, `In Review` → `in-review`, `Done` → `done`.
GitHub PR → `PrStatus`: merged → `merged`, `CHANGES_REQUESTED` review → `changes-requested`,
otherwise `in-review`.

## Type change

`DailyStats` loses `tokensSpent` and `estCostUsd`:

```ts
export interface DailyStats {
  completedToday: number;
  awaitingReview: number;
  avgCycleMinutes: number;
}
```

`render.ts` drops the two corresponding `stat-row`s ("Tokens spent", "Est. cost"). The
`mock.ts` `STATS` constant drops those keys. No other view change.

## Secrets / config

`.env` is gitignored; a committed `.env.example` documents every var. All read only in
`server/config.ts`, never imported from `src/`.

```
JIRA_BASE_URL        e.g. https://godaddy-corp.atlassian.net
JIRA_EMAIL           account email for basic auth
JIRA_API_TOKEN       Atlassian API token
JIRA_PROJECT         default AIROBUILD
JIRA_ASSIGNEE        default the operator's accountId or email
JIRA_JQL             optional full override of the queue JQL
GITHUB_TOKEN         PAT with repo read (pull request read)
GITHUB_REPO          owner/name, e.g. nathanloehlein/backlog-runner
GITHUB_PR_AUTHOR     GitHub login whose PRs count as "the agent's"
```

## Error handling

The endpoint never fails the page:

- Missing/invalid credentials → return the `mock.ts` payload with a `degraded: true`
  marker; the UI shows a subtle "showing sample data" banner.
- Per-source `try/catch`: a Jira outage must not blank the GitHub panel and vice-versa;
  a failed source falls back to its slice of the mock payload and contributes a
  `degraded` reason.
- Browser poll failure → keep the last-good snapshot on screen; do not clear the UI.

## Testing

Pure assemblers in `server/snapshot.ts` are unit-tested with Vitest against static
fixtures (captured raw Jira/GitHub JSON) — no network in tests, matching the existing
`src/logic/*.test.ts` style:

- priority-name → `Priority` mapping (incl. the default branch)
- ticket-id parse from PR title and from head branch, and the no-match case
- Jira changelog → `activity` ordering and `accent` rules
- GitHub PR → `ShippedPr` (each `PrStatus`)
- avg-cycle / throughput math on a fixed changelog fixture

`server/jira.ts` and `server/github.ts` (thin fetch wrappers) are not unit-tested;
they hold no logic beyond request construction.

## Out of scope

- Production deploy target (serverless fn / hosting). The `snapshot.ts` seam is built
  to be reused there, but wiring it is a later change.
- Writing to Jira or GitHub. This dashboard is read-only; the agent it watches is what
  transitions tickets and opens PRs.
- Websocket / push updates. A 30s poll is sufficient per the README.

## Tie-in (post-merge of the build)

After the code is built and tests are green:

1. Create a Jira tracking ticket describing this work (project TBD with the user).
2. Open a PR on `nathanloehlein/backlog-runner` that links the ticket.

Both are external side effects and require explicit user consent before execution.
