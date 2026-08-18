# Agent Control Plane — Phase 2 (Lifecycle + Gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the loop. When a run launches, claim its ticket in Jira (assign to the bot + transition to In Progress); when the agent opens a PR, detect it and transition the ticket to In Review; on failure, re-run up to a cap and otherwise leave the ticket In Progress for a human. The agent still never merges.

**Architecture:** Add a `jira-actions` module (Jira Cloud REST **writes**), a GitHub PR-detection helper, and fold both into the run driver as injected deps so the lifecycle stays unit-testable. Builds directly on P0+P1 (`docs/superpowers/plans/2026-08-18-agent-control-plane-p0-p1.md`). Spec: `docs/superpowers/specs/2026-08-18-agent-control-plane-design.md`.

**Tech Stack:** TypeScript (strict), Vitest, Node built-ins, better-sqlite3. No new deps.

## Global Constraints

- TypeScript strict; explicit annotations on all locals/params/returns; no `any`.
- No inline comments (repo hook); JSDoc directly above an `export` is allowed.
- Tests do no network — inject a fake `fetch`/deps.
- The agent never merges; the orchestrator only assigns + transitions Jira status.
- Jira writes must fail soft: a transition/assign error degrades the run to a logged event, never crashes the orchestrator and never blocks the agent from working.
- New env: `BOT_ACCOUNT_ID` (Jira accountId the bot claims as), `AGENT_MAX_ATTEMPTS` (default 2), optional `JIRA_STATUS_IN_PROGRESS` / `JIRA_STATUS_IN_REVIEW` (default "In Progress" / "In Review").
- Conventional Commits; commit after each task.

---

### Task 1: Jira write actions (`jira-actions.ts`)

**Files:** Create `server/orchestrator/jira-actions.ts`; Test `server/orchestrator/jira-actions.test.ts`.

**Interfaces:**
- Consumes: `JiraConfig` (`server/config.ts`).
- Produces:
  - `interface JiraActions { assign(ticketId: string, accountId: string): Promise<void>; transition(ticketId: string, statusName: string): Promise<boolean> }`
  - `makeJiraActions(jira: JiraConfig, fetchImpl?: typeof fetch): JiraActions`
  - `transition` fetches `GET /rest/api/3/issue/{key}/transitions`, finds the transition whose `to.name` (case-insensitive) matches `statusName`, POSTs `{transition:{id}}`; returns `false` (no throw) when no matching transition or a non-2xx response.

- [ ] **Step 1: Write the failing test** — inject a fake `fetch` that records calls and returns canned transition lists. Assert: `assign` PUTs `/issue/K/assignee` with `{accountId}` + Basic auth header; `transition` looks up the id for "In Review" and POSTs it; `transition` returns `false` when the status isn't offered; neither throws on a 500 (returns false / resolves).

- [ ] **Step 2: Run → FAIL.** `npx vitest run server/orchestrator/jira-actions.test.ts`

- [ ] **Step 3: Implement** using `node` global `fetch` (default param `fetchImpl: typeof fetch = fetch`), Basic auth from `jira.email`/`jira.apiToken` (`Buffer.from(...).toString('base64')`), `jira.baseUrl`. Wrap network in try/catch → return false / resolve; do not throw.

- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit`.

- [ ] **Step 5: Commit** `feat(orchestrator): Jira assign + transition write actions`.

---

### Task 2: GitHub PR detection by branch

**Files:** Modify `server/orchestrator/github.ts` (add export); no unit test (I/O wrapper) — covered by the runner test via injection.

**Interfaces:**
- Produces: `findPrNumberByBranch(github: GithubConfig, repo: string, branch: string): Promise<number | null>` — `GET /repos/{repo}/pulls?head={owner}:{branch}&state=all&per_page=1`, returns the PR number or null.

- [ ] **Step 1: Implement** the helper (array-arg-free URL via `URLSearchParams`; `repo` is `owner/name`, so `head` = `${owner}:${branch}`). Return `null` on non-2xx / empty.
- [ ] **Step 2:** `npx tsc --noEmit` clean.
- [ ] **Step 3: Commit** `feat(orchestrator): detect the PR a run opened by branch`.

---

### Task 3: Run driver lifecycle + gate + re-run cap

**Files:** Modify `server/orchestrator/runner.ts` + `runner.test.ts`.

**Interfaces:**
- Extend `RunnerDeps` with (all optional so P1 tests still compile):
  - `jira?: JiraActions | null`
  - `botAccountId?: string`
  - `statusInProgress?: string` (default "In Progress"), `statusInReview?: string` (default "In Review")
  - `findPrNumber?: (repo: string, branch: string) => Promise<number | null>`
  - `maxAttempts?: number` (default 1 in tests; wired from `AGENT_MAX_ATTEMPTS` in main)
- Behavior additions to `startRun`:
  1. After `insertRun` + worktree, if `jira`+`botAccountId`: `await jira.assign(ticketId, botAccountId)` then `jira.transition(ticketId, statusInProgress)` — each fail-soft (log an event, continue).
  2. Run the adapter. If the result is not ok, retry up to `maxAttempts` total attempts (fresh adapter.start each attempt, same worktree; append a "retry N" event; update `runs.attempt`). 
  3. On a successful attempt: if `findPrNumber` is set, `const pr = await findPrNumber(repo, branch)`; set `prNumber`. If `jira` set and a PR was found: `jira.transition(ticketId, statusInReview)`.
  4. On exhausted failure: leave the ticket In Progress (no transition), run `status='failed'`.
- Keep the P1 guarantee: `startRun` never rejects; worktree always cleaned in `finally`.

- [ ] **Step 1: Write failing tests** (extend `runner.test.ts`) with fake `JiraActions` (records assign/transition calls), fake `findPrNumber`, and a fake adapter that fails N times then succeeds:
  - launch assigns bot + transitions In Progress before the adapter runs;
  - success with a detected PR → transitions In Review + sets `prNumber`;
  - adapter fails then succeeds within `maxAttempts` → ends succeeded, `attempt` incremented, In Review reached;
  - adapter fails past `maxAttempts` → `failed`, NO In Review transition, ticket left In Progress;
  - jira deps absent → behaves exactly like P1 (existing tests still pass).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the lifecycle in `startRun`, fail-soft around every Jira call.
- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit` + `npm test` full suite green.
- [ ] **Step 5: Commit** `feat(orchestrator): claim/In-Progress on launch, In-Review on PR, bounded re-runs`.

---

### Task 4: Wire config + main.ts

**Files:** Modify `server/config.ts` (+ test), `server/orchestrator/main.ts`, `.env.example`.

- [ ] **Step 1:** `loadConfig` parses `BOT_ACCOUNT_ID`, `AGENT_MAX_ATTEMPTS` (int, default 2), `JIRA_STATUS_IN_PROGRESS`/`JIRA_STATUS_IN_REVIEW` (defaults). Add config-test cases.
- [ ] **Step 2:** In `main.ts` `launch()`, build `jira = config.jira ? makeJiraActions(config.jira) : null` and pass `jira`, `botAccountId`, statuses, `findPrNumber: (repo, branch) => config.github ? findPrNumberByBranch(config.github, repo, branch) : Promise.resolve(null)`, `maxAttempts` into the runner deps.
- [ ] **Step 3:** `.env.example` documents the new vars + notes the Jira token now needs **write** scope.
- [ ] **Step 4:** `npx tsc --noEmit` + `npm test` green.
- [ ] **Step 5: Commit** `feat(orchestrator): wire Jira lifecycle config into launch`.

---

### Task 5: Surface lifecycle in the UI (light)

**Files:** Modify `src/render.ts` / `src/main.ts` / `src/data/agents.ts` as needed.

- [ ] **Step 1:** When a run reports a `result` event and `/api/agents` shows a `prNumber`, show a PR link + the ticket's new status in the drawer footer (read from the run row via `GET /api/agents`). Keep it minimal — the full running-agents view is P3.
- [ ] **Step 2:** `npm run build` + `npm test` green.
- [ ] **Step 3: Commit** `feat(ui): show PR link + ticket status when a run reaches the gate`.

---

### Task 6: End-to-end verification (user-gated)

- [ ] Configure `BOT_ACCOUNT_ID` (your Jira accountId) + a repo↔project mapping whose backlog has an agent-eligible ticket. Launch it; confirm: ticket → In Progress on launch, agent works in the worktree, a PR opens, ticket → In Review, run row shows `prNumber` + `succeeded`. Confirm a forced failure leaves the ticket In Progress and retries up to the cap. **Spawns a live agent, writes Jira status, opens a PR — external side effects; run only with consent.**

---

## Self-Review

- Jira writes (assign + In Progress + In Review) → Tasks 1, 3. ✓
- PR detection populating `prNumber` (the P1 deferral) → Tasks 2, 3. ✓
- Single-flight per repo → already enforced by the P1 ProcessManager (no new work). ✓
- Failure re-run cap → Task 3 (`maxAttempts`). ✓
- Fail-soft Jira (never crash / never block the agent) → global constraint + Task 3. ✓
- Config/env + write-scope note → Task 4. ✓
- No placeholders; every step names files + behavior; test cases enumerated.
- Backward compatibility: all new `RunnerDeps` fields optional, so P1's runner tests compile unchanged.
