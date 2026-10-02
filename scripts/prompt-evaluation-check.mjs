import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildBundle, budgets, loadFixtures, renderProductionPrompt, scoreResponses, validateFixtures } from './prompt-evaluation.mjs';

const fixtures = await loadFixtures();
const bundle = await buildBundle(fixtures);
const oraclePredictions = () => bundle.samples.map(sample => ({ caseId: sample.caseId, runtime: sample.runtime, promptSha256: sample.promptSha256,
  verdict: fixtures.cases.find(item => item.id === sample.caseId).expectedVerdict,
  rationale: 'Synthetic test input validating the scorer, not a model result.' }));

test('fixtures cover blocking, optional and unresolved outcomes and critical failures', () => {
  assert.equal(fixtures.cases.length, 8);
  assert.deepEqual(new Set(fixtures.cases.map(item => item.expectedVerdict)), new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']));
  assert.equal(fixtures.cases.filter(item => item.critical).length, 4);
  const invalid = structuredClone(fixtures);
  invalid.cases.push(invalid.cases[0]);
  assert.throws(() => validateFixtures(invalid), /duplicate/);
});

test('blinded bundle embeds the active production generator for each provider', async () => {
  assert.equal(bundle.samples.length, fixtures.cases.length * 2);
  for (const sample of bundle.samples) {
    const item = fixtures.cases.find(value => value.id === sample.caseId);
    const generated = await renderProductionPrompt(sample.runtime, item);
    assert.ok(sample.prompt.includes(`<production-instructions>\n${generated}\n</production-instructions>`));
    assert.ok(sample.prompt.includes(item.evidence[0]));
    assert.ok(!sample.prompt.includes(item.rationale));
    assert.ok(!sample.prompt.includes('expectedVerdict'));
    assert.equal(sample.inputCharacters, sample.prompt.length);
    assert.ok(sample.inputCharacters <= budgets.inputCharacters);
  }
  const [codex, claude] = ['codex', 'claude-code'].map(runtime => bundle.samples.find(sample => sample.runtime === runtime).prompt);
  assert.ok(codex.includes('Use $review-agent'));
  assert.ok(!claude.includes('Use $review-agent'));
});

test('score classifies false approval, missed blocker, overblocking and unsupported rejection separately', () => {
  const predictions = oraclePredictions();
  predictions.find(item => item.caseId === 'unsanitized-svg-executes').verdict = 'APPROVE';
  predictions.find(item => item.caseId === 'same-thread-timeout').verdict = 'COMMENT';
  predictions.find(item => item.caseId === 'contained-parser').verdict = 'REQUEST_CHANGES';
  predictions.find(item => item.caseId === 'serving-evidence-unavailable').verdict = 'REQUEST_CHANGES';
  const result = scoreResponses(fixtures, bundle, predictions);
  assert.equal(result.correct, 12);
  assert.equal(result.verdictAccuracy, 0.75);
  assert.equal(result.criticalFalseApprovals, 1);
  assert.equal(result.missedCriticalDefects, 2);
  assert.equal(result.overblocking, 1);
  assert.equal(result.unsupportedRejections, 1);
  assert.equal(result.byRuntime.codex.correct, 4);
  assert.equal(result.byRuntime['claude-code'].correct, 8);
  assert.equal(result.tokenUsageAvailable, 0);
});

test('rejects missing, duplicate, unknown, malformed and invalid predictions', () => {
  const predictions = oraclePredictions();
  assert.throws(() => scoreResponses(fixtures, bundle, predictions.slice(1)), /Missing predictions/);
  assert.throws(() => scoreResponses(fixtures, bundle, [...predictions, predictions[0]]), /duplicate/);
  for (const patch of [{ caseId: 'unknown' }, { runtime: 'unknown' }, { verdict: 'PASS' }, { rationale: ' ' }, { usage: { outputTokens: -1 } }, { usage: { inputTokens: 1, outputTokens: '2' } }]) {
    assert.throws(() => scoreResponses(fixtures, bundle, [{ ...predictions[0], ...patch }, ...predictions.slice(1)]), /Invalid/);
  }
  assert.throws(() => scoreResponses(fixtures, bundle, {}), /JSON array/);
  assert.throws(() => scoreResponses(fixtures, bundle, [null]), /Invalid/);
});

test('rejects changed fixture contracts and altered or incomplete bundles', () => {
  const predictions = oraclePredictions();
  assert.throws(() => scoreResponses(fixtures, { ...bundle, fixtureSha256: 'old' }, predictions), /fixture version/);
  assert.throws(() => scoreResponses(fixtures, { ...bundle, samples: bundle.samples.slice(1) }, predictions), /Incomplete/);
  const altered = structuredClone(bundle);
  altered.samples[0].prompt += 'modified';
  assert.throws(() => scoreResponses(fixtures, altered, predictions), /altered/);
});

test('binds predictions and reports to the exact executed prompt and rejects stale baseline answers', () => {
  const predictions = oraclePredictions();
  const scored = scoreResponses(fixtures, bundle, predictions);
  assert.equal(scored.fixtureSha256, bundle.fixtureSha256);
  assert.equal(scored.bundleSha256, createHash('sha256').update(JSON.stringify(bundle)).digest('hex'));
  assert.equal(scored.results[0].promptSha256, bundle.samples[0].promptSha256);
  for (const promptSha256 of [undefined, null, '', 'a'.repeat(64)]) {
    assert.throws(() => scoreResponses(fixtures, bundle, [{ ...predictions[0], promptSha256 }, ...predictions.slice(1)]), /response promptSha256/);
  }
  const candidate = structuredClone(bundle);
  candidate.samples[0].prompt += '\nChanged candidate instructions.';
  candidate.samples[0].promptSha256 = createHash('sha256').update(candidate.samples[0].prompt).digest('hex');
  candidate.samples[0].inputCharacters = candidate.samples[0].prompt.length;
  assert.throws(() => scoreResponses(fixtures, candidate, predictions), /mismatched response promptSha256/);
});

test('reports actual token usage separately and detects character and token budget overruns', () => {
  const predictions = oraclePredictions();
  predictions[0].usage = { inputTokens: 4000, outputTokens: budgets.outputTokens + 1 };
  predictions[1].rationale = 'x'.repeat(budgets.responseCharacters + 1);
  const result = scoreResponses(fixtures, bundle, predictions);
  assert.equal(result.budgetExceedances, 2);
  assert.equal(result.tokenUsageAvailable, 1);
  assert.equal(result.results[0].usage.inputTokens, 4000);
  assert.equal(result.results[1].usage, null);
});

test('CLI exports current prompts, refuses overwrite and requires saved prediction input to score', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helmsman-prompt-eval-'));
  const output = join(directory, 'bundle.json');
  const responses = join(directory, 'responses.json');
  const script = new URL('./prompt-evaluation.mjs', import.meta.url);
  const run = args => spawnSync(process.execPath, ['--import', 'tsx', script.pathname, ...args], { encoding: 'utf8' });
  try {
    const exported = run(['bundle', '--output', output]);
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).samples.length, 16);
    assert.notEqual(run(['bundle', '--output', output]).status, 0);
    assert.notEqual(run(['score', '--bundle', output]).status, 0);
    await writeFile(responses, '[]');
    assert.match(run(['score', '--bundle', output, '--responses', responses]).stderr, /Missing predictions/);
    await writeFile(responses, JSON.stringify(oraclePredictions()));
    const scored = run(['score', '--bundle', output, '--responses', responses]);
    assert.equal(scored.status, 0, scored.stderr);
    assert.equal(JSON.parse(scored.stdout).correct, 16);
    const failing = oraclePredictions();
    failing[0].verdict = 'REQUEST_CHANGES';
    await writeFile(responses, JSON.stringify(failing));
    assert.equal(run(['score', '--bundle', output, '--responses', responses]).status, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
