# Backlog Runner → cmux Control Bridge

**Date:** 2026-09-01
**Status:** Approved design

## Goal

Let the dashboard **see and drive live cmux terminal tabs** — not just Helmsman-launched Jira runs. cmux ([cmux.com](https://cmux.com)) is a scriptable Ghostty-based terminal with a Unix-socket control CLI. The bridge surfaces every cmux tab (workspace/pane/surface) in the dashboard, streams a selected tab's screen live, and sends input to it: free-text commands and provider-aware high-level agent actions (continue / stop / interrupt / approve). This turns the dashboard into a single supervision surface for both headless Helmsman runs and interactive cmux agent sessions.

This is additive and isolated: a new `server/helmsman/cmux/` subsystem plus a new frontend panel. Zero coupling to the existing Jira/run/PR logic. If cmux is not running, the feature degrades cleanly and the rest of the dashboard is unaffected.

## Decisions (from brainstorming)

- **Scope: all cmux tabs.** Every window/workspace/pane/surface cmux reports, not only Helmsman-launched agents. Full remote control of the user's terminal from the dashboard.
- **Interaction: free-text + high-level agent actions.** Type arbitrary text into a tab (`cmux send`), plus provider-aware action buttons that map to key sequences (`cmux send-key`). Raw control-key access falls out of the action map.
- **Readback: live screen.** Stream the selected tab's rendered screen into the dashboard so the user watches while they type.
- **Transport: CLI shell-out + polled `read-screen` (Approach 1).** The bridge spawns the documented `cmux` CLI over argv (never a shell string). Live screen is `read-screen` polled while a tab is selected. Tree changes come from one persistent `cmux events --reconnect` child. Rejected alternatives: `pipe-pane` raw-pty streaming into xterm.js (Approach 2 — higher fidelity, needs an ANSI terminal emulator + per-tab fifo lifecycle, deferred until polling lag is proven annoying); direct Unix-socket / `rpc` framing (Approach 3 — undocumented, brittle to cmux updates).
- **Rendering: plaintext `<pre>`, no terminal emulator.** `cmux read-screen` returns the *already-rendered* screen as plaintext (probed live 2026-09-01). No xterm.js, no ANSI parsing in v1.
- **Security posture: 127.0.0.1-only, argv-only send.** Sending arbitrary input to any terminal is RCE-equivalent by design. Acceptable *only* because Helmsman binds loopback for a single local user (existing invariant). The send path must use `spawn` with an argv array, never a shell string. See Security.

## Background: what cmux exposes (probed live)

cmux CLI resolves the running app's socket automatically (`cmux identify --json`). Confirmed working on 2026-09-01:

| Need | Command | Notes |
|---|---|---|
| Enumerate tabs | `cmux tree --all --id-format both` | Text tree with refs (`workspace:1`, `surface:1`) **and** UUIDs. |
| Live changes | `cmux events --reconnect --no-heartbeat` | Append-only JSON-line stream; `seq`, `category`, `name`, `payload`. Carries agent status (`set_status claude_code Running`). `--limit N` exits after N; `--reconnect` runs forever. |
| Read a tab | `cmux read-screen --surface <ref> --lines <n>` | Returns rendered plaintext (ANSI already applied). `--scrollback` for history. |
| Send text | `cmux send --surface <ref> <text>` | Types into the tab. |
| Send key | `cmux send-key --surface <ref> <key>` | e.g. `Enter`, `Escape`, `C-c`. |
| Target model | `window > workspace > pane > surface`; a *tab* is a surface within a pane. | Commands accept UUID, ref (`surface:2`), or index. |

Surface types: `terminal`, `browser`, `simulator`, `agent-session` (provider `claude` / `codex` / `opencode`).

## Architecture

### Runtime placement

The persistent Helmsman Node server (`server/helmsman/`, `node:http` + `node:child_process`) already spawns and supervises child processes and serves the REST + SSE API. The cmux bridge is another shell-out integration in the same mold as the existing git / `gh` / Claude adapters. In dev, Vite proxies `/api/*` to Helmsman (existing setup); the new endpoints ride that proxy with no config change.

One long-lived `cmux events --reconnect` child is owned by the Helmsman process (started lazily on first cmux API use, restarted on exit). Everything else is short-lived per-request `cmux` invocations.

### Modules (`server/helmsman/cmux/`)

| Module | Responsibility | Purity |
|---|---|---|
| `bridge.ts` | The only module that spawns `cmux`. `listTabsRaw()`, `readScreen(ref, lines)`, `send(ref, text, {enter})`, `sendKey(ref, key)`, `watchEvents(onEvent)`. Every call uses `spawn('cmux', [args…])` — argv only, no shell, no string interpolation into a command line. Detects "cmux not running" and reports it rather than throwing. | I/O; tested by mocking `spawn`. |
| `model.ts` | Normalize raw `tree` output → `CmuxTab[]`: `{ windowRef, workspaceRef, paneRef, surfaceRef, uuid, type, title, cwd?, provider?, status? }`. Parse-only. | Pure. |
| `actions.ts` | Map `provider → action → keySequence`. e.g. `claude`: `continue`→`[Enter]`, `stop`→`[Escape]`, `interrupt`→`[C-c]`, `approve`→`[y, Enter]`. `codex`/`opencode`/`terminal` variants. Returns the list of `send-key` calls a high-level action expands to, or the available action set for a given provider. | Pure. |

### Endpoints (existing `node:http` server)

| Endpoint | Purpose | Shape |
|---|---|---|
| `GET /api/cmux/tabs` | List all tabs. | `{ connected: boolean, tabs: CmuxTab[] }`. `connected:false` when cmux is down. |
| `GET /api/cmux/screen?surface=<ref>&lines=<n>` | Snapshot of one tab's rendered screen. | `{ surface, lines, text }` or 404 if the surface is gone. |
| `POST /api/cmux/send` | Send free text. Body `{ surface, text, enter? }`. | `{ ok: true }` / error. |
| `POST /api/cmux/action` | High-level action. Body `{ surface, action }`. Expands via `actions.ts` → one or more `send-key`. | `{ ok: true, keys: string[] }` / error. |
| `GET /api/cmux/events` | SSE. Emits `cmux-tabs-changed` (client re-fetches `/tabs`) on relevant cmux events (surface add/remove, status change). | text/event-stream. |

The screen is polled by the client via `GET /api/cmux/screen`, not pushed over SSE (v1 simplicity; the SSE channel is only for coarse tree/status changes).

### Frontend

- `src/logic/cmuxPanel.ts` — **pure**: panel state machine (selected surface, whether the screen poll is active), and `availableActions(tab)` derived from `actions.ts`'s provider map. Unit-tested with no DOM.
- `src/render.ts` — renders the panel: a **tab list** (grouped by window → workspace), the **selected tab's screen** in an auto-refreshing `<pre>`, a **text input + Send**, and **provider-aware action buttons**. Follows the existing New-run / Recent-runs panel pattern. New nav entry alongside the current dashboard view.

### Data flow

```
load ──▶ GET /api/cmux/tabs ──▶ render list
SSE /api/cmux/events ──(cmux-tabs-changed)──▶ re-fetch /tabs ──▶ re-render list
select tab ──▶ poll GET /api/cmux/screen every ~750ms ──▶ render <pre>
type + Send ──▶ POST /api/cmux/send ──▶ (next poll reflects it)
action button ──▶ POST /api/cmux/action ──▶ (next poll reflects it)
deselect / panel hidden ──▶ stop screen poll
```

## Security

- **RCE by design.** `POST /api/cmux/send` sends arbitrary bytes to arbitrary terminals; `POST /api/cmux/action` sends keystrokes. This is remote command execution over the local HTTP API. It is acceptable **only** because Helmsman binds `127.0.0.1` for a single local user — the same posture that already gates the existing agent-launch and config endpoints.
- **No shell, ever.** `bridge.ts` spawns `cmux` with an argv array. User-supplied text is passed as a single argv element to `cmux send`; it is never concatenated into a shell command line. This reuses the no-injection discipline already established for the generic-command adapter (tokenized template, per-argv substitution).
- **Invariant test:** a unit test asserts the send/action path calls `spawn('cmux', [...])` (or the module's wrapper) with the user text as one array element and **no** `shell: true`.
- **Non-loopback bind is forbidden.** No change to the existing loopback bind. The design does not add any config that could expose these endpoints off-host.

## Error handling

- **cmux not running / socket unavailable:** `bridge.ts` detects the failure; `GET /api/cmux/tabs` returns `{ connected: false, tabs: [] }`; the panel shows a "cmux not connected" state. Mirrors the existing per-source degraded-mode philosophy (name the unavailable source, keep the rest working). The rest of the dashboard is unaffected.
- **Stale surface ref** (tab closed between list and action): the `cmux` call errors; the endpoint returns 404/409; the panel drops the selection and re-fetches the tab list.
- **`events` child exits:** Helmsman restarts it (bounded backoff). While it is down, the tab list still works via on-demand `GET /api/cmux/tabs`; only live change-push is briefly lost.

## Testing

- `bridge.ts` — mock `child_process.spawn`; assert exact argv for each method, assert no `shell: true`, assert the free-text and send-key paths pass user input as a single argv element. Assert "cmux down" detection maps to the degraded result.
- `model.ts` — fixture `tree` output (single tab, nested windows/workspaces, an agent-session with a provider, a browser surface) → expected `CmuxTab[]`.
- `actions.ts` — each provider's action set and key expansion; unknown provider → empty/terminal-only set.
- `src/logic/cmuxPanel.ts` — selection transitions, poll on/off, `availableActions`.
- **Live smoke (manual):** against the real running cmux — list this session's own tab, read its screen, send a harmless command to a scratch tab, fire a high-level action against a scratch agent session.

## YAGNI cuts (v1)

- No xterm.js, no ANSI parsing, no raw-pty stream (Approach 2 deferred).
- No scrollback view (single rendered screen only; `--scrollback` available later).
- One live screen at a time (no simultaneous multi-tab mirror).
- No pane resize, no `new-workspace`/`new-surface` launching from the dashboard, no browser-surface control.
- No auth beyond the existing loopback bind.

## Build order (for the plan)

1. `bridge.ts` + `model.ts` + tests (list tabs, read screen — read-only path).
2. `GET /api/cmux/tabs` + `GET /api/cmux/screen` + `SSE /api/cmux/events` + the events child lifecycle.
3. Frontend panel: list + live screen (read-only remote view working end-to-end).
4. `actions.ts` + `POST /api/cmux/send` + `POST /api/cmux/action` + the security invariant test (write path).
5. Frontend: text input + Send + provider-aware action buttons.
6. Live smoke against real cmux; degraded-mode check with cmux quit.
