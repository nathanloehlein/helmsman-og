# Moon Units recommendations: implementation and verification

Source: `deliverables/Moon-Units-vs-Helmsman.docx` (source-reviewed edition, 18 September 2026), with implementation detail in `Moon-Units-Code-Reuse-Assessment.md`. Moon Units reference revision: `d723a019`. Helmsman starting revision: `45e6fcf6`.

The recommendations were implemented on `feat/moonunit-adoption` and merged into `master`. This checklist records implementation evidence and remaining setup requirements.

## Feature overview

| Feature | What it adds to Helmsman |
|---|---|
| Costs & Outcomes | Tracks reported costs, tokens, duration and PR outcomes; separately estimates unpriced Codex usage using published Standard API rates. |
| Batch campaigns | Imports CSV/JSONL tasks with a preview, concurrency controls, pause/stop and failed-item retry. |
| Agent Questions | Lets an agent request a human decision during a run and receive an answer in the UI. Agents are instructed to wait before dependent work; unresolved required questions block successful completion and publication. |
| Reproducible runs | Freezes workflow settings and required skills, saves immutable artifacts, and verifies saved evidence before continuing. |
| Isolated execution | Runs supported agent stages in Docker with restricted networking and run-scoped credential access. |
| Webhook intake | Maps authenticated, deduplicated events to saved workflows once configured. |
| Reliable dispatch and telemetry | Persists launch claims, reconciles interrupted work, and records structured provider usage and lifecycle events. |

See the updated [voyage flowchart](helmsman-process.html) for how these features connect to implementation, review and publication.

## Required capabilities

- [x] Structured Codex JSON events; malformed/null fields guarded; raw fallback and PR discovery preserved.
- [x] Provider usage accounting with idempotent ingestion and unknown costs distinguished from zero; no invented model prices. Unpriced Astra, Sol and Terra token records can also receive a separate Standard short-context API baseline estimate.
- [x] Bounded GitHub/Jira HTTP error parsing with size limits, deadlines, and safe fallbacks.
- [x] Dedicated Costs & Outcomes tab, header galleon scope, date window, costs/coverage, tokens, durations, unique PR review/publication/merge metrics, failure stages and correction rounds.
- [x] Persistent outcome evidence distinct from process success and mandatory review gates; explicit complete/partial/failed/not-assessed evaluation state.
- [x] Immutable stage artifacts, safe paths, hashes, exclusive writes and verification on checkpoint continuation.
- [x] Versioned workflow definitions and complete execution snapshots, preserving frozen settings across retry/resume.
- [x] Required-skill preflight, immutable content verification and per-run provisioning; safe names/argv, actionable failures.
- [x] Durable dispatch claims, stale-claim reconciliation and uncertain-launch handling, preserving existing deduplication and one active writer per galleon.
- [x] Batch campaigns with CSV/JSONL preview/intake, deterministic import/record identities, concurrency, phases, pause/stop and failed-item retry.
- [x] Durable run-bound clarification questions/answers, deadlines, local UI, explicit waiting/capacity policy; required answers never inferred from timeout.
- [x] Trusted contact defaults, conversation ownership and orphan cleanup; no outbound messages without explicit configured authorization.
- [x] Docker RunHost with persistent identity, liveness, stop and restart reattachment.
- [x] Run-scoped credential access, operation/branch restrictions and human-only merges; no long-lived token vending or inherited alternate credentials in isolated execution.
- [x] Authenticated, deduplicated webhook intake mapped to saved workflows.
- [x] Launch preflight and lifecycle telemetry with model/effort/attempt/stage identity.
- [x] Remote-worker reconnect behavior if the implemented host requires a remote control channel; otherwise document why local Docker uses the existing durable host protocol.

## Completion gates

- [x] Relevant unit/integration tests exercise real application entry points, not only standalone helpers.
- [x] `npm run build` (TypeScript + Vite) and required checks pass.
- [x] UI verified in browser for Costs & Outcomes, campaigns, clarifications, empty/error states, scope changes and terminology modes.
- [x] Commit reviewed as Senior Software Architect; material findings fixed and reverified.
- [x] Final requirement-by-requirement audit includes file/test/runtime evidence and remaining limitations.

## Human-input todos

- Register trusted contacts with the Jira account ID in the address field for automatic assignee/reporter routing; contact selection never authorizes sending.
- Configure host OpenAI/Anthropic API keys to validate a real provider-backed Docker run. Neither key is configured in this development session. No provider calls or external messages were sent for testing.
- Choose webhook event/action mappings and a webhook secret before enabling external intake. Intake is disabled by default; deploying public ingress is not part of local implementation.

## Implementation limits

- Isolated agents have no arbitrary internet egress; required dependencies/cache must be supplied in the runtime image.
- Docker branch-update reruns currently fail preflight; use the existing trusted local host for that mode. New coding and standalone review use host-supervised isolated stages.
- Workflow retries enforce saved prompt-source and skill hashes. Code/skill drift fails preflight instead of silently executing a different revision. Unreported provider-default model identities and prices remain unknown.
- PR metrics are live best-effort reads with bounded refreshes and explicit unavailable/stale counts. Reviewed external PRs do not count as Helmsman-authored publications.

## Requirement audit

| Capability | Implementation and evidence |
|---|---|
| Structured events, usage, lifecycle | `agents/codex-stream.ts`, `agents/claude-stream.ts`, `run-telemetry.ts`, `log-tail.ts`; parser, replay and UTF-8 tests |
| Bounded errors | `server/http-failure.ts`; GitHub/Jira integration; stalled cancellation regression |
| Costs & Outcomes | `outcomes.ts`, `outcome-service.ts`, router, `renderOutcomes.ts`; `cost-estimates.ts`; reported costs and separate baseline estimates with record coverage, evidence validation, scope and client tests |
| Immutable artifacts, frozen workflows, skills | `artifacts.ts`, `workflow-snapshots.ts`, `skills-preflight.ts`, `prepare-run.ts`, runtime/resume hooks; hashes, symlinks, exclusive writes and drift tests |
| Durable claims and campaigns | `campaigns.ts`, `campaign-service.ts`, `campaign-dispatcher.ts`, `created-pr-reviews.ts`; CAS, stale-claim, dedup, preview/confirm tests |
| Human clarification and contacts | `clarifications.ts`, `clarification-runtime.ts`, `contact-policy.ts`, Jira hints, local page and publication gates; expiry/ownership/blocking integration tests |
| Isolated host and credentials | `docker-host.ts`, `docker-stage.ts`, `docker-workspace.ts`, `scoped-gateway.ts`; real offline Docker lifecycle, retry, output-copy and network-isolation smoke checks |
| Webhooks | `webhooks.ts`, main/router wiring; raw-body HMAC, mapping, persistent delivery and uncertain-launch tests |
| Recovery | Local detached supervisor plus persisted Docker identity; no remote socket/control channel, so no new reconnect protocol is required |

## Progress and evidence

- Development used worktree `helmsman-moonunit-adoption`, branch `feat/moonunit-adoption`, before merging into `master`.
- Codex stream + HTTP errors: 112 focused adapter/GitHub/Jira tests passed at first integration.
- Persistent usage, outcomes, API routes, evidence assessments and Costs & Outcomes UI implemented. Byte-offset replay is idempotent, split UTF-8 log records are preserved, unreported billed costs stay unknown; eligible Codex usage receives a separately labeled API estimate.
- Campaign import/service/dispatcher/UI and durable created-PR review claims implemented; campaign scope and preview/confirm tested without launching external work.
- Clarification store, local UI, JSONL relay, required-answer publication gates and orphan cleanup implemented. Expired questions never imply an answer.
- Immutable report artifacts, workflow snapshots, required skill hashes and cross-platform private provisioning integrated with runtime/retry/resume.
- Docker image built successfully. Real offline RunHost smoke passed with host-visible log and exit marker. Credential gateway forwarding, expiry, revocation, persistence and scope checks tested with fake upstreams.
- UI verified in cmux browser against a temporary database on port 8799: empty pages, known/unknown costs, scoped clarification answer, campaign import preview/confirm, and Pirate terminology. Screenshots saved under `/tmp/helmsman-ui-ekdio3/`.
- Final full suite: 146 files / 2,248 tests passed. Final recovery/output-reader and UI polish then passed `npm run build` and 107 focused tests. Build emits an existing Vite config-loader compatibility warning; no build or TypeScript errors.
- Final browser screenshots inspected: Costs & Outcomes, campaigns and clarifications. Post-commit Senior Software Architect review found and fixed Claude beta-request forwarding, stale automatic outcome evidence after resume, and unpinned known Codex defaults. Final fixes pass the build and 91 focused tests. A real pinned Claude container reached a mocked upstream with its beta flags and host credential substitution verified; no provider request was made.
- Integration into `master`: TypeScript/Vite build and full suite passed (149 files / 2,286 tests), including the newer Slack master toggle and grouped settings.

## Token-based spend estimates

Costs & Outcomes estimates unreported Codex usage for exact model IDs `gpt-6-astra`, `gpt-5.6-sol` and `gpt-5.6-terra` when input, cached-input and output counts are all available. It uses [OpenAI Standard short-context API rates](https://developers.openai.com/api/docs/pricing), checked September 19, 2026. Cached input is removed from ordinary input before applying its separate rate. Already-priced usage is never estimated again; duplicate events remain deduplicated.

These estimates are separate from reported spend, fully priced coverage, per-PR costs and budget enforcement. The UI shows estimated versus unpriced usage records and runs without usage records. Missing model identity or token counts remain unknown. Service tier, per-request context size and cache-write usage are not recorded, so actual charges can differ; subscription usage is not a token-based invoice. Claude fallback needs cache-write and actual per-model usage data before it can be estimated safely. Historical usage is valued with this dated rate card, not reconstructed historical billing.
