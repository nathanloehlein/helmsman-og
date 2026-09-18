# Bug View — design

Date: 2026-09-15
Status: approved (direction), pending spec review

## Problem / motivation

Helmsman already surfaces backlog/triage tickets and PRs, but has no
operational read on **bug health per project**. The reference is GoDaddy's
"Airo Opsignal → Bug View": a per-squad card showing open-bug counts, SLA
breaches, aging, and a resolution-time percentile, plus a table of open bugs
with Priority / Severity / SLA. This spec adds an equivalent **BUGS** page
tab driven by our own Jira (AIROBUILD and any other mapped project).

## Data semantics (grounded in our Jira, not assumed)

Confirmed by querying a live AIROBUILD Bug (`AIROBUILD-6434`) with Helmsman's Jira creds:

- **Issue type**: `Bug`.
- **Priority**: `priority.name` → e.g. `"P2 - Medium"`.
- **Severity**: `customfield_14808.value` → e.g. `"S2 - Medium"`.
- **SLA date**: `duedate` (e.g. `2026-09-29`). SLA label = `duedate − today`:
  `duedate < today` → "Past SLA by Nd" (overdue); else "SLA in Nd".
  `duedate` null → "—" (no SLA), sorted last.
- **Resolution time** (for percentile): `resolutiondate − created`.
- **Open**: `statusCategory != Done`. **Completed/resolved**:
  `statusCategory = Done` with a `resolutiondate`.

No per-priority SLA policy is invented — Jira's `duedate` is the SLA source.

## Product decisions

- **Delta** ("Open 20 (+4 vs prior)"): **net = createdLast7d − completedLast7d**.
  No historical open-count snapshot store (rejected as heavier persistence for
  little gain). Rendered as `+N` / `−N` / `±0`.
- **Scope**: reuse the existing repo-scope selector. Scoped → that project's
  single card. "All repos" → one card per mapped project (`repoProjectMap`),
  matching the reference's squad card.
- **Windows**: rolling 7d "latest" and preceding 7d "previous" (labels only,
  Pacific-style display of the generated instant). P75 over a **90d** window.
- **Table columns**: Key, Title, Priority, Severity, SLA. Sort: priority rank
  ascending (parse leading `P<n>` from `"P1 - High"`), then overdue-first, then
  `duedate` ascending, then key.

## Architecture

Two processes unchanged. New read-only endpoint + new page-tab view. All
metric math is pure and unit-tested; I/O stays in jira.ts/endpoint.

### Server

`server/jira.ts` (extend):
- `FIELDS_BUG = 'summary,status,priority,duedate,resolutiondate,created,customfield_14808'`.
- `buildOpenBugsJql(project)` → `project=<P> AND issuetype=Bug AND statusCategory != Done ORDER BY priority ASC, duedate ASC`.
- `buildCreatedSinceJql(project, days)` / `buildResolvedSinceJql(project, days)` →
  `... AND issuetype=Bug AND created >= -<d>d` etc.
- `fetchOpenBugs(jira, project)` → `JiraIssue[]` (cap 100).
- `fetchBugCount(jira, jql)` → number (search `maxResults=0`, read `total`).
- `fetchResolvedDurations(jira, project, days)` → `number[]` of resolution days
  (cap 100; also return `total` so the card can flag a cap).

Severity read helper tolerates the field being absent/null.

`server/bugs-endpoint.ts` (new): `buildBugsResponse(env, now, deps?, repo?)`.
- Resolve target projects from `repoProjectMap` (all, or the one matching `repo`).
- Per project, `Promise.allSettled` the open-bugs fetch + the three counts +
  durations; a rejected project yields a `degraded` card (empty rows, counts
  null) rather than failing the whole response.
- Assemble each `BugCard` via the pure metrics module.
- Jira absent → `{ cards: [], degraded: true }`.

`server/helmsman/main.ts`: add `GET /api/bugs?repo=` wired to
`buildBugsResponse(configStore.effectiveEnv(), new Date(), undefined, repo)`,
plus a `bugs` dep in the router (mirrors `triage`).

### Pure metrics — `src/logic/bugMetrics.ts`

- `priorityRank(name)` → number (`"P1 - High"` → 1; unknown → large).
- `ageDays(fromIso, now)` / `daysBetween`.
- `slaLabel(duedate|null, now)` → `{ text, overdue, days|null }`.
- `percentile(values, p)` → number|null (linear interpolation; empty → null).
- `sortBugs(rows)` → priority rank, then overdue, then duedate, then key.
- `bugRow(issue)` → `BugRow` (extracts priority/severity/sla/title/key).
- `bugCard(project, repo, label, issues, counts, durations, jiraBaseUrl, now)` →
  `BugCard` (open, delta, completed, pastSla, oldest, p75, rows).

### Types — `src/types.ts`

```
interface BugSla { text: string; overdue: boolean }
interface BugRow { key: string; title: string; priority: string; severity: string; sla: BugSla }
interface BugOldest { key: string; ageDays: number }
interface BugP75 { days: number | null; n: number; capped: boolean }
interface BugCard {
  project: string; repo: string | null; label: string;
  open: number; delta: number; completed: number; pastSla: number;
  oldest: BugOldest | null; p75: BugP75; rows: BugRow[];
  degraded: boolean; jiraBaseUrl: string | null;
}
interface BugsResponse {
  cards: BugCard[]; degraded: boolean;
  generatedAt: string; latestWindow: string; previousWindow: string;
}
```

### Frontend

`src/data/bugs.ts`: `fetchBugs(repo)` → `BugsResponse` (fail-soft to
`{ cards: [], degraded: true, ... }`, like `fetchTriage`).

`src/render.ts`: `renderBugsView(res, opts)`:
- Bench head with `active: 'bugs'` (adds a BUGS tab to `renderBenchHead`).
- Window strip: LATEST 7d / PREVIOUS 7d / "Generated <ts>".
- Degraded banner when `res.degraded`.
- Per card `.bug-card`: header (`<label>` chip + `N Open bugs`), stat row
  (Open `+Δ`, Completed, Past SLA, Oldest open key-link + age, `P75 · <days> · n=<n>`),
  table (Key ticket-link, Title, Priority chip, Severity chip, SLA chip),
  "View all in Jira" link (project search URL).
- Chips reuse `.chip-*`; P1 gets an emphasized class; overdue SLA → `chip-blocked`
  (red), future SLA → neutral. Empty card → empty-note row.

`src/main.ts`: `view` union `+= 'bugs'`; `bugsResponse` state; `enterBugsView`
(load + paint), `paintBugs` (`innerHTML = renderBugsView(...)` + `bindHeadControls`);
`.view-toggle[data-view="bugs"]` branch; repo-scope change re-loads bugs when in
bugs view (mirror triage).

### Chip / color rules

Stay in the design system (DESIGN.md). Reuse existing chip classes. Add only:
`.chip-p1` (amber emphasis to match the reference's P1 outline) if no existing
class fits. Overdue SLA uses the existing `chip-blocked`. No new signal hues.

## Testing

- `bugMetrics.test.ts`: `priorityRank`, `slaLabel` boundaries (overdue, future,
  **due today = SLA in 0d, not overdue**, null → "—"), `percentile` (incl empty,
  single, interpolation), `sortBugs` ordering, `bugCard` assembly (delta sign,
  oldest, pastSla count).
- `jira.test.ts`: new JQL builders (project interpolation, issuetype=Bug,
  statusCategory clause, created/resolved windows).
- `bugs-endpoint.test.ts`: assembles a card from mocked deps; one project
  rejects → that card `degraded`, others fine; scope filter selects one project;
  jira absent → `degraded: true, cards: []`.
- `render.test.ts`: `renderBugsView` emits a card per input, rows with all four
  chips + key link, overdue vs future SLA class, empty-card note, degraded banner,
  BUGS tab present; escapes malicious titles.
- `main.test.ts`: clicking the BUGS tab loads `/api/bugs` and renders cards;
  scope change re-fetches.

## Failure modes / edge cases

- `duedate` null → "—", sorted last, not counted in `pastSla`.
- `customfield_14808` absent → severity "—".
- Resolved set > 100 → P75 on the first 100, `capped: true` (label shows `n=100+`).
- Priority string not matching `P<n>` → rank last.
- Project with zero bugs → card renders with zeroed stats + empty table.
- Jira reachable but one project's query fails → only that card degrades.

## Out of scope (YAGNI)

Historical open-count snapshots; per-card collapse (can reuse the new
`surface-collapse` mechanism later); pagination past 100; priority/severity
filter controls; CSV/export; the reference's other tabs (Signal, Agent Health,
Incident & Change, Vulnerability).
