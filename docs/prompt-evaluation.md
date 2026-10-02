# Prompt decision evaluations

Prompt parity checks whether versions agree. This evaluation checks how model predictions handle eight labeled review situations: an inert-byte non-threat with serving evidence, actual SVG execution, an ineffective same-thread timeout, effective parser containment, a non-goal contradicting a requirement, optional favicon scope, changed evidence reopening a decision, and material evidence that remains unavailable.

The fixtures are anonymized synthetic reconstructions inspired by the supplied PR #11104 retrospective. They are not historical model results or complete reproductions of the PR. The suite exercises reviewer verdict calibration; it does not measure implementation quality or establish that prompts are effective without model responses.

## Export blinded exercises

From either checkout:

```sh
npm run test:prompt-evaluation
npm run eval:prompts -- bundle --output /tmp/helmsman-prompt-bundle.json
```

Choose a new output filename for each export; the command refuses to overwrite existing files. The bundle contains 16 independent exercises: eight cases for each of the Codex and Claude prompt variants. Each sample embeds the current production standalone reviewer prompt, the case's property and observed evidence, and a small offline output protocol. POST uses the active workflow-review plugin; PRE uses its legacy generator. Fixture labels and rubric rationales are excluded from the bundle. The source fixture file contains the labels and should not be included in the model context.

Submit each sample's `prompt` independently through an authorized GoCaaS execution route. Use the intended model/provider and effort settings, and record the actual model version and settings beside the saved responses. Runtime names identify prompt variants, not proof of which model ran them. Avoid carrying answers or context between samples. The export and scoring commands do not call models, launch live jobs, access credentials, write GitHub reviews, or incur model charges.

The offline protocol replaces file-writing, tool access, delegation, and publication with a JSON prediction. It retains the production acceptance and materiality rules. This tests decisions from supplied evidence, not whether an agent can discover that evidence in a checkout. Evaluate actual tool use and coding outcomes separately.

## Collect and score predictions

Collect the 16 model-produced objects into one JSON array. Keep `caseId`, `runtime`, `verdict`, and a nonempty `rationale` for every sample. The runner must attach `promptSha256` from the exact bundle sample it submitted, and persist that association when collecting the response. The model must not compute or invent the hash. Never copy a newer bundle hash onto an older prediction. Missing or mismatched hashes are rejected, so baseline predictions cannot be scored as candidate results. Verdicts must be `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`. The runner may add `usage` only when it has actual token counts; supply both `inputTokens` and `outputTokens` as nonnegative integers. Do not estimate tokens from characters or fill responses from the fixture labels.

```sh
npm run eval:prompts -- score \
  --bundle /tmp/helmsman-prompt-bundle.json \
  --responses /tmp/helmsman-predictions.json
```

The scorer requires every sample exactly once and rejects missing, duplicate, unknown, malformed or invalid responses. It verifies the fixture version, exported prompt hashes and each prediction’s matching prompt hash; use the matching checkout when scoring historical bundles. It reports:

- Exact verdict accuracy, overall and by prompt runtime.
- Critical false approvals, missed critical defects including `COMMENT`, overblocking of correct fixes, and unsupported rejections when evidence is incomplete.
- Prompt and serialized-response character counts, actual supplied token usage, and budget exceedances.
- Each prediction's rationale next to the reference rationale for human review.
- Fixture and bundle SHA-256 provenance, plus each scored sample’s prompt hash.

The default diagnostic budgets are 32,000 input characters, 4,000 response characters, 9,000 input tokens and 1,200 output tokens per case. These are evaluation budgets, not production limits or statistical quality thresholds. Token budgets are checked only when actual usage was supplied; the report states how many responses have usage. Nonzero exit status means invalid input, a verdict mismatch, or a budget exceedance. It does not independently decide whether a production change can ship.

## Compare prompt changes

Export a baseline bundle before editing prompts and another after. Run both with the same actual model versions and settings, using independent contexts, and score each set of saved responses against its executed bundle and the same fixture revision. Bundle hashes in reports identify the exact exported inputs; per-response hashes bind predictions to individual prompts, not just case names. Compare critical misses and overblocking before aggregate accuracy; then inspect rationale quality and context/token costs. An accurate verdict with an invented argument is still a concern even though the deterministic scorer cannot judge it. Repeat ambiguous cases when model variability could explain a difference.

The local checks exercise fixture validation, prompt wiring, scorer classifications, malformed inputs, budgets, and CLI behavior. Their synthetic oracle responses prove the scorer works; they are explicitly not evidence of model quality. No live evaluation results are committed or claimed by these tests. Extend the cases when a concrete production failure provides new evidence; keep the suite small and remove redundant cases.
