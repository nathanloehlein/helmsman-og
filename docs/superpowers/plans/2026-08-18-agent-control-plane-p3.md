# Agent Control Plane — Phase 3 (Multi-Agent Running View) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the dashboard show *all* active agent runs at once — replace the single "Working on" panel with a live running-agents list (ticket, repo, elapsed, cost, attempt, Stop, click-to-open logs) — and first fix the run-terminal signal so the log drawer/footer key off run completion, not a per-attempt `result` (the P2 review's deferred #1/#2).

**Architecture:** One backend/protocol change (a distinct `run-complete` event emitted after the run row is finalized; SSE + client + footer close/settle on it) then client-side work: `DashboardView` also fetches `GET /api/agents`, and `renderDashboard` renders the active runs. Builds on P0–P2. Spec: `docs/superpowers/specs/2026-08-18-agent-control-plane-design.md`.

**Tech Stack:** TypeScript (strict), Vitest (jsdom for UI), Node built-ins, better-sqlite3. No new deps.

## Global Constraints

- TS strict; explicit annotations; no `any`; no inline comments (JSDoc above `export` ok).
- No new deps. Tests do no network/spawn — inject fakes / stub `fetch`/`EventSource`.
- No free `let` closed over by callbacks — hold state on `DashboardView` fields.
- Escape untrusted strings (ticket ids, repos) before `innerHTML`; prefer `textContent`.
- Conventional Commits; commit after each task.

---

### Task 1: `run-complete` terminal event (fixes the footer race + multi-attempt SSE)

**Files:** Modify `server/orchestrator/agents/adapter.ts`, `server/orchestrator/runner.ts` (+ `runner.test.ts`), `server/orchestrator/main.ts` (SSE close), `src/data/agents.ts` (client close), `src/main.ts` (footer trigger + `src/main.test.ts`).

**Interfaces:**
- `AgentEventKind` gains `'run-complete'`.
- Runner publishes exactly one `{ kind: 'run-complete', text: <final status> }` after the run row reaches its terminal status, in every path (success / failed / stopped / early-catch).

- [ ] **Step 1: Extend the kind union** — in `adapter.ts`, `AgentEventKind = 'phase' | 'tool' | 'log' | 'result' | 'error' | 'run-complete'`.

- [ ] **Step 2: Failing runner test** — assert `startRun` publishes a `run-complete` event (via a bus subscription) whose text is the final status, AND that it arrives AFTER the run row is already terminal (subscribe, capture; on `run-complete`, `db.getRun(id).status` is not `'running'`). Add for both a succeeded and a failed run.

- [ ] **Step 3: Implement** — in `runner.ts`, publish the terminal event once, after all `updateRun` terminal writes, in the `finally` (so it fires on success, failure, stopped, and the early-catch path). Read the finalized row for the status:
```ts
  } finally {
    if (worktreePath) await deps.removeWorktree(task.repo, worktreePath);
    const finalRow: RunRow | null = deps.db.getRun(runId);
    const finalStatus: string = finalRow?.status ?? 'failed';
    deps.db.appendEvent(runId, 'run-complete', finalStatus, deps.now());
    deps.bus.publish(runId, { kind: 'run-complete', text: finalStatus });
  }
```

- [ ] **Step 4: SSE closes on `run-complete` only** — in `main.ts` `/api/agents/:id/log`, change the close condition from `ev.kind === 'result' || ev.kind === 'error'` to `ev.kind === 'run-complete'`. (Per-attempt `result`/`error` no longer close the stream.)

- [ ] **Step 5: Client closes + footer settles on `run-complete`** — in `src/data/agents.ts` `openRunStream`, close the `EventSource` when `event.kind === 'run-complete'` (not on result/error). In `src/main.ts`, trigger the footer `getRun` render on `run-complete` (the row is finalized then, so status + prNumber are correct — fixes the P2 footer race). Update the existing `src/main.test.ts` footer test to drive a `run-complete` event.

- [ ] **Step 6: Verify** — `npx vitest run server/orchestrator src/main.test.ts` + `npx tsc --noEmit` + `npm test` green. Commit `feat(orchestrator): emit a run-complete terminal event; SSE/footer key off it`.

---

### Task 2: Client data — list runs + stop

**Files:** Modify `src/data/agents.ts`; Modify `src/main.ts` (`DashboardView.refresh` fetches runs).

**Interfaces:**
- `interface RunSummary { id: string; ticketId: string; repo: string; status: string; attempt: number; prNumber: number | null; startedAt: string; costUsd: number | null }`
- `listRuns(): Promise<RunSummary[]>` — `GET /api/agents` → `body.runs` (fail-soft: `[]` on error).
- `stopAgent(runId: string): Promise<void>` — `POST /api/agents/:id/stop` (fail-soft).

- [ ] **Step 1: Add `listRuns` + `stopAgent`** to `src/data/agents.ts` (typed, fail-soft, no throw).
- [ ] **Step 2: Fetch runs in the poll** — in `DashboardView.refresh`, after `loadDashboard`, also `const runs = await listRuns()`; store `this.runs = runs`. Pass `this.runs` into `renderDashboard` (new param, Task 3). Keep the 30s cadence.
- [ ] **Step 3: Verify** — `npx tsc --noEmit` + `npm test` green (no behavior change yet if render ignores the param until Task 3; wire the param in Task 3). Commit `feat(ui): fetch orchestrator runs alongside the dashboard`.

---

### Task 3: Render the running-agents panel

**Files:** Modify `src/render.ts` (+ `src/render.test.ts`), `src/style.css`.

**Interfaces:**
- `renderDashboard(root, data, now, degraded=[], repos=[], selectedRepo=null, runs: RunSummary[] = [])` — replace the single **Working on** panel body with a list of **active** runs (`status === 'running'`).

- [ ] **Step 1: Failing render test** — with two running runs passed in, `.agent-row` count is 2; each shows the ticket id, short repo, and a `.agent-stop` button carrying `data-runid`; with zero running runs, an empty-note ("No agents running.") renders; a non-running run is excluded.
- [ ] **Step 2: Implement** — change the "Working on" panel to "Agents running" with a `.panel-count` of the active-run count and a list of `.agent-row`s. Each row: `data-runid`, ticket id (accent mono), short repo, elapsed (`formatRelativeTime(startedAt, now)`), attempt (`×N` when >1), cost (`$x.xx` when set), a chip for status, and a `.agent-stop` button (authored SVG, no emoji). Escape ticket id + repo. Empty state when none. Reuse `shortRepo`, `formatCycle`/`formatRelativeTime`, `esc`.
- [ ] **Step 3: Style** `.agent-row` / `.agent-stop` in `style.css` with existing tokens (`--surface-hi`, `--line`, `--accent`, `--bad`), consistent with `.queue-item` / chips. The row is clickable (cursor:pointer) except the Stop button.
- [ ] **Step 4: Verify** — `npx vitest run src/render.test.ts` + `npm run build` + `npm test` green. Commit `feat(ui): running-agents panel replaces the single working-on view`.

---

### Task 4: Wire Stop + click-to-open; live-ish refresh

**Files:** Modify `src/main.ts` (+ `src/main.test.ts`).

- [ ] **Step 1: Failing test** — clicking `.agent-stop` calls `stopAgent(runId)` (stub) and does not open the drawer; clicking an `.agent-row` (not the stop button) opens the drawer + `openRunStream` for that `runId`.
- [ ] **Step 2: Implement** in `DashboardView.handleClick` (the existing single delegated listener): a `.agent-stop` click → `stopAgent(btn.dataset.runid)` then `void this.refresh()` (reflect the new status); stop propagation so it doesn't also open the drawer. An `.agent-row` click (excluding the stop button) → open the drawer titled with the row's ticket + `openRunStream(runid, …)`, reusing the launch drawer path and the `launchSeq`/`activeStreamUnsubscribe` guards.
- [ ] **Step 3: Verify** — `npx vitest run src/main.test.ts` + `npx tsc --noEmit` + `npm test` green. Commit `feat(ui): stop and open logs from the running-agents panel`.

---

### Task 5: Build + end-to-end check

- [ ] **Step 1:** `npm run build`, `npx tsc --noEmit`, `npm test` all green.
- [ ] **Step 2 (manual, optional live):** `npm run dev`, launch a ticket → it appears as an `.agent-row` while running, the drawer streams and now closes cleanly on `run-complete` (footer shows final status + PR link, no lingering "running"); Stop transitions it. Two concurrent launches (different repos) show two rows.
- [ ] **Step 3: Commit** any doc touch-ups (README "running-agents" mention if warranted).

---

## Self-Review

- Run-terminal event fixing footer race + multi-attempt SSE (P2 deferred #1/#2) → Task 1. ✓
- Replace "Working on" with multi-agent running view → Tasks 2–3. ✓
- Per-agent Stop + click-to-open logs → Task 4. ✓
- Metrics (elapsed/cost/attempt) → Task 3. ✓
- No placeholders; each task names files + behavior + tests.
- Type consistency: `RunSummary` (Task 2) is the shape `renderDashboard` (Task 3) and the Task 4 handlers consume; `run-complete` kind (Task 1) is referenced by SSE, client, footer.
- Back-compat: `renderDashboard`'s new `runs` param is optional (default `[]`), so existing render tests compile; `AgentEventKind` addition is additive.
- Note: after Task 1, `AGENT_MAX_ATTEMPTS>1` is safe to enable (SSE no longer closes on a per-attempt result) — but leave the default at 1; enabling it is a separate operator choice.
