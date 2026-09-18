# Durable Runs — design

Date: 2026-09-16
Status: approved (direction), pending spec review

## Problem / motivation

An agent run is a child process of Helmsman, streamed over a live
stdout pipe, tracked in an in-memory `ProcessManager`. When Helmsman
restarts or crashes mid-run, the child dies, the live state is lost, and
`recovery.ts` marks the run `failed` (and the worktree sweep deletes its
worktree). We want a run to **survive a Helmsman restart**: keep running,
and on reconnect re-attach and resume the live log stream, then finalize
normally.

## Decisions (from brainstorming)

- **Full durability**: the agent keeps running through a restart; Helmsman re-attaches and resumes live streaming, then finalizes.
- **Host: cmux primary + detached fallback.** Host the agent in a cmux
  workspace when `cmux` is on PATH and connected; otherwise a detached OS
  process. Both survive Helmsman dying.
- **Single file-tail path.** All runs go through one path: a wrapper writes
  the agent's output to a per-run **log file** and its exit code to a per-run
  **exit sentinel**; Helmsman tails the log and waits on the sentinel.
  This replaces the live child-pipe for every adapter.

## The substrate

Truth lives on disk, not in Helmsman memory. Per run, under
`RUNS_DIR` (default `<AGENTS_ROOT>/.helmsman-runs/` — outside any worktree so
the worktree sweep can't touch it):

- `<runId>.json` — launch spec `{ cmd, args, cwd, logPath, exitPath }`.
- `<runId>.log` — merged stdout+stderr of the agent, append-only.
- `<runId>.exit` — the integer exit code, written once when the agent exits.

Helmsman reads these; it does not own the process.

### Wrapper — `server/helmsman/run-wrapper.mjs` (new, standalone)

Invoked as `node run-wrapper.mjs <specPath>`. Plain Node, no app imports.

1. Read+parse the spec JSON.
2. `open(logPath, 'a')` → fd. `spawn(spec.cmd, spec.args, { cwd: spec.cwd, stdio: ['ignore', fd, fd] })` — stdin ignored (/dev/null → EOF; this also removes the codex stdin-hang natively), stdout+stderr to the log.
3. On child `exit(code)` → `writeFileSync(exitPath, String(code ?? 1))`, then exit.
4. On child `error` (spawn failure) → append the error message to the log, write `exitPath = 127`, exit.

Passing untrusted data (ticket title) only via the spec JSON file — never a
shell string — keeps launch injection-safe for both hosts.

### Host abstraction — `server/helmsman/run-host.ts` (new)

```ts
export type HostRef = { kind: 'cmux'; workspace: string } | { kind: 'detached'; pid: number };
export interface LaunchSpec { runId: string; cmd: string; args: string[]; cwd: string; logPath: string; exitPath: string; specPath: string; }
export interface RunHost {
  readonly kind: 'cmux' | 'detached';
  launch(spec: LaunchSpec): Promise<HostRef>;
  isAlive(ref: HostRef): Promise<boolean>;
  stop(ref: HostRef): Promise<void>;
}
export function pickHost(deps: { hasCmux: () => Promise<boolean> }): Promise<RunHost>;
```

- **detachedHost**: `launch` writes the spec file, then
  `spawn('node', [wrapperPath, specPath], { detached: true, stdio: 'ignore' }).unref()`;
  ref `{kind:'detached', pid: child.pid}`. `isAlive`: `process.kill(pid, 0)` (true unless throws ESRCH). `stop`: `process.kill(-pid, 'SIGTERM')` (detached child is its own process-group leader; negative pid kills the group so the agent dies too), fall back to `kill(pid)`.
- **cmuxHost**: `launch` writes the spec file, then runs (argv, no shell)
  `cmux new-workspace --cwd <cwd> --no-focus --name "run-<runId>" --command "node <wrapperPath> <specPath>"`, parses the created workspace ref from stdout (verify the exact output shape at build; cmux prints the new workspace id/ref). ref `{kind:'cmux', workspace}`. `isAlive`: `cmux list-workspaces` (or `workspace status`) contains the ref. `stop`: `cmux workspace-action --action close --workspace <ref>` (verify action name at build; fall back to sending Ctrl-C via the existing bridge then close).
- **pickHost**: cmux when `hasCmux()` (a `cmux list-workspaces`/`--version` probe succeeds); else detached. Chosen once at startup, injected into the runner.

`cmux` specifics (`new-workspace` output ref, close action) are verified
against the real CLI during implementation — the spec fixes the shape, the
implementer confirms the exact flags/parse.

### Tailer — `server/helmsman/log-tail.ts` (new)

```ts
export interface Tail { stop(): void; }
export function tailLog(
  logPath: string,
  startOffset: number,
  onLine: (line: string) => void,
  onOffset: (offset: number) => void,
): Tail;
```

Poll (250ms) + `fs.watch` the file; read from `startOffset`; split on `\n`;
emit each complete line via `onLine`; call `onOffset` with the new byte offset
after each batch (buffer a trailing partial line until its newline arrives).
Pure of app types; unit-testable by writing to a temp file.

## DB changes — `server/helmsman/db.ts`

Add columns to `runs` (additive; migrate with `ALTER TABLE runs ADD COLUMN`
guarded by a `PRAGMA table_info` check so existing DBs upgrade in place):

- `hostKind TEXT` — `'cmux' | 'detached' | null`
- `hostRef TEXT` — JSON of `HostRef`
- `logPath TEXT`, `exitPath TEXT`, `specPath TEXT`
- `logOffset INTEGER` — bytes of the log already parsed into events
- `taskJson TEXT` — JSON of the `AgentTask` (so reattach can run post-exit
  steps — review posting, In-Review, Copilot — without the in-memory task)

Extend `RunRow`, `COLS`, and add a `reattachableRuns()` reader (`status =
'running'`). Keep `activeRuns()` for compatibility or replace its callers.

## Adapter contract change — `server/helmsman/agents/adapter.ts`

Replace the process-owning `start()/AgentHandle` with a command + parser:

```ts
export interface AgentAdapter {
  readonly id: string;
  buildCommand(task: AgentTask): { cmd: string; args: string[] };
  parseLine(line: string): AgentEvent | null;
}
```

- **claude-code** (`claude-code.ts`): `buildCommand` = `{ cmd: 'claude', args: ['-p', buildPrompt(task), '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...agentFlags(task)] }`; `parseLine` = `mapStreamLine` (already parses stream-json → event incl. cost/prNumber).
- **codex** (`codex.ts`): `buildCommand` = `{ cmd: 'codex', args: codexArgs(task) }`; `parseLine(line)` → `{ kind: 'log', text: line, prNumber: parsePrNumber(line) }` (or null for blank). The wrapper's stdin-ignore supersedes the current `stdio` fix.
- **command** (`command.ts`): `buildCommand` from the template (`buildArgv`); `parseLine` = the existing `/(?:pull\/|PR[ #]*)(\d+)/i` regex → log event.

The JIRA_* env stripping moves to the wrapper/host env (the wrapper inherits
the Helmsman env; strip `JIRA_API_TOKEN`/`JIRA_EMAIL` before launch, or
pass a scrubbed env in the spec — spec carries `env` additions/removals if
needed; simplest: the runner builds the child env and the wrapper uses
`process.env` minus those two, so the runner sets them via the spawned
wrapper's env).

Env handling: `detachedHost` spawns the wrapper with `{ ...process.env }`
minus `JIRA_API_TOKEN`/`JIRA_EMAIL`. `cmuxHost` inherits the cmux app's env
(which already lacks Helmsman secrets in normal operation) — document that
cmux-hosted agents run under cmux's environment; if JIRA_* must be scrubbed
there too, pass them out via the spec is NOT possible (spec has no secrets),
so rely on cmux env. (Acceptable: the agent is prompt-forbidden from Jira
writes and the token isn't in cmux's shell env by default.)

## Runner rewrite — `server/helmsman/runner.ts`

`startRun(task, deps)`:

1. `runId`, insert `running` row with `logPath/exitPath/specPath/logOffset=0/taskJson`.
2. Worktree (unchanged: `createWorktree` / `createWorktreeFromBranch`).
3. Claim ticket (unchanged; `!task.task && !task.prBranch`).
4. Attempt loop (`maxAttempts`): per attempt —
   - `cmd/args = adapter.buildCommand(task)`.
   - `host.launch({runId, cmd, args, cwd: worktree.path, logPath, exitPath, specPath})` → persist `hostKind/hostRef`.
   - Register in `ProcessManager` with `stop = () => host.stop(ref)`.
   - `tailLog(logPath, 0, onLine, onOffset)` where `onLine` → `adapter.parseLine` → if event: `appendEvent` + `bus.publish` + accumulate `costUsd`/`prNumber`; `onOffset` → `updateRun{logOffset}`.
   - Await exit: poll `exitPath` (exists → read int) OR `isStopped()` OR cost cap; when exit file appears, `code`; `ok = code === 0`; stop the tail (flush remaining lines first).
   - Retry logic as today (retry on `!ok` unless stopped/cost-capped).
5. Finalize (unchanged logic): resolve `prNumber`, status, `postReviewDerivingStatusFromReviewNotExitCode` for review runs, `markInReview`, `requestCopilotReview`.
6. `finally`: remove worktree, append `run-complete`, publish. Delete the
   spec/log/exit files? **No** — keep the log for the Recent-runs replay
   (`listEvents` already persists events to DB; the log file can be cleaned by
   a bounded janitor later). Keep exit/spec cleanup optional.

`reattachRun(row, deps)` (new, used by recovery):

1. Parse `taskJson` → task; parse `hostRef`.
2. If `exitPath` exists → the run finished while we were down: read code, parse
   any log tail beyond `logOffset` into events, then finalize (status +
   review/copilot/In-Review). 
3. Else if `host.isAlive(ref)` → resume: `tailLog(logPath, row.logOffset, …)`,
   register stop in `ProcessManager`, await exit as in step 4 above, finalize.
4. Else (host dead, no exit) → mark `failed` (`'run interrupted: host gone'`).

The finalize path is shared between `startRun` and `reattachRun` (extract a
`finalizeRun(...)` helper).

## Recovery rewrite — `server/helmsman/recovery.ts`

Replace mark-all-failed with: for each `reattachableRuns()` row, call
`reattachRun(row, deps)` (fire-and-forget, each guarded). Return the ids
reattached vs failed for the startup log. Recovery now needs the full runner
deps (adapter, host, bus, db, jira, github, worktree remove, config) — wire
from `main.ts`.

## Worktree sweep — `server/helmsman/worktree.ts` + `main.ts`

`sweepOrphanedWorktrees` already spares worktrees whose `<runId>` is an active
`ProcessManager` run. Change the "is active" predicate at the `main.ts` call
site to also spare `reattachableRuns()` ids (runs being reattached), so a
mid-run restart doesn't delete the live run's worktree before reattach
registers it. Order: run recovery/reattach BEFORE the sweep, or pass the
reattachable id set into the sweep.

## main.ts wiring

- `RUNS_DIR = process.env.RUNS_DIR ?? join(AGENTS_ROOT, '.helmsman-runs')`; mkdir.
- `const host = await pickHost({ hasCmux })` at startup; inject into runner/recovery deps.
- Startup order: open db → **reattach** (`recoverOrphanedRuns` → now reattach) → worktree sweep (sparing reattached ids) → listen.
- `stop` route → `pm.stop(id)` → `host.stop(ref)` (ProcessManager entry's stop closure).
- `launch()` builds the runner deps with `host`, `runsDir`, and persists task.

## Testing

- `run-wrapper` (child): spawn it on a fake `cmd` that prints to stdout+stderr and exits N → log has both streams, exit file has N; spawn-failure → exit 127 + error in log. (Node child test, real temp files.)
- `log-tail`: write lines incrementally to a temp file → onLine per complete line, partial line buffered until newline, offset advances; start from a non-zero offset resumes correctly.
- `run-host` detached: launch a wrapper on `node -e 'process.exit(3)'` → isAlive transitions true→false, exit file `3`; `stop` kills a sleeper. cmux host: unit-test the argv builder (`cmux new-workspace … --command …`) and ref parse against a captured sample; gate the live-cmux path behind a probe (skip if cmux absent in CI).
- adapters: `buildCommand` argv (claude flags, codex `-m gpt-6-astra -c …`, command template) + `parseLine` (claude stream-json line → cost/pr; codex pull URL → prNumber; command regex).
- `runner`: with a fake host that runs a scripted wrapper writing a known log + exit, assert events streamed, cost/pr parsed, status, review/copilot finalize (reuse existing runner tests, adapted to the new host/tail path). New: **reattach** — seed a `running` row + a log file + (a) exit file present → finalizes; (b) fake host alive, no exit → tails remaining + awaits injected exit → finalizes; (c) host dead + no exit → failed.
- `recovery`: reattachable rows dispatched to reattach, not blanket-failed.
- `db`: migration adds columns to a pre-existing DB without data loss; new reader.

## Failure modes / edge cases

- Exit file written but log still flushing → on finalize, read the full log tail past `logOffset` before deciding events; small race, poll a beat after exit.
- Wrapper/node missing on the cmux host PATH → cmux workspace command fails; detect (workspace exits immediately, no exit file, isAlive false soon) → fail the run with a clear error.
- Two Helmsman instances (shouldn't happen; single 127.0.0.1 bind) — out of scope.
- Very large logs → tail reads incrementally; DB events already bounded by agent output. A janitor to prune old `<runId>.log` files is a follow-up, not this spec.
- Stop during reattach → `host.stop(ref)` + status `stopped`.
- cmux disconnected after launching a cmux-hosted run → `isAlive` false though the agent may still run detached inside cmux; treat as host-gone → the exit file still finalizes it if it completes; acceptable.

## Out of scope (YAGNI)

- Log-file janitor/retention (follow-up).
- Freeform re-run (now enabled by `taskJson` persistence — separate small change).
- Multi-host / remote execution beyond cmux+detached.
- Backfilling durability columns for historical runs (only new runs get them; old rows reattach-skip → failed as today).
