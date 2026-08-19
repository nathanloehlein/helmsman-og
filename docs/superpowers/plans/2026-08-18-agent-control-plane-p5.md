# Agent Control Plane — Phase 5 (Generic Adapter + Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the second agent backend (a **generic-command adapter** behind the existing `AgentAdapter` interface, selectable by config) and three hardening features: **crash recovery** (reconcile runs left `running` after an orchestrator restart), an **orphaned-worktree sweep** (remove agent worktrees no live run owns), and **cost/attempt caps surfaced in the UI** (with a cost-cap that stops the retry loop).

**Architecture:** The command adapter is a factory returning an `AgentAdapter` — same contract as `claudeCodeAdapter`, spawns a configured command (no shell; argv tokenized to avoid injection from untrusted Jira titles), streams stdout lines as `log` events. `main.ts` picks the adapter from config. Recovery and sweep are pure-ish startup functions with injected I/O, run once after `openDb`. Caps add config values, a runner loop break on cost, and a `caps` object on `GET /api/agents` that the running-agents rows render. Builds on P0–P4. Spec: `docs/superpowers/specs/2026-08-18-agent-control-plane-design.md` (P5 line).

**Tech Stack:** TypeScript (strict), Vitest (jsdom for UI), Node built-ins (`child_process`, `readline`), better-sqlite3. No new deps.

## Global Constraints

- TS strict; explicit type annotations on every local, parameter, and return type — including single-use locals; no `any`.
- No inline comments (JSDoc above an `export` allowed only if useful; `.env.example` lines follow that file's convention).
- Prefer `const`; no free `let` closed over by a callback. The runner's existing `for (let attempt...)` retry loop and its `let result/totalCost/stopped` accumulators are the established tactical-local idiom — extend them in place, do not restructure.
- No new deps. Tests do no real network/spawn/git/fs — inject fakes or stub.
- **Security:** the command adapter must NOT invoke a shell. Tokenize the template and substitute placeholders per-argv-token so a Jira title containing shell metacharacters cannot inject. Strip `JIRA_API_TOKEN` and `JIRA_EMAIL` from the child env, exactly as `claudeCodeAdapter` does.
- Fail-soft on startup: recovery and sweep errors must be logged and swallowed — a sweep failure must never prevent the server from starting or listening.
- Conventional Commits; commit after each task.

---

### Task 1: Generic-command adapter

**Files:** Create `server/orchestrator/agents/command.ts`; Test `server/orchestrator/agents/command.test.ts`.

**Interfaces:**
- Produces: `export function commandAdapter(template: string): AgentAdapter` — `id: 'command'`. `start(task, workdir, onEvent)` returns an `AgentHandle`.
- Consumes: `AgentAdapter`, `AgentEvent`, `AgentHandle`, `AgentResult`, `AgentTask` from `./adapter`.

Behavior:
- `buildArgv(template, task)`: `template.trim().split(/\s+/)`, and for each token replace the literal placeholders `{ticket}` → `task.ticketId`, `{repo}` → `task.repo`, `{title}` → `task.title` (replace all occurrences within the token). Returns `string[]`. Export it for direct unit testing.
- `start`: `const argv = buildArgv(template, task); const [cmd, ...args] = argv;` strip Jira secrets: `const { JIRA_API_TOKEN, JIRA_EMAIL, ...agentEnv } = process.env;` then `spawn(cmd, args, { cwd: workdir, env: agentEnv })` (no `shell`). Each stdout line (via `readline` over `child.stdout`) → `onEvent({ kind: 'log', text: line })`; also scan the line for a PR marker with `/(?:pull\/|PR[ #]*)(\d+)/i` and keep the LAST match's number in a `let prNumber: number | undefined`. Each stderr line → `onEvent({ kind: 'log', text: line })`. `exit` resolves `{ ok: code === 0, prNumber }` on `close`; `child.on('error', (err) => { onEvent({ kind: 'error', text: err.message }); resolve({ ok: false, prNumber }); })`. `stop: () => child.kill('SIGTERM')`. (No `costUsd` — generic commands report none.)

- [ ] **Step 1: Failing test** for `buildArgv` — `buildArgv('run --ticket {ticket} --repo {repo} --title {title}', { ticketId: 'ABC-1', repo: 'o/r', title: 'Fix bug', jiraBaseUrl: '' })` returns `['run','--ticket','ABC-1','--repo','o/r','--title','Fix','bug']` (note: a multi-word title splits into multiple argv tokens because the template splits on whitespace first — assert this exact array so the behavior is pinned and the security rationale is explicit: no single shell string is ever built). Also assert a title with a shell metachar, `title: 'a; rm -rf /'`, yields tokens `['a;','rm','-rf','/']` as SEPARATE argv entries (never concatenated into one shell string).
- [ ] **Step 2: Run → FAIL** (`npx vitest run server/orchestrator/agents/command.test.ts`).
- [ ] **Step 3: Implement** `command.ts` (`buildArgv` + `commandAdapter`).
- [ ] **Step 4: Add a spawn-level test** using an injected/real fake: spawn a real Node one-liner as the template to keep it hermetic — e.g. `commandAdapter('node -e console.log("hello");console.log("pull/42")')`, call `start({ticketId:'X-1',title:'t',repo:'o/r',jiraBaseUrl:''}, process.cwd(), onEvent)`, `await handle.exit`, assert `result.ok === true`, `result.prNumber === 42`, and that at least one `log` event carried `hello`. (This uses `node` on PATH; acceptable in this repo's test env, mirroring how other tests shell out.) If a spawn test proves flaky in review, downgrade to asserting only `buildArgv` + the event wiring via a stubbed child — but attempt the real spawn first.
- [ ] **Step 5: Run → PASS** + `npx tsc --noEmit`.
- [ ] **Step 6: Commit** `feat(orchestrator): generic-command agent adapter (no-shell argv)`.

---

### Task 2: Adapter selection from config

**Files:** Modify `server/config.ts` (+ `server/config.test.ts`), `server/orchestrator/main.ts`, `.env.example`.

**Interfaces:**
- `AppConfig` gains `agentAdapter: 'claude-code' | 'command'` and `agentCmd: string | null`.
- Parse: `AGENT_ADAPTER` (default `'claude-code'`; any value other than `'command'` → `'claude-code'`), `AGENT_CMD` (via `req`, else null).

- [ ] **Step 1: Failing config test** — default `agentAdapter === 'claude-code'` and `agentCmd === null`; with `AGENT_ADAPTER='command'` + `AGENT_CMD='run {ticket}'`, `agentAdapter === 'command'` and `agentCmd === 'run {ticket}'`; an unknown `AGENT_ADAPTER='foo'` falls back to `'claude-code'`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the two fields in `loadConfig` (mirror the existing `req`/default pattern). In `main.ts`, select the adapter once at module scope: `const adapter: AgentAdapter = config.agentAdapter === 'command' && config.agentCmd ? commandAdapter(config.agentCmd) : claudeCodeAdapter;` (import `commandAdapter` and the `AgentAdapter` type). Replace the hardcoded `adapter: claudeCodeAdapter` in the `startRun` deps with `adapter`. If `AGENT_ADAPTER='command'` but `AGENT_CMD` is empty, fall back to claude-code and `process.stderr.write('AGENT_ADAPTER=command but AGENT_CMD is empty; using claude-code\n')`. Add `AGENT_ADAPTER` and `AGENT_CMD` to `.env.example` with one-line comments.
- [ ] **Step 4: Run → PASS** (`npx vitest run server/config.test.ts` + `npx tsc --noEmit` + `npm test`).
- [ ] **Step 5: Commit** `feat(orchestrator): select agent adapter from config`.

---

### Task 3: Crash recovery for interrupted runs

**Files:** Create `server/orchestrator/recovery.ts`; Test `server/orchestrator/recovery.test.ts`; Modify `server/orchestrator/main.ts`.

**Interfaces:**
- Produces: `export function recoverOrphanedRuns(db: Db, now: () => string): string[]` — every run with `status === 'running'` (via `db.activeRuns()`) is reconciled to `'failed'` with `endedAt: now()`, an event is appended (`db.appendEvent(id, 'error', 'run interrupted: orchestrator restarted', now())`), and the affected id is returned. Uses only existing `Db` methods (`activeRuns`, `updateRun`, `appendEvent`). No new `RunStatus` value.
- Consumes: `Db` from `./db`.

- [ ] **Step 1: Failing test** — build a real in-memory-ish `openDb(':memory:')`, insert two runs `status:'running'` and one `status:'succeeded'`; call `recoverOrphanedRuns(db, () => '2026-08-18T00:00:00.000Z')`; assert it returns the two running ids, that `db.getRun(id).status === 'failed'` and `endedAt` is set for both, that the succeeded run is untouched, and that each recovered run has an appended event whose text contains `interrupted`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `recovery.ts`.
- [ ] **Step 4: Wire into `main.ts`** — after `const db = openDb(...)` and before `server.listen`, call `recoverOrphanedRuns(db, () => new Date().toISOString())` inside a try/catch that `process.stderr.write`s on failure (fail-soft; must not block startup). Log a one-line summary of how many were recovered.
- [ ] **Step 5: Run → PASS** (`npx vitest run server/orchestrator/recovery.test.ts` + `npx tsc --noEmit` + `npm test`).
- [ ] **Step 6: Commit** `feat(orchestrator): reconcile interrupted runs on startup`.

---

### Task 4: Orphaned-worktree sweep

**Files:** Modify `server/orchestrator/worktree.ts` (+ create `server/orchestrator/worktree.test.ts` if none exists); Modify `server/orchestrator/main.ts`.

**Interfaces:**
- Produces (in `worktree.ts`):
  - `export interface WorktreeSweepDeps { listAgentWorktrees: (repoDir: string) => Promise<string[]>; remove: (repoDir: string, path: string) => Promise<void>; isActiveRunId: (runId: string) => boolean; repoDirs: string[]; }`
  - `export async function sweepOrphanedWorktrees(deps: WorktreeSweepDeps): Promise<string[]>` — for each `repoDir`, `listAgentWorktrees(repoDir)` returns absolute worktree paths; for each path whose basename (the run id, since agent worktrees live at `<repoDir>/.worktrees/<runId>`) is NOT `isActiveRunId`, call `remove(repoDir, path)` and collect it. Returns the list of removed paths. Each removal wrapped so one failure does not abort the rest.
  - `export async function listAgentWorktrees(repoDir: string): Promise<string[]>` — run `git -C <repoDir> worktree list --porcelain`, parse `worktree <path>` lines, return only paths containing `${sep}.worktrees${sep}` (the agent-created location; never the repo's main worktree). Fail-soft: on git error return `[]`.

- [ ] **Step 1: Failing test** for `sweepOrphanedWorktrees` with fakes — `repoDirs: ['/agents/r']`, `listAgentWorktrees` returns `['/agents/r/.worktrees/run-A','/agents/r/.worktrees/run-B']`, `isActiveRunId` true only for `run-A`; assert `remove` was called once with `run-B`'s path and the returned array is `['/agents/r/.worktrees/run-B']`; assert `run-A` (active) was NOT removed. Add a case where `remove` for one path rejects and a second orphan still gets removed (fail-soft).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `sweepOrphanedWorktrees` + `listAgentWorktrees` in `worktree.ts`. `listAgentWorktrees` uses the existing `run` (promisified `execFile`) and `sep`/`join` from `node:path`; parse porcelain output line-by-line.
- [ ] **Step 4: Wire into `main.ts`** — after recovery (Task 3), build the real deps: `repoDirs` = the distinct repo directories under `AGENTS_ROOT` derived from `config.repoProjectMap` keys and `config.github?.repo` (map each `owner/name` → `join(AGENTS_ROOT, basename)`, de-duplicated; skip if none); `listAgentWorktrees` = the exported git helper; `remove: (repoDir, path) => removeWorktree(AGENTS_ROOT, <repo>, path)` — since `removeWorktree` needs the repo, pass a wrapper that runs `git -C repoDir worktree remove --force path` directly, OR extend `removeWorktree` to accept a repoDir; simplest: add `export async function removeWorktreeAt(repoDir: string, worktreePath: string): Promise<void>` to `worktree.ts` and use it both here and (optionally) refactor `removeWorktree` to delegate. `isActiveRunId` = `(id) => pm.activeRepos` is by repo, not id — instead use the live process set: add `pm.hasRun(runId): boolean` (checks `entries.has(runId)`) to `ProcessManager` and pass `(id) => pm.hasRun(id)`. Run the sweep inside a try/catch that logs and swallows; log the count removed. Because recovery has already marked crashed runs failed and no runs are active at startup, the sweep clears all leftover agent worktrees from prior crashes.
- [ ] **Step 5:** Add a `ProcessManager.hasRun(runId: string): boolean` (+ a one-line test in `process-manager.test.ts`).
- [ ] **Step 6: Run → PASS** (`npx vitest run server/orchestrator` + `npx tsc --noEmit` + `npm test`).
- [ ] **Step 7: Commit** `feat(orchestrator): sweep orphaned agent worktrees on startup`.

---

### Task 5: Cost/attempt caps surfaced in the UI

**Files:** Modify `server/config.ts` (+ test), `server/orchestrator/runner.ts` (+ `runner.test.ts`), `server/orchestrator/router.ts` (+ `router.test.ts`), `server/orchestrator/main.ts`, `src/data/agents.ts`, `src/render.ts` (+ `render.test.ts`), `src/main.ts`, `src/style.css`.

**Interfaces:**
- `AppConfig` gains `maxCostUsd: number | null` (`AGENT_MAX_COST_USD`, parsed as float; non-numeric/absent → null).
- `RunnerDeps` gains optional `maxCostUsd?: number | null`. After the per-attempt `totalCost` update, if `deps.maxCostUsd != null && totalCost != null && totalCost >= deps.maxCostUsd`, stop the loop with `onEvent({ kind: 'log', text: 'cost cap reached, no further attempts' })` and set `stopped`-like termination (a distinct local `let cappedOut: boolean`); final status when capped without success is `'failed'` (log explains why). Do not change the `succeeded` path.
- `GET /api/agents` payload gains `caps: { maxAttempts: number; maxCostUsd: number | null }`. `RouterDeps` gains `caps: () => { maxAttempts: number; maxCostUsd: number | null }`.
- Client `fetchAgents` returns `caps` too; `renderDashboard` gains a `caps` param; each agent-row shows attempt as `×<attempt>/<maxAttempts>` (or just `×N/M`) and, when `maxCostUsd` is set and a run has cost, `$<cost>/<cap>`.

- [ ] **Step 1: Failing config test** — `maxCostUsd` default null; `AGENT_MAX_COST_USD='2.5'` → `2.5`; non-numeric → null.
- [ ] **Step 2: Failing runner test** — with `maxAttempts: 3`, `maxCostUsd: 1.0`, an adapter that always returns `{ ok: false, costUsd: 0.6 }`: assert the loop runs at most 2 attempts (0.6 + 0.6 = 1.2 ≥ 1.0 stops it before a 3rd), the run ends `failed`, and a `log` event contains `cost cap`. Confirm that with `maxCostUsd: null` the same adapter runs the full 3 attempts (regression guard on the cap being opt-in).
- [ ] **Step 3: Failing router test** — `GET /api/agents` json includes `caps` from the stubbed `caps()`.
- [ ] **Step 4: Failing render test** — an agent-row for a run with `attempt: 2` and `caps.maxAttempts: 3` shows `2/3` (or `×2/3`); with `maxCostUsd: 5` and `costUsd: 1.25`, the row shows the cost against the cap.
- [ ] **Step 5: Run all four → FAIL.**
- [ ] **Step 6: Implement** — config field; runner cap loop-break (extend the existing `let` accumulators, no restructure); `caps` on the router payload + `RouterDeps`; `main.ts` passes `maxCostUsd` into `startRun` deps and `caps: () => ({ maxAttempts: config.maxAttempts, maxCostUsd: config.maxCostUsd })` into `handleApi` deps; `fetchAgents` returns `caps` (extend its return type + `AgentsListResponse`); `renderDashboard` gains a `caps` param (default `{ maxAttempts: 1, maxCostUsd: null }`) and renders attempt/cost against caps; `src/main.ts` stores `caps` from `fetchAgents` and passes it to `renderDashboard`; style any new element with existing tokens. Add `AGENT_MAX_COST_USD` to `.env.example`.
- [ ] **Step 7: Run all → PASS** (`npx vitest run server src` + `npm run build` + `npm test` + `npx tsc --noEmit`).
- [ ] **Step 8: Commit** `feat: cost cap enforcement + attempt/cost caps surfaced in the UI`.

---

### Task 6: Build + end-to-end check

- [ ] **Step 1:** `npm run build`, `npx tsc --noEmit`, `npm test` all green.
- [ ] **Step 2 (manual, optional live):** (a) set `AGENT_ADAPTER=command` + a trivial `AGENT_CMD` (e.g. an echo script) and launch a ticket → the run streams the command's stdout as log lines and ends. (b) Launch a run, kill the orchestrator mid-run, restart → the interrupted run shows `failed` (not stuck `running`) and its leftover worktree is gone. **These touch git worktrees + spawn — run only with consent.**
- [ ] **Step 3: Commit** any doc touch-ups (README: command adapter, recovery, sweep, caps, new env vars).

---

## Self-Review

- Generic-command adapter behind the interface, config-selected → Tasks 1–2. ✓
- Crash recovery from SQLite → Task 3. ✓
- Orphaned-worktree sweep → Task 4. ✓
- Cost/attempt caps surfaced in UI (+ cost-cap enforcement, the "hardening") → Task 5. ✓
- Security: no-shell tokenized argv + stripped Jira env in the command adapter, pinned by a test asserting a metachar title never becomes one shell string → Task 1 + Global Constraints. ✓
- Fail-soft startup (recovery + sweep never block `listen`) → Tasks 3–4. ✓
- No placeholders; each task names files, interfaces, and test cases.
- Type consistency: `commandAdapter` returns the same `AgentAdapter` the runner consumes; `caps` shape is identical across runner-config, `/api/agents` payload, `fetchAgents`, and `renderDashboard`; `recoverOrphanedRuns` and `sweepOrphanedWorktrees` use only existing/added Db + ProcessManager methods; `RunStatus` is unchanged (recovery reuses `'failed'`).
- Idiom: extends the runner's existing `for (let attempt...)` + `let` accumulators rather than restructuring (consistent with the file and called out in Global Constraints).
- Replace-don't-duplicate: adapter selection replaces the hardcoded `claudeCodeAdapter` wiring; if `removeWorktreeAt` is added, `removeWorktree` should delegate to it rather than duplicating the git call.
