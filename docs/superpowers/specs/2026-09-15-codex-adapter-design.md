# Codex Adapter (default) — design

Date: 2026-09-15
Status: approved (direction), pending spec review

## Problem / motivation

Helmsman launches coding agents through an `AgentAdapter`. Today there are
two impls — `claude-code` (default, spawns the `claude` CLI) and `command`
(generic template). We want **Codex** (OpenAI `codex` CLI, v0.154.0, present
on this machine) to be the **default** agent, running model **astra** at
**medium** reasoning effort, while keeping the Claude adapter available.

## Grounding (confirmed on this machine)

- `codex --version` → `codex-cli 0.154.0`.
- `codex exec` runs non-interactively (alias `e`).
- `-m, --model <MODEL>` sets the model.
- Reasoning effort is a config override: `-c model_reasoning_effort="medium"`
  (help shows the `-c key="value"` form, e.g. `-c model="o3"`).
- `--dangerously-bypass-approvals-and-sandbox` runs fully unattended (the
  Codex analog of the claude adapter's `--dangerously-skip-permissions`).
  The per-run git worktree is the working dir, not a sandbox — same posture
  as the existing adapters.

## Decisions

- **First-class `codex` adapter**, not a `command`-template hack — so the
  model/effort selectors apply and the PR-open → In-Review gate keeps working.
- **Codex becomes the runtime default**; Claude stays selectable (mixed model
  dropdown).
- Invocation: `-m astra` + `-c model_reasoning_effort="medium"`.
- Default model/effort live as constants in the codex adapter
  (`DEFAULT_MODEL='astra'`, `DEFAULT_EFFORT='medium'`) — a blank UI selection,
  a quick-launch, or an auto-claim tick all fall back to astra/medium. No new
  config env for defaults (YAGNI).

## Architecture

### Shared prompt

`buildPrompt` currently lives in `server/helmsman/agents/claude-code.ts`
and is adapter-agnostic prose (includes the merged "review the whole change
path" rule). Extract it verbatim to
`server/helmsman/agents/prompt.ts` and export it. `claude-code.ts` imports
it (drops its local copy); `codex.ts` imports it. Update the one test that
imports `buildPrompt` to import from `./prompt` (or keep a re-export from
`claude-code.ts` — implementer's call, but no behavior change).

### `server/helmsman/agents/codex.ts` (new)

Mirror the `command` adapter's spawn/parse structure.

```
const DEFAULT_MODEL = 'astra';
const DEFAULT_EFFORT = 'medium';
const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

export function validCodexEffort(effort: string | undefined | null): string | null {
  return effort && CODEX_EFFORTS.has(effort) ? effort : null;
}

export function codexArgs(task: AgentTask): string[] {
  const model = validModel(task.model) ?? DEFAULT_MODEL;      // validModel from src/logic/agentOptions
  const effort = validCodexEffort(task.effort) ?? DEFAULT_EFFORT;
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
  start(task, workdir, onEvent) {
    const { JIRA_API_TOKEN, JIRA_EMAIL, ...agentEnv } = process.env;
    const child = spawn('codex', codexArgs(task), { cwd: workdir, env: agentEnv });
    let prNumber: number | undefined;
    // stdout: emit {kind:'log'}, scan each line with parsePrNumber (reused from claude-stream)
    // stderr: emit {kind:'log'}
    // exit: code === 0 → { ok, prNumber }; 'error' → { ok:false, prNumber } after an error event
    return { stop: () => child.kill('SIGTERM'), exit };
  },
};
```

- `parsePrNumber` is currently private to `claude-stream.ts`; export it and
  import it here (single source of the PR-URL regex). If exporting is awkward,
  the `command` adapter's inline `/(?:pull\/|PR[ #]*)(\d+)/i` is an acceptable
  fallback — but prefer reuse.
- Cost is not parsed (`costUsd` omitted) — the cost cap still works for claude
  runs; codex runs simply report no cost. Acceptable; note it.

### `server/config.ts`

```
agentAdapter: 'claude-code' | 'command' | 'codex';
// parse:
const raw = req(env, 'AGENT_ADAPTER');
const agentAdapter = raw === 'command' ? 'command' : raw === 'claude-code' ? 'claude-code' : 'codex';
```

`.env` sets no `AGENT_ADAPTER`, so the runtime default flips to codex with no
`.env` edit. Update `config.test.ts` (a test currently asserts the unset
default is `'claude-code'` — flip it to `'codex'`, and assert `AGENT_ADAPTER=claude-code`
still yields claude-code).

### `server/helmsman/main.ts`

```
const adapter: AgentAdapter =
  cfg.agentAdapter === 'command' && cfg.agentCmd ? commandAdapter(cfg.agentCmd)
  : cfg.agentAdapter === 'claude-code' ? claudeCodeAdapter
  : codexAdapter;
```

Keep the existing `command`-without-`AGENT_CMD` warning. Import `codexAdapter`.

### `src/logic/agentOptions.ts`

Add astra to the shared model list (mixed with Claude models):

```
export const MODEL_OPTIONS: AgentOption[] = [
  { value: '', label: 'Default model' },
  { value: 'astra', label: 'Astra (Codex)' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'fable', label: 'Fable' },
];
```

`validModel` (regex) already accepts `astra`. `EFFORT_OPTIONS` unchanged
(medium already present). Update the agentOptions guard test if it asserts the
option count/contents.

### `src/render.ts` — `tuningSelects`

Give it defaults and mark them `selected`:

```
function tuningSelects(prefix: string, defaultModel: string = 'astra', defaultEffort: string = 'medium'): string {
  const opts = (list: AgentOption[], def: string): string =>
    list.map((o) => `<option value="${esc(o.value)}"${o.value === def ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  return `<div class="tuning">
      <select class="${prefix}-model tuning-select" aria-label="Model">${opts(MODEL_OPTIONS, defaultModel)}</select>
      <select class="${prefix}-effort tuning-select" aria-label="Effort">${opts(EFFORT_OPTIONS, defaultEffort)}</select>
    </div>`;
}
```

Both call sites (`newrun`, `pr`) inherit astra/medium. This is display default
only; the adapter fallback guarantees astra/medium even if a caller sends
blank.

### `.env.example`

Change the adapter comment/line to document the new default:

```
# AGENT_ADAPTER: codex (default) | claude-code | command
# AGENT_ADAPTER=codex
# Codex runs model 'astra' at medium reasoning effort by default.
```

(Leave it commented so unset → codex.)

## Testing

- `codex.test.ts`: `codexArgs` contains `exec`, `--dangerously-bypass-approvals-and-sandbox`,
  `-m astra` (default) and `-c model_reasoning_effort="medium"` (default); a
  provided `task.model='opus'` / `task.effort='high'` override; an invalid
  effort (`'max'`) falls back to `medium`; the prompt is the last arg. A
  spawn-level test (mirror `command.test.ts` / `claude-code` spawn test) that
  a `pull/<n>` line sets `prNumber` and exit 0 → `ok:true`.
- `validCodexEffort`: medium/high/low/minimal pass; max/xhigh/''/null → null.
- `config.test.ts`: unset `AGENT_ADAPTER` → `codex`; `=claude-code` → claude-code;
  `=command` → command.
- `agentOptions` guard test: astra present, validModel('astra') truthy.
- `render` test: `tuningSelects` marks the astra `<option>` and medium
  `<option>` `selected` at both call sites (New Run panel + PR panel).
- Full `tsc`, full vitest, `npm run build` green.

## Failure modes / edge cases

- `task.model` for a claude model (opus) selected while codex is the adapter →
  codex gets `-m opus`, which it will reject at runtime. Mixed list is the
  user's accepted tradeoff; the selector is advisory, the adapter passes it
  through. Not guarded (same as claude ignoring `astra`).
- Invalid/unsupported effort (xhigh/max) → clamped to medium default.
- `codex` binary missing → spawn `error` event → run fails cleanly (same as
  claude/command).
- PR URL not echoed in codex stdout → `prNumber` stays undefined; runner's
  `findPrNumberByBranch` fallback still runs. Best-effort, documented.

## Live-verify (after implementation)

Drive one real run (or at least `codex exec` invocation) to confirm:
1. `codex exec … <prompt>` accepts the prompt as a positional arg (vs stdin).
2. `-c model_reasoning_effort="medium"` is accepted (no arg-parse error).
3. `-m astra` resolves in this environment.
If prompt-passing differs (needs stdin or a flag), adjust `codexArgs`/`start`.

## Out of scope (YAGNI)

Removing the Claude adapter; config-env default model/effort; codex cost
parsing; per-adapter model dropdowns (mixed list is accepted); auto-detecting
codex vs claude availability.
