# cmux Control Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dashboard panel that lists all live cmux terminal tabs, streams a selected tab's screen, and sends free-text commands and high-level agent actions to it.

**Architecture:** A new isolated `server/orchestrator/cmux/` subsystem shells out to the documented `cmux` CLI (argv only, never a shell) for list/read/send/events. New REST + SSE endpoints ride the existing `node:http` server via the `handleApi` deps-injection pattern. A new frontend view renders the tab list + a polled live screen `<pre>` + input + action buttons. Zero coupling to the existing Jira/run/PR logic; degrades cleanly when cmux is not running.

**Tech Stack:** TypeScript, `node:child_process` (spawn), `node:http`, Vite front end (vanilla TS, html-template-string rendering), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-cmux-control-bridge-design.md`

## Global Constraints

- **No shell, ever.** All cmux invocations use `spawn('cmux', [args…])` with an argv array. User text is passed as a single argv element. Never `shell: true`, never string interpolation into a command line. (Repo invariant — same discipline as the generic-command adapter.)
- **Loopback only.** The orchestrator binds `127.0.0.1` (`server/orchestrator/main.ts:249`). Do not change the bind. These endpoints are RCE-equivalent by design and are safe only on loopback.
- **`--erasableSyntaxOnly` is on.** No TypeScript constructor parameter properties (`constructor(private readonly x)`). Use an explicit field + assignment in the constructor body.
- **Set `CMUX_QUIET=1`** in the child env for every `cmux` spawn to suppress the legacy-alias notice lines that would otherwise corrupt JSON parsing.
- **Tests are colocated** as `*.test.ts` next to source; run with `npm test` (`vitest run`).
- **Commit after each task** with a one-line imperative message. Do not push (user consent required).

---

## File Structure

- `server/orchestrator/cmux/model.ts` — pure normalization of cmux JSON → `CmuxTab[]`. Exports the `CmuxTab` type.
- `server/orchestrator/cmux/model.test.ts`
- `server/orchestrator/cmux/actions.ts` — pure provider→action→key-sequence map + available-action lookup.
- `server/orchestrator/cmux/actions.test.ts`
- `server/orchestrator/cmux/bridge.ts` — the only module that spawns `cmux`. Methods: `listTabs`, `readScreen`, `send`, `sendKey`, `watchEvents`. Reports "not connected" instead of throwing on socket failure.
- `server/orchestrator/cmux/bridge.test.ts` — mocks `node:child_process`.
- `server/orchestrator/router.ts` (modify) — add cmux endpoints + deps.
- `server/orchestrator/router.test.ts` (modify) — endpoint + security-invariant tests.
- `server/orchestrator/main.ts` (modify) — wire cmux deps, add the SSE route + the `events` child lifecycle.
- `src/logic/cmuxPanel.ts` — pure panel state (selection, action availability). Defines the frontend-side `CmuxTab` view type.
- `src/logic/cmuxPanel.test.ts`
- `src/render.ts` (modify) — render the cmux view (list + screen + input + actions).
- `src/main.ts` (modify) — view nav, fetch/poll/SSE wiring, event delegation for the new controls.

---

## Task 1: cmux model (pure normalization)

**Files:**
- Create: `server/orchestrator/cmux/model.ts`
- Test: `server/orchestrator/cmux/model.test.ts`

**Interfaces:**
- Consumes: raw JSON objects as returned by `cmux workspace list --json` (`{ window_ref, workspaces: [{ ref, id, index, current_directory, custom_title, title? }] }`) and `cmux list-pane-surfaces --json` (`{ pane_ref, workspace_ref, window_ref, surfaces: [{ index, ref, selected, title, type }] }`).
- Produces:
  ```ts
  export interface CmuxTab {
    windowRef: string;
    workspaceRef: string;
    workspaceTitle: string;
    surfaceRef: string;
    surfaceTitle: string;
    type: 'terminal' | 'browser' | 'simulator' | 'agent-session' | string;
    cwd: string | null;
    selected: boolean;
  }
  export function toTabs(
    workspaces: { windowRef: string; workspaceRef: string; workspaceTitle: string; cwd: string | null }[],
    surfacesByWorkspace: Record<string, { surfaceRef: string; surfaceTitle: string; type: string; selected: boolean }[]>,
  ): CmuxTab[];
  ```
  (Two already-parsed inputs keyed by `workspaceRef`; `toTabs` flattens the join. Parsing raw CLI stdout lives in the bridge, not here — this module stays free of any I/O or JSON-shape guessing beyond the typed inputs.)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { toTabs } from './model';

describe('toTabs', () => {
  it('joins workspaces to their surfaces into flat tabs', () => {
    const tabs = toTabs(
      [{ windowRef: 'window:1', workspaceRef: 'workspace:1', workspaceTitle: 'Open orchestrator', cwd: '/repo' }],
      { 'workspace:1': [{ surfaceRef: 'surface:1', surfaceTitle: 'Open orchestrator', type: 'terminal', selected: true }] },
    );
    expect(tabs).toEqual([
      {
        windowRef: 'window:1',
        workspaceRef: 'workspace:1',
        workspaceTitle: 'Open orchestrator',
        surfaceRef: 'surface:1',
        surfaceTitle: 'Open orchestrator',
        type: 'terminal',
        cwd: '/repo',
        selected: true,
      },
    ]);
  });

  it('emits one tab per surface when a workspace has several', () => {
    const tabs = toTabs(
      [{ windowRef: 'window:1', workspaceRef: 'workspace:2', workspaceTitle: 'ws', cwd: null }],
      {
        'workspace:2': [
          { surfaceRef: 'surface:1', surfaceTitle: 'a', type: 'terminal', selected: false },
          { surfaceRef: 'surface:2', surfaceTitle: 'b', type: 'browser', selected: true },
        ],
      },
    );
    expect(tabs.map((t) => t.surfaceRef)).toEqual(['surface:1', 'surface:2']);
    expect(tabs[1].type).toBe('browser');
  });

  it('emits no tabs for a workspace with no surfaces', () => {
    const tabs = toTabs([{ windowRef: 'window:1', workspaceRef: 'workspace:9', workspaceTitle: 'empty', cwd: null }], {});
    expect(tabs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- model.test`
Expected: FAIL — `toTabs` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface CmuxTab {
  windowRef: string;
  workspaceRef: string;
  workspaceTitle: string;
  surfaceRef: string;
  surfaceTitle: string;
  type: 'terminal' | 'browser' | 'simulator' | 'agent-session' | string;
  cwd: string | null;
  selected: boolean;
}

interface WorkspaceInput {
  windowRef: string;
  workspaceRef: string;
  workspaceTitle: string;
  cwd: string | null;
}
interface SurfaceInput {
  surfaceRef: string;
  surfaceTitle: string;
  type: string;
  selected: boolean;
}

export function toTabs(workspaces: WorkspaceInput[], surfacesByWorkspace: Record<string, SurfaceInput[]>): CmuxTab[] {
  const tabs: CmuxTab[] = [];
  for (const ws of workspaces) {
    const surfaces = surfacesByWorkspace[ws.workspaceRef] ?? [];
    for (const s of surfaces) {
      tabs.push({
        windowRef: ws.windowRef,
        workspaceRef: ws.workspaceRef,
        workspaceTitle: ws.workspaceTitle,
        surfaceRef: s.surfaceRef,
        surfaceTitle: s.surfaceTitle,
        type: s.type,
        cwd: ws.cwd,
        selected: s.selected,
      });
    }
  }
  return tabs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- model.test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/cmux/model.ts server/orchestrator/cmux/model.test.ts
git commit -m "feat(cmux): pure tab-model normalization"
```

---

## Task 2: cmux actions (pure provider→key map)

**Files:**
- Create: `server/orchestrator/cmux/actions.ts`
- Test: `server/orchestrator/cmux/actions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type CmuxAction = 'enter' | 'escape' | 'interrupt' | 'continue' | 'stop' | 'approve';
  export interface ActionSpec { action: CmuxAction; label: string; keys: string[]; }
  // keys are cmux send-key names, sent in order.
  export function actionsFor(provider: string | null): ActionSpec[];
  export function keysFor(provider: string | null, action: CmuxAction): string[] | null; // null = action unavailable
  ```
  Universal set (any tab, provider `null`): `enter`→`['Enter']`, `escape`→`['Escape']`, `interrupt`→`['C-c']`. When a provider is known (`'claude'`/`'codex'`/`'opencode'`), add higher-level aliases mapping to the same primitive keys: `continue`→`['Enter']`, `stop`→`['Escape']`, `approve`→`['y','Enter']`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { actionsFor, keysFor } from './actions';

describe('actions', () => {
  it('offers the universal terminal set for an unknown provider', () => {
    expect(actionsFor(null).map((a) => a.action)).toEqual(['enter', 'escape', 'interrupt']);
  });

  it('adds agent actions for a known provider', () => {
    const acts = actionsFor('claude').map((a) => a.action);
    expect(acts).toContain('continue');
    expect(acts).toContain('stop');
    expect(acts).toContain('approve');
  });

  it('maps approve to y then Enter', () => {
    expect(keysFor('claude', 'approve')).toEqual(['y', 'Enter']);
  });

  it('interrupt is Ctrl-C for any tab', () => {
    expect(keysFor(null, 'interrupt')).toEqual(['C-c']);
  });

  it('returns null for an action the provider does not offer', () => {
    expect(keysFor(null, 'approve')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- actions.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
export type CmuxAction = 'enter' | 'escape' | 'interrupt' | 'continue' | 'stop' | 'approve';
export interface ActionSpec {
  action: CmuxAction;
  label: string;
  keys: string[];
}

const UNIVERSAL: ActionSpec[] = [
  { action: 'enter', label: 'Enter', keys: ['Enter'] },
  { action: 'escape', label: 'Esc', keys: ['Escape'] },
  { action: 'interrupt', label: 'Ctrl-C', keys: ['C-c'] },
];

const AGENT: ActionSpec[] = [
  { action: 'continue', label: 'Continue', keys: ['Enter'] },
  { action: 'stop', label: 'Stop', keys: ['Escape'] },
  { action: 'approve', label: 'Approve', keys: ['y', 'Enter'] },
];

const AGENT_PROVIDERS = new Set(['claude', 'codex', 'opencode']);

export function actionsFor(provider: string | null): ActionSpec[] {
  return provider && AGENT_PROVIDERS.has(provider) ? [...UNIVERSAL, ...AGENT] : [...UNIVERSAL];
}

export function keysFor(provider: string | null, action: CmuxAction): string[] | null {
  const spec = actionsFor(provider).find((a) => a.action === action);
  return spec ? spec.keys : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- actions.test`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/cmux/actions.ts server/orchestrator/cmux/actions.test.ts
git commit -m "feat(cmux): pure provider action-to-key map"
```

---

## Task 3: cmux bridge (spawn wrapper, argv-only)

**Files:**
- Create: `server/orchestrator/cmux/bridge.ts`
- Test: `server/orchestrator/cmux/bridge.test.ts`

**Interfaces:**
- Consumes: `toTabs` + `CmuxTab` from `./model`. `node:child_process`.
- Produces:
  ```ts
  export interface Bridge {
    listTabs(): Promise<{ connected: boolean; tabs: CmuxTab[] }>;
    readScreen(surfaceRef: string, lines: number): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
    send(surfaceRef: string, text: string, enter: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
    sendKey(surfaceRef: string, key: string): Promise<{ ok: true } | { ok: false; error: string }>;
    watchEvents(onChange: () => void): () => void; // returns unsubscribe; spawns `cmux events --reconnect`
  }
  export function createBridge(run?: RunCmux): Bridge; // run defaults to a spawn-based impl; injectable for tests
  export type RunCmux = (args: string[], opts?: { input?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;
  ```
  `createBridge` takes an injectable `run` so tests never spawn a real process. The default `run` uses `spawn('cmux', args, { env: { ...process.env, CMUX_QUIET: '1' } })` — **argv array, no shell**. `send` passes `text` as the final argv element (`['send', '--surface', ref, text]`), then, if `enter`, a follow-up `['send-key', '--surface', ref, 'Enter']`. A non-zero exit or a spawn error (cmux not running) maps to `{ ok: false }` for actions and `{ connected: false, tabs: [] }` for `listTabs`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createBridge, type RunCmux } from './bridge';

function fakeRun(script: (args: string[]) => { code?: number; stdout?: string; stderr?: string }): RunCmux {
  return (args) => Promise.resolve({ code: 0, stdout: '', stderr: '', ...script(args) });
}

describe('bridge.send', () => {
  it('passes user text as a single argv element (no shell)', async () => {
    const calls: string[][] = [];
    const bridge = createBridge((args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    await bridge.send('surface:1', 'rm -rf $(pwd); echo pwned', false);
    expect(calls).toEqual([['send', '--surface', 'surface:1', 'rm -rf $(pwd); echo pwned']]);
  });

  it('sends Enter as a separate send-key call when enter=true', async () => {
    const calls: string[][] = [];
    const bridge = createBridge((args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    await bridge.send('surface:1', 'ls', true);
    expect(calls).toEqual([
      ['send', '--surface', 'surface:1', 'ls'],
      ['send-key', '--surface', 'surface:1', 'Enter'],
    ]);
  });
});

describe('bridge.listTabs', () => {
  it('reports not connected when cmux errors', async () => {
    const bridge = createBridge(() => Promise.reject(new Error('ENOENT: cmux')));
    expect(await bridge.listTabs()).toEqual({ connected: false, tabs: [] });
  });

  it('joins workspace + surface JSON into tabs', async () => {
    const run: RunCmux = (args) => {
      if (args[0] === 'workspace' && args[1] === 'list') {
        return Promise.resolve({
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            window_ref: 'window:1',
            workspaces: [{ ref: 'workspace:1', title: 'ws', current_directory: '/repo' }],
          }),
        });
      }
      // list-pane-surfaces --workspace workspace:1 --json
      return Promise.resolve({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          workspace_ref: 'workspace:1',
          window_ref: 'window:1',
          surfaces: [{ ref: 'surface:1', title: 'ws', type: 'terminal', selected: true }],
        }),
      });
    };
    const res = await createBridge(run).listTabs();
    expect(res.connected).toBe(true);
    expect(res.tabs).toHaveLength(1);
    expect(res.tabs[0].surfaceRef).toBe('surface:1');
    expect(res.tabs[0].cwd).toBe('/repo');
  });
});
```

> Note on `workspaceTitle`: cmux workspace JSON uses `custom_title`/`has_custom_title` with a computed display title. For v1, read `title` if present, else `custom_title`, else the workspace `ref`. The fixture above uses `title`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- bridge.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { spawn } from 'node:child_process';
import { toTabs, type CmuxTab } from './model';

export type RunCmux = (args: string[], opts?: { input?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface Bridge {
  listTabs(): Promise<{ connected: boolean; tabs: CmuxTab[] }>;
  readScreen(surfaceRef: string, lines: number): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  send(surfaceRef: string, text: string, enter: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
  sendKey(surfaceRef: string, key: string): Promise<{ ok: true } | { ok: false; error: string }>;
  watchEvents(onChange: () => void): () => void;
}

const defaultRun: RunCmux = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('cmux', args, { env: { ...process.env, CMUX_QUIET: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

function pickTitle(w: { title?: string; custom_title?: string | null; ref: string }): string {
  return w.title ?? w.custom_title ?? w.ref;
}

export function createBridge(run: RunCmux = defaultRun): Bridge {
  async function listTabs(): Promise<{ connected: boolean; tabs: CmuxTab[] }> {
    try {
      const wsRes = await run(['workspace', 'list', '--json']);
      if (wsRes.code !== 0) return { connected: false, tabs: [] };
      const parsed = JSON.parse(wsRes.stdout) as {
        window_ref: string;
        workspaces: { ref: string; title?: string; custom_title?: string | null; current_directory?: string | null }[];
      };
      const workspaces = parsed.workspaces.map((w) => ({
        windowRef: parsed.window_ref,
        workspaceRef: w.ref,
        workspaceTitle: pickTitle({ ...w, ref: w.ref }),
        cwd: w.current_directory ?? null,
      }));
      const surfacesByWorkspace: Record<string, { surfaceRef: string; surfaceTitle: string; type: string; selected: boolean }[]> = {};
      for (const w of workspaces) {
        const sRes = await run(['list-pane-surfaces', '--workspace', w.workspaceRef, '--json']);
        if (sRes.code !== 0) continue;
        const sParsed = JSON.parse(sRes.stdout) as { surfaces: { ref: string; title: string; type: string; selected: boolean }[] };
        surfacesByWorkspace[w.workspaceRef] = sParsed.surfaces.map((s) => ({
          surfaceRef: s.ref,
          surfaceTitle: s.title,
          type: s.type,
          selected: s.selected,
        }));
      }
      return { connected: true, tabs: toTabs(workspaces, surfacesByWorkspace) };
    } catch {
      return { connected: false, tabs: [] };
    }
  }

  async function readScreen(surfaceRef: string, lines: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    try {
      const res = await run(['read-screen', '--surface', surfaceRef, '--lines', String(lines)]);
      return res.code === 0 ? { ok: true, text: res.stdout } : { ok: false, error: res.stderr || 'read failed' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'cmux unavailable' };
    }
  }

  async function send(surfaceRef: string, text: string, enter: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await run(['send', '--surface', surfaceRef, text]);
      if (res.code !== 0) return { ok: false, error: res.stderr || 'send failed' };
      if (enter) {
        const k = await run(['send-key', '--surface', surfaceRef, 'Enter']);
        if (k.code !== 0) return { ok: false, error: k.stderr || 'enter failed' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'cmux unavailable' };
    }
  }

  async function sendKey(surfaceRef: string, key: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await run(['send-key', '--surface', surfaceRef, key]);
      return res.code === 0 ? { ok: true } : { ok: false, error: res.stderr || 'send-key failed' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'cmux unavailable' };
    }
  }

  function watchEvents(onChange: () => void): () => void {
    const child = spawn('cmux', ['events', '--reconnect', '--no-heartbeat'], { env: { ...process.env, CMUX_QUIET: '1' } });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += String(d);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as { type?: string; category?: string };
          if (ev.type === 'event' && (ev.category === 'workspace' || ev.category === 'sidebar')) onChange();
        } catch {
          /* ignore non-JSON */
        }
      }
    });
    child.on('error', () => {});
    return () => child.kill();
  }

  return { listTabs, readScreen, send, sendKey, watchEvents };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- bridge.test`
Expected: PASS (4 tests). The security test (`no shell`) passes because `send` pushes `text` as one argv element and `defaultRun` never sets `shell: true`.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/cmux/bridge.ts server/orchestrator/cmux/bridge.test.ts
git commit -m "feat(cmux): argv-only spawn bridge (list/read/send/events)"
```

---

## Task 4: REST endpoints + security-invariant test

**Files:**
- Modify: `server/orchestrator/router.ts`
- Modify: `server/orchestrator/router.test.ts`
- Modify: `server/orchestrator/main.ts` (wire deps)

**Interfaces:**
- Consumes: `Bridge` from `./cmux/bridge`, `actionsFor`/`keysFor` from `./cmux/actions`.
- Produces (new `RouterDeps` fields):
  ```ts
  cmuxListTabs: () => Promise<{ connected: boolean; tabs: CmuxTab[] }>;
  cmuxReadScreen: (surface: string, lines: number) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  cmuxSend: (surface: string, text: string, enter: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
  cmuxAction: (surface: string, provider: string | null, action: string) => Promise<{ ok: true; keys: string[] } | { ok: false; error: string }>;
  ```
  New routes in `handleApi`: `GET /api/cmux/tabs`, `GET /api/cmux/screen`, `POST /api/cmux/send`, `POST /api/cmux/action`.

- [ ] **Step 1: Write the failing test** (append to `router.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { handleApi, type RouterDeps } from './router';

function baseDeps(over: Partial<RouterDeps>): RouterDeps {
  // Minimal stub: only the cmux deps matter here; cast the rest.
  return {
    cmuxListTabs: () => Promise.resolve({ connected: true, tabs: [] }),
    cmuxReadScreen: () => Promise.resolve({ ok: true, text: 'screen' }),
    cmuxSend: () => Promise.resolve({ ok: true }),
    cmuxAction: () => Promise.resolve({ ok: true, keys: ['Enter'] }),
    ...over,
  } as unknown as RouterDeps;
}

describe('cmux endpoints', () => {
  it('GET /api/cmux/tabs returns the bridge result', async () => {
    const res = await handleApi('GET', '/api/cmux/tabs', new URLSearchParams(), null, baseDeps({}));
    expect(res).toEqual({ status: 200, json: { connected: true, tabs: [] } });
  });

  it('GET /api/cmux/screen requires a surface', async () => {
    const res = await handleApi('GET', '/api/cmux/screen', new URLSearchParams(), null, baseDeps({}));
    expect(res?.status).toBe(400);
  });

  it('POST /api/cmux/send forwards text + enter, requires surface and text', async () => {
    const calls: unknown[] = [];
    const deps = baseDeps({
      cmuxSend: (s, t, e) => {
        calls.push([s, t, e]);
        return Promise.resolve({ ok: true });
      },
    });
    const bad = await handleApi('POST', '/api/cmux/send', new URLSearchParams(), { surface: 'surface:1' }, deps);
    expect(bad?.status).toBe(400);
    const ok = await handleApi('POST', '/api/cmux/send', new URLSearchParams(), { surface: 'surface:1', text: 'ls', enter: true }, deps);
    expect(ok?.status).toBe(200);
    expect(calls).toEqual([['surface:1', 'ls', true]]);
  });

  it('POST /api/cmux/action rejects an unknown action', async () => {
    const deps = baseDeps({ cmuxAction: () => Promise.resolve({ ok: false, error: 'unknown action' }) });
    const res = await handleApi('POST', '/api/cmux/action', new URLSearchParams(), { surface: 'surface:1', action: 'nope' }, deps);
    expect(res?.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- router.test`
Expected: FAIL — cmux routes return 404 / deps missing.

- [ ] **Step 3: Write minimal implementation** (add to `handleApi` in `router.ts`, before the `if (path.startsWith('/api/'))` catch-all; add the four fields to the `RouterDeps` interface and import `CmuxTab`)

```ts
  if (path === '/api/cmux/tabs' && method === 'GET') {
    return { status: 200, json: await deps.cmuxListTabs() };
  }
  if (path === '/api/cmux/screen' && method === 'GET') {
    const surface = query.get('surface');
    if (!surface) return { status: 400, json: { error: 'surface required' } };
    const lines = Number(query.get('lines') ?? '40');
    const r = await deps.cmuxReadScreen(surface, Number.isFinite(lines) ? lines : 40);
    return r.ok ? { status: 200, json: { surface, text: r.text } } : { status: 404, json: { error: r.error } };
  }
  if (path === '/api/cmux/send' && method === 'POST') {
    const b = _body as { surface?: string; text?: string; enter?: boolean } | null;
    if (typeof b?.surface !== 'string' || typeof b?.text !== 'string') {
      return { status: 400, json: { error: 'surface and text required' } };
    }
    const r = await deps.cmuxSend(b.surface, b.text, b.enter === true);
    return r.ok ? { status: 200, json: { ok: true } } : { status: 400, json: { error: r.error } };
  }
  if (path === '/api/cmux/action' && method === 'POST') {
    const b = _body as { surface?: string; provider?: string | null; action?: string } | null;
    if (typeof b?.surface !== 'string' || typeof b?.action !== 'string') {
      return { status: 400, json: { error: 'surface and action required' } };
    }
    const r = await deps.cmuxAction(b.surface, b.provider ?? null, b.action);
    return r.ok ? { status: 200, json: { ok: true, keys: r.keys } } : { status: 400, json: { error: r.error } };
  }
```

Wire deps in `main.ts` (create one bridge instance near the other singletons, then add to the `handleApi` deps object):

```ts
import { createBridge } from './cmux/bridge';
import { actionsFor, keysFor } from './cmux/actions';
// ...
const cmux = createBridge();
// inside the deps object passed to handleApi:
      cmuxListTabs: () => cmux.listTabs(),
      cmuxReadScreen: (surface: string, lines: number) => cmux.readScreen(surface, lines),
      cmuxSend: (surface: string, text: string, enter: boolean) => cmux.send(surface, text, enter),
      cmuxAction: async (surface: string, provider: string | null, action: string) => {
        const keys = keysFor(provider, action as never);
        if (!keys) return { ok: false as const, error: 'unknown action' };
        for (const k of keys) {
          const r = await cmux.sendKey(surface, k);
          if (!r.ok) return r;
        }
        return { ok: true as const, keys };
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- router.test` then `npm test` (full suite — ensure existing router tests still pass with the widened deps).
Expected: PASS. If existing router tests build a full `RouterDeps` literal, add the four cmux fields there too.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add server/orchestrator/router.ts server/orchestrator/router.test.ts server/orchestrator/main.ts
git commit -m "feat(cmux): REST endpoints for tabs/screen/send/action"
```

---

## Task 5: SSE tree-change stream + events child lifecycle

**Files:**
- Modify: `server/orchestrator/main.ts`

**Interfaces:**
- Consumes: `cmux.watchEvents` from the bridge instance created in Task 4.
- Produces: `GET /api/cmux/events` SSE route emitting `data: {"kind":"cmux-tabs-changed"}` whenever cmux reports a workspace/sidebar change. One shared `watchEvents` subscription fans out to all connected SSE clients.

- [ ] **Step 1: Add a shared fan-out + the SSE route** (in `main.ts`, mirroring the existing `/api/agents/:id/log` SSE block at `main.ts:176`)

```ts
// near the other singletons:
const cmuxClients = new Set<ServerResponse>();
let cmuxWatchOff: (() => void) | null = null;
function ensureCmuxWatch(): void {
  if (cmuxWatchOff) return;
  cmuxWatchOff = cmux.watchEvents(() => {
    for (const res of cmuxClients) res.write(`data: ${JSON.stringify({ kind: 'cmux-tabs-changed' })}\n\n`);
  });
}
```

Add this route inside the request handler, alongside the `logMatch` block:

```ts
    if (url.pathname === '/api/cmux/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ kind: 'connected' })}\n\n`);
      cmuxClients.add(res);
      ensureCmuxWatch();
      req.on('close', () => cmuxClients.delete(res));
      return;
    }
```

- [ ] **Step 2: Manual verification (no unit test — this is process/IO glue)**

Run the dev server (`npm run dev`), then:
```bash
curl -N http://localhost:8787/api/cmux/events &
# In cmux, open or close a workspace/tab, or switch workspaces.
# Expect: a `data: {"kind":"cmux-tabs-changed"}` line appears within ~1s.
kill %1
```
Expected: the `connected` line immediately, then a `cmux-tabs-changed` line on the next cmux workspace/sidebar event.

- [ ] **Step 3: Commit**

```bash
git add server/orchestrator/main.ts
git commit -m "feat(cmux): SSE tree-change stream backed by a shared events watch"
```

---

## Task 6: frontend panel logic (pure)

**Files:**
- Create: `src/logic/cmuxPanel.ts`
- Test: `src/logic/cmuxPanel.test.ts`

**Interfaces:**
- Consumes: nothing (defines its own view type mirroring the API JSON — the front end does not import from `server/`).
- Produces:
  ```ts
  export interface CmuxTabView {
    windowRef: string;
    workspaceRef: string;
    workspaceTitle: string;
    surfaceRef: string;
    surfaceTitle: string;
    type: string;
    cwd: string | null;
    selected: boolean;
  }
  export interface PanelState { selectedSurface: string | null; }
  export function selectSurface(state: PanelState, surfaceRef: string): PanelState;
  export function isPolling(state: PanelState): boolean; // true iff a surface is selected
  export function providerOf(tab: CmuxTabView): string | null; // 'claude'|'codex'|'opencode'|null from type==='agent-session' heuristics; null for plain terminal
  ```
  `providerOf` v1: return `null` unless `tab.type === 'agent-session'` — provider strings are not yet reliably exposed per-surface, so plain terminals get the universal action set. (When richer provider data lands, this is the single place to enrich.)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { selectSurface, isPolling, providerOf, type CmuxTabView } from './cmuxPanel';

const tab = (over: Partial<CmuxTabView>): CmuxTabView => ({
  windowRef: 'window:1',
  workspaceRef: 'workspace:1',
  workspaceTitle: 'ws',
  surfaceRef: 'surface:1',
  surfaceTitle: 's',
  type: 'terminal',
  cwd: null,
  selected: false,
  ...over,
});

describe('cmuxPanel', () => {
  it('selecting a surface stores it and enables polling', () => {
    const s = selectSurface({ selectedSurface: null }, 'surface:2');
    expect(s.selectedSurface).toBe('surface:2');
    expect(isPolling(s)).toBe(true);
  });

  it('no selection means no polling', () => {
    expect(isPolling({ selectedSurface: null })).toBe(false);
  });

  it('providerOf is null for a plain terminal', () => {
    expect(providerOf(tab({ type: 'terminal' }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- cmuxPanel.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface CmuxTabView {
  windowRef: string;
  workspaceRef: string;
  workspaceTitle: string;
  surfaceRef: string;
  surfaceTitle: string;
  type: string;
  cwd: string | null;
  selected: boolean;
}
export interface PanelState {
  selectedSurface: string | null;
}
export function selectSurface(state: PanelState, surfaceRef: string): PanelState {
  return { ...state, selectedSurface: surfaceRef };
}
export function isPolling(state: PanelState): boolean {
  return state.selectedSurface !== null;
}
export function providerOf(tab: CmuxTabView): string | null {
  return tab.type === 'agent-session' ? 'claude' : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- cmuxPanel.test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/logic/cmuxPanel.ts src/logic/cmuxPanel.test.ts
git commit -m "feat(cmux): pure frontend panel state"
```

---

## Task 7: frontend view (list + live screen + input + actions)

**Files:**
- Modify: `src/render.ts` (add `renderCmuxView`)
- Modify: `src/main.ts` (nav entry, fetch/poll/SSE wiring, delegated click/submit handlers)
- Modify: `src/style.css` (reuse existing `.panel` classes; add minimal cmux layout rules)

**Interfaces:**
- Consumes: `CmuxTabView`, `selectSurface`, `isPolling`, `providerOf` from `./logic/cmuxPanel`; the four REST endpoints + the SSE stream.
- Produces: a rendered cmux view string + wired interactions. No new exported types for later tasks.

- [ ] **Step 1: Add `renderCmuxView` to `render.ts`** (pure string builder, mirrors `renderPrPanel` style)

```ts
import { actionsFor } from '../server/orchestrator/cmux/actions'; // if cross-import is disallowed by tsconfig, inline the label list instead
import type { CmuxTabView } from './logic/cmuxPanel';
import { providerOf } from './logic/cmuxPanel';

export function renderCmuxView(
  state: { connected: boolean; tabs: CmuxTabView[]; selectedSurface: string | null; screen: string },
): string {
  if (!state.connected) return '<div class="panel empty-note">cmux not connected. Is the cmux app running?</div>';
  const list = state.tabs
    .map(
      (t) => `<button class="cmux-tab ${t.surfaceRef === state.selectedSurface ? 'is-selected' : ''}" data-surface="${t.surfaceRef}">
        <span class="cmux-tab-title">${escapeHtml(t.surfaceTitle)}</span>
        <span class="cmux-tab-meta mono">${escapeHtml(t.workspaceTitle)} · ${t.type}</span>
      </button>`,
    )
    .join('');
  const selected = state.tabs.find((t) => t.surfaceRef === state.selectedSurface) ?? null;
  const actionBtns = selected
    ? actionsFor(providerOf(selected))
        .map((a) => `<button class="cmux-action" data-action="${a.action}">${a.label}</button>`)
        .join('')
    : '';
  const screen = selected
    ? `<pre class="cmux-screen mono">${escapeHtml(state.screen)}</pre>
       <form class="cmux-send"><input class="cmux-input" name="text" placeholder="Send to ${escapeHtml(selected.surfaceTitle)}…" autocomplete="off" /><button type="submit">Send ⏎</button></form>
       <div class="cmux-actions">${actionBtns}</div>`
    : '<div class="empty-note">Select a tab to view its screen.</div>';
  return `<div class="cmux-view"><div class="panel cmux-list">${list}</div><div class="panel cmux-detail">${screen}</div></div>`;
}
```

Use the existing HTML-escape helper (`src/logic/html.ts`); import it as the other render functions do. **If `src/` may not import from `server/`** (check `tsconfig.json` `include`/paths — the front end is a separate Vite build), do NOT import `actionsFor` from the server; inline a local `CMUX_ACTION_LABELS` array in `render.ts` instead. Resolve this during the task and pick one.

- [ ] **Step 2: Wire `src/main.ts`** — add a nav entry that switches to the cmux view, and on entry:
  - `GET /api/cmux/tabs` → render list.
  - open `EventSource('/api/cmux/events')`; on `cmux-tabs-changed`, re-fetch `/api/cmux/tabs`.
  - on tab click (delegated): `selectSurface`, start a `setInterval` (~750ms) that `GET /api/cmux/screen?surface=&lines=40` and re-renders the `<pre>`; clear the interval when leaving the view or selecting another tab (guard with `isPolling`).
  - on send-form submit (delegated): `POST /api/cmux/send {surface, text, enter:true}`, clear the input.
  - on action button click (delegated): `POST /api/cmux/action {surface, provider, action}`.

  **Follow the memory lesson (P7):** if any of these controls render into a body-appended container rather than `#app`, attach the delegated listener to the actual container. Here everything renders inside the main view root, so delegate on that root — but verify the listener root contains the rendered targets before assuming clicks fire.

- [ ] **Step 3: Manual verification (this task's deliverable is visual/interactive)**

Run `npm run dev`, open `http://localhost:5173/`, go to the cmux view:
  - The list shows this session's own tab(s).
  - Selecting a tab shows its live screen, refreshing ~1/s.
  - Typing `echo hello` + Send makes `hello` appear in the screen.
  - An action button (e.g. Enter) affects the selected tab.
  - Quitting the cmux app flips the view to "cmux not connected".

- [ ] **Step 4: Typecheck, build, test, commit**

```bash
npx tsc --noEmit && npm run build && npm test
git add src/render.ts src/main.ts src/style.css
git commit -m "feat(cmux): dashboard view — tab list, live screen, send, actions"
```

---

## Task 8: live smoke + degraded-mode verification + memory update

**Files:**
- Modify: `memory.md` (session log + TODO updates)

- [ ] **Step 1: Full live smoke against real cmux**
  - Open a scratch cmux tab (`cmux ~/tmp` or a new workspace). From the dashboard: select it, send `pwd`, confirm output; fire Enter/Esc/Ctrl-C actions; confirm the tab list updates when you open/close a cmux workspace (SSE path).
  - Confirm the send path is argv-only in practice: `git grep -n "shell: true" server/orchestrator/cmux` returns nothing.

- [ ] **Step 2: Degraded-mode check**
  - Quit the cmux app. Reload the dashboard cmux view → "cmux not connected". Confirm the rest of the dashboard (agents/queue/config) still works. Relaunch cmux → the view recovers on next fetch.

- [ ] **Step 3: Update `memory.md`**
  - Append a dated `2026-09-01` session-log entry describing the cmux control bridge (subsystem, endpoints, transport choice, security posture).
  - Resolve/annotate the relevant TODO. Add the spec + plan paths to External references.

- [ ] **Step 4: Commit**

```bash
git add memory.md
git commit -m "docs: record cmux control bridge in project memory"
```

---

## Self-Review

**Spec coverage:**
- All tabs listed → Tasks 1, 3, 4 (`listTabs` + `/api/cmux/tabs`). ✔
- Live screen → Tasks 3, 4, 7 (`readScreen` + `/api/cmux/screen` + polled `<pre>`). ✔
- Free-text send → Tasks 3, 4, 7 (`send` + `/api/cmux/send` + input form). ✔
- High-level actions → Tasks 2, 4, 7 (`actions.ts` + `/api/cmux/action` + buttons). ✔
- Live change push → Task 5 (SSE + events child). ✔
- Security (argv-only, loopback, invariant test) → Global Constraints + Task 3 send test + Task 8 grep. ✔
- Degraded mode → Task 3 (`connected:false`) + Task 7 render + Task 8 check. ✔
- YAGNI cuts (no xterm.js, one screen, no launching) → honored; nothing in the plan adds them. ✔

**Placeholder scan:** No TBD/TODO-in-code; every code step has real content; the two genuine decision points (front-end→server import allowed? / workspace title field) are called out explicitly with a default and a fallback, not left vague. ✔

**Type consistency:** `CmuxTab` (server, model.ts) vs `CmuxTabView` (frontend, cmuxPanel.ts) are intentionally separate (no cross-boundary import) with identical shape. `keysFor(provider, action)` signature matches its use in `main.ts` deps. `Bridge` method names (`listTabs`/`readScreen`/`send`/`sendKey`/`watchEvents`) match router deps and main.ts wiring. Endpoint bodies match the router tests. ✔
