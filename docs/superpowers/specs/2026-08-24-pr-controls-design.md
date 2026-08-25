# PR Controls (P7) — Design

## Goal

Bring PR status, review actions, and an agent re-run loop into the dashboard. For any PR (a run's PR *or* an arbitrary repo + number / URL): see its state, CI checks, review decision, and comment count; and act on it — approve / request changes / comment. For a PR whose repo is checked out locally: re-run the agent on the **existing** PR branch with review feedback so it updates the same PR.

Builds on P0–P6. One change, one PR.

## Non-goals

- **No merging from the UI.** The invariant holds: the agent never merges, and merge stays a deliberate human action on GitHub. There is no Merge button.
- No editing PR metadata (title/labels/reviewers) from the UI.
- No steering a live agent mid-run (unchanged).
- No new secrets surface. All GitHub writes use the existing server-side token.

## Security posture

- The GitHub token stays server-side. The browser calls `/api/pr*`; the orchestrator (127.0.0.1) makes the authenticated GitHub calls. The token is never sent to or exposed in the client.
- Review + re-run are writes gated by the same `127.0.0.1` bind as launch/config.
- Re-run feedback is passed to the agent prompt only (a single argv element), never a shell.
- Approving your own PR is a GitHub 422; surfaced as an inline error, not a crash.

## Architecture

Three additions across the existing two processes; no new services, no new deps.

### A. GitHub PR service (`server/github.ts`)

- `export interface PrStatus { number: number; repo: string; state: 'open' | 'closed'; draft: boolean; merged: boolean; headRefName: string; headSha: string; reviewDecision: PrReviewDecision; comments: number; checks: { passed: number; failed: number; pending: number }; url: string }`
- `export async function fetchPrStatus(github: GithubConfig, repo: string, number: number): Promise<PrStatus | null>`:
  - `GET /repos/{repo}/pulls/{number}` → `state`, `draft`, `merged`, `head.ref` (headRefName), `head.sha`, `comments`, `html_url`.
  - CI: `GET /repos/{repo}/commits/{headSha}/check-runs` → tally `check_runs[].conclusion`/`status` into `{ passed (success/neutral/skipped), failed (failure/timed_out/cancelled/action_required), pending (queued/in_progress or null conclusion) }`.
  - `reviewDecision`: reuse the existing `latestReviewDecision(github, repo, number)` (returns `APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED`).
  - Fail-soft: on a non-ok primary fetch return `null`; on a CI/reviews sub-fetch failure, degrade that field (checks all-zero / decision `REVIEW_REQUIRED`) rather than failing the whole call. Never throws.
- `export async function submitReview(github: GithubConfig, repo: string, number: number, event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', body: string): Promise<{ ok: true } | { ok: false; error: string }>`:
  - `POST /repos/{repo}/pulls/{number}/reviews` with `{ event, body }`. `COMMENT`/`REQUEST_CHANGES` require a non-empty `body`; `APPROVE` allows empty.
  - On non-ok, return `{ ok: false, error: <GitHub message> }` (e.g. the self-approve 422). Never throws.

### B. API endpoints (`router` + `main` wiring)

- `GET /api/pr?repo=<owner/name>&number=<n>` → `{ status: 200, json: PrStatus }`, or 400 on missing/bad params, or 404-shaped `{ error }` when the PR can't be fetched.
- `POST /api/pr/review` body `{ repo, number, event, body }` → validates `event` ∈ the three verbs and `body` present for comment/request-changes; calls `submitReview`; 200 `{ ok: true }` or 400 `{ error }`.
- `RouterDeps` gains `prStatus: (repo, number) => Promise<PrStatus | null>` and `submitReview: (repo, number, event, body) => Promise<{ ok: true } | { ok: false; error: string }>`, wired in `main.ts` from `configStore.current().github` (fail-soft null when GitHub isn't configured).

### C. Re-run launch mode

- Launch body gains `mode: 'rerun'` with `{ repo, prNumber, feedback }`.
- `main.ts` `launch()` for rerun: resolve the head branch via `fetchPrStatus(github, repo, prNumber).headRefName` (if the PR/branch can't be resolved → emit an error event on the run and finish `failed`, fail-soft; if the repo isn't checked out in `AGENTS_ROOT`, same). Build an `AgentTask` with `task` = the feedback and a new field `prBranch` (the existing branch) + `prNumber`.
- `worktree.ts`: `export async function createWorktreeFromBranch(agentsRoot, repo, runId, branch): Promise<Worktree>` — `git -C <repoDir> fetch origin <branch>` then `git -C <repoDir> worktree add <path> <branch>` (checkout the existing branch; no `-b`, no new branch). Returns `{ path, branch }`.
- `runner`: when the task is a rerun (has `prBranch`), use `createWorktreeFromBranch` instead of `createWorktree`; skip Jira claim/transition (the ticket is already In Review, and rerun may target a non-ticket PR); the agent pushes to the same branch → the PR updates. `findPrNumber` is unnecessary (we already know `prNumber`); record it on the run row.
- `buildPrompt` rerun variant: "You are updating an existing open pull request (#<n>) on the current branch. Address this review feedback: `<feedback>`. Run the tests, commit, and **push to the same branch** — do NOT open a new PR, do NOT merge." No ticket-id phrasing.

### D. UI

- **PR panel** (in the run drawer, when the run has a `prNumber`, and standalone for review-any-PR): renders `PrStatus` — a state chip (open/draft/merged/closed), CI summary (`✓passed ✗failed ⋯pending` with a status color), review-decision chip, comment count, and a PR link. Below it: a review row — **Approve** / **Request changes** / **Comment** buttons + a feedback `<textarea>` (required for request-changes/comment); and a separate **Re-run with feedback** button + its own textarea (shown only when the run/PR repo is one the orchestrator can check out — i.e. present in the config repo set; for an arbitrary PR whose repo isn't local, the re-run button is hidden/disabled with a note).
- **Review any PR**: a small form (repo select or free text + PR number, or a single "paste PR URL" input that parses `github.com/<owner>/<repo>/pull/<n>`) → fetch `PrStatus` → show the PR panel + review buttons (no re-run unless the repo is local).
- Data: `src/data/pr.ts` — `getPrStatus(repo, number)`, `submitReview(repo, number, event, body)`, `parsePrUrl(url)`; `launchRun` gains the `rerun` shape.
- All untrusted strings (PR title/branch/repo, GitHub error messages, review decision) escaped before `innerHTML`.

## Data flow

Browser → 5173 (proxy) → 8787. New: `GET /api/pr`, `POST /api/pr/review`, and the `rerun` launch. All GitHub calls happen server-side with the token; the re-run runs the normal agent pipeline on the existing branch.

## Testing strategy

- `github`: `fetchPrStatus` maps a stubbed `/pulls/{n}` + `/check-runs` + reviews into `PrStatus` (state/draft/merged/headRef/checks tally/decision); degrades sub-fetch failures; returns null on primary non-ok. `submitReview` posts the right body and returns `{ok:false,error}` on a stubbed 422 (self-approve). Stub `fetch`.
- `router`: `GET /api/pr` returns status / 400 on missing params; `POST /api/pr/review` validates event + body, calls the dep, maps ok/!ok. Secret never in any response.
- `worktree`: `createWorktreeFromBranch` issues `fetch origin <branch>` then `worktree add <path> <branch>` (no `-b`) — assert the git argv via an injected runner/fake.
- `runner`: a rerun task (has `prBranch`) uses the from-branch worktree, does NOT claim/transition Jira, records `prNumber`, runs the adapter.
- `claude-code` buildPrompt: rerun variant references the PR number + feedback + "push to the same branch / do not open a new PR / do not merge"; no ticket phrasing.
- `render`/`main`: PR panel renders a `PrStatus` (chips, CI, link); review buttons fire `submitReview` with the right event + guard empty body for request-changes/comment; the paste-PR-URL form parses and fetches; re-run button hidden for a non-local repo; re-run fires the `rerun` launch and opens the drawer.

## Rollout / compat

- Additive: `/api/pr*` are new; the launch body gains a `rerun` mode (existing modes unchanged); `/api/agents` and `/api/config` unchanged.
- No schema change (PR data is fetched live from GitHub; the run row already has `prNumber`). `AgentTask` gains optional `prBranch?` / `prNumber?` (additive).
- Works only when GitHub is configured; degrades to a clear "GitHub not configured" state otherwise.

## Open decisions (resolved)

- **Review vs re-run:** separate actions (review works on any PR; re-run needs a local checkout).
- **CI checks:** included (check-runs tally).
- **Merge:** never in the UI — GitHub-only.
- **Re-run branch source:** fetched live from the PR (`headRefName`) at re-run time; no schema/storage.
- **Arbitrary-PR re-run:** only for repos checked out in `AGENTS_ROOT`; otherwise the re-run control is disabled with a note (review actions still work).
- **Delivery:** one spec → one plan → one PR.
