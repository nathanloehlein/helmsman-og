# Durable Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent runs survive a Helmsman restart — the agent keeps running in a cmux workspace (or detached process), and on reconnect Helmsman reattaches, resumes the live log stream, and finalizes normally.

**Architecture:** Truth moves to disk: a standalone wrapper writes each run's output to `<id>.log` and its exit code to `<id>.exit`; Helmsman tails the log and awaits the sentinel instead of owning a child pipe. A `RunHost` (cmux primary, detached fallback) launches the wrapper. Adapters shrink from owning a process to `buildCommand()` + `parseLine()`. Recovery reattaches running rows instead of failing them.

**Tech Stack:** TypeScript strict + `--erasableSyntaxOnly` (no ctor param props), Node `node:child_process`/`node:fs` under `tsx`, better-sqlite3, Vitest. `cmux` 0.64.x on PATH.

**Spec:** `docs/superpowers/specs/2026-09-16-durable-runs-design.md`

## Global Constraints

- Per-run files live under `RUNS_DIR` (default `<AGENTS_ROOT>/.helmsman-runs/`), NOT inside any worktree.
- Untrusted data (ticket title) reaches the agent only via the spec JSON file / argv arrays — never a shell command string.
- Wrapper strips no env itself; the detached host spawns it with `JIRA_API_TOKEN`/`JIRA_EMAIL` removed. cmux-hosted agents run under cmux's env (documented tradeoff).
- `--erasableSyntaxOnly`: explicit field + assignment, no constructor parameter properties.
- No comments unless a non-obvious "why" (repo hook enforces JSDoc-above-export only; encode reasons in names).
- Vitest: `npx vitest run <file>`. Final gate: `npx tsc --noEmit && npx vitest run && npm run build`.
- Exit codes: `ok = code === 0`.

---

### Task 1: DB columns + reattachable reader

**Files:** Modify `server/helmsman/db.ts`; Test `server/helmsman/db.test.ts`.

**Interfaces produced:** `RunRow` gains `hostKind: string | null; hostRef: string | null; logPath: string | null; exitPath: string | null; specPath: string | null; logOffset: number | null; taskJson: string | null;`. New `Db.reattachableRuns(): RunRow[]`.

- [ ] **Step 1: Failing test** — append to `db.test.ts`:

```ts
it('migrates: adds durable-run columns to a pre-existing runs table and round-trips them', () => {
  const path = join(tmpdir(), `helmsman-mig-${Math.random().toString(36).slice(2)}.sqlite`);
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, ticketId TEXT, repo TEXT, adapter TEXT, status TEXT, attempt INTEGER, prNumber INTEGER, startedAt TEXT, endedAt TEXT, costUsd REAL, worktreePath TEXT);`);
  legacy.prepare(`INSERT INTO runs (id,ticketId,repo,adapter,status,attempt,prNumber,startedAt,endedAt,costUsd,worktreePath) VALUES ('old','T-1','o/r','codex','running',1,null,'t',null,null,null)`).run();
  legacy.close();

  const db = openDb(path);
  db.updateRun('old', { hostKind: 'detached', hostRef: '{"kind":"detached","pid":9}', logPath: '/l', exitPath: '/e', specPath: '/s', logOffset: 42, taskJson: '{"ticketId":"T-1"}' });
  const row = db.getRun('old')!;
  expect(row.hostKind).toBe('detached');
  expect(row.logOffset).toBe(42);
  expect(db.reattachableRuns().map((r) => r.id)).toContain('old');
  db.close();
});
```

Add imports at top of the test file if missing: `import Database from 'better-sqlite3'; import { join } from 'node:path'; import { tmpdir } from 'node:os';`.

- [ ] **Step 2: Run → fails** (`npx vitest run server/helmsman/db.test.ts`) — columns missing.

- [ ] **Step 3: Implement.** In `db.ts`:
  - Extend `RunRow` with the 7 fields above (types as stated).
  - Extend `COLS` with `'hostKind','hostRef','logPath','exitPath','specPath','logOffset','taskJson'`.
  - After the `CREATE TABLE ... runs` exec, add a migration:

```ts
const existing = new Set((sql.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map((c) => c.name));
const addCols: [string, string][] = [
  ['hostKind', 'TEXT'], ['hostRef', 'TEXT'], ['logPath', 'TEXT'], ['exitPath', 'TEXT'],
  ['specPath', 'TEXT'], ['logOffset', 'INTEGER'], ['taskJson', 'TEXT'],
];
for (const [name, type] of addCols) {
  if (!existing.has(name)) sql.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
}
```

  (Keep the base `CREATE TABLE` as the pre-migration 11-column shape so a fresh DB + a legacy DB converge through the same ALTER path. Simplest: leave the existing CREATE TABLE unchanged and rely on ALTER for the new columns.)
  - Add reader: `reattachableRuns(): RunRow[] { return sql.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY startedAt DESC").all() as RunRow[]; }` and add it to the `Db` interface.

- [ ] **Step 4: Run → passes.** Also `npx vitest run server/helmsman/db.test.ts`.

- [ ] **Step 5: Commit** — `git add server/helmsman/db.ts server/helmsman/db.test.ts && git commit -m "Add durable-run columns and reattachableRuns to the run store"`

---

### Task 2: run-wrapper.mjs

**Files:** Create `server/helmsman/run-wrapper.mjs`; Test `server/helmsman/run-wrapper.test.ts`.

**Interfaces produced:** an executable Node script; `node run-wrapper.mjs <specPath>` reads `{cmd,args,cwd,logPath,exitPath}`, runs the agent, writes the exit code.

- [ ] **Step 1: Failing test** — `run-wrapper.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const WRAPPER = join(__dirname, 'run-wrapper.mjs');

function runWrapper(spec: object): void {
  const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, JSON.stringify({ cwd: dir, ...spec, logPath: join(dir, 'run.log'), exitPath: join(dir, 'run.exit') }));
  spawnSync('node', [WRAPPER, specPath], { encoding: 'utf8' });
  (runWrapper as unknown as { dir: string }).dir = dir;
}

describe('run-wrapper', () => {
  it('captures stdout+stderr to the log and the exit code to the sentinel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    const specPath = join(dir, 'spec.json');
    const logPath = join(dir, 'run.log');
    const exitPath = join(dir, 'run.exit');
    writeFileSync(specPath, JSON.stringify({ cmd: 'node', args: ['-e', 'process.stdout.write("out\\n");process.stderr.write("err\\n");process.exit(5)'], cwd: dir, logPath, exitPath }));
    spawnSync('node', [WRAPPER, specPath], { encoding: 'utf8' });
    expect(readFileSync(logPath, 'utf8')).toContain('out');
    expect(readFileSync(logPath, 'utf8')).toContain('err');
    expect(readFileSync(exitPath, 'utf8').trim()).toBe('5');
  });

  it('writes exit 127 and logs the error when the command cannot be spawned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    const specPath = join(dir, 'spec.json');
    const logPath = join(dir, 'run.log');
    const exitPath = join(dir, 'run.exit');
    writeFileSync(specPath, JSON.stringify({ cmd: 'definitely-not-a-real-binary-xyz', args: [], cwd: dir, logPath, exitPath }));
    spawnSync('node', [WRAPPER, specPath], { encoding: 'utf8' });
    expect(existsSync(exitPath)).toBe(true);
    expect(readFileSync(exitPath, 'utf8').trim()).toBe('127');
  });
});
```

- [ ] **Step 2: Run → fails** (module missing).

- [ ] **Step 3: Implement `run-wrapper.mjs`:**

```js
#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { openSync, readFileSync, writeFileSync } from 'node:fs';

const specPath = process.argv[2];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const fd = openSync(spec.logPath, 'a');

const child = spawn(spec.cmd, spec.args ?? [], { cwd: spec.cwd, stdio: ['ignore', fd, fd] });
child.on('exit', (code) => {
  writeFileSync(spec.exitPath, String(code ?? 1));
  process.exit(0);
});
child.on('error', (err) => {
  try { writeFileSync(spec.logPath, `run-wrapper: cannot start ${spec.cmd}: ${err.message}\n`, { flag: 'a' }); } catch {}
  writeFileSync(spec.exitPath, '127');
  process.exit(0);
});
```

- [ ] **Step 4: Run → passes.**

- [ ] **Step 5: Commit** — `git commit -m "Add run-wrapper: run an agent to a log file + exit sentinel"`

---

### Task 3: log-tail.ts

**Files:** Create `server/helmsman/log-tail.ts`; Test `server/helmsman/log-tail.test.ts`.

**Interfaces produced:** `tailLog(logPath, startOffset, onLine, onOffset): { stop(): void }`.

- [ ] **Step 1: Failing test** — write lines incrementally to a temp file, assert onLine per complete line, partial buffered, offset advances, and starting from a nonzero offset skips earlier bytes. (Use a 300ms poll interval; the test writes then `await` a short delay via `vi.waitFor`.) Example core:

```ts
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tailLog } from './log-tail';

it('emits complete lines and advances the offset, buffering partial lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tail-'));
  const log = join(dir, 'run.log');
  writeFileSync(log, 'alpha\nbeta\n');
  const lines: string[] = [];
  let offset = 0;
  const t = tailLog(log, 0, (l) => lines.push(l), (o) => { offset = o; });
  await vi.waitFor(() => expect(lines).toEqual(['alpha', 'beta']));
  appendFileSync(log, 'gam');
  appendFileSync(log, 'ma\n');
  await vi.waitFor(() => expect(lines).toEqual(['alpha', 'beta', 'gamma']));
  expect(offset).toBe('alpha\nbeta\ngamma\n'.length);
  t.stop();
});

it('resumes from a nonzero start offset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tail-'));
  const log = join(dir, 'run.log');
  writeFileSync(log, 'one\ntwo\n');
  const lines: string[] = [];
  const t = tailLog(log, 'one\n'.length, (l) => lines.push(l), () => {});
  await vi.waitFor(() => expect(lines).toEqual(['two']));
  t.stop();
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Implement `log-tail.ts`:**

```ts
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

export interface Tail {
  stop(): void;
}

export function tailLog(
  logPath: string,
  startOffset: number,
  onLine: (line: string) => void,
  onOffset: (offset: number) => void,
): Tail {
  let offset: number = startOffset;
  let buffer: string = '';
  let stopped: boolean = false;

  const pump = (): void => {
    if (stopped) return;
    let fd: number | null = null;
    try {
      fd = openSync(logPath, 'r');
      const size: number = fstatSync(fd).size;
      if (size > offset) {
        const len: number = size - offset;
        const buf: Buffer = Buffer.alloc(len);
        const read: number = readSync(fd, buf, 0, len, offset);
        offset += read;
        buffer += buf.subarray(0, read).toString('utf8');
        let nl: number = buffer.indexOf('\n');
        while (nl !== -1) {
          onLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
        }
        onOffset(offset - Buffer.byteLength(buffer, 'utf8'));
      }
    } catch {
      // file not created yet; retry next tick
    } finally {
      if (fd !== null) closeSync(fd);
    }
  };

  const timer: ReturnType<typeof setInterval> = setInterval(pump, 250);
  pump();
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
```

Note: `onOffset` reports bytes consumed up to the last complete line (offset minus the still-buffered partial), so a reattach never re-emits or skips a line.

- [ ] **Step 4: Run → passes.**

- [ ] **Step 5: Commit** — `git commit -m "Add log-tail: stream complete lines from a growing file with offset tracking"`

---

### Task 4: run-host.ts (detached + cmux + pickHost)

**Files:** Create `server/helmsman/run-host.ts`; Test `server/helmsman/run-host.test.ts`.

**Interfaces produced:** `HostRef`, `LaunchSpec`, `RunHost`, `detachedHost(wrapperPath)`, `cmuxHost(wrapperPath, run)`, `pickHost(deps)`. (`run` = an argv runner injected for testability, default a real `spawnSync`-based exec.)

- [ ] **Step 1: Failing tests.** Two real ones for detached, argv-only for cmux:

```ts
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detachedHost, cmuxHost, pickHost, type LaunchSpec } from './run-host';

const WRAPPER = join(__dirname, 'run-wrapper.mjs');

function spec(dir: string, cmd: string, args: string[]): LaunchSpec {
  return { runId: 'r1', cmd, args, cwd: dir, logPath: join(dir, 'run.log'), exitPath: join(dir, 'run.exit'), specPath: join(dir, 'r1.json') };
}

describe('detachedHost', () => {
  it('launches the wrapper, reports liveness, and finishes with an exit file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-'));
    const host = detachedHost(WRAPPER);
    const ref = await host.launch(spec(dir, 'node', ['-e', 'setTimeout(()=>process.exit(3), 300)']));
    expect(ref.kind).toBe('detached');
    expect(await host.isAlive(ref)).toBe(true);
    await vi.waitFor(() => expect(existsSync(join(dir, 'run.exit'))).toBe(true), { timeout: 3000 });
    expect(readFileSync(join(dir, 'run.exit'), 'utf8').trim()).toBe('3');
  });
});

describe('cmuxHost argv', () => {
  it('builds a new-workspace command that runs the wrapper, no untrusted shell data', async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => { calls.push(argv); return { stdout: 'workspace:7', code: 0 }; };
    const host = cmuxHost(WRAPPER, run);
    const dir = mkdtempSync(join(tmpdir(), 'host-'));
    const ref = await host.launch(spec(dir, 'codex', ['exec', 'title with spaces']));
    expect(ref).toEqual({ kind: 'cmux', workspace: 'workspace:7' });
    const argv = calls[0]!;
    expect(argv[0]).toBe('cmux');
    expect(argv).toContain('new-workspace');
    expect(argv).toContain('--command');
    const cmd = argv[argv.indexOf('--command') + 1]!;
    expect(cmd).toBe(`node ${WRAPPER} ${join(dir, 'r1.json')}`); // only the spec path, never the title
    expect(cmd).not.toContain('title with spaces');
  });
});

describe('pickHost', () => {
  it('prefers cmux when present, else detached', async () => {
    expect((await pickHost({ hasCmux: async () => true, wrapperPath: WRAPPER })).kind).toBe('cmux');
    expect((await pickHost({ hasCmux: async () => false, wrapperPath: WRAPPER })).kind).toBe('detached');
  });
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Implement `run-host.ts`.** Types per the spec. `detachedHost`:
  - `launch(spec)`: `writeFileSync(spec.specPath, JSON.stringify({cmd,args,cwd,logPath,exitPath}))`; `const env = { ...process.env }; delete env.JIRA_API_TOKEN; delete env.JIRA_EMAIL;`; `const child = spawn('node', [wrapperPath, spec.specPath], { detached: true, stdio: 'ignore', env }); child.unref();` → `{ kind: 'detached', pid: child.pid! }`.
  - `isAlive(ref)`: `try { process.kill(ref.pid, 0); return true; } catch { return false; }`.
  - `stop(ref)`: `try { process.kill(-ref.pid, 'SIGTERM'); } catch { try { process.kill(ref.pid, 'SIGTERM'); } catch {} }`.

  `cmuxHost(wrapperPath, run = defaultRun)` where `run(argv): Promise<{stdout:string;code:number}>` shells argv no-shell (default: promisified `execFile('cmux', ...)` — but keep it argv-only; for the non-cmux binary use `spawn`):
  - `launch(spec)`: write spec file; `const command = \`node ${wrapperPath} ${spec.specPath}\`;` `const { stdout } = await run(['cmux','new-workspace','--cwd',spec.cwd,'--no-focus','--name',\`run-${spec.runId}\`,'--command',command]);` parse the workspace ref = first `workspace:N`/uuid token in stdout (`parseCmuxWorkspaceRef(stdout)` — a small exported helper; **verify the real output shape against `cmux new-workspace` during build and adjust the parser**). Return `{kind:'cmux', workspace}`.
  - `isAlive(ref)`: `run(['cmux','list-workspaces'])` stdout includes `ref.workspace`.
  - `stop(ref)`: `run(['cmux','workspace-action','--action','close','--workspace',ref.workspace])` (**verify the close action name at build**; fall back to no-op on error).

  `pickHost({hasCmux, wrapperPath})`: `return (await hasCmux()) ? cmuxHost(wrapperPath) : detachedHost(wrapperPath);`. Also export `hasCmux()` default = `run(['cmux','list-workspaces'])` resolves with code 0.

- [ ] **Step 4: Run → passes** (detached + argv + pickHost). 

- [ ] **Step 5: Live-verify cmux (build-time, not a unit test):** from a shell, run `cmux new-workspace --cwd /tmp --no-focus --name run-probe --command "echo hi; sleep 1"` and capture stdout; confirm the ref parser matches, and that `cmux list-workspaces` shows it and the close action name. Adjust `parseCmuxWorkspaceRef` / the close argv to the real output. Record the confirmed shapes in the report.

- [ ] **Step 6: Commit** — `git commit -m "Add run-host: detached + cmux launch/liveness/stop and pickHost"`

---

### Task 5: Adapter contract → buildCommand + parseLine

**Files:** Modify `server/helmsman/agents/adapter.ts`, `claude-code.ts`, `codex.ts`, `command.ts`; Tests `claude-code.test.ts`, `codex.test.ts`, `command.test.ts`.

**Interfaces produced:** `AgentAdapter = { id; buildCommand(task): {cmd,args}; parseLine(line): AgentEvent|null }`. Remove `AgentHandle` and `start` from the interface (keep `AgentEvent`/`AgentResult`/`AgentTask`).

- [ ] **Step 1: Update `adapter.ts`** — replace the `AgentAdapter` interface and delete `AgentHandle`:

```ts
export interface AgentAdapter {
  readonly id: string;
  buildCommand(task: AgentTask): { cmd: string; args: string[] };
  parseLine(line: string): AgentEvent | null;
}
```

- [ ] **Step 2: claude-code.ts** — replace `claudeCodeAdapter`:

```ts
export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  buildCommand(task: AgentTask): { cmd: string; args: string[] } {
    return { cmd: 'claude', args: ['-p', buildPrompt(task), '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...agentFlags(task)] };
  },
  parseLine(line: string): AgentEvent | null {
    return mapStreamLine(line);
  },
};
```

Keep `agentFlags`, `buildPrompt` import, `mapStreamLine` import. Delete the old `start()` body and `spawn`/`createInterface` imports if now unused. Update `claude-code.test.ts`: replace any `start`-based test with `buildCommand` argv assertions (contains `-p`, `--output-format stream-json`, model/effort flags) — keep the existing `agentFlags`/`buildPrompt` tests.

- [ ] **Step 3: codex.ts** — replace `codexAdapter`:

```ts
export const codexAdapter: AgentAdapter = {
  id: 'codex',
  buildCommand(task: AgentTask): { cmd: string; args: string[] } {
    return { cmd: 'codex', args: codexArgs(task) };
  },
  parseLine(line: string): AgentEvent | null {
    if (!line) return null;
    const prNumber: number | undefined = parsePrNumber(line);
    return prNumber !== undefined ? { kind: 'log', text: line, prNumber } : { kind: 'log', text: line };
  },
};
```

Delete the old `start`/spawn/readline code and now-unused imports. Update `codex.test.ts`: keep `codexArgs`/`validCodexEffort` tests; replace the spawn/stdin/stderr tests with `buildCommand` + `parseLine` tests (`parseLine('… pull/7 …').prNumber === 7`; blank → null). The stdin-hang concern is now the wrapper's responsibility (Task 2), so those spawn tests are removed here.

- [ ] **Step 4: command.ts** — replace `commandAdapter(template)`:

```ts
export function commandAdapter(template: string): AgentAdapter {
  return {
    id: 'command',
    buildCommand(task: AgentTask): { cmd: string; args: string[] } {
      const argv: string[] = buildArgv(template, task);
      const [cmd, ...args]: string[] = argv;
      return { cmd: cmd ?? '', args };
    },
    parseLine(line: string): AgentEvent | null {
      const m: RegExpMatchArray | null = line.match(/(?:pull\/|PR[ #]*)(\d+)/i);
      return m ? { kind: 'log', text: line, prNumber: Number(m[1]) } : { kind: 'log', text: line };
    },
  };
}
```

Keep `buildArgv` + its tests; replace the `start`/spawn test with `buildCommand`/`parseLine` tests. An empty template → `cmd === ''` (runner treats an empty cmd as a failed run — assert in the runner task, not here).

- [ ] **Step 5: Run adapter tests + tsc** — `npx vitest run server/helmsman/agents/ && npx tsc --noEmit`. Expected: FAILURES in `runner.ts`/`main.ts`/`runner.test.ts` because they still call `adapter.start` — those are fixed in Tasks 6 & 8. Adapter-file tests + tsc-of-adapters pass. If tsc blocks on runner/main, that's expected mid-refactor; proceed to Task 6 (do not "fix" runner here).

- [ ] **Step 6: Commit** — `git commit -m "Adapter contract: buildCommand + parseLine (drop process ownership)"`

---

### Task 6: Runner rewrite (launch via host + tail + reattach)

**Files:** Modify `server/helmsman/runner.ts`; Test `server/helmsman/runner.test.ts`.

**Interfaces:**
- Consumes: Task 1 db, Task 3 `tailLog`, Task 4 `RunHost`/`HostRef`, Task 5 adapters.
- Produces: `startRun(task, deps)` (host+tail path) and `reattachRun(row, deps)`; `RunnerDeps` gains `host: RunHost`, `runsDir: string`, `pollExit?: () => ...` (a clock/poll injectable for tests), and keeps `db,bus,adapter,createWorktree,...,jira,findPrNumber,maxAttempts,maxCostUsd,isStopped,readReview,postReview,requestCopilotReview`. Remove `adapter.start`/`onStart`/`AgentHandle` usage.

Design notes for the implementer:
- Per attempt: `const {cmd,args} = deps.adapter.buildCommand(task)`; if `cmd === ''` → emit error, treat as failed attempt. `logPath/exitPath/specPath` = `join(deps.runsDir, runId + '.log' | '.exit' | '.json')`. Persist `logPath/exitPath/specPath/taskJson/logOffset=0`. `const ref = await deps.host.launch({runId,cmd,args,cwd:worktree.path,logPath,exitPath,specPath})`; persist `hostKind=ref.kind`, `hostRef=JSON.stringify(ref)`. `deps.onStart?` is replaced by registering stop: the runner returns/exposes a stop via `ProcessManager` in main; inside `startRun`, wire stop through a `deps.registerStop?(runId, () => deps.host.stop(ref))` callback (added to deps) OR keep the existing `onStart` shape replaced by `onLaunch?(runId, ref)`. Use `onLaunch?: (stop: () => Promise<void>) => void`.
- Streaming: `const tail = tailLog(logPath, 0, (line) => { const e = deps.adapter.parseLine(line); if (!e) return; if (e.costUsd != null) totalCost = (totalCost ?? 0) + e.costUsd; if (e.prNumber != null) resultPr = e.prNumber; onEvent(e); }, (off) => deps.db.updateRun(runId, { logOffset: off }));`
- Await exit: a helper `waitForExit(exitPath, { isStopped, isCostCapped }): Promise<number | 'stopped' | 'capped'>` that polls (250ms) for the exit file (read int), or stop/cap. Injectable interval via deps for tests (default 250ms; tests pass a tiny interval or pre-create the exit file). On resolution: `tail.stop()` after a final `pump` (read remaining), then proceed.
- `ok = exit === 0`. Retry as today.
- Extract `finalizeRun({runId, task, deps, prNumber, totalCost, status})` shared by startRun + reattachRun: sets status/pr/cost/endedAt; runs review (`postReviewDerivingStatusFromReviewNotExitCode`), markInReview, requestCopilotReview exactly as the current code; removes worktree; appends `run-complete`.
- `reattachRun(row, deps)`: `task = JSON.parse(row.taskJson)`; `ref = JSON.parse(row.hostRef)`. If `existsSync(row.exitPath)` → read code, run one `pump` over the log from `row.logOffset` (feed parseLine → events), finalize with that status. Else if `await deps.host.isAlive(ref)` → `tailLog(row.logPath, row.logOffset, …)` + register stop + `waitForExit` + finalize. Else → finalize as `failed` with an error event `run interrupted: host gone`.

- [ ] **Step 1: Rewrite the existing runner tests** to the new deps (a `fakeHost` that, on `launch`, spawns the real `run-wrapper.mjs` on a scripted `node -e` cmd writing known lines + exit; or simpler, a fake host whose `launch` writes the log + exit files directly). Keep the behavioral assertions: events streamed to the bus, cost/pr parsed, status succeeded/failed, review posting (all the current review tests), Jira claim/transition, Copilot request, cost cap, stop. Add:
  - **reattach: exit file already present** → finalizes to the stored code's status, posts review if review-run.
  - **reattach: host alive, no exit** → tails remaining log + awaits an exit file the test writes → finalizes.
  - **reattach: host dead + no exit** → failed with the interrupted error.

  (This is the largest test rewrite; mirror the existing `deps()` helper, swapping `fakeAdapter([...], ok)` for `{ id, buildCommand: () => ({cmd,args}), parseLine }` + a `fakeHost`.)

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Implement** per the design notes.

- [ ] **Step 4: Run → passes** (`npx vitest run server/helmsman/runner.test.ts`).

- [ ] **Step 5: Commit** — `git commit -m "Runner: launch via RunHost, stream from the log file, add reattachRun"`

---

### Task 7: Recovery rewrite (reattach, not fail)

**Files:** Modify `server/helmsman/recovery.ts`; Test `server/helmsman/recovery.test.ts`.

**Interfaces:** `recoverRuns(db, deps): Promise<{ reattached: string[]; failed: string[] }>` where `deps` carries what `reattachRun` needs plus `reattach: (row) => Promise<void>` (inject `reattachRun` for testability). Old `recoverOrphanedRuns(db, now)` is replaced; update its `main.ts` caller (Task 8).

- [ ] **Step 1: Failing test** — `recovery.test.ts`: seed a `running` row with `hostRef`/`taskJson`; a fake `reattach` records calls. Assert every reattachable row is dispatched to `reattach` and none is blanket-marked `failed` by recovery itself (finalization is `reattachRun`'s job).

```ts
it('dispatches each running row to reattach instead of failing it', async () => {
  const db = openDb(':memory:');
  db.insertRun({ /* running row with taskJson/hostRef/logPath/exitPath */ } as RunRow);
  const seen: string[] = [];
  const res = await recoverRuns(db, { reattach: async (row) => { seen.push(row.id); } });
  expect(seen).toEqual(['<id>']);
  expect(db.getRun('<id>')!.status).toBe('running'); // recovery didn't fail it; reattach decides
  db.close();
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Implement:**

```ts
export interface RecoverDeps { reattach: (row: RunRow) => Promise<void>; }
export async function recoverRuns(db: Db, deps: RecoverDeps): Promise<{ reattached: string[]; failed: string[] }> {
  const rows: RunRow[] = db.reattachableRuns();
  const reattached: string[] = [];
  for (const row of rows) {
    try { await deps.reattach(row); reattached.push(row.id); }
    catch { /* reattachRun handles its own failure marking */ }
  }
  return { reattached, failed: [] };
}
```

(Reattach itself decides finalize-vs-continue-vs-fail; recovery just dispatches. Fire in the background from main so startup isn't blocked — main wraps each in `void`.)

- [ ] **Step 4: Run → passes.**

- [ ] **Step 5: Commit** — `git commit -m "Recovery: reattach running runs instead of marking them failed"`

---

### Task 8: main.ts wiring + worktree-sweep spare

**Files:** Modify `server/helmsman/main.ts`; (worktree.ts unchanged — the spare set is passed at the call site).

- [ ] **Step 1: Wire.**
  - `const RUNS_DIR = process.env.RUNS_DIR ?? join(AGENTS_ROOT, '.helmsman-runs'); mkdirSync(RUNS_DIR, { recursive: true });`
  - `const WRAPPER = join(import.meta.dirname, 'run-wrapper.mjs');` (or `fileURLToPath(new URL('./run-wrapper.mjs', import.meta.url))`).
  - `const host = await pickHost({ hasCmux, wrapperPath: WRAPPER });` and log `host.kind`.
  - Build a `runnerDeps(task)` factory carrying `host`, `runsDir: RUNS_DIR`, and the existing jira/github/worktree/config deps; `launch()` uses it and persists `taskJson`.
  - `stop` route → `pm.stop(id)` where the ProcessManager entry's stop closure is `() => void host.stop(ref)` set via the runner's `onLaunch`.
  - **Startup order:** open db → compute `const reattachIds = db.reattachableRuns().map(r => r.id)` → run the worktree sweep with `isActiveRunId: (id) => pm.hasRun(id) || reattachIds.includes(id)` → then dispatch reattach: `void recoverRuns(db, { reattach: (row) => reattachRun(row, runnerDepsFromRow(row)) })`. (Sweep BEFORE reattach registers in pm, so the spare set must include `reattachIds` explicitly — which it does.)
  - Replace the old `recoverOrphanedRuns` call.

- [ ] **Step 2: Typecheck + full suite + build** — `npx tsc --noEmit && npx vitest run && npm run build`. Fix any remaining `start`/`AgentHandle` references. Expected: green.

- [ ] **Step 3: Commit** — `git commit -m "Wire durable runs into the helmsman: host, RUNS_DIR, reattach on startup, sweep spares live runs"`

---

## Self-Review

**Spec coverage:** substrate files (Task 2), host cmux+detached (Task 4), tailer (Task 3), db columns+taskJson (Task 1), adapter buildCommand/parseLine (Task 5), runner file-tail + reattach + finalize (Task 6), recovery reattach (Task 7), main wiring + sweep spare + startup order (Task 8). ✓

**Placeholder scan:** the only deferred specifics are the exact cmux `new-workspace` output parse and close-action name — Task 4 Step 5 live-verifies them against the real CLI and records the confirmed shapes; the code and its test assert an argv shape now and the implementer adjusts the parser. Not a logic placeholder.

**Type consistency:** `AgentAdapter` (id/buildCommand/parseLine) identical across adapter.ts + the three adapters + runner consumption. `HostRef`/`LaunchSpec`/`RunHost` identical across run-host.ts + runner + main. `RunRow` new columns identical across db.ts + runner persistence + reattach reads. `reattachRun`/`recoverRuns` signatures match between Tasks 6/7/8.

**Ordering:** 1 (db) → 2/3/4 (substrate, independent) → 5 (adapters) → 6 (runner needs 1/3/4/5) → 7 (recovery needs 6) → 8 (main needs all). Tasks 5–8 leave the tree non-compiling in between (adapter contract change); tsc/build only asserted green at Task 8. Each of Tasks 5–8 still runs its own file's unit tests where meaningful.

**Risk:** Task 6 is the heavy one (runner rewrite + large test port). If an implementer stalls, split it: 6a startRun-via-host+tail (reuse finalize), 6b reattachRun.
