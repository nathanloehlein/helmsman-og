# Agent Control Plane — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the persistent Node orchestrator (P0: serves the dashboard API + SQLite), then run one CLI agent against a ticket in a git worktree and stream its work live to the UI (P1). No Jira writes yet — the agent works, you watch.

**Architecture:** A standalone `node:http` orchestrator process replaces the dev-only Vite plugin. It serves `/api/*`, owns a SQLite database (runs + events), spawns agents via an `AgentAdapter`, isolates each run in a git worktree, and streams `AgentEvent`s over SSE. Vite proxies `/api` to it in dev. Pure seams (DB queries, router, event mapping, process registry, run driver with injected deps) are unit-tested; process/git/http I/O wrappers are integration-verified.

**Tech Stack:** TypeScript (strict), Vite 8, Vitest 4, `node:http` / `node:child_process` / `process.loadEnvFile`, **better-sqlite3** (only new runtime dep). Spec: `docs/superpowers/specs/2026-08-18-agent-control-plane-design.md`.

## Global Constraints

- TypeScript strict; explicit type annotations on all locals, params, return types; no `any`.
- No inline comments (repo hook blocks them); JSDoc directly above an `export` is allowed.
- Only new runtime dependency is **better-sqlite3**; everything else uses Node built-ins.
- Tests do **no** network calls, no real process spawns, no real git — inject fakes.
- The agent never merges; the orchestrator performs no Jira writes in these phases.
- Conventional Commit messages; commit after each task.
- Secrets stay server-side (`.env`), never in the browser bundle.
- Node-side code lives under `server/`; `tsconfig.json` `include` already covers it.

---

## PHASE 0 — Backend foundation

### Task 1: Add better-sqlite3 + orchestrator entry scripts

**Files:**
- Modify: `package.json` (dependency + scripts)
- Modify: `tsconfig.json` (ensure `esModuleInterop`)
- Create: `scripts/dev.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run orchestrator` (runs the server, added in Task 3), `npm run dev` (Vite + orchestrator), dep `better-sqlite3` + `@types/better-sqlite3`.

- [ ] **Step 1: Install deps**

Run: `npm install better-sqlite3 && npm install -D @types/better-sqlite3`
Expected: both appear in `package.json`; native build succeeds.

- [ ] **Step 2: Ensure esModuleInterop for the CJS default import**

In `tsconfig.json` `compilerOptions`, confirm/add `"esModuleInterop": true`. Run `npx tsc --noEmit` — still clean.

- [ ] **Step 3: Add scripts**

In `package.json` `scripts`, set:

```json
"orchestrator": "tsx server/orchestrator/main.ts",
"dev": "node scripts/dev.mjs",
"serve": "tsx server/orchestrator/main.ts"
```

Install `tsx` if not present: `npm install -D tsx`.

- [ ] **Step 4: Write `scripts/dev.mjs`** (spawns Vite + orchestrator, no new dep)

```js
import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'orchestrator'], { stdio: 'inherit' }),
  spawn('npx', ['vite'], { stdio: 'inherit' }),
];

const shutdown = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const p of procs) p.on('exit', shutdown);
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json scripts/dev.mjs
git commit -m "chore: add better-sqlite3, tsx, and dev orchestrator script"
```

---

### Task 2: SQLite layer (`db.ts`)

**Files:**
- Create: `server/orchestrator/db.ts`
- Test: `server/orchestrator/db.test.ts`

**Interfaces:**
- Consumes: `better-sqlite3`.
- Produces:
  - `interface RunRow { id: string; ticketId: string; repo: string; adapter: string; status: RunStatus; attempt: number; prNumber: number | null; startedAt: string; endedAt: string | null; costUsd: number | null; worktreePath: string | null }`
  - `type RunStatus = 'running' | 'succeeded' | 'failed' | 'stopped'`
  - `interface RunEventRow { id: number; runId: string; ts: string; kind: string; text: string }`
  - `openDb(path: string): Db`
  - `interface Db { insertRun(r: RunRow): void; updateRun(id: string, patch: Partial<RunRow>): void; getRun(id: string): RunRow | null; listRuns(limit: number): RunRow[]; activeRuns(): RunRow[]; appendEvent(runId: string, kind: string, text: string, ts: string): RunEventRow; listEvents(runId: string): RunEventRow[]; close(): void }`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db, type RunRow } from './db';

let db: Db;
afterEach(() => db?.close());

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    id: 'r1', ticketId: 'LEKA-1', repo: 'o/r', adapter: 'claude-code',
    status: 'running', attempt: 1, prNumber: null,
    startedAt: '2026-08-18T00:00:00.000Z', endedAt: null, costUsd: null, worktreePath: '/tmp/w',
    ...over,
  };
}

describe('db', () => {
  it('inserts and reads a run', () => {
    db = openDb(':memory:');
    db.insertRun(run());
    expect(db.getRun('r1')?.ticketId).toBe('LEKA-1');
    expect(db.getRun('missing')).toBeNull();
  });

  it('patches a run', () => {
    db = openDb(':memory:');
    db.insertRun(run());
    db.updateRun('r1', { status: 'succeeded', prNumber: 42, endedAt: '2026-08-18T01:00:00.000Z', costUsd: 1.5 });
    const r = db.getRun('r1');
    expect(r?.status).toBe('succeeded');
    expect(r?.prNumber).toBe(42);
    expect(r?.costUsd).toBe(1.5);
  });

  it('lists active runs only', () => {
    db = openDb(':memory:');
    db.insertRun(run({ id: 'a', status: 'running' }));
    db.insertRun(run({ id: 'b', status: 'succeeded' }));
    expect(db.activeRuns().map((r) => r.id)).toEqual(['a']);
  });

  it('appends and lists events in order', () => {
    db = openDb(':memory:');
    db.insertRun(run());
    db.appendEvent('r1', 'phase', 'claimed', '2026-08-18T00:00:01.000Z');
    db.appendEvent('r1', 'log', 'working', '2026-08-18T00:00:02.000Z');
    const evs = db.listEvents('r1');
    expect(evs.map((e) => e.text)).toEqual(['claimed', 'working']);
    expect(evs[0].kind).toBe('phase');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/orchestrator/db.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `server/orchestrator/db.ts`**

```ts
import Database from 'better-sqlite3';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'stopped';

export interface RunRow {
  id: string;
  ticketId: string;
  repo: string;
  adapter: string;
  status: RunStatus;
  attempt: number;
  prNumber: number | null;
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  worktreePath: string | null;
}

export interface RunEventRow {
  id: number;
  runId: string;
  ts: string;
  kind: string;
  text: string;
}

export interface Db {
  insertRun(r: RunRow): void;
  updateRun(id: string, patch: Partial<RunRow>): void;
  getRun(id: string): RunRow | null;
  listRuns(limit: number): RunRow[];
  activeRuns(): RunRow[];
  appendEvent(runId: string, kind: string, text: string, ts: string): RunEventRow;
  listEvents(runId: string): RunEventRow[];
  close(): void;
}

const COLS: string[] = ['id', 'ticketId', 'repo', 'adapter', 'status', 'attempt', 'prNumber', 'startedAt', 'endedAt', 'costUsd', 'worktreePath'];

export function openDb(path: string): Db {
  const sql: Database.Database = new Database(path);
  sql.pragma('journal_mode = WAL');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, ticketId TEXT, repo TEXT, adapter TEXT, status TEXT,
      attempt INTEGER, prNumber INTEGER, startedAt TEXT, endedAt TEXT, costUsd REAL, worktreePath TEXT
    );
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT, ts TEXT, kind TEXT, text TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(runId, id);
  `);

  return {
    insertRun(r: RunRow): void {
      sql.prepare(`INSERT INTO runs (${COLS.join(',')}) VALUES (${COLS.map((c) => '@' + c).join(',')})`).run(r);
    },
    updateRun(id: string, patch: Partial<RunRow>): void {
      const keys: string[] = Object.keys(patch);
      if (keys.length === 0) return;
      const set: string = keys.map((k) => `${k} = @${k}`).join(', ');
      sql.prepare(`UPDATE runs SET ${set} WHERE id = @id`).run({ ...patch, id });
    },
    getRun(id: string): RunRow | null {
      return (sql.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined) ?? null;
    },
    listRuns(limit: number): RunRow[] {
      return sql.prepare('SELECT * FROM runs ORDER BY startedAt DESC LIMIT ?').all(limit) as RunRow[];
    },
    activeRuns(): RunRow[] {
      return sql.prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY startedAt DESC`).all() as RunRow[];
    },
    appendEvent(runId: string, kind: string, text: string, ts: string): RunEventRow {
      const info: Database.RunResult = sql.prepare('INSERT INTO run_events (runId, ts, kind, text) VALUES (?, ?, ?, ?)').run(runId, ts, kind, text);
      return { id: Number(info.lastInsertRowid), runId, ts, kind, text };
    },
    listEvents(runId: string): RunEventRow[] {
      return sql.prepare('SELECT * FROM run_events WHERE runId = ? ORDER BY id ASC').all(runId) as RunEventRow[];
    },
    close(): void {
      sql.close();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/orchestrator/db.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/db.ts server/orchestrator/db.test.ts
git commit -m "feat(orchestrator): SQLite runs + events store"
```

---

### Task 3: Pure request router + HTTP server serving the dashboard

**Files:**
- Create: `server/orchestrator/router.ts` (pure: request → response object)
- Create: `server/orchestrator/main.ts` (node:http binding; not unit-tested)
- Test: `server/orchestrator/router.test.ts`

**Interfaces:**
- Consumes: `buildDashboardResponse` (`server/dashboard-endpoint.ts`), `Db` (Task 2).
- Produces:
  - `interface ApiResult { status: number; json: unknown }`
  - `interface RouterDeps { dashboard: (repo: string | null) => Promise<{ snapshot: unknown; degraded: string[]; repos: string[]; selectedRepo: string | null }>; db: Db }`
  - `handleApi(method: string, path: string, query: URLSearchParams, body: unknown, deps: RouterDeps): Promise<ApiResult | null>` — returns `null` when no API route matches (so the server can fall through to static).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { handleApi, type RouterDeps } from './router';

const deps: RouterDeps = {
  dashboard: async (repo) => ({ snapshot: { repo: repo ?? 'all' }, degraded: [], repos: ['o/r'], selectedRepo: repo }),
  db: {
    listRuns: () => [{ id: 'r1', ticketId: 'T-1', repo: 'o/r', adapter: 'claude-code', status: 'running', attempt: 1, prNumber: null, startedAt: 'x', endedAt: null, costUsd: null, worktreePath: null }],
  } as unknown as RouterDeps['db'],
};

describe('handleApi', () => {
  it('serves the dashboard with the repo query', async () => {
    const r = await handleApi('GET', '/api/dashboard', new URLSearchParams('repo=o/r'), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { selectedRepo: string }).selectedRepo).toBe('o/r');
  });

  it('lists runs', async () => {
    const r = await handleApi('GET', '/api/agents', new URLSearchParams(), null, deps);
    expect(r?.status).toBe(200);
    expect((r?.json as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it('returns null for non-API paths', async () => {
    expect(await handleApi('GET', '/index.html', new URLSearchParams(), null, deps)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/orchestrator/router.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `server/orchestrator/router.ts`** (Task 12 extends this; for now dashboard + agents list)

```ts
import type { Db } from './db';

export interface ApiResult {
  status: number;
  json: unknown;
}

export interface RouterDeps {
  dashboard: (repo: string | null) => Promise<{ snapshot: unknown; degraded: string[]; repos: string[]; selectedRepo: string | null }>;
  db: Db;
}

export async function handleApi(
  method: string,
  path: string,
  query: URLSearchParams,
  _body: unknown,
  deps: RouterDeps,
): Promise<ApiResult | null> {
  if (path === '/api/dashboard' && method === 'GET') {
    const payload = await deps.dashboard(query.get('repo'));
    return { status: 200, json: payload };
  }
  if (path === '/api/agents' && method === 'GET') {
    return { status: 200, json: { runs: deps.db.listRuns(50) } };
  }
  if (path.startsWith('/api/')) {
    return { status: 404, json: { error: 'not found' } };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/orchestrator/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `server/orchestrator/main.ts`** (I/O binding — verified by running, not unit-tested)

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { existsSync } from 'node:fs';
import { buildDashboardResponse } from '../dashboard-endpoint';
import { openDb } from './db';
import { handleApi } from './router';

process.loadEnvFile('.env');

const PORT: number = Number(process.env.ORCHESTRATOR_PORT ?? '8787');
const DIST: string = join(process.cwd(), 'dist');
const db = openDb(process.env.ORCHESTRATOR_DB ?? join(process.cwd(), '.backlog-runner.sqlite'));

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    const url: URL = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const body: unknown = req.method === 'POST' ? await readBody(req) : null;
    const api = await handleApi(req.method ?? 'GET', url.pathname, url.searchParams, body, {
      dashboard: (repo) => buildDashboardResponse(process.env, new Date(), undefined, repo),
      db,
    });
    if (api) {
      res.writeHead(api.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(api.json));
      return;
    }
    const rel: string = url.pathname === '/' ? '/index.html' : url.pathname;
    const file: string = normalize(join(DIST, rel));
    if (file.startsWith(DIST) && existsSync(file)) {
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(await readFile(file));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  })().catch((err: unknown) => {
    res.writeHead(500);
    res.end(String(err));
  });
});

server.listen(PORT, () => process.stdout.write(`orchestrator on :${PORT}\n`));
```

- [ ] **Step 6: Commit**

```bash
git add server/orchestrator/router.ts server/orchestrator/router.test.ts server/orchestrator/main.ts
git commit -m "feat(orchestrator): http server + pure router serving dashboard and runs"
```

---

### Task 4: Vite dev proxy; remove the dashboard plugin

**Files:**
- Modify: `vite.config.ts`
- Delete: `vite-plugin-dashboard.ts`
- Modify: `docs`/README wiring note if present (optional)

**Interfaces:**
- Consumes: orchestrator on `ORCHESTRATOR_PORT` (default 8787).
- Produces: dev UI served by Vite with `/api/*` proxied to the orchestrator.

- [ ] **Step 1: Rewrite `vite.config.ts`**

```ts
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port: string = env.ORCHESTRATOR_PORT ?? '8787';
  return {
    server: {
      proxy: {
        '/api': { target: `http://localhost:${port}`, changeOrigin: true },
      },
    },
  };
});
```

- [ ] **Step 2: Delete the plugin**

Run: `git rm vite-plugin-dashboard.ts`

- [ ] **Step 3: Verify end-to-end**

Run: `npm run build` (UI builds) then start both: `npm run orchestrator &` and `npx vite`. Load `https://localhost:5173` (or the Vite URL) — the dashboard renders, `/api/dashboard` served by the orchestrator (check the network tab / `curl localhost:8787/api/dashboard`).
Expected: dashboard identical to before; data now comes through the orchestrator.

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts
git commit -m "refactor: proxy /api to the orchestrator; drop the dev-only dashboard plugin"
```

---

## PHASE 1 — Single live agent run

### Task 5: Agent adapter contract

**Files:**
- Create: `server/orchestrator/agents/adapter.ts`

**Interfaces:**
- Produces:
  - `interface AgentTask { ticketId: string; title: string; repo: string; jiraBaseUrl: string }`
  - `type AgentEventKind = 'phase' | 'tool' | 'log' | 'result' | 'error'`
  - `interface AgentEvent { kind: AgentEventKind; text: string; costUsd?: number; prNumber?: number }`
  - `interface AgentResult { ok: boolean; prNumber?: number; costUsd?: number }`
  - `interface AgentHandle { stop(): void; readonly exit: Promise<AgentResult> }`
  - `interface AgentAdapter { readonly id: string; start(task: AgentTask, workdir: string, onEvent: (e: AgentEvent) => void): AgentHandle }`

- [ ] **Step 1: Create the file**

```ts
export interface AgentTask {
  ticketId: string;
  title: string;
  repo: string;
  jiraBaseUrl: string;
}

export type AgentEventKind = 'phase' | 'tool' | 'log' | 'result' | 'error';

export interface AgentEvent {
  kind: AgentEventKind;
  text: string;
  costUsd?: number;
  prNumber?: number;
}

export interface AgentResult {
  ok: boolean;
  prNumber?: number;
  costUsd?: number;
}

export interface AgentHandle {
  stop(): void;
  readonly exit: Promise<AgentResult>;
}

export interface AgentAdapter {
  readonly id: string;
  start(task: AgentTask, workdir: string, onEvent: (e: AgentEvent) => void): AgentHandle;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/orchestrator/agents/adapter.ts
git commit -m "feat(orchestrator): agent adapter contract"
```

---

### Task 6: Claude Code stream-json → AgentEvent mapper (pure)

**Files:**
- Create: `server/orchestrator/agents/claude-stream.ts`
- Test: `server/orchestrator/agents/claude-stream.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` (Task 5).
- Produces: `mapStreamLine(line: string): AgentEvent | null` — parse one line of Claude Code `--output-format stream-json` into an `AgentEvent` (or null to ignore).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { mapStreamLine } from './claude-stream';

describe('mapStreamLine', () => {
  it('maps an assistant tool_use to a tool event', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
    expect(mapStreamLine(line)).toEqual({ kind: 'tool', text: 'Bash: npm test' });
  });

  it('maps assistant text to a log event', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Exploring the repo' }] } });
    expect(mapStreamLine(line)).toEqual({ kind: 'log', text: 'Exploring the repo' });
  });

  it('maps the final result with cost', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.42, result: 'done' });
    expect(mapStreamLine(line)).toEqual({ kind: 'result', text: 'done', costUsd: 0.42 });
  });

  it('ignores unknown / non-JSON lines', () => {
    expect(mapStreamLine('')).toBeNull();
    expect(mapStreamLine('not json')).toBeNull();
    expect(mapStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/orchestrator/agents/claude-stream.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `server/orchestrator/agents/claude-stream.ts`**

```ts
import type { AgentEvent } from './adapter';

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface StreamLine {
  type?: string;
  subtype?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  total_cost_usd?: number;
}

function toolText(block: ContentBlock): string {
  const input: Record<string, unknown> = block.input ?? {};
  const detail: string =
    typeof input.command === 'string'
      ? input.command
      : typeof input.file_path === 'string'
        ? input.file_path
        : '';
  return detail ? `${block.name}: ${detail}` : String(block.name);
}

export function mapStreamLine(line: string): AgentEvent | null {
  const trimmed: string = line.trim();
  if (!trimmed) return null;
  let parsed: StreamLine;
  try {
    parsed = JSON.parse(trimmed) as StreamLine;
  } catch {
    return null;
  }

  if (parsed.type === 'result') {
    return { kind: 'result', text: parsed.result ?? 'done', costUsd: parsed.total_cost_usd };
  }

  if (parsed.type === 'assistant') {
    const blocks: ContentBlock[] = parsed.message?.content ?? [];
    for (const block of blocks) {
      if (block.type === 'tool_use') return { kind: 'tool', text: toolText(block) };
      if (block.type === 'text' && block.text?.trim()) return { kind: 'log', text: block.text.trim() };
    }
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/orchestrator/agents/claude-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/agents/claude-stream.ts server/orchestrator/agents/claude-stream.test.ts
git commit -m "feat(orchestrator): map Claude Code stream-json to agent events"
```

---

### Task 7: Claude Code adapter (spawn)

**Files:**
- Create: `server/orchestrator/agents/claude-code.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `AgentTask`, `AgentEvent`, `AgentHandle`, `AgentResult` (Task 5); `mapStreamLine` (Task 6); `node:child_process`.
- Produces: `claudeCodeAdapter: AgentAdapter`.

This wraps `node:child_process.spawn` and line-splits stdout; it holds no branching logic beyond wiring, so it is integration-verified (Task 14), not unit-tested.

- [ ] **Step 1: Write `server/orchestrator/agents/claude-code.ts`**

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentResult, AgentTask } from './adapter';
import { mapStreamLine } from './claude-stream';

function buildPrompt(task: AgentTask): string {
  return [
    `Work Jira ticket ${task.ticketId}: ${task.title}.`,
    `The repository checkout is your current working directory.`,
    `Explore, implement the change, run the tests, then open a pull request with the ticket id in the title.`,
    `Do NOT merge. Stop after the PR is open.`,
  ].join(' ');
}

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  start(task: AgentTask, workdir: string, onEvent: (e: AgentEvent) => void): AgentHandle {
    const child: ChildProcess = spawn(
      'claude',
      ['-p', buildPrompt(task), '--output-format', 'stream-json', '--verbose'],
      { cwd: workdir, env: process.env },
    );

    let prNumber: number | undefined;
    let costUsd: number | undefined;

    if (child.stdout) {
      const rl: Interface = createInterface({ input: child.stdout });
      rl.on('line', (line: string) => {
        const ev: AgentEvent | null = mapStreamLine(line);
        if (!ev) return;
        if (ev.costUsd !== undefined) costUsd = ev.costUsd;
        if (ev.prNumber !== undefined) prNumber = ev.prNumber;
        onEvent(ev);
      });
    }
    if (child.stderr) {
      const rl: Interface = createInterface({ input: child.stderr });
      rl.on('line', (line: string) => onEvent({ kind: 'log', text: line }));
    }

    const exit: Promise<AgentResult> = new Promise((resolve) => {
      child.on('close', (code: number | null) => resolve({ ok: code === 0, prNumber, costUsd }));
    });

    return { stop: () => child.kill('SIGTERM'), exit };
  },
};
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/orchestrator/agents/claude-code.ts
git commit -m "feat(orchestrator): Claude Code spawn adapter"
```

---

### Task 8: Git worktree manager

**Files:**
- Create: `server/orchestrator/worktree.ts`

**Interfaces:**
- Consumes: `node:child_process`, `AGENTS_ROOT`.
- Produces:
  - `interface Worktree { path: string; branch: string }`
  - `createWorktree(agentsRoot: string, repo: string, runId: string): Promise<Worktree>` — `git worktree add` a fresh branch off the repo's default, inside `<agentsRoot>/<repo-basename>`.
  - `removeWorktree(agentsRoot: string, repo: string, worktreePath: string): Promise<void>`

Integration-verified (git I/O), not unit-tested.

- [ ] **Step 1: Write `server/orchestrator/worktree.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);

export interface Worktree {
  path: string;
  branch: string;
}

function repoBasename(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

export async function createWorktree(agentsRoot: string, repo: string, runId: string): Promise<Worktree> {
  const repoDir: string = join(agentsRoot, repoBasename(repo));
  const branch: string = `agent/${runId}`;
  const path: string = join(repoDir, '.worktrees', runId);
  await run('git', ['-C', repoDir, 'worktree', 'add', '-b', branch, path], { maxBuffer: 1024 * 1024 * 16 });
  return { path, branch };
}

export async function removeWorktree(agentsRoot: string, repo: string, worktreePath: string): Promise<void> {
  const repoDir: string = join(agentsRoot, repoBasename(repo));
  await run('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/orchestrator/worktree.ts
git commit -m "feat(orchestrator): git worktree per run"
```

---

### Task 9: Process manager (registry, single-flight, concurrency)

**Files:**
- Create: `server/orchestrator/process-manager.ts`
- Test: `server/orchestrator/process-manager.test.ts`

**Interfaces:**
- Produces:
  - `class ProcessManager { constructor(maxConcurrency: number); canStart(repo: string): { ok: true } | { ok: false; reason: string }; add(runId: string, repo: string, stop: () => void): void; remove(runId: string): void; stop(runId: string): boolean; activeRepos(): string[]; count(): number }`

Single-flight: reject a second run for a repo already active. Global cap: reject beyond `maxConcurrency`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { ProcessManager } from './process-manager';

describe('ProcessManager', () => {
  it('rejects a second run for the same repo (single-flight)', () => {
    const pm = new ProcessManager(4);
    expect(pm.canStart('o/r').ok).toBe(true);
    pm.add('r1', 'o/r', () => undefined);
    const res = pm.canStart('o/r');
    expect(res.ok).toBe(false);
  });

  it('rejects beyond max concurrency', () => {
    const pm = new ProcessManager(1);
    pm.add('r1', 'o/a', () => undefined);
    expect(pm.canStart('o/b').ok).toBe(false);
  });

  it('frees the slot on remove', () => {
    const pm = new ProcessManager(1);
    pm.add('r1', 'o/a', () => undefined);
    pm.remove('r1');
    expect(pm.canStart('o/b').ok).toBe(true);
  });

  it('stop invokes the run stopper and returns true', () => {
    const pm = new ProcessManager(4);
    const stop = vi.fn();
    pm.add('r1', 'o/a', stop);
    expect(pm.stop('r1')).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(pm.stop('missing')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/orchestrator/process-manager.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `server/orchestrator/process-manager.ts`**

```ts
interface Entry {
  repo: string;
  stop: () => void;
}

export class ProcessManager {
  private readonly maxConcurrency: number;
  private readonly entries: Map<string, Entry> = new Map();

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  canStart(repo: string): { ok: true } | { ok: false; reason: string } {
    if (this.entries.size >= this.maxConcurrency) return { ok: false, reason: 'max concurrency reached' };
    for (const entry of this.entries.values()) {
      if (entry.repo === repo) return { ok: false, reason: `a run is already active for ${repo}` };
    }
    return { ok: true };
  }

  add(runId: string, repo: string, stop: () => void): void {
    this.entries.set(runId, { repo, stop });
  }

  remove(runId: string): void {
    this.entries.delete(runId);
  }

  stop(runId: string): boolean {
    const entry: Entry | undefined = this.entries.get(runId);
    if (!entry) return false;
    entry.stop();
    return true;
  }

  activeRepos(): string[] {
    return Array.from(this.entries.values()).map((e) => e.repo);
  }

  count(): number {
    return this.entries.size;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/orchestrator/process-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/process-manager.ts server/orchestrator/process-manager.test.ts
git commit -m "feat(orchestrator): process manager with single-flight and concurrency cap"
```

---

### Task 10: SSE event bus

**Files:**
- Create: `server/orchestrator/event-bus.ts`
- Test: `server/orchestrator/event-bus.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` (Task 5).
- Produces:
  - `class RunBus { subscribe(runId: string, fn: (e: AgentEvent) => void): () => void; publish(runId: string, e: AgentEvent): void }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { RunBus } from './event-bus';
import type { AgentEvent } from './agents/adapter';

const ev: AgentEvent = { kind: 'log', text: 'hi' };

describe('RunBus', () => {
  it('delivers events to subscribers of that run only', () => {
    const bus = new RunBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('r1', a);
    bus.subscribe('r2', b);
    bus.publish('r1', ev);
    expect(a).toHaveBeenCalledWith(ev);
    expect(b).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new RunBus();
    const a = vi.fn();
    const off = bus.subscribe('r1', a);
    off();
    bus.publish('r1', ev);
    expect(a).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/orchestrator/event-bus.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `server/orchestrator/event-bus.ts`**

```ts
import type { AgentEvent } from './agents/adapter';

type Listener = (e: AgentEvent) => void;

export class RunBus {
  private readonly listeners: Map<string, Set<Listener>> = new Map();

  subscribe(runId: string, fn: Listener): () => void {
    const set: Set<Listener> = this.listeners.get(runId) ?? new Set();
    set.add(fn);
    this.listeners.set(runId, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  publish(runId: string, e: AgentEvent): void {
    const set: Set<Listener> | undefined = this.listeners.get(runId);
    if (!set) return;
    for (const fn of set) fn(e);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/orchestrator/event-bus.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/event-bus.ts server/orchestrator/event-bus.test.ts
git commit -m "feat(orchestrator): per-run SSE event bus"
```

---

### Task 11: Run driver (`runner.ts`)

**Files:**
- Create: `server/orchestrator/runner.ts`
- Test: `server/orchestrator/runner.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 2), `AgentAdapter`/`AgentTask`/`AgentEvent` (Task 5), `RunBus` (Task 10); worktree fns (Task 8) — injected for testability.
- Produces:
  - `interface RunnerDeps { db: Db; bus: RunBus; adapter: AgentAdapter; createWorktree: (repo: string, runId: string) => Promise<{ path: string; branch: string }>; removeWorktree: (repo: string, path: string) => Promise<void>; now: () => string; genId: () => string }`
  - `startRun(task: AgentTask, deps: RunnerDeps): Promise<string>` — creates the run row, worktree, spawns the adapter, streams events to db + bus, finalizes status on exit, removes the worktree. Returns the runId. **No Jira writes** (P2 adds them).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { startRun, type RunnerDeps } from './runner';
import { RunBus } from './event-bus';
import { openDb, type Db } from './db';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentTask } from './agents/adapter';

const task: AgentTask = { ticketId: 'LEKA-1', title: 'do it', repo: 'o/r', jiraBaseUrl: 'https://x' };

function fakeAdapter(events: AgentEvent[], ok: boolean, prNumber?: number): AgentAdapter {
  return {
    id: 'fake',
    start(_t: AgentTask, _wd: string, onEvent: (e: AgentEvent) => void): AgentHandle {
      for (const e of events) onEvent(e);
      return { stop: () => undefined, exit: Promise.resolve({ ok, prNumber, costUsd: 0.1 }) };
    },
  };
}

function deps(db: Db, adapter: AgentAdapter): RunnerDeps {
  return {
    db, bus: new RunBus(), adapter,
    createWorktree: async () => ({ path: '/tmp/wt', branch: 'agent/x' }),
    removeWorktree: vi.fn(async () => undefined),
    now: () => '2026-08-18T00:00:00.000Z',
    genId: () => 'run-1',
  };
}

describe('startRun', () => {
  it('records events and marks the run succeeded with the PR + cost', async () => {
    const db: Db = openDb(':memory:');
    const d = deps(db, fakeAdapter([{ kind: 'phase', text: 'exploring' }, { kind: 'result', text: 'done', costUsd: 0.1 }], true, 7));
    const id = await startRun(task, d);
    expect(id).toBe('run-1');
    const row = db.getRun('run-1');
    expect(row?.status).toBe('succeeded');
    expect(row?.prNumber).toBe(7);
    expect(row?.costUsd).toBe(0.1);
    expect(db.listEvents('run-1').some((e) => e.text === 'exploring')).toBe(true);
    expect(d.removeWorktree).toHaveBeenCalledOnce();
    db.close();
  });

  it('marks failed when the adapter exits not-ok', async () => {
    const db: Db = openDb(':memory:');
    const id = await startRun(task, deps(db, fakeAdapter([], false)));
    expect(db.getRun(id)?.status).toBe('failed');
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/orchestrator/runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `server/orchestrator/runner.ts`**

```ts
import type { Db, RunRow } from './db';
import type { RunBus } from './event-bus';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentResult, AgentTask } from './agents/adapter';

export interface RunnerDeps {
  db: Db;
  bus: RunBus;
  adapter: AgentAdapter;
  createWorktree: (repo: string, runId: string) => Promise<{ path: string; branch: string }>;
  removeWorktree: (repo: string, path: string) => Promise<void>;
  now: () => string;
  genId: () => string;
}

export async function startRun(task: AgentTask, deps: RunnerDeps): Promise<string> {
  const runId: string = deps.genId();
  const worktree: { path: string; branch: string } = await deps.createWorktree(task.repo, runId);

  const row: RunRow = {
    id: runId, ticketId: task.ticketId, repo: task.repo, adapter: deps.adapter.id,
    status: 'running', attempt: 1, prNumber: null, startedAt: deps.now(),
    endedAt: null, costUsd: null, worktreePath: worktree.path,
  };
  deps.db.insertRun(row);

  const onEvent = (e: AgentEvent): void => {
    deps.db.appendEvent(runId, e.kind, e.text, deps.now());
    deps.bus.publish(runId, e);
  };

  const handle: AgentHandle = deps.adapter.start(task, worktree.path, onEvent);
  const result: AgentResult = await handle.exit;

  deps.db.updateRun(runId, {
    status: result.ok ? 'succeeded' : 'failed',
    prNumber: result.prNumber ?? null,
    costUsd: result.costUsd ?? null,
    endedAt: deps.now(),
  });
  await deps.removeWorktree(task.repo, worktree.path);
  return runId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/orchestrator/runner.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/runner.ts server/orchestrator/runner.test.ts
git commit -m "feat(orchestrator): single-run driver (worktree, spawn, stream, persist)"
```

---

### Task 12: Wire launch / stop / list / SSE log into the router + server

**Files:**
- Modify: `server/orchestrator/router.ts` (+ its test)
- Modify: `server/orchestrator/main.ts` (SSE + POST wiring)

**Interfaces:**
- Consumes: `ProcessManager` (Task 9), `RunBus` (Task 10), `startRun` (Task 11), `Db` (Task 2).
- Produces (router additions): handle `POST /api/agents/launch` (`{ ticketId, title, repo }` → single-flight check via `deps.canStart`, then `deps.launch` returns `{ runId }`), `POST /api/agents/:id/stop`. The SSE endpoint (`GET /api/agents/:id/log`) is handled in `main.ts` because it holds the socket open.
- Extend `RouterDeps` with `canStart(repo: string): { ok: boolean; reason?: string }` and `launch(body: { ticketId: string; title: string; repo: string }): string` and `stop(runId: string): boolean`.

- [ ] **Step 1: Add failing router tests** (append to `router.test.ts`)

```ts
import { vi } from 'vitest';

const launchDeps = {
  ...deps,
  canStart: (_repo: string) => ({ ok: true }),
  launch: vi.fn((_b: { ticketId: string; title: string; repo: string }) => 'run-9'),
  stop: (id: string) => id === 'run-9',
} as unknown as RouterDeps;

describe('agent control routes', () => {
  it('launches a run and returns the id', async () => {
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1', title: 't', repo: 'o/r' }, launchDeps);
    expect(r?.status).toBe(200);
    expect((r?.json as { runId: string }).runId).toBe('run-9');
  });

  it('rejects launch when single-flight blocks it', async () => {
    const blocked = { ...launchDeps, canStart: () => ({ ok: false, reason: 'busy' }) } as unknown as RouterDeps;
    const r = await handleApi('POST', '/api/agents/launch', new URLSearchParams(), { ticketId: 'T-1', title: 't', repo: 'o/r' }, blocked);
    expect(r?.status).toBe(409);
  });

  it('stops a run', async () => {
    const r = await handleApi('POST', '/api/agents/run-9/stop', new URLSearchParams(), null, launchDeps);
    expect(r?.status).toBe(200);
  });
});
```

Update `RouterDeps` in the test's `deps` object to include `canStart`/`launch`/`stop` (no-op defaults) so existing tests still compile.

- [ ] **Step 2: Run to verify new tests fail**

Run: `npx vitest run server/orchestrator/router.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Extend `RouterDeps` + `handleApi` in `router.ts`**

Add to `RouterDeps`:

```ts
  canStart: (repo: string) => { ok: boolean; reason?: string };
  launch: (body: { ticketId: string; title: string; repo: string }) => string;
  stop: (runId: string) => boolean;
```

Add these branches before the `startsWith('/api/')` 404:

```ts
  if (path === '/api/agents/launch' && method === 'POST') {
    const b = _body as { ticketId?: string; title?: string; repo?: string } | null;
    if (!b?.ticketId || !b.repo) return { status: 400, json: { error: 'ticketId and repo required' } };
    const gate = deps.canStart(b.repo);
    if (!gate.ok) return { status: 409, json: { error: gate.reason ?? 'cannot start' } };
    const runId = deps.launch({ ticketId: b.ticketId, title: b.title ?? b.ticketId, repo: b.repo });
    return { status: 200, json: { runId } };
  }
  const stopMatch: RegExpMatchArray | null = path.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (stopMatch && method === 'POST') {
    return { status: 200, json: { stopped: deps.stop(stopMatch[1]) } };
  }
```

- [ ] **Step 4: Run router tests**

Run: `npx vitest run server/orchestrator/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire real deps + SSE in `main.ts`**

Construct singletons and pass real deps:

```ts
import { ProcessManager } from './process-manager';
import { RunBus } from './event-bus';
import { startRun } from './runner';
import { claudeCodeAdapter } from './agents/claude-code';
import { createWorktree, removeWorktree } from './worktree';
import { randomUUID } from 'node:crypto';

const pm = new ProcessManager(Number(process.env.AGENT_MAX_CONCURRENCY ?? '3'));
const bus = new RunBus();
const AGENTS_ROOT: string = process.env.AGENTS_ROOT ?? process.cwd();

function launch(body: { ticketId: string; title: string; repo: string }): string {
  const runId: string = randomUUID();
  const stopRef: { stop: () => void } = { stop: () => undefined };
  pm.add(runId, body.repo, () => stopRef.stop());
  void startRun(
    { ticketId: body.ticketId, title: body.title, repo: body.repo, jiraBaseUrl: process.env.JIRA_BASE_URL ?? '' },
    {
      db, bus, adapter: claudeCodeAdapter,
      createWorktree: (repo, id) => createWorktree(AGENTS_ROOT, repo, id),
      removeWorktree: (repo, p) => removeWorktree(AGENTS_ROOT, repo, p),
      now: () => new Date().toISOString(),
      genId: () => runId,
    },
  ).finally(() => pm.remove(runId));
  return runId;
}
```

Pass `canStart: (repo) => pm.canStart(repo)`, `launch`, `stop: (id) => pm.stop(id)` into the `handleApi` deps. Add the SSE route **before** calling `handleApi` (it owns the socket):

```ts
    const logMatch: RegExpMatchArray | null = url.pathname.match(/^\/api\/agents\/([^/]+)\/log$/);
    if (logMatch && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for (const e of db.listEvents(logMatch[1])) res.write(`data: ${JSON.stringify(e)}\n\n`);
      const off = bus.subscribe(logMatch[1], (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
      req.on('close', off);
      return;
    }
```

Note the `startRun` `genId` is pinned to the pre-generated `runId` so the process-manager key and the DB row match; the adapter's real `stop` is captured by reassigning `stopRef.stop` inside `startRun` is not possible — instead, have `launch` obtain the handle. Simplify: move `pm.add` to occur with a real stopper by returning the handle from `startRun`. If that coupling is awkward, keep `stop` as SIGTERM via a stored child map. Implementer: ensure `pm.stop(runId)` actually kills the process (store the `AgentHandle.stop` in the manager once available).

- [ ] **Step 6: Verify**

Run: `npx vitest run server/orchestrator && npx tsc --noEmit`
Expected: PASS, clean. (Endpoint I/O verified in Task 14.)

- [ ] **Step 7: Commit**

```bash
git add server/orchestrator/router.ts server/orchestrator/router.test.ts server/orchestrator/main.ts
git commit -m "feat(orchestrator): launch/stop/log endpoints wired to runner + bus"
```

---

### Task 13: UI — Launch action + live log drawer

**Files:**
- Create: `src/data/agents.ts` (client API)
- Modify: `src/render.ts` (Launch button on queue items; a log-drawer container)
- Modify: `src/main.ts` (wire Launch clicks + SSE drawer)
- Modify: `src/style.css` (drawer + launch button)

**Interfaces:**
- Consumes: `POST /api/agents/launch`, `GET /api/agents/:id/log` (SSE), `POST /api/agents/:id/stop`.
- Produces: `launchAgent(ticketId: string, title: string, repo: string): Promise<{ runId: string }>`; `openRunStream(runId: string, onEvent: (e: { kind: string; text: string }) => void): () => void`.

- [ ] **Step 1: Create `src/data/agents.ts`**

```ts
export interface LaunchResult { runId: string }

export async function launchAgent(ticketId: string, title: string, repo: string): Promise<LaunchResult> {
  const res: Response = await fetch('/api/agents/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticketId, title, repo }),
  });
  if (!res.ok) throw new Error(`launch ${res.status}`);
  return res.json() as Promise<LaunchResult>;
}

export interface RunEvent { kind: string; text: string }

export function openRunStream(runId: string, onEvent: (e: RunEvent) => void): () => void {
  const src: EventSource = new EventSource(`/api/agents/${encodeURIComponent(runId)}/log`);
  src.onmessage = (m: MessageEvent<string>) => onEvent(JSON.parse(m.data) as RunEvent);
  return () => src.close();
}
```

- [ ] **Step 2: Add a Launch button to each queue item in `render.ts`**

In the queue item template, add a button carrying the ticket + repo:

```ts
`<button class="launch-btn" data-ticket="${esc(ticket.id)}" data-title="${esc(ticket.title)}" data-repo="${esc(ticket.repo)}" aria-label="Launch agent for ${esc(ticket.id)}">Launch</button>`
```

Add a drawer container as the last child of `.wrap`:

```html
<div class="run-drawer" hidden><div class="run-drawer-head"><span class="run-drawer-title mono"></span><button class="run-drawer-close" aria-label="Close">✕</button></div><div class="run-drawer-body mono"></div></div>
```

Replace the `✕` glyph with the authored close SVG used elsewhere if one exists; otherwise a small authored SVG (no emoji).

- [ ] **Step 3: Wire clicks + SSE in `main.ts`**

After each `renderDashboard`, bind (delegate) `.launch-btn` clicks: call `launchAgent(ticket,title,repo)`, then open the drawer and `openRunStream(runId, e => appendLine(e))`. Bind `.run-drawer-close` to close the stream + hide the drawer. Keep the stream handle on the `DashboardView` instance (a field) so it's closed on re-render/close (no closed-over `let`).

- [ ] **Step 4: Style the drawer + button in `style.css`**

Use existing tokens (`--surface-2`, `--line`, `--accent`). Drawer: fixed right panel, `z-index` above the grid, `--shadow`, scrollable body, monospace lines. Launch button: small accent-outline button matching chips.

- [ ] **Step 5: Verify build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data/agents.ts src/render.ts src/main.ts src/style.css
git commit -m "feat(ui): launch agents from the backlog and stream run logs in a drawer"
```

---

### Task 14: End-to-end verification (one real run)

**Files:** none (verification + `.env.example` update)

- [ ] **Step 1: Configure**

Add to `.env.example` and set in `.env`: `ORCHESTRATOR_PORT=8787`, `AGENTS_ROOT=/absolute/path/holding/repo/checkouts`, `AGENT_MAX_CONCURRENCY=3`. Ensure a checkout of a mapped repo exists at `<AGENTS_ROOT>/<repo-basename>` with a clean default branch.

- [ ] **Step 2: Run the stack**

Run: `npm run dev` (starts orchestrator + Vite). Confirm `curl localhost:8787/api/dashboard` returns JSON and the UI loads.

- [ ] **Step 3: Launch a run**

Pick a backlog ticket, click **Launch**. Expected: a run row is created (`curl localhost:8787/api/agents` shows it `running`), the drawer opens and streams tool/log events, a git worktree appears under `AGENTS_ROOT`, and on completion the run flips to `succeeded`/`failed` and the worktree is removed. The agent opens a PR (no merge). No Jira writes yet.

- [ ] **Step 4: Commit the env docs**

```bash
git add .env.example
git commit -m "docs: orchestrator + agent env vars for local runs"
```

---

## Self-Review

**Spec coverage (P0 + P1 scope):**
- Orchestrator HTTP server + dashboard move → Tasks 3, 4. ✓
- SQLite (runs + events) → Task 2. ✓
- Vite proxy, plugin removed → Task 4. ✓
- Agent adapter contract → Task 5; Claude Code adapter (stream mapping + spawn) → Tasks 6, 7. ✓
- Worktree per task → Task 8. ✓
- Process manager (single-flight + concurrency) → Task 9. ✓
- SSE event bus + endpoints → Tasks 10, 12. ✓
- Run driver (no Jira writes) → Task 11. ✓
- UI launch + live log drawer → Task 13. ✓
- E2E verify one live run → Task 14. ✓
- Deferred to later phases (correctly absent): Jira writes/gate (P2), multi-agent running view + metrics (P3), auto-claim (P4), generic adapter + hardening (P5).

**Placeholder scan:** no TBD/TODO; every code step carries real code. Task 12 Step 5 flags one real coupling decision (how `pm.stop` reaches the live process) with two concrete options — that is a genuine implementation choice, not a placeholder; the implementer picks one and the router test already pins the contract.

**Type consistency:** `RunRow`/`RunStatus`/`RunEventRow` (Task 2) reused by router (3), runner (11), main. `AgentAdapter`/`AgentEvent`/`AgentHandle`/`AgentResult`/`AgentTask` (Task 5) reused by claude-stream (6), claude-code (7), runner (11), event-bus (10). `RouterDeps` grows in Task 12 with the test updated in lockstep. `startRun(task, deps): Promise<string>` consistent between Task 11 and its Task 12 call site.

**Note for the implementer:** better-sqlite3 is a native module — `npm install` must be able to compile it (build tools present). If the environment cannot build it, stop and surface it (do not swap the storage engine without approval). `process.loadEnvFile` requires Node ≥ 20.12; this repo targets Node 26, so it is available.
