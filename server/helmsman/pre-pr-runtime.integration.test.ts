// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cliPath = fileURLToPath(new URL('./pre-pr-cli.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');

async function fixture(mode: 'fix' | 'unavailable' | 'auth' | 'modified' | 'remote-moved' | 'ticket-title' | 'named-remote') {
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
  if(args[0] === 'push') { log({stage:'push',remote:args[1]}); args[args.indexOf(env.TEST_REMOTE)] = env.TEST_BARE; }
  process.stdout.write(cp.execFileSync('/usr/bin/git', args, {encoding:'utf8'}));
} else if(id === 'gh') {
  if(args[0] === 'repo') process.stdout.write(JSON.stringify({nameWithOwner:'example/project',defaultBranchRef:{name:'main'}}));
  else if(args[1] === 'list') process.stdout.write(fs.existsSync(env.TEST_STATE) ? fs.readFileSync(env.TEST_STATE) : '[]');
  else if(args[1] === 'create') {
    log({stage:'publish'});
    fs.writeFileSync(env.TEST_STATE, JSON.stringify([{number:42,headRefOid:runGit(['rev-parse','HEAD']),baseRefName:'main'}]));
    console.log('https://github.com/example/project/pull/42');
  } else process.exit(5);
} else {
  const prompt = args.find(value => value.startsWith('# '));
  const reportPath = JSON.parse(prompt.match(/external report path ("(?:[^"\\]|\\.)*")/)[1]);
  const review = prompt.startsWith('# Independent');
  const fix = prompt.startsWith('# Resolve');
  log({stage:review?'review':fix?'fix':'implement',id,cwd:process.cwd(),args:args.filter(value=>value!==prompt)});
  if (id === 'claude' && env.TEST_MODE === 'auth') { console.error('authentication unavailable'); process.exit(7); }
  if(review) {
    const baseSha = prompt.match(/Base revision: ([a-f0-9]+)/)[1];
    const headSha = prompt.match(/Head revision: ([a-f0-9]+)/)[1];
    const round = Number(prompt.match(/Round: (\d+)/)[1]);
    if(env.TEST_MODE === 'modified') fs.appendFileSync('code.txt','reviewer edit\n');
    const findings = env.TEST_MODE === 'fix' && round===1 ? [{title:'Missing guard',body:'Empty input breaks the primary workflow.',path:'code.txt',line:1}] : [];
    fs.writeFileSync(reportPath,JSON.stringify({baseSha,headSha,verdict:findings.length?'REQUEST_CHANGES':'APPROVE',summary:findings.length?'Guard required':'No material findings',findings}));
  } else {
    fs.appendFileSync('code.txt',fix?'fixed\n':'implemented\n');
    runGit(['add','code.txt']); runGit(['commit','-m',fix?'fix':'implement']);
    fs.writeFileSync(reportPath,JSON.stringify({title:env.TEST_MODE==='ticket-title'?'Implement task':'T-1 Implement task',body:'Implemented and checked.'}));
  }
  console.log(JSON.stringify({type:'result',result:'saw https://github.com/example/project/pull/999',total_cost_usd:1}));
}
`;
  for (const executable of ['git', 'gh', ...(mode === 'unavailable' ? [] : ['codex']), 'claude']) {
    await writeFile(join(bin, executable), script); await chmod(join(bin, executable), 0o755);
  }
  const input = { task: { ticketId: 'T-1', title: 'Fix issue', repo: 'example/project', jiraBaseUrl: '', model: 'author-model', effort: 'medium' }, writerId: 'codex', runsDir: join(root, 'runs') };
  return { root, cwd, state, transcript, async run() {
    try {
      const output = await exec(process.execPath, ['--import', tsx, cliPath, JSON.stringify(input)], {
        cwd, timeout: 30_000, env: { ...process.env, PATH: bin, TEST_MODE: mode, TEST_REMOTE: mode==='named-remote'?'godaddy':'origin', TEST_BARE: bare, TEST_STATE: state, TEST_TRANSCRIPT: transcript },
      });
      return { code: 0, output: output.stdout };
    } catch (error) {
      const failure = error as { code: number; stdout: string };
      return { code: failure.code, output: failure.stdout };
    }
  } };
}

describe('pre-PR runtime with real git and fake CLIs', () => {
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
