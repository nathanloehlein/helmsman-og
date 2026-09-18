# PR Controls (P7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** View PR status (state, CI, review decision, comments) and act on any PR (approve / request-changes / comment) from the dashboard, and re-run the agent on an existing PR branch with feedback so it updates the same PR. Merge stays GitHub-only.

**Architecture:** GitHub PR read/write via the server-side token (new `/api/pr*` endpoints proxy it), a PR panel + review-any-PR form in the UI, and a `rerun` launch mode that checks out the existing PR branch. Builds on P0–P6. Spec: `docs/superpowers/specs/2026-08-24-pr-controls-design.md`.

**Tech Stack:** TypeScript (strict), Vitest (jsdom for UI), Node built-ins, better-sqlite3. No new deps.

## Global Constraints

- TS strict; explicit type annotations on every local, parameter, and return type — including single-use locals; no `any`.
- No inline comments (JSDoc above an `export` only if useful; `.env.example` lines follow that file's convention).
- Prefer `const`; no free `let` closed over by a callback. `tsconfig` has `erasableSyntaxOnly` — no constructor parameter properties.
- No new deps. Tests do no real network/spawn/git — stub `fetch`, inject fakes; DB tests use `openDb(':memory:')`.
- **No Merge from the UI.** No merge endpoint, no merge button. The agent never merges; merge stays a human action on GitHub.
- **GitHub token stays server-side.** Never returned to or referenced by the client. Review/re-run writes go through Helmsman (127.0.0.1).
- Re-run feedback reaches the agent prompt only (one argv element), never a shell.
- Escape untrusted strings (PR title/branch/repo, GitHub error text, review decision) before `innerHTML` (`esc()`).
- Conventional Commits; commit after each task.

---

### Task 1: GitHub PR status + review (`server/github.ts`)

**Files:** Modify `server/github.ts` (+ `server/github.test.ts`).

**Interfaces (Produces):**
- `export interface PrStatus { number: number; repo: string; state: 'open' | 'closed'; draft: boolean; merged: boolean; headRefName: string; headSha: string; reviewDecision: PrReviewDecision; comments: number; checks: { passed: number; failed: number; pending: number }; url: string }` (`PrReviewDecision` already exists in `server/types.ts`).
- `export async function fetchPrStatus(github: GithubConfig, repo: string, prNumber: number): Promise<PrStatus | null>`:
  - `GET {API}/repos/{repo}/pulls/{prNumber}` (headers via the existing `headers(github)`). On non-ok → return `null`. Map: `state` (`'open'|'closed'`), `draft`, `merged`, `headRefName = body.head.ref`, `headSha = body.head.sha`, `comments = body.comments ?? 0`, `url = body.html_url`.
  - CI: `GET {API}/repos/{repo}/commits/{headSha}/check-runs` → tally `check_runs[]`: `passed` = conclusion ∈ {success,neutral,skipped}; `failed` = conclusion ∈ {failure,timed_out,cancelled,action_required,startup_failure}; `pending` = `status !== 'completed'` or conclusion null. On sub-fetch failure → `{passed:0,failed:0,pending:0}` (degrade, don't fail the whole call).
  - `reviewDecision`: reuse the existing private `latestReviewDecision(github, repo, prNumber)`; on its failure default `'REVIEW_REQUIRED'`.
  - Wrap in try/catch → `null` on the primary fetch throwing. Sub-fetches (checks/reviews) degrade rather than null the whole thing.
- `export async function submitReview(github: GithubConfig, repo: string, prNumber: number, event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', body: string): Promise<{ ok: true } | { ok: false; error: string }>`:
  - `POST {API}/repos/{repo}/pulls/{prNumber}/reviews` with JSON `{ event, body }`. On ok → `{ok:true}`. On non-ok → `{ ok:false, error: <message from the GitHub json `.message` or the status> }`. try/catch → `{ok:false, error}`. Never throws.

- [ ] **Step 1: Failing tests** (`github.test.ts`, stub global `fetch`): `fetchPrStatus` maps a stubbed pulls body (`{state:'open',draft:false,merged:false,head:{ref:'fix/x',sha:'abc'},comments:2,html_url:'u'}`) + a check-runs body (`{check_runs:[{status:'completed',conclusion:'success'},{status:'in_progress',conclusion:null},{status:'completed',conclusion:'failure'}]}`) + a reviews body into `PrStatus` with `checks:{passed:1,failed:1,pending:1}`; returns `null` on a non-ok pulls fetch; degrades checks to zeros when the check-runs fetch is non-ok. `submitReview` posts `{event,body}` and returns `{ok:false,error}` on a stubbed 422 with `{message:'...can not approve...'}`.
- [ ] **Step 2: Run → FAIL** (`npx vitest run server/github.test.ts`).
- [ ] **Step 3: Implement** in `github.ts`.
- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit` + `npm test`.
- [ ] **Step 5: Commit** `feat(github): PR status (state, CI, review decision) + submit review`.

---

### Task 2: PR API endpoints (`router` + `main` wiring)

**Files:** Modify `server/helmsman/router.ts` (+ `router.test.ts`), `server/helmsman/main.ts`.

**Interfaces:**
- `RouterDeps` gains:
  - `prStatus: (repo: string, prNumber: number) => Promise<PrStatus | null>`
  - `submitReview: (repo: string, prNumber: number, event: 'APPROVE'|'REQUEST_CHANGES'|'COMMENT', body: string) => Promise<{ ok: true } | { ok: false; error: string }>`
- Branches (before the `/api/` 404 fallthrough):
  - `GET /api/pr` — read `query.get('repo')` + `query.get('number')`; if missing or `number` NaN → 400 `{error:'repo and number required'}`; `const s = await deps.prStatus(repo, n); return s ? {status:200,json:s} : {status:404,json:{error:'PR not found or GitHub not configured'}}`.
  - `POST /api/pr/review` — body `{ repo?, number?, event?, body? }`; validate `repo` string, `number` finite, `event` ∈ the three; require non-empty `body` for `REQUEST_CHANGES`/`COMMENT`; else 400. `const r = await deps.submitReview(...); return r.ok ? {status:200,json:{ok:true}} : {status:400,json:{error:r.error}}`.
- `main.ts` wiring (bundle here so the branch compiles — extending `RouterDeps` with required fields breaks the deps literal otherwise): in the `handleApi` deps object add
  - `prStatus: (repo, n) => { const g = configStore.current().github; return g ? fetchPrStatus(g, repo, n) : Promise.resolve(null); }`
  - `submitReview: (repo, n, event, body) => { const g = configStore.current().github; return g ? submitReview(g, repo, n, event, body) : Promise.resolve({ ok: false as const, error: 'GitHub not configured' }); }`
  - import `fetchPrStatus`, `submitReview`, `type PrStatus` from `../github`.

- [ ] **Step 1: Failing router tests** — add `prStatus`/`submitReview` stubs to the `deps` object. `GET /api/pr?repo=o/r&number=5` → 200 with the stubbed status; `GET /api/pr?repo=o/r` (no number) → 400; `GET /api/pr?...&number=x` (NaN) → 400; a stub returning null → 404. `POST /api/pr/review {repo,number,event:'APPROVE',body:''}` → calls submitReview + 200; `{...event:'COMMENT', body:''}` → 400 (empty body); `{...event:'BOGUS'}` → 400; a submitReview stub returning `{ok:false,error:'nope'}` → 400 `{error:'nope'}`. Assert no response contains `GITHUB_TOKEN`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** router branches + `RouterDeps` + `main.ts` wiring.
- [ ] **Step 4: Run → PASS** (`npx vitest run server/helmsman/router.test.ts` + `npx tsc --noEmit` + `npm test` + `npm run build`).
- [ ] **Step 5: Commit** `feat(helmsman): /api/pr status + review endpoints`.

---

### Task 3: Re-run on the existing PR branch

**Files:** Modify `server/helmsman/worktree.ts` (+ `worktree.test.ts`), `server/helmsman/agents/adapter.ts` (AgentTask), `server/helmsman/agents/claude-code.ts` (buildPrompt), `server/helmsman/runner.ts` (+ `runner.test.ts`), `server/helmsman/router.ts` (+ `router.test.ts`), `server/helmsman/main.ts`.

**Interfaces:**
- `AgentTask` gains optional `prBranch?: string` and `prNumber?: number`. When `prBranch` is set the run is a rerun (update an existing PR).
- `worktree.ts`: `export async function createWorktreeFromBranch(agentsRoot: string, repo: string, runId: string, branch: string): Promise<Worktree>` — `const repoDir = join(agentsRoot, repoBasename(repo)); await run('git', ['-C', repoDir, 'fetch', 'origin', branch]); const path = join(repoDir, '.worktrees', runId); await run('git', ['-C', repoDir, 'worktree', 'add', path, branch]); return { path, branch };` (checkout existing branch; no `-b`).
- `claude-code.ts` `buildPrompt`: add a rerun branch — if `task.prBranch` (and `task.prNumber`): `\`You are updating open pull request #${task.prNumber} on the current branch (${task.prBranch}). Address this review feedback: ${task.task}.\`` + repo-cwd + unattended + `\`Run the tests, commit, and push to the same branch. Do NOT open a new pull request and do NOT merge.\``. (This branch takes precedence over the free-form and ticket branches.)
- `runner.startRun`: if `task.prBranch` is set, call `deps.createWorktreeFromBranch(task.repo, runId, task.prBranch)` instead of `deps.createWorktree(...)`; skip Jira claim + markInReview (rerun); set the run row `prNumber` from `task.prNumber` (so history links the PR). Add `createWorktreeFromBranch?` to `RunnerDeps` (optional; required only for reruns).
- `router.ts` launch branch: `mode === 'rerun'` → require `repo` + `prNumber` (400 else) → `deps.launch({ repo, prNumber, mode:'rerun' })`; keep the `canStart` gate. `RouterDeps.launch` body type gains `prNumber?: number; mode?: string`.
- `main.ts` `launch()`: when `body.mode === 'rerun'`, resolve the branch: `const g = cfg.github; const pr = g ? await fetchPrStatus(g, body.repo, body.prNumber!) : null;` if `!pr` → emit an error event + finish failed (fail-soft). Else build the `AgentTask` with `prBranch: pr.headRefName`, `prNumber: pr.number`, `task: <feedback passed through the launch body>`, `ticketId: 'rerun'`. Wire `createWorktreeFromBranch: (repo, id, branch) => createWorktreeFromBranch(AGENTS_ROOT, repo, id, branch)` into the runner deps. The launch body also needs `feedback?: string` (the rerun instruction) — carry it into `task`.

- [ ] **Step 1: Failing tests:**
  - `worktree.test.ts`: `createWorktreeFromBranch` (fake `run`) issues `git -C <dir> fetch origin <branch>` then `git -C <dir> worktree add <path> <branch>` (no `-b`), returns `{path, branch}`.
  - `runner.test.ts`: a task with `prBranch:'fix/x', prNumber:12, task:'address it'`, `jira`+`botAccountId` present → uses `createWorktreeFromBranch` (spy) not `createWorktree`, does NOT claim/transition, run row `prNumber === 12`, adapter ran.
  - `claude-code` buildPrompt: rerun task → prompt includes `#12`, `address it`, `push to the same branch`, `do NOT open a new pull request`; no `Jira ticket`.
  - `router.test.ts`: `POST /api/agents/launch {mode:'rerun', repo:'o/r', prNumber:12, feedback:'fix'}` → `launch` called with `{repo:'o/r', prNumber:12, mode:'rerun', feedback:'fix'}` (or the shape you settle) + 200; `{mode:'rerun', repo:'o/r'}` (no prNumber) → 400.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** across the files.
- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit` + `npm test` + `npm run build`.
- [ ] **Step 5: Commit** `feat(helmsman): re-run the agent on an existing PR branch with feedback`.

---

### Task 4: Client data helpers (`src/data/pr.ts`)

**Files:** Create `src/data/pr.ts` (+ `src/data/pr.test.ts`); Modify `src/data/agents.ts` (`launchRun` rerun shape).

**Interfaces:**
- `src/data/pr.ts`:
  - `export interface PrStatusView { number: number; repo: string; state: string; draft: boolean; merged: boolean; headRefName: string; reviewDecision: string; comments: number; checks: { passed: number; failed: number; pending: number }; url: string }` (mirror the server `PrStatus`, minus `headSha`).
  - `export async function getPrStatus(repo: string, prNumber: number): Promise<PrStatusView | null>` — `GET /api/pr?repo=&number=`; null on non-ok / throw (fail-soft).
  - `export async function submitReview(repo: string, prNumber: number, event: 'APPROVE'|'REQUEST_CHANGES'|'COMMENT', body: string): Promise<{ ok: boolean; error?: string }>` — `POST /api/pr/review`; `{ok:false,error}` on non-ok (reads `{error}` body); fail-soft.
  - `export function parsePrUrl(url: string): { repo: string; number: number } | null` — parse `github.com/<owner>/<repo>/pull/<n>`; null if it doesn't match.
- `src/data/agents.ts`: extend `launchRun`'s body type with `prNumber?: number; feedback?: string` and allow `mode: 'ticket' | 'freeform' | 'rerun'`.

- [ ] **Step 1: Failing tests** (`pr.test.ts`, stub `fetch`): `getPrStatus` returns the parsed body on 200, null on non-ok/throw; `submitReview` `{ok:true}` on 200, `{ok:false,error}` on 400; `parsePrUrl('https://github.com/o/r/pull/12')` → `{repo:'o/r', number:12}`, `parsePrUrl('nope')` → null.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `pr.ts` + extend `launchRun`.
- [ ] **Step 4: Run → PASS** + `npx tsc --noEmit` + `npm test`.
- [ ] **Step 5: Commit** `feat(ui): client helpers for PR status, review, and re-run`.

---

### Task 5: UI — PR panel, review actions, review-any-PR, re-run

**Files:** Modify `src/render.ts` (+ `src/render.test.ts`), `src/main.ts` (+ `src/main.test.ts`), `src/style.css`.

**Interfaces / behavior:**
- A pure render helper `export function renderPrPanel(pr: PrStatusView | null, canRerun: boolean): string` in `render.ts` (unit-testable): state chip (open/draft/merged/closed), CI summary (`✓<passed> ✗<failed> ⋯<pending>` with color when failed>0 / all-passed), review-decision chip, comment count, a PR link (`pr.url`), review buttons (`.pr-approve`, `.pr-request-changes`, `.pr-comment`) + a `.pr-review-body` textarea, and — only when `canRerun` — a `.pr-rerun` button + `.pr-rerun-feedback` textarea. Empty/`null` → a "No PR / not found" note. Escape everything untrusted.
- **In the run drawer:** when the open run has a `prNumber`, `DashboardView` fetches `getPrStatus(repo, prNumber)` and renders the PR panel into a drawer sub-region (below the log). `canRerun` = the run's repo is in the known repo set (from the dashboard `repos`).
- **Review-any-PR:** a small panel on the dashboard — a `.pr-lookup-input` (paste a PR URL or `owner/repo#n`) + `.pr-lookup-go` button → `parsePrUrl`/parse → `getPrStatus` → render the PR panel in a dedicated container (`.pr-lookup-result`) with review buttons; `canRerun` per repo-set membership.
- `DashboardView` handlers (delegated): `.pr-approve`/`.pr-request-changes`/`.pr-comment` → read the panel's repo/number + `.pr-review-body` → `submitReview(...)` (guard empty body for request-changes/comment) → re-fetch + re-render the panel (+ inline error on `{ok:false}`); `.pr-rerun` → read `.pr-rerun-feedback` (guard empty) → `launchRun({ mode:'rerun', repo, prNumber, feedback })` → open the drawer + stream; `.pr-lookup-go` → fetch + render. Hold state on fields; no free `let`.

- [ ] **Step 1: Failing render tests** — `renderPrPanel` with an open PR + checks `{passed:2,failed:0,pending:1}` renders the state chip, a CI summary containing `2`, the review buttons + textarea, the PR link; with `canRerun:false` the `.pr-rerun` control is absent; with `canRerun:true` it's present; `null` → the not-found note. Assert a malicious `headRefName`/`url` is escaped.
- [ ] **Step 2: Failing main tests** — clicking `.pr-approve` calls `submitReview(repo,number,'APPROVE','')` (stub); `.pr-comment` with an empty body does NOT call submitReview; `.pr-rerun` with feedback calls `launchRun({mode:'rerun',...})` and opens the drawer; `.pr-lookup-go` with a pasted URL fetches + renders. Stub `getPrStatus`/`submitReview`/`launchRun`/`fetch`/`EventSource` per the file's patterns.
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** render + main + CSS (reuse tokens; Tactical-HUD look; a distinct color for a failing-CI/changes-requested chip using `--bad`).
- [ ] **Step 5: Run → PASS** — `npx vitest run src` + `npm run build` + `npm test` + `npx tsc --noEmit`.
- [ ] **Step 6: Commit** `feat(ui): PR panel with review actions, review-any-PR, and re-run`.

---

### Task 6: Build + end-to-end check

- [ ] **Step 1:** `npm run build`, `npx tsc --noEmit`, `npm test` all green.
- [ ] **Step 2 (manual, optional live):** `npm run dev`; open a run with a PR → the panel shows state + CI + decision; paste a PR URL → its status loads; Comment on a PR → the comment appears on GitHub; Re-run with feedback on a local-repo PR → the agent updates the same branch/PR (no new PR). **Real GitHub writes + spawn — run only with consent.**
- [ ] **Step 3: Commit** README updates (PR panel, review actions, review-any-PR, re-run loop; note merge stays GitHub-only).

---

## Self-Review

- View PR status (state/CI/decision/comments) → Task 1 + Task 5. ✓
- Review actions (approve/request-changes/comment), any PR → Tasks 1–2 (`submitReview` + endpoint) + Task 5 (buttons + review-any-PR form). ✓
- Request-changes → re-run loop (separate button, same branch) → Task 3 (`createWorktreeFromBranch` + rerun runner/prompt/launch) + Task 5 (`.pr-rerun`). ✓
- CI checks included → Task 1 (`check-runs` tally) + Task 5 (CI summary). ✓
- No merge in UI → no merge endpoint/button anywhere (Global Constraints). ✓
- Token server-side, writes 127.0.0.1, feedback→prompt-only → Task 1/2 (endpoints hold the token) + Task 3 (feedback in prompt). ✓
- Re-run only for local-checkout repos → Task 3 (fail-soft when branch unresolvable) + Task 5 (`canRerun` gates the button). ✓
- No placeholders; each task names files, interfaces, and test cases.
- Type consistency: `PrStatus` (server) ↔ `PrStatusView` (client) fields align; `RouterDeps.prStatus/submitReview` match `main.ts` wiring; `launchRun` rerun shape matches the router launch branch and `AgentTask.prBranch/prNumber`; `renderPrPanel` consumes `PrStatusView`.
- Replace-don't-duplicate: reuse the existing `headers()` + `latestReviewDecision()` in `github.ts`; `createWorktreeFromBranch` sits beside `createWorktree` (distinct behavior — checkout vs new branch — not a duplicate); `launchRun` remains the single launch fetch path (rerun is another mode, not a new function).
- Idiom: `erasableSyntaxOnly` respected (no new classes with param properties); fail-soft matches existing `github.ts`/client helper patterns.

## Execution note

One PR (per the spec). Subagent-driven: fresh implementer per task, task review after each, whole-branch review at the end, then one PR to the fork stacked on `master`. Task 2 bundles the `main.ts` wiring so the branch never sits non-compiling (lesson from P6). Task 3 is the riskiest (git worktree from an existing branch + the rerun runner path) — review the git argv and the Jira-skip carefully.
