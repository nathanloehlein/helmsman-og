# UI Control Plane (P6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the browser a full control surface: launch any Jira ticket or a free-form task, view every run's output (live + historical), and edit non-secret runtime config that persists and takes effect without a restart.

**Architecture:** Three additions to the existing Vite UI + Helmsman Node server. (A) A SQLite config-override layer read through a `ConfigStore` so config becomes dynamic. (B) A broadened launch path (any-ticket / free-form). (C) A run-history UI over the existing `/api/agents`. Builds on P0–P5. Spec: `docs/superpowers/specs/2026-08-24-ui-control-plane-design.md`.

**Tech Stack:** TypeScript (strict), Vitest (jsdom for UI), Node built-ins, better-sqlite3. No new deps.

## Global Constraints

- TS strict; explicit type annotations on every local, parameter, and return type — including single-use locals; no `any`.
- No inline comments (JSDoc above an `export` only if useful; `.env.example` lines follow that file's convention).
- Prefer `const`; no free `let` closed over by a callback. `tsconfig` has `erasableSyntaxOnly` — **no constructor parameter properties** (`constructor(private readonly x)`); use an explicit field + assignment.
- No new deps. Tests do no real network/spawn/git — inject fakes / stub `fetch`/`EventSource`; DB tests use `openDb(':memory:')`.
- **Secrets never leave the server or become editable:** `JIRA_API_TOKEN`, `GITHUB_TOKEN`, `JIRA_EMAIL` are never returned by `/api/config` and never accepted by `PUT /api/config`.
- Helmsman stays bound to `127.0.0.1`. Escape untrusted strings before `innerHTML` (`esc()`).
- Conventional Commits; commit after each task.

---

### Task 1: Config-override store (SQLite + ConfigStore)

**Files:** Modify `server/helmsman/db.ts`; Create `server/helmsman/config-store.ts` + `server/helmsman/config-store.test.ts`.

**Interfaces:**
- `db.ts`: add table in `openDb`'s `exec`:
  ```sql
  CREATE TABLE IF NOT EXISTS config_overrides (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt TEXT NOT NULL);
  ```
  Add to the `Db` interface + impl: `getConfigOverrides(): Record<string, string>` (SELECT all → map) and `setConfigOverride(key: string, value: string, ts: string): void` (INSERT ... ON CONFLICT(key) DO UPDATE SET value=@value, updatedAt=@ts).
- `config-store.ts`:
  - `export const EDITABLE_KEYS: readonly string[] = ['AGENT_ADAPTER','AGENT_CMD','AGENT_MAX_ATTEMPTS','AGENT_MAX_COST_USD','AUTO_CLAIM_INTERVAL_MS','REPO_PROJECT_MAP','JIRA_PROJECT','JIRA_ASSIGNEE','JIRA_JQL','GITHUB_REPO','GITHUB_PR_AUTHOR'];`
  - `export const SECRET_KEYS: readonly string[] = ['JIRA_API_TOKEN','GITHUB_TOKEN','JIRA_EMAIL'];`
  - `export function publicConfig(cfg: AppConfig): Record<string, unknown>` — the non-secret effective values: `{ agentAdapter, agentCmd, maxAttempts, maxCostUsd, autoClaimIntervalMs, repoProjectMap, jiraProject: cfg.jira?.project ?? null, jiraAssignee: cfg.jira?.assignee ?? null, jiraJql: cfg.jira?.jql ?? null, githubRepo: cfg.github?.repo ?? null, githubAuthor: cfg.github?.author ?? null }`. Contains no token/email.
  - `export class ConfigStore { constructor(baseEnv: Record<string,string|undefined>, db: Db); effectiveEnv(): Record<string,string|undefined>; current(): AppConfig; overrides(): Record<string,string>; setOverride(key: string, value: string, now: () => string): void }`
    - `effectiveEnv()` = `{ ...this.baseEnv, ...this.db.getConfigOverrides() }`.
    - `current()` = `loadConfig(this.effectiveEnv())`.
    - `setOverride`: `if (SECRET_KEYS.includes(key) || !EDITABLE_KEYS.includes(key)) throw new Error(\`not an editable config key: ${key}\`);` then `db.setConfigOverride(key, value, now())`.
    - `overrides()` = `db.getConfigOverrides()`.
    - Fields assigned explicitly in the constructor body (no param properties).

- [ ] **Step 1: Failing test** (`config-store.test.ts`, `openDb(':memory:')`): `current()` equals `loadConfig(env)` with no overrides; after `setOverride('AGENT_MAX_ATTEMPTS','3',()=>ts)`, `current().maxAttempts === 3` and `overrides()` has that key; `setOverride('JIRA_API_TOKEN',...)` throws; `setOverride('NOPE',...)` throws; `publicConfig(current())` has no `JIRA_API_TOKEN`/`GITHUB_TOKEN`/`JIRA_EMAIL` keys and includes `agentAdapter` + `maxAttempts`.
- [ ] **Step 2: Run → FAIL** (`npx vitest run server/helmsman/config-store.test.ts`).
- [ ] **Step 3: Implement** the db methods + table and `config-store.ts`.
- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit` + `npm test`.
- [ ] **Step 5: Commit** `feat(helmsman): SQLite config-override store layered over env`.

---

### Task 2: Config API endpoints (router)

**Files:** Modify `server/helmsman/router.ts` (+ `router.test.ts`).

**Interfaces:**
- `RouterDeps` gains:
  - `getConfig: () => { config: Record<string, unknown>; overridden: string[] }`
  - `setConfig: (key: string, value: string) => { ok: true } | { ok: false; error: string }`
- `handleApi` branches:
  - `GET /api/config` → `{ status: 200, json: deps.getConfig() }`.
  - `PUT /api/config` body `{ key?: string; value?: string }` → if `key`/`value` missing/non-string → 400 `{error:'key and value required'}`; else `const r = deps.setConfig(key, value); r.ok ? { status:200, json:{ key, value } } : { status:400, json:{ error: r.error } }`.

- [ ] **Step 1: Failing router tests** — stub `getConfig` → `{ config: { agentAdapter:'claude-code', maxAttempts:1 }, overridden: ['AGENT_MAX_ATTEMPTS'] }`; assert `GET /api/config` returns it and the json contains no `JIRA_API_TOKEN`/`GITHUB_TOKEN` key. `PUT /api/config {key:'AGENT_MAX_ATTEMPTS',value:'3'}` with a `setConfig` stub returning `{ok:true}` → 200 `{key,value}`; a `setConfig` stub returning `{ok:false,error:'not editable'}` → 400 with the error; `PUT` with no key → 400.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the two branches (place before the `/api/` 404 fallthrough). Extend `RouterDeps`.
- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit` + `npm test`.
- [ ] **Step 5: Commit** `feat(helmsman): GET/PUT /api/config endpoints`.

---

### Task 3: Broadened launch backend (any-ticket, free-form, title fetch)

**Files:** Modify `server/helmsman/agents/adapter.ts` (AgentTask), `server/helmsman/agents/claude-code.ts` (buildPrompt), `server/helmsman/runner.ts` (+ `runner.test.ts`), `server/jira.ts` (+ used in launch), `server/helmsman/router.ts` (+ `router.test.ts`), `server/helmsman/agents/claude-code.test.ts` (if present, else assert buildPrompt via a small exported helper).

**Interfaces:**
- `AgentTask` gains `task?: string` (a free-form instruction; when set, there is no Jira ticket to claim).
- `claude-code.ts`: export `buildPrompt(task: AgentTask): string` is already module-private — make the branch: if `task.task` is a non-empty string, the prompt is the free-form instruction (`\`${task.task}\`` + the same "unattended, push + open PR, do not merge" rules, referencing the repo checkout as cwd); else the existing ticket prompt. Keep it exported-for-test or add a tiny test through the adapter; prefer exporting `buildPrompt` for a direct unit test.
- `jira.ts`: `export async function fetchIssueSummary(jira: JiraConfig, key: string): Promise<string | null>` — `GET /rest/api/3/issue/{key}?fields=summary`; return `body.fields.summary ?? null`; fail-soft (`catch → null`, non-ok → null).
- `router.ts` launch branch accepts `{ ticketId?, title?, repo, task?, mode? }`:
  - `mode === 'freeform'`: require `task` + `repo` (400 otherwise); call `deps.launch({ repo, task })` (launch body type extended — see below).
  - else (ticket): require `ticketId` + `repo` (400 otherwise); `deps.launch({ ticketId, title, repo })`.
  - `RouterDeps.launch` type becomes `(body: { ticketId?: string; title?: string; repo: string; task?: string }) => string`.
- `runner.startRun`: `claimTicket` is already guarded by `deps.jira && deps.botAccountId`; add `&& task.ticketId` so a free-form run (empty `ticketId`) never claims. `markInReview` already needs `prNumber != null`; also guard `&& task.ticketId`. The run row `ticketId` for free-form is a synthetic label — the caller (main.ts) passes `ticketId: 'freeform'` for display; the *prompt* uses `task.task`. (So `AgentTask.ticketId` stays required for the row; free-form sets it to `'freeform'` and sets `task`.)

- [ ] **Step 1: Failing tests:**
  - `runner.test.ts`: a run with `task = { ticketId:'freeform', title:'', repo:'o/r', jiraBaseUrl:'', task:'do the thing' }`, `jira` + `botAccountId` present → assert `jira.assignCalls` and `jira.transitionCalls` are **empty** (no claim, no In-Review) and the adapter still ran + the run row is recorded.
  - `claude-code` buildPrompt: `buildPrompt({ticketId:'freeform',title:'',repo:'o/r',jiraBaseUrl:'',task:'Add a healthcheck'})` contains `Add a healthcheck` and the push/PR rule, and does NOT contain `Jira ticket`; the ticket-mode `buildPrompt({ticketId:'X-1',title:'T',...})` contains `X-1`.
  - `jira.test` (or a new case): `fetchIssueSummary` returns the summary on 200 and `null` on a non-ok/throw (stub `fetch`).
  - `router.test.ts`: `POST /api/agents/launch {mode:'freeform', task:'x', repo:'o/r'}` → calls `launch({repo:'o/r', task:'x'})` and 200; `{mode:'freeform', repo:'o/r'}` (no task) → 400; existing `{ticketId,repo}` still 200.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** across the files. Extend `AgentTask`, the `buildPrompt` branch, the runner guards, `fetchIssueSummary`, the router launch branch + `RouterDeps.launch` type.
- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit` + `npm test`.
- [ ] **Step 5: Commit** `feat(helmsman): launch any ticket or a free-form task`.

---

### Task 4: main.ts — dynamic config + wire config/launch

**Files:** Modify `server/helmsman/main.ts`, `server/dashboard-endpoint.ts` (accept a merged env), `.env.example` (note UI-editable keys).

**Interfaces / behavior:**
- Construct `const configStore: ConfigStore = new ConfigStore(process.env, db);` (after `db`). Remove `const config = loadConfig(process.env)`.
- Replace every `config.X` read with `configStore.current().X` **at use time**: inside `launch()` (jira actions, botAccountId, statuses, findPrNumber via `current().github`, maxAttempts, maxCostUsd, repoProjectMap for `fetchTopBacklog`), the scheduler's `fetchTopBacklog`, the `handleApi` deps (`caps`, `dashboard`). Bind a `const cfg: AppConfig = configStore.current();` locally at the top of each such function/callback rather than capturing a stale outer value.
- Adapter selection currently module-scope from `config` — move it to read `configStore.current()` inside `launch()` (so an adapter/`AGENT_CMD` edit takes effect on the next launch): `const cfg = configStore.current(); const adapter = cfg.agentAdapter === 'command' && cfg.agentCmd ? commandAdapter(cfg.agentCmd) : claudeCodeAdapter;` (keep the empty-`AGENT_CMD` stderr fallback).
- `launch()` extended: signature `launch(body: { ticketId?: string; title?: string; repo: string; task?: string }): string`. For a ticket with no `title`, fetch it: `const title = body.title ?? (cfg.jira ? (await fetchIssueSummary(cfg.jira, body.ticketId!).catch(() => null)) : null) ?? body.ticketId!;` — note `launch` currently returns synchronously with a generated runId; keep that by doing the title fetch **inside** the async `startRun` driver, OR resolve the title before `startRun` (launch can stay sync by passing the raw body into the async closure). Simplest: keep `launch` sync (return runId immediately), and inside the async work resolve title/task. Set `AgentTask.ticketId = body.ticketId ?? 'freeform'`, `title = resolvedTitle ?? body.ticketId ?? 'freeform'`, `task = body.task`.
- `dashboard-endpoint.ts`: `buildDashboardResponse` currently reads `process.env`; change its call in `main.ts` to pass `configStore.effectiveEnv()` so config edits (repo map, Jira project/assignee/jql) affect the dashboard. (Adjust the function signature only if it takes an env param today; if it reads `process.env` internally, add an `env` parameter and pass it through to its `loadConfig`.)
- Wire config endpoints into `handleApi` deps: `getConfig: () => ({ config: publicConfig(configStore.current()), overridden: Object.keys(configStore.overrides()) })`, `setConfig: (key, value) => { try { configStore.setOverride(key, value, () => new Date().toISOString()); return { ok: true }; } catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'invalid' }; } }`.
- `.env.example`: add a comment noting these keys are also editable at runtime from the UI (secrets are not).

- [ ] **Step 1:** No new unit test (composition root). Make the edits.
- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean; `npm test` green (Task 1–3 tests still pass); `npm run build` succeeds. Manually confirm (read-through) no `config.` reads remain that bypass `configStore`.
- [ ] **Step 3: Commit** `refactor(helmsman): read config dynamically via ConfigStore; wire config + broadened launch`.

---

### Task 5: Client data layer

**Files:** Modify `src/data/agents.ts`; Create `src/data/config.ts` (+ `src/data/config.test.ts` if a stubbed-fetch test fits the existing style).

**Interfaces:**
- `src/data/config.ts`:
  - `export interface UiConfig { config: Record<string, unknown>; overridden: string[] }`
  - `export async function getConfig(): Promise<UiConfig>` — `GET /api/config`, fail-soft `{ config:{}, overridden:[] }` on error.
  - `export async function setConfig(key: string, value: string): Promise<{ ok: boolean; error?: string }>` — `PUT /api/config` JSON `{key,value}`; return `{ok:res.ok, error}` (fail-soft, no throw).
- `src/data/agents.ts`: add `export async function launchRun(body: { ticketId?: string; title?: string; repo: string; task?: string; mode?: 'ticket' | 'freeform' }): Promise<LaunchResult>` — POST `/api/agents/launch`. Keep the existing `launchAgent(ticketId,title,repo)` as a thin wrapper delegating to `launchRun` (so the queue Launch path is unchanged) — or replace its body to call `launchRun`. Do not leave two independent fetch implementations.

- [ ] **Step 1:** Add `src/data/config.ts` + `launchRun`; make `launchAgent` delegate to `launchRun`.
- [ ] **Step 2: Verify** — `npx tsc --noEmit` + `npm test`. (A stubbed-fetch test for `getConfig`/`setConfig` fail-soft is welcome but optional if the file mirrors `stopAgent`'s established fail-soft shape.)
- [ ] **Step 3: Commit** `feat(ui): client helpers for config + generalized launch`.

---

### Task 6: UI — New-run panel, Recent-runs list, Config panel

**Files:** Modify `src/render.ts` (+ `src/render.test.ts`), `src/main.ts` (+ `src/main.test.ts`), `src/style.css`.

**Interfaces / behavior:**
- `renderDashboard` gains two params after `caps`: `recentRuns: RunSummary[] = []` (terminal runs) and `uiConfig: UiConfig = { config:{}, overridden:[] }`. (Alternatively derive `recentRuns` inside from the full `runs` list — simpler: keep passing the full `runs` and split inside into active vs terminal. Choose: split inside `renderDashboard` from the existing `runs` param; add only `uiConfig`.)
- **New run panel** (top of the grid or near the queue): a `mode` control (`.newrun-mode` radio/toggle Ticket|Free-form); Ticket = `.newrun-ticket` input + repo `<select class="newrun-repo">` (options from `repos`) + optional `.newrun-title` input; Free-form = `.newrun-task` textarea + the repo select; a `.newrun-launch` button. Fields for the inactive mode are hidden.
- **Recent runs panel**: from `runs.filter(status !== 'running')`, a `.recent-run` row each with `data-runid`, ticket id (or `freeform`), short repo, a status chip (`succeeded`/`failed`/`stopped`), cost, and a PR link (`#<n>`, `https://github.com/<repo>/pull/<n>`) when `prNumber` set. Empty note when none. Escape ids/repos.
- **Config panel**: for each key in `uiConfig.config`, a labeled read/edit row (`.config-row` with `data-key`), value in a `.config-input`, a `.config-save` button; an "overridden" marker when the key is in `overridden`. A short warning line that adapter/`AGENT_CMD` are powerful and the auto-claim interval applies on restart. Never render a secret (the payload never contains them).
- `DashboardView` (`src/main.ts`):
  - Fetch config in `refresh()` alongside runs: `this.uiConfig = await getConfig()`; pass into `renderDashboard`.
  - Delegated handlers (extend the single `handleClick` / add a `change`/`submit` listener bound once): `.newrun-launch` → read mode + fields → `launchRun({...})` → open drawer + `openRunStream(runId)` (reuse the `launchSeq`/`activeStreamUnsubscribe` guards + the existing launch drawer path); `.recent-run` row click → open drawer + `openRunStream` (same as agent-row); `.config-save` → `setConfig(key, input.value)` then `refresh()`.
  - Hold no free `let`; state on `DashboardView` fields (`uiConfig`).

- [ ] **Step 1: Failing render tests** — New-run panel renders both modes' controls (ticket input + repo select; free-form textarea) and a launch button; Recent-runs list renders terminal runs (status chip + PR link) and excludes running ones + shows an empty note when none; Config panel renders a row per `uiConfig.config` key with its value and marks overridden keys, and renders **no** row whose key is a secret (feed a payload that (correctly) omits secrets and assert none appear).
- [ ] **Step 2: Failing main tests** — clicking `.newrun-launch` in free-form mode calls `launchRun` (stub) with `{repo, task, mode:'freeform'}` and opens the drawer; a `.recent-run` click opens the drawer + `openRunStream(runId)`; `.config-save` calls `setConfig(key,value)` then refreshes. (Stub `launchRun`/`setConfig`/global `fetch`/`EventSource` per the file's existing patterns.)
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** render + main + CSS (reuse tokens; keep the Tactical-HUD look). Split `runs` into active/recent inside `renderDashboard`.
- [ ] **Step 5: Run → PASS** — `npx vitest run src` + `npm run build` + `npm test` + `npx tsc --noEmit`.
- [ ] **Step 6: Commit** `feat(ui): new-run panel, recent-runs history, and config editor`.

---

### Task 7: Build + end-to-end check

- [ ] **Step 1:** `npm run build`, `npx tsc --noEmit`, `npm test` all green.
- [ ] **Step 2 (manual, optional live):** `npm run dev`; (a) New run → Free-form against backlog-runner ("add a comment to README") → streams, opens a PR on our repo; (b) New run → Ticket by ID for a ticket not in the queue → claims + runs; (c) open a completed run from Recent runs → its stored log + PR link show; (d) Config panel → change `AGENT_MAX_ATTEMPTS`, save, confirm `overridden` marks it and a new launch reads it. **Real spawn/PR/Jira — run only with consent.**
- [ ] **Step 3: Commit** README updates (New run, Recent runs, Config editor, runtime-editable keys + the secret/interval caveats).

---

## Self-Review

- Launch any ticket by ID → Task 3 (router mode:'ticket', no queue gate) + Task 6 (New-run panel). ✓
- Free-form task, no Jira → Task 3 (`AgentTask.task`, buildPrompt branch, runner skip-claim) + Task 6. ✓
- Run history + re-open → Task 6 (Recent-runs list over existing `/api/agents`; re-open via `openRunStream`). ✓
- Runtime config (SQLite overrides, live) → Tasks 1–2 (store + API), Task 4 (dynamic reads), Task 6 (Config panel). ✓
- Secrets never exposed/editable → `publicConfig` omits them (Task 1), `EDITABLE_KEYS`/`SECRET_KEYS` gate `setOverride` (Task 1), render feeds a secret-free payload (Task 6). ✓
- Auto-claim interval length applies on restart; other edits live → Task 4 (reads `current()` per launch/tick; timer length noted). ✓
- No placeholders; each task names files, interfaces, and test cases.
- Type consistency: `AppConfig` is the shape `ConfigStore.current()` returns and `publicConfig` projects; `RouterDeps.launch`/`getConfig`/`setConfig` match main.ts's wiring; `launchRun` body matches the router launch branch; `UiConfig` is shared by `getConfig` and `renderDashboard`.
- Replace-don't-duplicate: `launchAgent` delegates to `launchRun` (one fetch path); adapter selection moves into `launch()` (removing the module-scope const), not duplicated; `config` const fully replaced by `configStore`.
- Idiom: `erasableSyntaxOnly` respected in `ConfigStore` (explicit field + assignment, no param properties).

## Execution note

Delivered as one PR (per the spec). Recommend subagent-driven-development: fresh implementer per task, task review after each, whole-branch review at the end, then one PR to the fork stacked on `master`. Task 4 is a composition-root refactor (no unit test) — lean on tsc + build + the Task 1–3 tests, and review it carefully for stale `config.` reads.
