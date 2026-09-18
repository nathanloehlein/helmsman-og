# Backlog Runner → Agent Control Plane

**Date:** 2026-08-18
**Status:** Approved design

## Goal

Transform Backlog Runner from a read-only dashboard into a **one-stop control plane** that launches CLI coding agents against Jira tickets, streams their work live, and drives each ticket through the loop the README already describes: claim → explore → implement → test → open PR → transition to In Review → stop. Multiple agents run concurrently on separate tickets (single-flight per repo). A human still reviews and merges — the agent never merges.

## Decisions (from brainstorming)

- **Agent execution:** an `AgentAdapter` interface with two implementations — a first-class **Claude Code** adapter (`claude -p --output-format stream-json`) and a **generic-command** adapter (configurable command template). Claude Code is the default.
- **Loop model:** *one session → PR gate*. A single agent session works the ticket end-to-end and stops at the gate (PR opened + Jira → In Review). Re-run only on failure, bounded by a max-attempts cap.
- **Autonomy:** manual **Launch** per ticket, plus an optional per-repo **auto-claim** toggle that pulls the top backlog ticket automatically. Single-flight per repo either way.
- **Workspace:** a **git worktree per task** inside a configured local checkout of each repo.
- **State:** **Jira remains the task state store** (`Backlog → In Progress → In Review → Done`). **SQLite** is added for *runtime* state only — run history, streamed events/logs, and metrics — which Jira does not model. This is a deliberate, scoped deviation from the README's "no parallel DB": SQLite never shadows ticket status; it records agent runs.

## Architecture

### Runtime shift

Today a Vite dev-server plugin serves read-only `/api/dashboard`. That is dev-only and cannot spawn or supervise processes. The target is a **persistent Helmsman Node process**:

- Serves the dashboard API **and** the new control/stream API over `node:http`.
- Spawns and supervises agent processes (`node:child_process`).
- Owns the SQLite database.
- Manages git worktrees (shell-out to `git`).
- In **dev**: runs alongside Vite; Vite proxies `/api/*` to it (`server.proxy`). In **prod/normal use**: serves the built `dist/` UI itself.

The existing pure/fetch modules (`config.ts`, `jira.ts`, `github.ts`, `snapshot.ts`, `dashboard-endpoint.ts`) move under Helmsman and are reused unchanged for the read/dashboard path. `vite-plugin-dashboard.ts` is removed; a Vite proxy replaces it.

### Dependencies

- New runtime dep: **better-sqlite3** (synchronous, simple embedded SQLite).
- Everything else uses Node built-ins: `node:http` (REST + SSE), `node:child_process` (spawn agents + git), `node:fs`, `URL`.
- Dev orchestration: a `concurrently`-style script or a tiny custom runner to start Vite + Helmsman together (prefer a plain npm script over a dep if feasible).

### Modules (`server/helmsman/`)

| Module | Responsibility |
| --- | --- |
| `server.ts` | HTTP server: REST endpoints + SSE; static serving in prod; wires the rest together. |
| `db.ts` | SQLite open/migrate + typed queries. Tables: `runs`, `run_events`. |
| `agents/adapter.ts` | `AgentAdapter` interface + shared event types. |
| `agents/claude-code.ts` | Spawn `claude -p --output-format stream-json`; map stream-json → `AgentEvent`s. |
| `agents/command.ts` | Generic adapter: run a configured command template, treat stdout lines as events. |
| `runner.ts` | Drive one run: create worktree → spawn adapter → stream events (SQLite + SSE) → detect PR → transition Jira → mark done → remove worktree. Failure re-run with cap. |
| `process-manager.ts` | Registry of active runs; enforce single-flight per repo + global max concurrency; start/stop; expose active snapshot. |
| `worktree.ts` | `git worktree add/remove` per task inside the configured repo checkout. |
| `scheduler.ts` | Optional per-repo auto-claim heartbeat: query backlog JQL, claim top ticket, launch (single-flight). |
| `jira-actions.ts` | **Jira writes** (new): assign ticket to the bot, transition status. |

### API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/dashboard` | Existing read snapshot (unchanged contract). |
| POST | `/api/agents/launch` | `{ ticketId, repo }` → start a run. |
| POST | `/api/agents/:runId/stop` | Terminate a run + its process/worktree. |
| GET | `/api/agents` | Active + recent runs (from SQLite). |
| GET | `/api/agents/:runId/log` | **SSE** live event/log stream for a run. |
| POST | `/api/repos/:repo/auto-claim` | `{ enabled }` → toggle the auto-claim scheduler for a repo. |

### Data model (SQLite)

```
runs(
  id TEXT PRIMARY KEY,          -- run id
  ticket_id TEXT,               -- Jira key
  repo TEXT,
  adapter TEXT,                 -- 'claude-code' | 'command'
  status TEXT,                  -- 'running' | 'succeeded' | 'failed' | 'stopped'
  attempt INTEGER,
  pr_number INTEGER,            -- set when the agent opens a PR
  started_at TEXT,              -- ISO
  ended_at TEXT,                -- ISO, null while running
  cost_usd REAL,                -- from adapter, when available
  worktree_path TEXT
)
run_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,                  -- FK runs.id
  ts TEXT,                      -- ISO
  kind TEXT,                    -- 'phase' | 'tool' | 'log' | 'result' | 'error'
  text TEXT
)
```

Timestamps are ISO strings supplied by Helmsman at write time.

### Agent adapter contract

```ts
interface AgentTask { ticketId: string; title: string; repo: string; jiraBaseUrl: string }
interface AgentEvent { kind: 'phase' | 'tool' | 'log' | 'result' | 'error'; text: string; costUsd?: number; prNumber?: number }
interface AgentHandle { stop(): void; readonly exit: Promise<{ ok: boolean; prNumber?: number; costUsd?: number }> }
interface AgentAdapter {
  readonly id: string;
  start(task: AgentTask, workdir: string, onEvent: (e: AgentEvent) => void): AgentHandle;
}
```

The Claude Code adapter parses `stream-json` events into `AgentEvent`s (tool uses, text, final result with cost). The command adapter emits one `log` event per stdout line and infers `prNumber` from a trailing marker or a post-run `gh pr list` check.

### Task lifecycle (one run)

1. Launch (manual or auto-claim) → `process-manager` checks single-flight for the repo; rejects if busy.
2. `jira-actions.assign(ticket, bot)` + `transition(ticket, In Progress)`; write `runs` row (`running`).
3. `worktree.create(repo, runId)` → fresh branch off the repo's default.
4. `runner` spawns the adapter in the worktree; every `AgentEvent` is written to `run_events` and pushed to any SSE subscribers.
5. Agent opens a PR (the only write it performs beyond its branch). Helmsman captures `prNumber`, `transition(ticket, In Review)`.
6. Mark `runs` `succeeded`, `ended_at`, `cost_usd`; `worktree.remove`.
7. On non-zero exit / no PR: mark `failed`; re-run up to the attempts cap; then stop and leave the ticket In Progress for a human.

The agent **never merges to main**; Helmsman only transitions status — merge is always a human action.

### UI

- **Backlog queue** items gain a **Launch** action (disabled when the repo already has an active run — single-flight).
- The single **Working on** panel becomes **Agents running** — a list of active runs (repo, ticket, current phase, elapsed, cost, **Stop**). Empty state when none.
- Clicking a run opens a **live log drawer** subscribed to `GET /api/agents/:id/log` (SSE), rendering `run_events` as they arrive.
- Per-repo **auto-claim** toggle (in the repo selector area or a settings affordance).
- The **activity feed** and **Recently shipped** continue to reflect Jira/GitHub; agent lifecycle events also surface there.
- Dark HUD visual world and the full-viewport layout are preserved; new controls adopt the existing tokens/components.

### Config additions (`.env`)

- `AGENTS_ROOT` — local directory holding the per-repo checkouts Helmsman worktrees from.
- `AGENT_ADAPTER` — `claude-code` (default) | `command`.
- `AGENT_CMD` — command template for the generic adapter (`{ticket} {repo} {title}` placeholders).
- `AGENT_MAX_CONCURRENCY` — global cap on simultaneous runs.
- `AGENT_MAX_ATTEMPTS` — failure re-run cap (default e.g. 2).
- `BOT_ACCOUNT_ID` — Jira account id the agent claims tickets as.
- Jira token must now carry **write** scope (transitions + assignee).

## Security & guardrails

- The agent's only writes are its own branch + opening a PR; Helmsman's only Jira writes are status transitions + assignee. **No merge is ever automated.**
- Single-flight per repo prevents two agents colliding on one codebase.
- `AGENT_MAX_CONCURRENCY` bounds resource use; `AGENT_MAX_ATTEMPTS` bounds cost on failing tickets.
- Worktrees are created under `AGENTS_ROOT` and removed on completion; a startup sweep prunes orphaned worktrees from crashed runs.
- Secrets stay server-side (`.env`), never sent to the browser — unchanged from today.

## Phased roadmap

Each phase is independently shippable and testable and gets its own implementation plan.

- **P0 — Backend foundation.** Stand up the Helmsman `node:http` server; move the dashboard API into it; add the Vite dev proxy; scaffold SQLite (`db.ts` + migrations). No user-visible behavior change; the dashboard renders through the new server.
- **P1 — Single run.** `AgentAdapter` + Claude Code adapter; `worktree.ts`; `runner` for one manual run; SSE log stream + a log drawer in the UI; persist the run in SQLite. **No Jira writes yet** — the agent works, you watch the stream.
- **P2 — Lifecycle + gate.** `jira-actions` writes (assign, In Progress, In Review); PR detection; single-flight per repo; failure re-run cap. The full one-session→gate loop.
- **P3 — Multi-agent UI.** Replace "Working on" with the running-agents view; Stop controls; per-agent live logs; metrics (elapsed/cost/attempts) from SQLite.
- **P4 — Autonomy.** Per-repo auto-claim scheduler + toggle.
- **P5 — Generic adapter + hardening.** The command adapter behind the interface; crash recovery from SQLite; orphaned-worktree sweep; cost/attempt caps surfaced in the UI.

## Out of scope

- Automating merge or any post-review action.
- Remote/multi-machine execution (single local Helmsman only).
- Auth on the control API (assumes a trusted local operator, same as today's local dashboard).
- Replacing Jira/GitHub as the sources of truth.

## First implementation plan

Following this spec, the writing-plans step produces the **Phase 0 + Phase 1** implementation plan (backend foundation through a first live single run), since those establish Helmsman and adapter the later phases build on.
