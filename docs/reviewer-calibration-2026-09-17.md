# Reviewer calibration audit — September 17, 2026

Scope: the five most recently completed successful review runs, ordered by completion time. PR #10354 appears twice at different revisions. Evidence is the generated review artifacts and recorded verification in persisted run logs; this is a manual calibration audit, not a fresh code review or a model-evaluation run. All five recommended changes.

| PR / revision | Findings and calibration |
| --- | --- |
| [#10427](https://github.com/gdcorp-partners/airo-app-builder/pull/10427) / `d83dd9a5eda5` | Two functional findings: late flag refresh re-enables disabled Edit Mode; container selection leaks clicks into application handlers. Retain if the recorded call paths hold. Hardcoded English hover labels and a 4.23:1 contrast result need explicit acceptance requirements or demonstrated material impact to warrant this review’s blocking threshold. Drop repeated CI/E2E housekeeping. **Calibration:** REQUEST_CHANGES remains supportable on the functional defects. |
| [#10354](https://github.com/gdcorp-partners/airo-app-builder/pull/10354) / `1e3d92dd3a37` | New source-mapping/semantic-bucket telemetry cases lack a demonstrated material consequence or cited acceptance criterion. Missing flag-off tests and analytics documentation are not standalone blockers. The browser-reproduced wrapper-padding event issue was already reported; refer to its original thread only if independently verified to materially defeat the intended metric. **Calibration:** Do not automatically request changes for the new checklist items; COMMENT if materiality or an essential requirement remains unresolved. |
| [#10357](https://github.com/gdcorp-partners/airo-app-builder/pull/10357) / `bf250ce748e5` | Four recorded reproductions concern wrong-image fallback targeting, wrong record selection with spreads, false success when a spread overrides the edit, and wrong source-array selection under lexical shadowing. These are correctness failures in code that writes customer source, although individual case severity depends on supported inputs. **Calibration:** Retain material wrong-source/false-success findings and REQUEST_CHANGES; concise comments, not an AST audit diary. |
| [#10354](https://github.com/gdcorp-partners/airo-app-builder/pull/10354) / `branch revie` | One finding: layout padding clicks emit rejected text-edit events. The recorded reproduction used actual helpers with supplied browser hit-testing. This is a plausible logic flaw in the PR’s central metric, but the review needs to establish that the trigger reflects supported behavior and materially violates the intended visible-text metric. **Calibration:** Not a blanket false positive. Block only on the demonstrated requirement/impact; otherwise explain the specific uncertainty with COMMENT. Missing local dependencies are not grounds for requesting changes. |
| [#10281](https://github.com/gdcorp-partners/airo-app-builder/pull/10281) / `branch revie` | Three findings: delegated style work fails to resume dormant SSE, a preparatory CSS write can yield false success without changing the target, and fallback prompts discard the selected element identity. These have concrete broken-flow or wrong-target consequences in the recorded traces/reproductions. **Calibration:** Retain REQUEST_CHANGES. Remove the resolved/waived finding table and unrelated external-repository audit narrative. |

## Prompt changes

- Define the blocking bar: consequential structural/integration defects, obvious logic failures, or missed explicit material acceptance criteria. Require a supported trigger, changed path, expected/actual behavior, and material impact.
- Use repository guidance to establish contracts, without importing self-review hygiene checklists as automatic blockers. Do not suppress serious accessibility, localization, telemetry, or performance defects when their impact is established.
- Remove standalone test/documentation/style/hardening requests, speculative inputs, duplicate threads, resolved-issue recaps, and broad audit diaries. Existing verified material blockers can retain REQUEST_CHANGES with a single original-thread reference.
- Keep inline findings and reliable code suggestions. No finding quota; APPROVE is valid when no material issues remain. Missing tools or inaccessible acceptance criteria must not be mislabeled as code defects.
- Lead reviewers delegate bounded logic, acceptance/tests, UX, and external-effects checks. Skip unaffected areas, share fetched context, and validate/deduplicate candidates. Low effort is the default; medium for broad scopes and high only for serious architecture.
- Codex leaf reviewers explicitly invoke `$review-agent`. The installed skill forbids its workers from further delegation, file edits, and publication; the lead writes the two existing review artifacts. A missing required skill/delegation capability yields a COMMENT limitation.
- Enable Codex multi-agent capability only for review runs. Ordinary coding/feedback runs and review publication remain unchanged.

## Evidence and validation

Run IDs (newest first):
- `slack-6ecf77b0511a1d843cc3ff928a0fc483cf1781deda13b6faadd1bcc1938b3207` — completed `2026-09-17T21:36:19.534Z`
- `f59c6d66-9a84-42ce-af55-68b0f5a2524a` — completed `2026-09-17T21:11:18.421Z`
- `c4fe137e-aa16-4877-9aa4-b2fb75c53080` — completed `2026-09-17T20:33:31.856Z`
- `73f88cba-cf7b-4117-b5d8-320e7b32431a` — completed `2026-09-17T17:12:17.894Z`
- `8d83bf8b-6538-4ca4-878a-7f5bb160019e` — completed `2026-09-17T16:38:29.700Z`

Prompt contracts and provider-specific command assembly are covered by adapter tests. Those checks validate instructions and configuration; they do not prove that future model output will follow the rubric. The next natural reviews should be sampled for unsupported blockers, duplicate findings, and summary length. No historical review was reposted or changed.

Prompt structure follows the [official OpenAI prompt-engineering guidance](https://developers.openai.com/api/docs/guides/prompt-engineering): explicit instructions, clear context, and evaluation of behavior. The review-agent leaf constraints were read from the installed `review-agent/SKILL.md`.
