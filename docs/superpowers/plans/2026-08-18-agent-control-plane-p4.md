# Agent Control Plane — Phase 4 (Auto-Claim Scheduler) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an opt-in, per-repo **auto-claim** loop: when enabled for a repo, a heartbeat pulls that repo's top backlog ticket and launches an agent for it — single-flight per repo (never while a run is active for that repo), one ticket per tick. A per-repo toggle in the UI turns it on/off. Off by default; manual Launch is unchanged.

**Architecture:** An `AutoClaimScheduler` holds the set of enabled repos and, each tick, for each enabled repo that is idle (`ProcessManager.canStart`), fetches the top backlog ticket for that repo's mapped Jira project and calls the existing `launch`. All I/O is injected so the scheduler is unit-tested. A `POST /api/repos/:repo/auto-claim` toggle mutates the enabled set; the enabled set is exposed for the UI. Builds on P0–P3. Spec: `docs/superpowers/specs/2026-08-18-agent-control-plane-design.md`.

**Tech Stack:** TypeScript (strict), Vitest, Node built-ins, better-sqlite3. No new deps.

## Global Constraints

- TS strict; explicit annotations; no `any`; no inline comments (JSDoc above `export` ok).
- No new deps. Tests do no network/spawn/timers-for-real — inject fakes; drive the scheduler tick directly (no real `setInterval` in tests).
- Single-flight per repo is the invariant: the scheduler must never launch a second run for a repo with an active run (defer to `ProcessManager.canStart`).
- Auto-claim is OFF by default and per-repo; a repo with no `REPO_PROJECT_MAP` entry can't be auto-claimed (no project to query).
- Fail-soft: a Jira/launch error for one repo must not stop the heartbeat or affect other repos.
- No free `let` closed over by callbacks. Conventional Commits.
- New env: `AUTO_CLAIM_INTERVAL_MS` (default 60000).

---

### Task 1: `AutoClaimScheduler` core

**Files:** Create `server/helmsman/scheduler.ts`; Test `server/helmsman/scheduler.test.ts`.

**Interfaces:**
- `interface SchedulerDeps { canStart: (repo: string) => boolean; fetchTopBacklog: (repo: string) => Promise<{ ticketId: string; title: string } | null>; launch: (body: { ticketId: string; title: string; repo: string }) => void; onLog?: (msg: string) => void }`
- `class AutoClaimScheduler { constructor(deps: SchedulerDeps); setEnabled(repo: string, enabled: boolean): void; isEnabled(repo: string): boolean; enabledRepos(): string[]; tick(): Promise<void> }`
- `tick()`: for each enabled repo, if `canStart(repo)` is true, `await fetchTopBacklog(repo)`; if a ticket comes back, `launch({ticketId, title, repo})`. Skip repos that are busy (`canStart` false) or have no backlog ticket. Each repo wrapped in try/catch (fail-soft) so one repo's error doesn't abort the tick.

- [ ] **Step 1: Failing test** — with two enabled repos, one idle (`canStart` true) with a top ticket and one busy (`canStart` false): `tick()` launches exactly the idle repo's ticket (launch spy called once with the right body), never the busy one. Enabled/disabled toggles reflect in `isEnabled`/`enabledRepos`. A repo whose `fetchTopBacklog` returns null → no launch. A repo whose `fetchTopBacklog` rejects → no launch, no throw (other repos still processed). Disabling a repo stops it being ticked.

- [ ] **Step 2: Run → FAIL.** `npx vitest run server/helmsman/scheduler.test.ts`

- [ ] **Step 3: Implement** `scheduler.ts` — a `Set<string>` of enabled repos; `tick()` iterates a snapshot of the set, `canStart` gate, `await fetchTopBacklog`, `launch`, each repo in its own try/catch calling `onLog` on error. No real timer inside the class (the caller drives `tick`).

- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit`.

- [ ] **Step 5: Commit** `feat(helmsman): per-repo auto-claim scheduler core`.

---

### Task 2: Wire scheduler into the server + toggle endpoint

**Files:** Modify `server/helmsman/main.ts`, `server/helmsman/router.ts` (+ `router.test.ts`), `server/config.ts` (interval), `.env.example`.

**Interfaces:**
- `RouterDeps` gains `setAutoClaim: (repo: string, enabled: boolean) => void` and `autoClaimRepos: () => string[]`.
- `POST /api/repos/:repo/auto-claim` body `{ enabled: boolean }` → `setAutoClaim(repo, enabled)`, returns `{ repo, enabled }`. (Decode the `:repo` segment — repos contain `/`, so match `^/api/repos/(.+)/auto-claim$` and `decodeURIComponent`.)
- Expose enabled repos: include `autoClaim: string[]` in the `GET /api/agents` response (add to that payload) so the UI can read current state.

- [ ] **Step 1: Failing router tests** — `POST /api/repos/<enc>/auto-claim {enabled:true}` calls `setAutoClaim(repo,true)` and returns `{repo,enabled:true}`; the repo segment is URL-decoded (`owner%2Fname` → `owner/name`); `GET /api/agents` includes `autoClaim` from `autoClaimRepos()`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — extend `RouterDeps` + `handleApi` (the `POST /api/repos/:repo/auto-claim` branch via regex + decode; add `autoClaim` to the `/api/agents` json). In `config.ts` parse `AUTO_CLAIM_INTERVAL_MS` (default 60000, non-numeric → 60000). In `main.ts`: build `fetchTopBacklog(repo)` = resolve the repo's mapped Jira project from `config.repoProjectMap`; if none, return null; else `fetchQueueIssues({ ...config.jira, project })` → map the first issue to `{ticketId: issue.key, title: issue.fields.summary}` (or null). Construct `new AutoClaimScheduler({ canStart: (r) => pm.canStart(r).ok, fetchTopBacklog, launch, onLog: (m) => process.stderr.write(m + '\n') })`. `setInterval(() => void scheduler.tick(), config.autoClaimIntervalMs)`. Wire `setAutoClaim`/`autoClaimRepos` into `handleApi` deps.

- [ ] **Step 4: Run → PASS** (`npx vitest run server/helmsman` + `npx tsc --noEmit` + `npm test`).

- [ ] **Step 5: Commit** `feat(helmsman): auto-claim toggle endpoint + heartbeat wiring`.

---

### Task 3: UI — per-repo auto-claim toggle

**Files:** Modify `src/data/agents.ts`, `src/render.ts` (+ `render.test.ts`), `src/main.ts`, `src/style.css`.

**Interfaces:**
- `src/data/agents.ts`: `setAutoClaim(repo: string, enabled: boolean): Promise<void>` (POST, fail-soft); `listRuns` (or a new fetch) returns the `autoClaim: string[]` too — add `autoClaimRepos` to the runs fetch shape.

- [ ] **Step 1:** Render an **Auto-claim** toggle next to the repo selector in the topbar, shown only when a specific repo is selected (not "All repos"): a checkbox/switch reflecting whether the selected repo is in `autoClaim`. (`renderDashboard` gains the current `autoClaimRepos: string[]` + reuses `selectedRepo`.) Add a failing render test: toggle present + checked when the selected repo is in the list, absent/unchecked otherwise.
- [ ] **Step 2:** In `DashboardView`: fetch `autoClaim` alongside runs; on toggle change, `setAutoClaim(selectedRepo, checked)` then `refresh()`. Wire via the delegated listener (a `change` on `.auto-claim-toggle`, or a click handler). Hold no free `let`.
- [ ] **Step 3:** Style the toggle with existing tokens; keep it unobtrusive.
- [ ] **Step 4:** `npx vitest run src/render.test.ts src/main.test.ts` + `npm run build` + `npm test` green. Commit `feat(ui): per-repo auto-claim toggle`.

---

### Task 4: Build + end-to-end check

- [ ] **Step 1:** `npm run build`, `npx tsc --noEmit`, `npm test` all green.
- [ ] **Step 2 (manual, optional live):** enable auto-claim for a mapped repo with a backlog ticket → within one interval an agent launches for the top ticket; a second tick does not double-claim while it runs; disabling stops further claims. **Real Jira read + agent launch + PR — external side effects; run only with consent.**
- [ ] **Step 3: Commit** any doc touch-ups.

---

## Self-Review

- Per-repo auto-claim heartbeat (query backlog → claim top → launch, single-flight) → Tasks 1–2. ✓
- Per-repo toggle (endpoint + UI) → Tasks 2–3. ✓
- Off by default, opt-in, no double-claim (defers to ProcessManager) → Task 1 invariant + Task 2 `canStart` wiring. ✓
- Fail-soft per repo → Task 1. ✓
- Config `AUTO_CLAIM_INTERVAL_MS` → Task 2. ✓
- No placeholders; each task names files, interfaces, and test cases.
- Type consistency: `SchedulerDeps.launch` matches `main.ts`'s existing `launch(body)`; `fetchTopBacklog` returns `{ticketId,title}|null`; `autoClaim: string[]` added to the `/api/agents` payload is the same list the UI reads.
- Single-flight is not re-implemented — the scheduler asks `ProcessManager.canStart`, the one source of truth.
