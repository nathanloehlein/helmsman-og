// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { PrePrSettings } from '../../src/logic/prePrSettings';
import type { AgentTask } from './agents/adapter';
import { PRE_PR_REVIEW_SUMMARY_LIMIT, type PrePrReviewerId } from './pre-pr-workflow';

const exec = promisify(execFile);
const cliPath = fileURLToPath(new URL('./pre-pr-cli.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');

async function fixture(mode: 'fix' | 'unavailable' | 'auth' | 'modified' | 'remote-moved' | 'ticket-title' | 'named-remote' | 'existing'
  | 'summary-approval' | 'summary-fix' | 'summary-still-long' | 'summary-mutated-findings' | 'summary-mutated-verdict', settings?: PrePrSettings,
  options: { task?: Partial<AgentTask>; writerId?: PrePrReviewerId; body?: string; existingBody?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-runtime-'));
  const cwd = join(root, 'author');
  const bin = join(root, 'bin');
  const state = join(root, 'state.json');
  const transcript = join(root, 'transcript.jsonl');
  const bare = join(root, 'remote.git');
  await mkdir(cwd); await mkdir(bin);
  const git = (args: string[]) => exec('/usr/bin/git', args, { cwd });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await writeFile(join(cwd, 'code.txt'), 'initial\n');
  await git(['add', '.']); await git(['commit', '-m', 'initial']);
  await git(['clone', '--bare', cwd, bare]);
  await git(['remote', 'add', 'origin', 'https://github.com/example/project.git']);
  if (mode === 'named-remote') {
    await git(['remote', 'set-url', 'origin', 'https://github.com/old/unrelated.git']);
    await git(['remote', 'add', 'godaddy', 'git@github.com:example/project.git']);
  }
  await git(['switch', '-c', 'voyage/test']);
  const script = `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
const id = path.basename(process.argv[1]);
const env = process.env;
const runGit = args => cp.execFileSync('/usr/bin/git', args, {encoding:'utf8'}).trim();
const log = data => fs.appendFileSync(env.TEST_TRANSCRIPT, JSON.stringify(data)+'\n');
if(id === 'git') {
  if(args[0] === 'fetch' || args[0] === 'ls-remote') args[args.indexOf(env.TEST_REMOTE)] = env.TEST_BARE;
  if(args[0] === 'ls-remote' && env.TEST_MODE === 'remote-moved') {
    console.log('a'.repeat(40)+'\trefs/heads/voyage/test'); process.exit(0);
  }
  if(args[0] === 'push') {
    log({stage:'push',remote:args[1]}); args[args.indexOf(env.TEST_REMOTE)] = env.TEST_BARE;
    if(fs.existsSync(env.TEST_STATE)) {
      const prs=JSON.parse(fs.readFileSync(env.TEST_STATE,'utf8'));
      for(const pr of prs) pr.headRefOid=runGit(['rev-parse','HEAD']);
      fs.writeFileSync(env.TEST_STATE,JSON.stringify(prs));
    }
  }
  process.stdout.write(cp.execFileSync('/usr/bin/git', args, {encoding:'utf8'}));
} else if(id === 'gh') {
  if(args[0] === 'repo') process.stdout.write(JSON.stringify({nameWithOwner:'example/project',defaultBranchRef:{name:'main'}}));
  else if(args[1] === 'list') process.stdout.write(fs.existsSync(env.TEST_STATE) ? fs.readFileSync(env.TEST_STATE) : '[]');
  else if(args[1] === 'create') {
    const body=fs.readFileSync(args[args.indexOf('--body-file')+1],'utf8');
    log({stage:'publish',body});
    fs.writeFileSync(env.TEST_STATE, JSON.stringify([{number:42,headRefOid:runGit(['rev-parse','HEAD']),baseRefName:'main',body}]));
    console.log('https://github.com/example/project/pull/42');
  } else if(args[1] === 'edit') {
    const body=fs.readFileSync(args[args.indexOf('--body-file')+1],'utf8');
    const prs=JSON.parse(fs.readFileSync(env.TEST_STATE,'utf8'));
    const pr=prs.find(pr=>pr.number===Number(args[2]));
    if(!pr) process.exit(6);
    pr.body=body;
    fs.writeFileSync(env.TEST_STATE,JSON.stringify(prs));
    log({stage:'edit-pr',body});
  } else process.exit(5);
} else {
  const prompt = args.find(value => value.startsWith('# '));
  const correction = prompt.startsWith('# Correct');
  const reportPath = JSON.parse(prompt.match(correction ? /Write the corrected complete JSON object only to ("(?:[^"\\]|\\.)*")/ : /external report path ("(?:[^"\\]|\\.)*")/)[1]);
  const review = prompt.startsWith('# Independent');
  const fix = prompt.startsWith('# Resolve');
  log({stage:correction?'correction':review?'review':fix?'fix':'implement',id,cwd:process.cwd(),reportPath,head:runGit(['rev-parse','HEAD']),args:args.filter(value=>value!==prompt)});
  if (id === 'claude' && env.TEST_MODE === 'auth') { console.error('authentication unavailable'); process.exit(7); }
  if(correction) {
    const priorPath = JSON.parse(prompt.match(/Read the prior complete JSON report from ("(?:[^"\\]|\\.)*")/)[1]);
    const report = JSON.parse(fs.readFileSync(priorPath,'utf8'));
    report.summary = env.TEST_MODE==='summary-still-long' ? 'x'.repeat(Number(env.TEST_SUMMARY_LIMIT)+1) : 'Concise review result';
    if(env.TEST_MODE==='summary-mutated-findings') report.findings[0].body='Changed evidence';
    if(env.TEST_MODE==='summary-mutated-verdict') report.verdict='COMMENT';
    fs.writeFileSync(reportPath,JSON.stringify(report));
  } else if(review) {
    const baseSha = prompt.match(/Base revision: ([a-f0-9]+)/)[1];
    const headSha = prompt.match(/Head revision: ([a-f0-9]+)/)[1];
    const round = Number(prompt.match(/Round: (\d+)/)[1]);
    if(env.TEST_MODE === 'modified') fs.appendFileSync('code.txt','reviewer edit\n');
    const findings = ['fix','summary-fix','summary-mutated-findings'].includes(env.TEST_MODE) && round===1 ? [{title:'Missing guard',body:'Empty input breaks the primary workflow.',path:'code.txt',line:1}] : [];
    const summary = env.TEST_MODE.startsWith('summary-') && round===1 ? 'x'.repeat(Number(env.TEST_SUMMARY_LIMIT)+1) : findings.length?'Guard required':'No material findings';
    fs.writeFileSync(reportPath,JSON.stringify({baseSha,headSha,verdict:findings.length?'REQUEST_CHANGES':'APPROVE',summary,findings}));
  } else {
    fs.appendFileSync('code.txt',fix?'fixed\n':'implemented\n');
    runGit(['add','code.txt']); runGit(['commit','-m',fix?'fix':'implement']);
    fs.writeFileSync(reportPath,JSON.stringify({title:env.TEST_MODE==='ticket-title'?'Implement task':'T-1 Implement task',body:env.TEST_BODY}));
    if(env.TEST_MODE==='existing'&&!fs.existsSync(env.TEST_STATE)) {
      fs.writeFileSync(env.TEST_STATE,JSON.stringify([{number:42,headRefOid:runGit(['rev-parse','HEAD']),baseRefName:'main',body:env.TEST_EXISTING_BODY}]));
    }
  }
  console.log(JSON.stringify({type:'result',result:'saw https://github.com/example/project/pull/999',total_cost_usd:1}));
}
`;
  for (const executable of ['git', 'gh', ...(mode === 'unavailable' ? [] : ['codex']), 'claude']) {
    await writeFile(join(bin, executable), script); await chmod(join(bin, executable), 0o755);
  }
  const input = { task: { ticketId: 'T-1', title: 'Fix issue', repo: 'example/project', jiraBaseUrl: '', model: 'author-model', effort: 'medium', ...options.task }, writerId: options.writerId ?? 'codex', runsDir: join(root, 'runs'), settings };
  return { root, cwd, state, transcript, async run(task: Partial<AgentTask> = {}) {
    try {
      const output = await exec(process.execPath, ['--import', tsx, cliPath, JSON.stringify({ ...input, task: { ...input.task, ...task } })], {
        cwd, timeout: 30_000, env: { ...process.env, PATH: bin, TEST_MODE: mode, TEST_REMOTE: mode==='named-remote'?'godaddy':'origin', TEST_BARE: bare, TEST_STATE: state, TEST_TRANSCRIPT: transcript,
          TEST_SUMMARY_LIMIT: String(PRE_PR_REVIEW_SUMMARY_LIMIT), TEST_BODY: options.body ?? 'Implemented and checked.', TEST_EXISTING_BODY: options.existingBody ?? 'Human-maintained PR description.' },
      });
      return { code: 0, output: output.stdout };
    } catch (error) {
      const failure = error as { code: number; stdout: string };
      return { code: failure.code, output: failure.stdout };
    }
  } };
}

describe('pre-PR runtime with real git and fake CLIs', () => {
  it.each(['codex', 'claude-code'] as const)('repairs an overlong %s approval once and preserves the original report', async writerId => {
    const env = await fixture('summary-approval', { reviewerCount: 1, maxRounds: 2, stageTimeoutMinutes: 10 }, { writerId });
    try {
      const result = await env.run();
      expect(result.code, result.output).toBe(0);
      const steps = (await readFile(env.transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(steps.map(step => step.stage)).toEqual(['implement', 'review', 'correction', 'push', 'publish']);
      const review = steps.find(step => step.stage === 'review');
      const correction = steps.find(step => step.stage === 'correction');
      const original = JSON.parse(await readFile(review.reportPath, 'utf8'));
      const corrected = JSON.parse(await readFile(correction.reportPath, 'utf8'));
      expect(original.summary).toBe('x'.repeat(PRE_PR_REVIEW_SUMMARY_LIMIT + 1));
      expect(corrected).toEqual({ ...original, summary: 'Concise review result' });
      expect(correction.reportPath).not.toBe(review.reportPath);
      expect(correction.id).toBe(review.id);
      expect(correction.head).toBe(review.head);
      expect(correction.args).not.toContain('features.multi_agent=true');
      expect(result.output).toContain('"prNumber":42');
    } finally { await rm(env.root, { recursive: true, force: true }); }
  }, 30_000);

  it('retains request-changes findings through correction and requires remediation and a fresh review', async () => {
    const env = await fixture('summary-fix', { reviewerCount: 1, maxRounds: 2, stageTimeoutMinutes: 10 });
    try {
      const result = await env.run();
      expect(result.code, result.output).toBe(0);
      const steps = (await readFile(env.transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(steps.map(step => step.stage)).toEqual(['implement', 'review', 'correction', 'fix', 'review', 'push', 'publish']);
      const original = JSON.parse(await readFile(steps[1].reportPath, 'utf8'));
      const corrected = JSON.parse(await readFile(steps[2].reportPath, 'utf8'));
      expect(corrected).toEqual({ ...original, summary: 'Concise review result' });
      expect(corrected.verdict).toBe('REQUEST_CHANGES');
      expect(corrected.findings).toHaveLength(1);
      expect(steps[4].head).not.toBe(steps[1].head);
      expect(await readFile(join(env.cwd, 'code.txt'), 'utf8')).toBe('initial\nimplemented\nfixed\n');
    } finally { await rm(env.root, { recursive: true, force: true }); }
  }, 30_000);

  it.each(['summary-still-long', 'summary-mutated-findings', 'summary-mutated-verdict'] as const)('blocks %s after one correction attempt', async mode => {
    const env = await fixture(mode, { reviewerCount: 1, maxRounds: 2, stageTimeoutMinutes: 10 });
    try {
      const result = await env.run();
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('summary correction failed after one attempt; publication blocked');
      const steps = (await readFile(env.transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(steps.map(step => step.stage)).toEqual(['implement', 'review', 'correction']);
      const original = JSON.parse(await readFile(steps[1].reportPath, 'utf8'));
      expect(original.summary).toHaveLength(PRE_PR_REVIEW_SUMMARY_LIMIT + 1);
      expect(original.verdict).toBe(mode === 'summary-mutated-findings' ? 'REQUEST_CHANGES' : 'APPROVE');
      if (mode === 'summary-mutated-findings') expect(original.findings[0]?.body).toBe('Empty input breaks the primary workflow.');
      expect(JSON.parse(await readFile(steps[2].reportPath, 'utf8'))).toBeTruthy();
      await expect(readFile(env.state)).rejects.toThrow();
    } finally { await rm(env.root, { recursive: true, force: true }); }
  }, 30_000);

  it('continues saved round-two reports without repeating implementation, then fixes and reviews round three', async () => {
    const env = await fixture('summary-fix', { reviewerCount: 2, maxRounds: 3, stageTimeoutMinutes: 10 });
    try {
      const git = async (args: string[]) => (await exec('/usr/bin/git', args, { cwd: env.cwd })).stdout.trim();
      const baseSha = await git(['rev-parse', 'HEAD']);
      await writeFile(join(env.cwd, 'code.txt'), 'initial\npreserved implementation\n');
      await git(['add', 'code.txt']);
      await git(['commit', '-m', 'preserved implementation']);
      const headSha = await git(['rev-parse', 'HEAD']);
      const artifacts = join(env.root, 'runs', 'author.pre-pr');
      await mkdir(artifacts, { recursive: true });
      const metadataPath = join(artifacts, 'implement-1.json');
      await writeFile(metadataPath, JSON.stringify({ title: 'T-1 Preserved implementation', body: 'Existing implementation.' }));
      const reviewerReports = { codex: join(artifacts, 'review-2-codex.json'), 'claude-code': join(artifacts, 'review-2-claude-code.json') };
      const pending = { baseSha, headSha, verdict: 'REQUEST_CHANGES', summary: 'x'.repeat(PRE_PR_REVIEW_SUMMARY_LIMIT + 1),
        findings: [{ title: 'Missing guard', body: 'Empty input breaks the primary workflow.', path: 'code.txt', line: 1 }] };
      const approved = { baseSha, headSha, verdict: 'APPROVE', summary: 'No material findings', findings: [] };
      await writeFile(reviewerReports.codex, JSON.stringify(pending));
      await writeFile(reviewerReports['claude-code'], JSON.stringify(approved));
      const result = await env.run({ prePrResume: { baseSha, headSha, branch: 'voyage/test', round: 2, reviewerReports, metadataPath } });
      expect(result.code, result.output).toBe(0);
      const steps = (await readFile(env.transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(steps.map(step => step.stage)).toEqual(['correction', 'fix', 'review', 'review', 'push', 'publish']);
      expect(steps[0].head).toBe(headSha);
      expect(steps[1].head).toBe(headSha);
      expect(steps[1].reportPath).toBe(join(artifacts, 'fix-2.json'));
      expect(steps.filter(step => step.stage === 'review').map(step => step.reportPath)).toEqual([
        join(artifacts, 'review-3-codex.json'), join(artifacts, 'review-3-claude-code.json'),
      ]);
      expect(steps[2].head).not.toBe(headSha);
      expect(steps[3].head).toBe(steps[2].head);
      expect(JSON.parse(await readFile(reviewerReports.codex, 'utf8'))).toEqual(pending);
      expect(JSON.parse(await readFile(reviewerReports['claude-code'], 'utf8'))).toEqual(approved);
      expect(await readFile(join(env.cwd, 'code.txt'), 'utf8')).toBe('initial\npreserved implementation\nfixed\n');
      expect(await git(['rev-list', '--count', `${headSha}..HEAD`])).toBe('1');
    } finally { await rm(env.root, { recursive: true, force: true }); }
  }, 30_000);

  it.each(['baseSha', 'headSha', 'branch'] as const)('rejects a stale continuation %s before running an agent', async field => {
    const env = await fixture('named-remote');
    try {
      const headSha = (await exec('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: env.cwd })).stdout.trim();
      const checkpoint = { baseSha: headSha, headSha, branch: 'voyage/test', round: 2, reviewerReports: {}, metadataPath: '' };
      checkpoint[field] = field === 'branch' ? 'voyage/stale' : 'a'.repeat(40);
      const result = await env.run({ prePrResume: checkpoint });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('continuation checkpoint does not match');
      await expect(readFile(env.transcript)).rejects.toThrow();
      await expect(readFile(env.state)).rejects.toThrow();
      expect((await exec('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: env.cwd })).stdout.trim()).toBe(headSha);
    } finally { await rm(env.root, { recursive: true, force: true }); }
  }, 30_000);

  it.each(['review-2-claude-code.json', 'review-1-codex.json', 'review-2-codex.corrected.json'])(
    'rejects mismatched saved reviewer path %s before running an agent', async filename => {
      const env = await fixture('named-remote', { reviewerCount: 1, maxRounds: 3, stageTimeoutMinutes: 10 });
      try {
        const headSha = (await exec('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: env.cwd })).stdout.trim();
        const artifacts = join(env.root, 'runs', 'author.pre-pr');
        await mkdir(artifacts, { recursive: true });
        const metadataPath = join(artifacts, 'implement-1.json');
        await writeFile(metadataPath, JSON.stringify({ title: 'T-1 Existing implementation', body: 'Existing implementation.' }));
        const reportPath = join(artifacts, filename);
        await writeFile(reportPath, JSON.stringify({ baseSha: headSha, headSha, verdict: 'APPROVE', summary: 'Approved', findings: [] }));
        const result = await env.run({ prePrResume: {
          baseSha: headSha, headSha, branch: 'voyage/test', round: 2, reviewerReports: { codex: reportPath }, metadataPath,
        } });
        expect(result.code, result.output).toBe(1);
        expect(result.output).toContain('each reviewer’s original report for the checkpoint round');
        await expect(readFile(env.transcript)).rejects.toThrow();
        await expect(readFile(env.state)).rejects.toThrow();
      } finally { await rm(env.root, { recursive: true, force: true }); }
    }, 30_000,
  );

  it.each(['codex', 'claude-code'] as const)('enforces the %s writer byline while preserving code and suggestions', async writerId => {
    const body = '## Outcome\n\n```ts\nconst value = "unchanged";\n```\n\n```suggestion\nreturn value;\n```';
    const env = await fixture('named-remote', undefined, { writerId, body, task: { model: 'author-model', effort: 'high' } });
    try {
      const result = await env.run();
      expect(result.code, result.output).toBe(0);
      const prs = JSON.parse(await readFile(env.state, 'utf8'));
      expect(prs[0]?.body).toBe(`${body}\n\n_Helmsman · author-model - high_`);
      const steps = (await readFile(env.transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const author = steps.find(step => step.stage === 'implement');
      expect(author.id).toBe(writerId === 'codex' ? 'codex' : 'claude');
      expect(author.args).toContain('author-model');
      expect(author.args).toContain(writerId === 'codex' ? 'model_reasoning_effort="high"' : 'high');
      expect(prs[0]?.body).not.toContain('gpt-5.6-terra');
    } finally { await rm(env.root, { recursive: true, force: true }); }
  }, 30_000);

  it('uses the actual Codex defaults when writer settings are omitted', async () => {
    const env = await fixture('named-remote', undefined, { task: { model: undefined, effort: undefined } });
    try {
      const result = await env.run();
      expect(result.code, result.output).toBe(0);
      const prs = JSON.parse(await readFile(env.state, 'utf8'));
      expect(prs[0]?.body).toBe('Implemented and checked.\n\n_Helmsman · gpt-6-astra - med_');
      const steps = (await readFile(env.transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const author = steps.find(step => step.stage === 'implement');
      expect(author.args).toContain('gpt-6-astra');
      expect(author.args).toContain('model_reasoning_effort="medium"');
    } finally { await rm(env.root, { recursive: true, force: true }); }
  }, 30_000);

  it('updates only the managed footer of an existing PR and does not repeat an unchanged edit', async () => {
    const content = 'Human-maintained description.\n\n```suggestion\nkeepThis();\n```';
    const existingBody = `${content}\n\n_Helmsman PR author · model: old-model · effort: low_`;
    const env = await fixture('existing', undefined, { existingBody, body: 'Do not replace the human description.' });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await env.run();
        expect(result.code, result.output).toBe(0);
        const prs = JSON.parse(await readFile(env.state, 'utf8'));
        expect(prs[0]?.body).toBe(`${content}\n\n_Helmsman · author-model - med_`);
      }
      const steps = (await readFile(env.transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(steps.filter(step => step.stage === 'edit-pr')).toHaveLength(1);
      expect(steps.filter(step => step.stage === 'publish')).toHaveLength(0);
    } finally { await rm(env.root, { recursive: true, force: true }); }
  }, 30_000);

  it('uses only the writer CLI when one reviewer is configured, even with another installed', async () => {
    const env = await fixture('auth', { reviewerCount: 1, maxRounds: 2, stageTimeoutMinutes: 10 });
    try {
      const result = await env.run();
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('1 reviewer(s), up to 2 rounds, 10 minutes per session');
      const steps = (await readFile(env.transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(steps.filter(step => step.stage === 'review').map(step => step.id)).toEqual(['codex']);
      expect(result.output).toContain('"prNumber":42');
    } finally { await rm(env.root, { recursive: true, force: true }); }
  }, 30_000);

  it('stops without fixes or publication after the configured final review round', async () => {
    const env = await fixture('fix', { reviewerCount: 2, maxRounds: 1, stageTimeoutMinutes: 45 });
    try {
      const result = await env.run();
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('unresolved material findings after 1 review rounds');
      const steps = (await readFile(env.transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(steps.map(step => step.stage)).toEqual(['implement', 'review', 'review']);
      await expect(readFile(env.state)).rejects.toThrow();
    } finally { await rm(env.root, { recursive: true, force: true }); }
  }, 30_000);

  it('implements, obtains both reviews, fixes and re-reviews before publishing the approved commit', async () => {
    const env = await fixture('fix');
    try {
      const result = await env.run();
      expect(result.code, result.output).toBe(0);
      const events = result.output.trim().split('\n').map(line => JSON.parse(line));
      expect(events.filter(event => event.prNumber !== undefined)).toEqual([expect.objectContaining({ kind: 'result', prNumber: 42 })]);
      expect(events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0)).toBe(2);
      const steps = (await readFile(env.transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(steps.map(step => step.stage)).toEqual(['implement', 'review', 'review', 'fix', 'review', 'review', 'push', 'publish']);
      expect(steps.filter(step => step.stage === 'review').map(step => step.id)).toEqual(['codex', 'claude', 'codex', 'claude']);
      expect(steps.filter(step => step.stage === 'review').every(step => step.cwd !== env.cwd)).toBe(true);
      expect(steps[0].args).toContain('author-model');
      expect(steps[1].args).toContain('gpt-5.6-terra');
      expect(steps[2].args).toContain('sonnet');
      expect(steps[1].args).toContain('model_reasoning_effort="low"');
      const status = await exec('/usr/bin/git', ['status', '--porcelain'], { cwd: env.cwd });
      expect(status.stdout).toBe('');
    } finally { await rm(env.root, { recursive: true, force: true }); }
  }, 30_000);

  it('publishes to the uniquely matching named remote when origin points elsewhere', async () => {
    const env = await fixture('named-remote');
    try {
      const result = await env.run();
      expect(result.code, result.output).toBe(0);
      const steps = (await readFile(env.transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(steps.find(step => step.stage === 'push')?.remote).toBe('godaddy');
      expect(result.output).toContain('"prNumber":42');
    } finally { await rm(env.root, { recursive: true, force: true }); }
  }, 30_000);

  it.each(['unavailable', 'auth', 'modified', 'remote-moved', 'ticket-title'] as const)('blocks publication for %s and preserves author checkout', async mode => {
    const env = await fixture(mode);
    try {
      const result = await env.run();
      expect(result.code, result.output).toBe(1);
      expect(result.output).not.toContain('"prNumber":');
      await expect(readFile(env.state)).rejects.toThrow();
      expect(await readFile(join(env.cwd, 'code.txt'), 'utf8')).toContain('initial');
      if (mode === 'unavailable') expect(result.output).toContain('writer CLI is unavailable');
      if (mode === 'modified') expect(result.output).toContain('modified its immutable worktree');
      if (mode === 'auth') expect(result.output).toContain('exited 7');
      if (mode === 'remote-moved') expect(result.output).toContain('Remote branch does not match the approved revision');
      if (mode === 'ticket-title') expect(result.output).toContain('PR title must include the Jira ticket ID');
    } finally { await rm(env.root, { recursive: true, force: true }); }
  }, 30_000);
});
