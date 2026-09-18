# UI Control Plane (P6) — Design

## Goal

Make the browser a full control surface for Helmsman: launch a run for **any** Jira ticket (not just the auto-fetched backlog), launch a **free-form** task with no ticket, **view every run's output** live and after the fact (running + completed/failed/stopped), and **edit non-secret runtime config** from the UI with changes that persist and take effect without a restart.

Builds on P0–P5 (Helmsman, SQLite run store, `AgentAdapter`, auto-claim, hardening). One change, one PR.

## Non-goals

- No steering a running agent (no mid-run chat/approval). Agents run unattended (`--dangerously-skip-permissions`); the only run controls remain Launch and Stop.
- No merging from the UI. The agent opens a PR and stops; merge stays a human action on the forge. The gate is unchanged.
- No editing or exposing secrets (`JIRA_API_TOKEN`, `GITHUB_TOKEN`, `JIRA_EMAIL`) from the UI.
- No auth/multi-user. Helmsman remains a single-user local process bound to `127.0.0.1`.

## Security posture

- Helmsman binds `127.0.0.1` only. All new endpoints (`/api/config`, the broadened launch) inherit that guard — same trust boundary as the existing `launch`/`stop`.
- Secrets are never returned by `GET /api/config` and never accepted by `PUT /api/config` (not in the editable allowlist). They stay `.env`-only.
- `AGENT_ADAPTER` and `AGENT_CMD` **are** UI-editable (explicit product decision). This is an RCE surface — the command adapter runs whatever `AGENT_CMD` names — but it is bounded by the localhost guard, and the command adapter already builds a no-shell tokenized argv (a ticket title cannot inject). Accepted under the localhost boundary.
- Free-form task text is passed to the agent prompt, not to a shell.

## Architecture

Three additions to the existing two processes (Vite UI + Helmsman Node server). No new services, no new deps.

### A. Config override layer (SQLite) — the core refactor

Today `server/helmsman/main.ts` computes `const config = loadConfig(process.env)` once at module load and reads it directly. To make config UI-editable without a restart, config reads become dynamic through a **ConfigStore**.

- New SQLite table:
  ```sql
  CREATE TABLE IF NOT EXISTS config_overrides (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  ```
- `ConfigStore` (new `server/helmsman/config-store.ts`), constructed with the base env and the `Db`:
  - `current(): AppConfig` — recomputes the effective config as `loadConfig({ ...baseEnv, ...overrideEnv })`, where `overrideEnv` is the override rows keyed by their env-var name. Cheap; called per launch / per tick / per config read.
  - `setOverride(key: string, value: string): void` — validates `key` against the editable allowlist (throws on a non-allowlisted or secret key), upserts the row.
  - `overrides(): Record<string, string>` — the raw override map (for the UI to show which keys are overridden).
- **Editable allowlist** (env-var names): `AGENT_ADAPTER`, `AGENT_CMD`, `AGENT_MAX_ATTEMPTS`, `AGENT_MAX_COST_USD`, `AUTO_CLAIM_INTERVAL_MS`, `REPO_PROJECT_MAP`, `JIRA_PROJECT`, `JIRA_ASSIGNEE`, `JIRA_JQL`, `GITHUB_REPO`, `GITHUB_PR_AUTHOR`.
- **Secret denylist** (never editable, never returned): `JIRA_API_TOKEN`, `GITHUB_TOKEN`, `JIRA_EMAIL`.
- `main.ts` refactor: replace the `const config` reads with `configStore.current()` at each use site — `launch()` reads it at call time; the auto-claim tick reads it each tick; the dashboard/caps/scheduler wiring reads it per request. The `setInterval` for auto-claim reads `current().autoClaimIntervalMs` each tick (interval value can't change a live timer, but the *fetch/enabled* behavior tracks current config; document that the interval length itself needs a restart — or re-arm the timer on change, see Open Decisions → resolved below).
  - **Resolved:** the auto-claim interval **length** change requires a restart; changing it via the UI updates the stored value and the next Helmsman start uses it. Every other edited field takes effect immediately because it is read at launch/tick/request time. This is stated in the UI ("interval applies on restart").
- API:
  - `GET /api/config` → `{ config: <non-secret effective values>, overridden: string[] }`. Never includes secret keys.
  - `PUT /api/config` body `{ key, value }` → allowlist-checked; 400 on a non-editable/secret/unknown key; on success persists and returns `{ key, value }`. `DELETE`-style clear is out of scope for P6 (set to the desired value; to revert, restart drops nothing — noted as a follow-up).

### B. Broadened launch (any ticket + free-form)

- The launch API body becomes `{ ticketId?, title?, repo, task?, mode? }`:
  - `mode: 'ticket'` (default): `ticketId` + `repo` required; `title` optional. If `title` is absent, Helmsman fetches the summary from Jira by ID (fail-soft: on any error, fall back to using `ticketId` as the title). Not gated on the backlog queue — any ticket ID works.
  - `mode: 'freeform'`: `task` + `repo` required; no `ticketId`. No Jira claim/transition happens. A synthetic run id/label is used for display.
- `AgentTask` gains optional `task?: string`. `buildPrompt` branches: with `task`, the prompt is the free-form task against the repo (explore → implement → test → push → open PR, same unattended/PR-required rules); without, the existing ticket prompt.
- `runner.startRun`: the Jira claim (`claimTicket`) and `markInReview` already guard on `deps.jira && deps.botAccountId` / `prNumber`. For free-form there is no ticket, so the runner must also skip the claim/transition when `task.ticketId` is empty. The run row's `ticketId` for a free-form run is a short synthetic label (e.g. `freeform`), so history stays readable.
- Jira title fetch: a new `fetchIssueSummary(jira, key): Promise<string | null>` in `server/jira.ts` (fail-soft), used by `launch` for the title default.

### C. Run history + re-open

- `GET /api/agents` already returns **all** runs (client-safe projection, most-recent 50). The UI today filters to `status === 'running'`; P6 adds a second **"Recent runs"** list rendering the non-running runs with a status chip, cost, elapsed/ended, and a PR link when present.
- Clicking any run row (running or terminal) opens the existing log drawer and calls `openRunStream(runId)`. For a terminal run the SSE replays the stored `run_events` and settles immediately on the stored `run-complete` — the footer shows final status + PR. No backend change needed beyond what exists.

## UI shape

- **Topbar** unchanged (repo selector, auto-claim toggle) + a new **Config** affordance (a gear opening a panel/section).
- **New run** panel: `mode` toggle (Ticket | Free-form); Ticket mode = ticket-ID input + repo select + optional title; Free-form mode = task textarea + repo select; a Launch button. On launch, open the drawer + stream (same path as the queue Launch).
- **Agents running** panel unchanged (live runs, Stop, click-to-open).
- **Recent runs** panel (new): terminal runs, click-to-reopen, status/cost/PR.
- **Config** panel: shows each editable key with its effective value + whether overridden; edit + save (`PUT /api/config`); secrets are not shown. A note that adapter/`AGENT_CMD` edits are powerful and that the auto-claim interval length applies on restart.
- All untrusted strings escaped before `innerHTML` (existing `esc()`); config values echoed into the DOM are escaped.

## Data flow

Browser → 5173 (Vite, proxy) → 8787 Helmsman. New: `GET/PUT /api/config` and the extended launch body. Config edits write `config_overrides`; subsequent launches/ticks/requests read the merged effective config via `ConfigStore.current()`.

## Testing strategy

- `config-store`: overrides merge over env; allowlist accepts editable keys and rejects secret/unknown keys; `current()` reflects a set override; `overridden()` lists them. (Real `openDb(':memory:')`.)
- `router`: `GET /api/config` returns effective non-secret values + `overridden`, and omits secret keys even if somehow present; `PUT /api/config` persists an allowlisted key and 400s a secret/unknown key.
- `jira`: `fetchIssueSummary` returns the summary and is fail-soft (null on error) — stubbed `fetch`.
- `runner`: a free-form run (no `ticketId`) does **not** call Jira claim/transition and still runs the adapter + records the run; `buildPrompt` free-form branch is exercised.
- `render`: the New-run panel renders both modes; the Recent-runs list renders terminal runs with status/PR and is click-to-open; config panel renders editable keys and never renders a secret key.
- `main.ts` (composition root) stays untested; covered by the store/router/runner tests + tsc + build.

## Rollout / compat

- Additive to the API: `/api/config` is new; the launch body extension is backward-compatible (`{ticketId,title,repo}` still works). `/api/agents` shape is unchanged.
- New SQLite table is created idempotently on open; existing DBs upgrade transparently.
- `.env` remains the source of secrets and the base for all config; a fresh install with no overrides behaves exactly as today.

## Open decisions (resolved)

- **Config persistence:** SQLite overrides layered over `.env` (durable, no secret-file writes).
- **Adapter/`AGENT_CMD` editable:** yes, under the `127.0.0.1` guard.
- **Auto-claim interval length change:** applies on restart; all other edits are live.
- **Reverting an override:** out of scope for P6 (set the value explicitly); a "clear override" action is a follow-up.
- **Delivery:** one spec → one plan → one PR.
