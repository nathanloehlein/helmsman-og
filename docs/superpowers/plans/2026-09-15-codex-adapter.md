# Codex Adapter (default) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `codex` agent adapter, make it the runtime default (Claude stays selectable), and default runs to model `astra` at `medium` effort.

**Architecture:** New `codexAdapter` spawns `codex exec` (mirrors the existing `command` adapter's spawn/parse). `buildPrompt` is extracted to a shared module both adapters import. Config default `AGENT_ADAPTER` flips to codex. UI model list gains Astra; the tuning dropdowns default-select astra/medium.

**Tech Stack:** TypeScript strict + `--erasableSyntaxOnly` (NO constructor parameter properties), Node `node:child_process`/`node:readline` Helmsman under `tsx`, Vite front end, Vitest + jsdom. `codex` CLI v0.154.0 on PATH.

**Spec:** `docs/superpowers/specs/2026-09-15-codex-adapter-design.md`

## Global Constraints

- Codex invocation: `codex exec --dangerously-bypass-approvals-and-sandbox -m <model> -c model_reasoning_effort="<effort>" <prompt>`. Prompt is the last positional arg.
- Defaults are constants in the codex adapter: `DEFAULT_MODEL='astra'`, `DEFAULT_EFFORT='medium'`. Blank/invalid model → astra; effort not in {minimal,low,medium,high} → medium.
- Runtime default adapter is codex: unset or unrecognized `AGENT_ADAPTER` → `'codex'`; `'claude-code'` → claude-code; `'command'` → command.
- Strip `JIRA_API_TOKEN`/`JIRA_EMAIL` from the child env (same as claude/command adapters).
- `--erasableSyntaxOnly`: explicit field + assignment; no ctor parameter properties.
- No comments unless a non-obvious "why". Match surrounding style.
- Vitest: `npx vitest run <file>`. Full gate before finishing: `npx tsc --noEmit && npx vitest run && npm run build`.

---

### Task 1: Extract shared `buildPrompt`

**Files:**
- Create: `server/helmsman/agents/prompt.ts`
- Modify: `server/helmsman/agents/claude-code.ts` (remove local `buildPrompt`, import from `./prompt`)
- Modify: `server/helmsman/agents/claude-code.test.ts` (import `buildPrompt` from `./prompt`)

**Interfaces:**
- Consumes: `AgentTask` (`./adapter`).
- Produces: `export function buildPrompt(task: AgentTask): string` in `prompt.ts`.

- [ ] **Step 1: Create `prompt.ts` with the current buildPrompt verbatim**

Move the entire existing `buildPrompt` function (all four branches incl. the "Review the whole change path…" review-agent line) from `claude-code.ts` into a new `server/helmsman/agents/prompt.ts`:

```ts
import type { AgentTask } from './adapter';

export function buildPrompt(task: AgentTask): string {
  // ... exact body currently in claude-code.ts, unchanged ...
}
```

Copy the body exactly as it stands in `claude-code.ts` today — do not reword any prompt text.

- [ ] **Step 2: Update `claude-code.ts` to import it**

Remove the `buildPrompt` function from `claude-code.ts`. Add `import { buildPrompt } from './prompt';`. Leave `agentFlags` and `claudeCodeAdapter` as-is (they call `buildPrompt`).

- [ ] **Step 3: Update the claude-code test import**

In `claude-code.test.ts`, change `import { agentFlags, buildPrompt } from './claude-code';` to import `buildPrompt` from `./prompt` and `agentFlags` from `./claude-code` (two imports). Do not change any assertions.

- [ ] **Step 4: Run the affected tests + typecheck**

Run: `npx vitest run server/helmsman/agents/claude-code.test.ts && npx tsc --noEmit`
Expected: PASS, clean (pure move, no behavior change).

- [ ] **Step 5: Commit**

```bash
git add server/helmsman/agents/prompt.ts server/helmsman/agents/claude-code.ts server/helmsman/agents/claude-code.test.ts
git commit -m "Extract shared buildPrompt for reuse across adapters"
```

---

### Task 2: `parsePrNumber` reusable

**Files:**
- Modify: `server/helmsman/agents/claude-stream.ts` (export `parsePrNumber`)
- Test: `server/helmsman/agents/claude-stream.test.ts` (add a direct `parsePrNumber` test if not already covered)

**Interfaces:**
- Produces: `export function parsePrNumber(text: string): number | undefined` (same signature it already has internally).

- [ ] **Step 1: Read the current `parsePrNumber`**

Open `server/helmsman/agents/claude-stream.ts`. It has a `parsePrNumber` used by `mapStreamLine`. If it is already `export`ed, skip to Task 3 (note that in your report). Otherwise continue.

- [ ] **Step 2: Add a failing direct test**

Append to `server/helmsman/agents/claude-stream.test.ts`:

```ts
import { parsePrNumber } from './claude-stream';

describe('parsePrNumber', () => {
  it('extracts the number from a PR URL', () => {
    expect(parsePrNumber('opened https://github.com/o/r/pull/8922 done')).toBe(8922);
  });
  it('returns undefined when absent', () => {
    expect(parsePrNumber('no pr here')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run server/helmsman/agents/claude-stream.test.ts`
Expected: FAIL — `parsePrNumber` is not exported.

- [ ] **Step 4: Export it**

Add `export` to the existing `function parsePrNumber(...)` in `claude-stream.ts`. Do not change its body.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run server/helmsman/agents/claude-stream.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/helmsman/agents/claude-stream.ts server/helmsman/agents/claude-stream.test.ts
git commit -m "Export parsePrNumber for adapter reuse"
```

---

### Task 3: Codex adapter

**Files:**
- Create: `server/helmsman/agents/codex.ts`
- Test: `server/helmsman/agents/codex.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`/`AgentEvent`/`AgentHandle`/`AgentResult`/`AgentTask` (`./adapter`), `buildPrompt` (`./prompt`), `parsePrNumber` (`./claude-stream`), `validModel` (`../../../src/logic/agentOptions`).
- Produces: `codexAdapter: AgentAdapter` (id `'codex'`), `codexArgs(task: AgentTask): string[]`, `validCodexEffort(effort: string | undefined | null): string | null`.

- [ ] **Step 1: Write the failing test**

Create `server/helmsman/agents/codex.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { codexArgs, validCodexEffort, codexAdapter } from './codex';
import type { AgentTask } from './adapter';

function task(over: Partial<AgentTask> = {}): AgentTask {
  return { ticketId: 'AB-1', title: 't', repo: 'o/r', jiraBaseUrl: '', ...over };
}

describe('validCodexEffort', () => {
  it('accepts codex efforts', () => {
    for (const e of ['minimal', 'low', 'medium', 'high']) expect(validCodexEffort(e)).toBe(e);
  });
  it('rejects non-codex efforts and blanks', () => {
    for (const e of ['xhigh', 'max', '', null, undefined]) expect(validCodexEffort(e)).toBeNull();
  });
});

describe('codexArgs', () => {
  it('defaults to exec, bypass, astra, medium, prompt last', () => {
    const args = codexArgs(task());
    expect(args[0]).toBe('exec');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('astra');
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="medium"');
    expect(args[args.length - 1]).toContain('AB-1'); // prompt is last, references the ticket
  });
  it('honors a provided model and effort', () => {
    const args = codexArgs(task({ model: 'opus', effort: 'high' }));
    expect(args[args.indexOf('-m') + 1]).toBe('opus');
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"');
  });
  it('clamps an unsupported effort to medium', () => {
    const args = codexArgs(task({ effort: 'max' }));
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="medium"');
  });
  it('falls back to astra for a blank model', () => {
    expect(codexArgs(task({ model: '' })) [codexArgs(task({ model: '' })).indexOf('-m') + 1]).toBe('astra');
  });
});

describe('codexAdapter.start', () => {
  it('has id codex', () => {
    expect(codexAdapter.id).toBe('codex');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/helmsman/agents/codex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `codex.ts`**

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { AgentAdapter, AgentEvent, AgentHandle, AgentResult, AgentTask } from './adapter';
import { buildPrompt } from './prompt';
import { parsePrNumber } from './claude-stream';
import { validModel } from '../../../src/logic/agentOptions';

const DEFAULT_MODEL: string = 'astra';
const DEFAULT_EFFORT: string = 'medium';
const CODEX_EFFORTS: Set<string> = new Set(['minimal', 'low', 'medium', 'high']);

export function validCodexEffort(effort: string | undefined | null): string | null {
  return effort && CODEX_EFFORTS.has(effort) ? effort : null;
}

export function codexArgs(task: AgentTask): string[] {
  const model: string = validModel(task.model) ?? DEFAULT_MODEL;
  const effort: string = validCodexEffort(task.effort) ?? DEFAULT_EFFORT;
  return [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m', model,
    '-c', `model_reasoning_effort="${effort}"`,
    buildPrompt(task),
  ];
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  start(task: AgentTask, workdir: string, onEvent: (e: AgentEvent) => void): AgentHandle {
    const { JIRA_API_TOKEN, JIRA_EMAIL, ...agentEnv } = process.env;
    const child: ChildProcess = spawn('codex', codexArgs(task), { cwd: workdir, env: agentEnv });

    let prNumber: number | undefined;

    if (child.stdout) {
      const rl: Interface = createInterface({ input: child.stdout });
      rl.on('line', (line: string) => {
        const parsed: number | undefined = parsePrNumber(line);
        if (parsed !== undefined) prNumber = parsed;
        onEvent({ kind: 'log', text: line });
      });
    }
    if (child.stderr) {
      const rl: Interface = createInterface({ input: child.stderr });
      rl.on('line', (line: string) => onEvent({ kind: 'log', text: line }));
    }

    const exit: Promise<AgentResult> = new Promise((resolve) => {
      child.on('close', (code: number | null) => resolve({ ok: code === 0, prNumber }));
      child.on('error', (err: Error) => {
        onEvent({ kind: 'error', text: err.message });
        resolve({ ok: false, prNumber });
      });
    });

    return { stop: () => child.kill('SIGTERM'), exit };
  },
};
```

Note: `parsePrNumber` returns `number | undefined`. If Task 2 found it returns `number | null`, adapt the check accordingly (`!== null`) and keep `prNumber` typed to match.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/helmsman/agents/codex.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/helmsman/agents/codex.ts server/helmsman/agents/codex.test.ts
git commit -m "Add codex adapter (codex exec, astra/medium defaults)"
```

---

### Task 4: Config default → codex

**Files:**
- Modify: `server/config.ts`
- Test: `server/config.test.ts`

**Interfaces:**
- Produces: `AppConfig.agentAdapter: 'claude-code' | 'command' | 'codex'` with default `'codex'`.

- [ ] **Step 1: Update the failing test first**

In `server/config.test.ts`, find the assertion that an unset `AGENT_ADAPTER` yields `'claude-code'`. Change it to expect `'codex'`, and add/keep assertions:

```ts
// unset → codex
expect(loadConfig({ ...baseEnv, AGENT_ADAPTER: undefined }).agentAdapter).toBe('codex');
// explicit claude-code preserved
expect(loadConfig({ ...baseEnv, AGENT_ADAPTER: 'claude-code' }).agentAdapter).toBe('claude-code');
// command preserved
expect(loadConfig({ ...baseEnv, AGENT_ADAPTER: 'command' }).agentAdapter).toBe('command');
```

(Use whatever `baseEnv`/config-fixture the file already defines; match its style. If an existing test asserted `claude-code` as the unset default, that is the one to flip — do not leave a contradictory assertion.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/config.test.ts`
Expected: FAIL — unset still returns `'claude-code'`.

- [ ] **Step 3: Update `server/config.ts`**

Change the type on `AppConfig`:

```ts
agentAdapter: 'claude-code' | 'command' | 'codex';
```

Change the parse (currently `req(env,'AGENT_ADAPTER') === 'command' ? 'command' : 'claude-code'`):

```ts
const rawAdapter: string | null = req(env, 'AGENT_ADAPTER');
const agentAdapter: 'claude-code' | 'command' | 'codex' =
  rawAdapter === 'command' ? 'command' : rawAdapter === 'claude-code' ? 'claude-code' : 'codex';
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/config.ts server/config.test.ts
git commit -m "Default AGENT_ADAPTER to codex"
```

---

### Task 5: Wire codex adapter selection in main

**Files:**
- Modify: `server/helmsman/main.ts`

**Interfaces:**
- Consumes: `codexAdapter` (`./agents/codex`), `cfg.agentAdapter`.

- [ ] **Step 1: Import and select**

Add `import { codexAdapter } from './agents/codex';` near the other adapter imports.

Replace the adapter-selection line (currently
`cfg.agentAdapter === 'command' && cfg.agentCmd ? commandAdapter(cfg.agentCmd) : claudeCodeAdapter`) with:

```ts
const adapter: AgentAdapter =
  cfg.agentAdapter === 'command' && cfg.agentCmd
    ? commandAdapter(cfg.agentCmd)
    : cfg.agentAdapter === 'claude-code'
      ? claudeCodeAdapter
      : codexAdapter;
```

Keep the existing `AGENT_ADAPTER=command but AGENT_CMD is empty` warning immediately after (it already guards `cfg.agentAdapter === 'command' && !cfg.agentCmd`).

- [ ] **Step 2: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean; all tests pass. (No unit test for main wiring — it's the composition root; the full suite + typecheck cover it. The live-verify at the end exercises it.)

- [ ] **Step 3: Commit**

```bash
git add server/helmsman/main.ts
git commit -m "Select codex adapter as the default in the helmsman"
```

---

### Task 6: UI model option + default selections

**Files:**
- Modify: `src/logic/agentOptions.ts`
- Modify: `src/logic/agentOptions.test.ts` (if it asserts option contents)
- Modify: `src/render.ts` (`tuningSelects`)
- Test: `src/render.test.ts`

**Interfaces:**
- Produces: `MODEL_OPTIONS` includes `{ value: 'astra', label: 'Astra (Codex)' }`; `tuningSelects(prefix, defaultModel='astra', defaultEffort='medium')` marks defaults `selected`.

- [ ] **Step 1: Add astra to MODEL_OPTIONS**

In `src/logic/agentOptions.ts`, insert astra after the Default entry:

```ts
export const MODEL_OPTIONS: AgentOption[] = [
  { value: '', label: 'Default model' },
  { value: 'astra', label: 'Astra (Codex)' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'fable', label: 'Fable' },
];
```

If `agentOptions.test.ts` asserts the exact array/length, update it to include astra and assert `validModel('astra')` is truthy. If it makes no such assertion, add a small test:

```ts
it('offers astra as a model option', () => {
  expect(MODEL_OPTIONS.some((o) => o.value === 'astra')).toBe(true);
  expect(validModel('astra')).toBe('astra');
});
```

- [ ] **Step 2: Write the failing render test**

Append to `src/render.test.ts` a test that renders the dashboard (or the New Run panel) and asserts the model select has astra selected and the effort select has medium selected. Reuse the file's existing `root()`/`renderDashboard(...)` harness:

```ts
it('defaults the New Run tuning selects to astra and medium', () => {
  const el = root();
  renderDashboard(el, snapshot(), NOW);
  const model = el.querySelector<HTMLSelectElement>('.newrun-model')!;
  const effort = el.querySelector<HTMLSelectElement>('.newrun-effort')!;
  expect(model.querySelector<HTMLOptionElement>('option[selected]')?.value).toBe('astra');
  expect(effort.querySelector<HTMLOptionElement>('option[selected]')?.value).toBe('medium');
});
```

(If jsdom `option[selected]` is unreliable, assert the rendered HTML string of `renderDashboard` contains `value="astra" selected` and `value="medium" selected` instead — check how the existing theme-select test at the top of the file queries `option[selected]` and mirror that; it already uses `option[selected]`, so the selector is known to work here.)

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/render.test.ts`
Expected: FAIL — no option marked selected (first option `''` is the implicit default today).

- [ ] **Step 4: Update `tuningSelects` in `src/render.ts`**

```ts
function tuningSelects(prefix: string, defaultModel: string = 'astra', defaultEffort: string = 'medium'): string {
  const opts = (list: AgentOption[], def: string): string =>
    list.map((o) => `<option value="${esc(o.value)}"${o.value === def ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  return `<div class="tuning">
      <select class="${prefix}-model tuning-select" aria-label="Model">${opts(MODEL_OPTIONS, defaultModel)}</select>
      <select class="${prefix}-effort tuning-select" aria-label="Effort">${opts(EFFORT_OPTIONS, defaultEffort)}</select>
    </div>`;
}
```

Both existing call sites (`tuningSelects('newrun')`, `tuningSelects('pr')`) now inherit astra/medium — no call-site change needed.

- [ ] **Step 5: Run to verify it passes + full gate**

Run: `npx vitest run src/render.test.ts src/logic/agentOptions.test.ts && npx tsc --noEmit && npm run build`
Expected: PASS, clean, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/logic/agentOptions.ts src/logic/agentOptions.test.ts src/render.ts src/render.test.ts
git commit -m "Add Astra model option and default tuning selects to astra/medium"
```

---

### Task 7: Document the default in .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Update the adapter comment/line**

Find the current lines:

```
# AGENT_ADAPTER: claude-code (default) | command
AGENT_ADAPTER=claude-code
```

Replace with (leave commented so unset → codex):

```
# AGENT_ADAPTER: codex (default) | claude-code | command
# Codex runs model 'astra' at medium reasoning effort by default.
# AGENT_ADAPTER=codex
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "Document codex as the default agent adapter"
```

---

## Self-Review

**Spec coverage:**
- Codex adapter (exec, bypass, -m, -c effort, prompt last, PR parse, defaults, effort clamp) → Task 3. ✓
- Shared buildPrompt → Task 1. ✓
- parsePrNumber reuse → Task 2. ✓
- Config default codex, claude/command preserved → Task 4. ✓
- main selection → Task 5. ✓
- Astra option + default astra/medium selects → Task 6. ✓
- .env.example → Task 7. ✓
- Effort clamp (xhigh/max→medium), blank model→astra → Task 3 tests. ✓
- Full tsc/vitest/build gate → Tasks 5 & 6. ✓

**Placeholder scan:** none — every code step has full code. Task 2 and Task 3 both flag the `undefined` vs `null` return-shape of `parsePrNumber` for the implementer to reconcile against the actual source (Task 2 reads it first).

**Type consistency:** `codexArgs`/`validCodexEffort`/`codexAdapter` signatures match between the test (Task 3 Step 1) and impl (Step 3). `agentAdapter` union identical across config type, parse, and main selection (Tasks 4–5). `validModel` imported from the same path the claude adapter uses. `tuningSelects` default params match the render test's expectations (Task 6).

**Ordering:** Task 1 (prompt) and Task 2 (parsePrNumber export) precede Task 3 (adapter consumes both). Task 3 precedes Task 5 (main imports the adapter). Task 4 (config union) precedes Task 5 (main switches on it). Task 6/7 independent of 3–5 but harmless in this order.

**Live-verify (post-merge, not a task):** drive one real `codex exec` invocation to confirm prompt-as-positional-arg, `-c model_reasoning_effort` acceptance, and `-m astra` resolution; adjust `codexArgs` if prompt must go via stdin.
