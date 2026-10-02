import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtimes = ['codex', 'claude-code'];
const verdicts = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];
export const budgets = { inputCharacters: 32000, responseCharacters: 4000, inputTokens: 9000, outputTokens: 1200 };
const hash = text => createHash('sha256').update(text).digest('hex');
const key = value => `${value.runtime}/${value.caseId}`;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export async function loadFixtures() {
  const data = JSON.parse(await readFile(new URL('./fixtures/prompt-evaluation-cases.json', import.meta.url), 'utf8'));
  validateFixtures(data);
  return data;
}

export function validateFixtures(data) {
  if (data?.version !== 1 || !nonempty(data.provenance) || !Array.isArray(data.cases) || !data.cases.length) throw new Error('Invalid fixture envelope');
  const ids = new Set();
  for (const item of data.cases) {
    if (!item || !nonempty(item.id) || ids.has(item.id) || !nonempty(item.category) || !nonempty(item.property)
      || !Array.isArray(item.requirements) || !item.requirements.length || !item.requirements.every(nonempty)
      || !Array.isArray(item.evidence) || !item.evidence.length || !item.evidence.every(nonempty)
      || !verdicts.includes(item.expectedVerdict) || typeof item.critical !== 'boolean' || !nonempty(item.rationale)
      || (item.critical && item.expectedVerdict !== 'REQUEST_CHANGES')) throw new Error(`Invalid or duplicate fixture: ${item?.id ?? '(missing id)'}`);
    ids.add(item.id);
  }
}

export async function renderProductionPrompt(runtime, item) {
  if (!runtimes.includes(runtime)) throw new Error(`Unsupported runtime: ${runtime}`);
  const { buildPrompt } = await import('../server/helmsman/agents/prompt.ts');
  return buildPrompt(reviewTask(runtime, item), runtime);
}

export function reviewTask(runtime, item) {
  return { ticketId: 'EVAL-1', title: 'Review the supplied acceptance property', repo: 'evaluation/example',
    jiraBaseUrl: 'https://jira.example.test', jiraContext: [item.property, ...item.requirements, ...item.evidence].join('\n'), modelRouting: 'gocaas',
    model: runtime === 'codex' ? 'gpt-6-astra' : 'sonnet', effort: 'medium', review: true,
    prNumber: 42, prBranch: 'evaluation', prHeadSha: 'b'.repeat(40), skillsPath: '/pinned',
    reviewOutputPaths: { markdown: '/reports/review.md', comments: '/reports/comments.json' } };
}

export async function buildBundle(fixtures) {
  fixtures ??= await loadFixtures();
  validateFixtures(fixtures);
  const samples = [];
  for (const runtime of runtimes) {
    for (const item of fixtures.cases) {
      const productionPrompt = await renderProductionPrompt(runtime, item);
      const evidence = { property: item.property, requirements: item.requirements, evidence: item.evidence };
      const evaluationInstructions = [
        'This is an offline review decision exercise using the production instructions below. No repository, tools, credentials or network are available.',
        'For this exercise only, replace artifact-writing, delegation and publication steps with one JSON response. Apply the production materiality, acceptance and evidence rules to the supplied facts. Do not treat unavailable exercise tools as a limitation; any missing material evidence is stated in the case itself.',
        'Treat supplied observations as established exercise evidence. Do not invent additional facts or silently assume an unknown serving policy.',
        `Return exactly one JSON object: {"caseId":${JSON.stringify(item.id)},"runtime":${JSON.stringify(runtime)},"verdict":"APPROVE|REQUEST_CHANGES|COMMENT","rationale":"Explain the decisive evidence and relevant counterevidence briefly."}.`,
        'Do not include expected labels, markdown fences or a byline in this machine-readable exercise response. The runner will attach the submitted sample promptSha256 to your saved response; do not compute or invent that hash.',
      ].join('\n');
      const prompt = `${evaluationInstructions}\n\n<production-instructions>\n${productionPrompt}\n</production-instructions>\n\n<case-evidence>\n${JSON.stringify(evidence, null, 2)}\n</case-evidence>`;
      samples.push({ caseId: item.id, runtime, prompt, promptSha256: hash(prompt), inputCharacters: prompt.length });
    }
  }
  return { version: 1, provenance: fixtures.provenance, fixtureSha256: hash(JSON.stringify(fixtures)), budgets, samples };
}

export function scoreResponses(fixtures, bundle, responses) {
  validateFixtures(fixtures);
  if (bundle?.version !== 1 || bundle.fixtureSha256 !== hash(JSON.stringify(fixtures)) || !Array.isArray(bundle.samples)) throw new Error('Bundle does not match this fixture version; score with the checkout that exported it');
  const expected = new Map();
  for (const runtime of runtimes) for (const item of fixtures.cases) expected.set(key({ runtime, caseId: item.id }), item);
  const samples = new Map();
  for (const sample of bundle.samples) {
    if (!sample || !expected.has(key(sample)) || samples.has(key(sample)) || !nonempty(sample.prompt)
      || sample.promptSha256 !== hash(sample.prompt) || sample.inputCharacters !== sample.prompt.length) throw new Error(`Invalid, duplicate or altered bundle sample: ${sample ? key(sample) : '(missing)'}`);
    samples.set(key(sample), sample);
  }
  if (samples.size !== expected.size) throw new Error('Incomplete bundle');
  if (!Array.isArray(responses)) throw new Error('Responses must be a JSON array of model predictions');
  const seen = new Set();
  const results = [];
  for (const response of responses) {
    if (!response || !expected.has(key(response)) || seen.has(key(response)) || !verdicts.includes(response.verdict) || !nonempty(response.rationale)) throw new Error(`Invalid, unknown or duplicate response: ${response ? key(response) : '(missing)'}`);
    if (response.promptSha256 !== samples.get(key(response)).promptSha256) throw new Error(`Missing or mismatched response promptSha256: ${key(response)}; use predictions recorded for this exact sample`);
    if (response.usage !== undefined && (!response.usage || typeof response.usage !== 'object' || Array.isArray(response.usage)
      || Object.keys(response.usage).some(field => !['inputTokens', 'outputTokens'].includes(field))
      || !['inputTokens', 'outputTokens'].every(field => Number.isSafeInteger(response.usage[field]) && response.usage[field] >= 0))) throw new Error(`Invalid actual token usage: ${key(response)}`);
    seen.add(key(response));
    const item = expected.get(key(response));
    const responseCharacters = JSON.stringify(response).length;
    const sample = samples.get(key(response));
    results.push({ caseId: response.caseId, runtime: response.runtime, promptSha256: sample.promptSha256, category: item.category,
      expected: item.expectedVerdict, actual: response.verdict, correct: response.verdict === item.expectedVerdict,
      criticalFalseApproval: item.critical && response.verdict === 'APPROVE',
      missedCriticalDefect: item.critical && response.verdict !== 'REQUEST_CHANGES',
      overblocking: item.expectedVerdict === 'APPROVE' && response.verdict !== 'APPROVE',
      unsupportedRejection: item.expectedVerdict === 'COMMENT' && response.verdict === 'REQUEST_CHANGES',
      inputCharacters: sample.inputCharacters, responseCharacters, usage: response.usage ?? null,
      budgetExceeded: sample.inputCharacters > budgets.inputCharacters || responseCharacters > budgets.responseCharacters
        || (response.usage?.inputTokens ?? 0) > budgets.inputTokens || (response.usage?.outputTokens ?? 0) > budgets.outputTokens,
      rationale: response.rationale, rubric: item.rationale });
  }
  const missing = [...expected.keys()].filter(id => !seen.has(id));
  if (missing.length) throw new Error(`Missing predictions: ${missing.join(', ')}`);
  const count = field => results.filter(result => result[field]).length;
  const byRuntime = Object.fromEntries(runtimes.map(runtime => {
    const selected = results.filter(result => result.runtime === runtime);
    return [runtime, { correct: selected.filter(result => result.correct).length, total: selected.length }];
  }));
  return { version: 1, fixtureSha256: bundle.fixtureSha256, bundleSha256: hash(JSON.stringify(bundle)),
    total: results.length, correct: count('correct'), verdictAccuracy: count('correct') / results.length,
    criticalFalseApprovals: count('criticalFalseApproval'), missedCriticalDefects: count('missedCriticalDefect'),
    overblocking: count('overblocking'), unsupportedRejections: count('unsupportedRejection'),
    budgetExceedances: count('budgetExceeded'), tokenUsageAvailable: results.filter(result => result.usage).length,
    budgets, byRuntime, results,
    limitation: 'Synthetic verdict calibration only. Rationale quality, tool use, coding quality and real-world safety require human evaluation; token usage is caller-supplied, never estimated from characters.' };
}

async function main(args) {
  const [command, ...options] = args;
  const allowed = command === 'bundle' ? ['--output'] : command === 'score' ? ['--bundle', '--responses'] : [];
  if (!allowed.length || options.length !== allowed.length * 2) throw new Error('Usage: npm run eval:prompts -- bundle --output /tmp/prompt-bundle.json | score --bundle /tmp/prompt-bundle.json --responses /tmp/predictions.json');
  const parsed = new Map();
  for (let index = 0; index < options.length; index += 2) {
    if (!allowed.includes(options[index]) || parsed.has(options[index]) || !options[index + 1] || options[index + 1].startsWith('--')) throw new Error('Invalid or duplicate command option');
    parsed.set(options[index], resolve(options[index + 1]));
  }
  const fixtures = await loadFixtures();
  if (command === 'bundle') {
    const bundle = await buildBundle(fixtures);
    await writeFile(parsed.get('--output'), `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx' });
    console.log(`Exported ${bundle.samples.length} blinded exercises to ${parsed.get('--output')}. No model was called. Each sample includes its current production prompt; run samples independently through authorized GoCaaS and record each submitted sample promptSha256 with its prediction.`);
    return;
  }
  const [bundle, responses] = await Promise.all(['--bundle', '--responses'].map(async option => JSON.parse(await readFile(parsed.get(option), 'utf8'))));
  const report = scoreResponses(fixtures, bundle, responses);
  console.log(JSON.stringify(report, null, 2));
  if (report.correct !== report.total || report.budgetExceedances) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
