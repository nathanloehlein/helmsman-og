// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { canCreateFileSymlink, hasProcessGroups } from '../test-support/platform';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertClarificationReady, executePrePrStage, githubRepository, localReviewScope, parsePrMetadata, readPrePrReport, stageEventEmitter } from './pre-pr-runtime';
import type { AgentAdapter, AgentEvent } from './agents/adapter';

const task = { ticketId: 'T-1', title: 'Task', repo: 'org/repo', jiraBaseUrl: '' };
const adapter = (script: string): AgentAdapter => ({ id: 'test', buildCommand: () => ({ cmd: process.execPath, args: ['-e', script] }),
  parseLine: line => JSON.parse(line) as AgentEvent });

describe('pre-PR runtime boundaries', () => {
  it.each([['codex', 3], ['claude-code', 2]] as const)('uses %s cost semantics and trusted stage metadata', (provider, total) => {
    const events: AgentEvent[] = [];
    const forward = stageEventEmitter(provider, { ...task, model: 'review-model', effort: 'high',
      prePr: { stage: 'review', baseSha: 'a'.repeat(40), reportPath: '/report', round: 2 } }, event => events.push(event));
    for (const costUsd of [0, 1, 2]) forward({ kind: 'usage', text: 'Usage', costUsd, provider: 'spoofed', stage: 'implement', round: 0 });
    expect(events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0)).toBe(total);
    expect(events[0]?.costUsd).toBe(0);
    expect(events.every(event => event.provider === provider && event.model === 'review-model' && event.effort === 'high'
      && event.stage === 'review' && event.round === 2)).toBe(true);
  });

  it('requires an explicit matching local gate for tasks using clarification and permits legacy tasks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: async () => ({ ready: true }) } as Response);
    await assertClarificationReady(task, 'run-1', fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    for (const gateUrl of [undefined, 'https://example.com/api/runs/run-1/clarification-gate', 'http://localhost:8787/api/runs/other/clarification-gate']) {
      await expect(assertClarificationReady({ ...task, clarification: { questionsPath: '/q', answersPath: '/a', gateUrl } }, 'run-1', fetcher)).rejects.toThrow('publication blocked');
    }
    expect(fetcher).not.toHaveBeenCalled();
    await assertClarificationReady({ ...task, clarification: { questionsPath: '/q', answersPath: '/a', gateUrl: 'http://127.0.0.1:8787/api/runs/run-1/clarification-gate' } }, 'run-1', fetcher);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });

  it('requires a bearer capability for the Docker host gate', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: async () => ({ ready: true }) } as Response);
    const clarification = { questionsPath: '/q', answersPath: '/a', gateUrl: 'http://host.docker.internal:8790/clarification-gate' };
    await expect(assertClarificationReady({ ...task, clarification }, 'run-1', fetcher)).rejects.toThrow('publication blocked');
    await assertClarificationReady({ ...task, clarification: { ...clarification, gateToken: 'a'.repeat(64) } }, 'run-1', fetcher);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: `Bearer ${'a'.repeat(64)}` });
  });

  it.each([null, {}, { ready: false }, { ready: 'true' }])('fails closed for unready/malformed clarification gate %j', async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: async () => body } as Response);
    await expect(assertClarificationReady({ ...task, clarification: { questionsPath: '/q', answersPath: '/a', gateUrl: 'http://127.0.0.1:8787/api/runs/run-1/clarification-gate' } }, 'run-1', fetcher)).rejects.toThrow('publication blocked');
  });
  it('validates origin identity for GitHub HTTPS and SSH only', () => {
    for (const remote of ['https://github.com/Org/repo.git', 'git@github.com:Org/repo.git', 'ssh://git@github.com/Org/repo']) {
      expect(githubRepository(remote)).toBe('org/repo');
    }
    for (const remote of ['https://github.com.evil/Org/repo', 'https://evil/github.com/Org/repo', '/tmp/repo', 'git@github.com:org/repo/extra']) {
      expect(githubRepository(remote)).toBeNull();
    }
  });

  it('rejects malformed or unsafe metadata and preserves Markdown', () => {
    expect(parsePrMetadata({ title: ' A title ', body: '## Change\n\n```ts\nfix();\n```' })).toEqual({ title: 'A title', body: '## Change\n\n```ts\nfix();\n```' });
    for (const value of [null, [], {}, { title: '', body: 'ok' }, { title: 'line\nbreak', body: 'ok' }, { title: 'ok', body: 'a'.repeat(64_001) }]) {
      expect(() => parsePrMetadata(value)).toThrow();
    }
  });

  it('reads null-delimited diff filenames without splitting tabs, spaces or newlines', () => {
    const scope = localReviewScope('3\t2\tsrc/a file.ts\0-\t-\tassets/photo.png\x001\t0\tsrc/tab\tname\n.ts\0', 'head');
    expect(scope).toMatchObject({ complete: true, changedFiles: 3, changedLines: 6 });
    expect(scope.files[2]?.filename).toBe('src/tab\tname\n.ts');
    expect(() => localReviewScope('broken\0', 'head')).toThrow();
  });

  it('requires the exact Jira ticket ID in ticket PR titles without restricting freeform titles', () => {
    expect(parsePrMetadata({ title: '[T-1] Fix purchase', body: 'Details' }, task).title).toBe('[T-1] Fix purchase');
    for (const title of ['Fix purchase', 'T-10 Fix purchase', 'NOT-1 Fix purchase']) {
      expect(() => parsePrMetadata({ title, body: 'Details' }, task)).toThrow('Jira ticket ID');
    }
    expect(parsePrMetadata({ title: 'Fix purchase', body: 'Details' }, { ticketId: 'freeform', task: 'Fix purchase' }).title).toBe('Fix purchase');
  });

  // Creating a file symlink on Windows needs Developer Mode or elevation.
  it.skipIf(!canCreateFileSymlink())('reads bounded regular JSON reports and rejects symlinks and oversized reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helmsman-report-test-'));
    try {
      const actual = join(root, 'actual.json');
      const link = join(root, 'link.json');
      await writeFile(actual, '{"verdict":"APPROVE"}');
      expect(await readPrePrReport(actual)).toEqual({ verdict: 'APPROVE' });
      await symlink(actual, link);
      await expect(readPrePrReport(link)).rejects.toThrow();
      await expect(readPrePrReport(root)).rejects.toThrow();
      await writeFile(actual, ' '.repeat(256 * 1024 + 1));
      await expect(readPrePrReport(actual)).rejects.toThrow('256 KB');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('strips claimed PR numbers from every child event', async () => {
    const events: AgentEvent[] = [];
    await executePrePrStage(adapter('console.log(JSON.stringify({kind:"result",text:"opened PR",prNumber:42,costUsd:1.5}))'), task, tmpdir(), event => events.push(event), new AbortController().signal);
    expect(events).toEqual([{ kind: 'result', text: 'opened PR', costUsd: 1.5 }]);
  });

  it('blocks nonzero exits and errors even when a child claims success', async () => {
    await expect(executePrePrStage(adapter('console.log(JSON.stringify({kind:"result",text:"done"}));process.exitCode=2'), task, tmpdir(), () => {}, new AbortController().signal)).rejects.toThrow('exited 2');
    await expect(executePrePrStage(adapter('console.log(JSON.stringify({kind:"error",text:"authentication failed"}))'), task, tmpdir(), () => {}, new AbortController().signal)).rejects.toThrow('reported an error');
  });

  it('stops stages on cancellation or timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'helmsman-stage-test-'));
    try {
      const abort = new AbortController();
      const stage = executePrePrStage(adapter('setInterval(()=>{},1000)'), task, dir, () => {}, abort.signal);
      abort.abort();
      await expect(stage).rejects.toThrow('stopped');
      await expect(executePrePrStage(adapter('setInterval(()=>{},1000)'), task, dir, () => {}, new AbortController().signal, 20)).rejects.toThrow('timed out');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each(['timeout', 'cancel'] as const)('kills descendants that ignore SIGTERM on %s', async reason => {
    const root = await mkdtemp(join(tmpdir(), 'helmsman-descendant-test-'));
    const pidPath = join(root, 'child.pid');
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));process.on('SIGTERM',()=>{});console.log(JSON.stringify({kind:'log',text:'ready'}));setInterval(()=>{},1000)`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
    const abort = new AbortController();
    try {
      const stage = executePrePrStage(adapter(parent), task, root, event => {
        if (reason === 'cancel' && event.text === 'ready') abort.abort();
        // The descendant has to spawn two nested node processes before it can
        // record its pid. Under full-suite load on Windows that takes longer
        // than half a second, and a stage that times out first kills the parent
        // before the descendant exists, leaving nothing to assert about. The
        // timeout only has to outlast process startup; what is under test is
        // that the descendant is killed, not how long the stage waited.
      }, abort.signal, reason === 'timeout' ? 5_000 : 10_000);
      await expect(stage).rejects.toThrow(reason === 'timeout' ? 'timed out' : 'stopped');
      const pid = Number(await readFile(pidPath, 'utf8'));
      await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { timeout: 2000 }).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);

  // Signalling a process group (kill(-pid)) has no Windows equivalent.
  it.skipIf(!hasProcessGroups)('does not signal a released process group again after exit cleanup', async () => {
    const originalKill = process.kill.bind(process);
    const cleaned = new Set<number>();
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 'SIGKILL') {
        if (cleaned.has(pid)) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
        cleaned.add(pid);
      }
      return originalKill(pid, signal);
    });
    try {
      await expect(executePrePrStage(adapter(''), task, tmpdir(), () => {}, new AbortController().signal)).resolves.toBeUndefined();
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
    } finally { kill.mockRestore(); }
  });

  it('cleans up inherited-pipe descendants when the CLI exits normally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helmsman-stage-exit-test-'));
    const pidPath = join(root, 'child.pid');
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));process.send('ready');setInterval(()=>{},1000)`;
    const parent = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']});child.on('message',()=>process.exit(0))`;
    try {
      await expect(executePrePrStage(adapter(parent), task, root, () => {}, new AbortController().signal, 3000)).resolves.toBeUndefined();
      const pid = Number(await readFile(pidPath, 'utf8'));
      await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { timeout: 2000 }).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
