// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db, type RunRow } from './db';
import { inspectPrePrContinuation, resumeFailedPrePrRun } from './resume';
import type { LaunchSpec, RunHost } from './run-host';
import { createRunArtifactStore } from './artifacts';

const fixtures: { root: string; db: Db }[] = [];
afterEach(() => { for (const { root, db } of fixtures.splice(0)) { db.close(); rmSync(root, { recursive: true, force: true }); } });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'helmsman-resume-'));
  const db = openDb(':memory:');
  fixtures.push({ root, db });
  const id = 'resume-run';
  const runsDir = join(root, 'runs');
  const cwd = join(root, '.worktrees', id);
  const artifacts = join(runsDir, `${id}.pre-pr`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'task.txt'), 'base\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', '-b', `agent/${id}`);
  writeFileSync(join(cwd, 'task.txt'), 'implemented\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'implementation');
  const headSha = git('rev-parse', 'HEAD');
  const task = { ticketId: 'PROJ-1', title: 'Retained task', repo: 'org/repo', jiraBaseUrl: 'https://jira.example.com', jiraContext: 'Original criteria', model: 'gpt-5.6-sol', effort: 'high' };
  const settings = { reviewerCount: 2, maxRounds: 3, stageTimeoutMinutes: 45 };
  const specPath = join(runsDir, `${id}.json`);
  const logPath = join(runsDir, `${id}.log`);
  const exitPath = join(runsDir, `${id}.exit`);
  const spec = { cwd, cmd: 'node', args: [JSON.stringify({ task, settings, writerId: 'codex', runsDir })] };
  writeFileSync(specPath, JSON.stringify(spec));
  writeFileSync(logPath, 'original log\n');
  writeFileSync(exitPath, '1');
  const report = { baseSha, headSha, verdict: 'REQUEST_CHANGES', summary: 'Fix the remaining issue.', findings: [{ title: 'Timing issue', body: 'Reproduce the remaining crash loop.' }] };
  writeFileSync(join(artifacts, 'review-2-codex.json'), JSON.stringify(report));
  writeFileSync(join(artifacts, 'review-2-claude-code.json'), JSON.stringify({ ...report, verdict: 'APPROVE', findings: [], summary: 'x'.repeat(2064) }));
  writeFileSync(join(artifacts, 'fix-1.json'), JSON.stringify({ title: 'PROJ-1 implement task', body: 'Original implementation and tests.' }));
  const row: RunRow = { id, ticketId: task.ticketId, repo: task.repo, adapter: 'pre-pr:codex', status: 'failed', attempt: 1,
    prNumber: null, startedAt: '2026-09-18T00:00:00Z', endedAt: '2026-09-18T01:00:00Z', costUsd: 5.2, worktreePath: cwd,
    hostKind: 'detached', hostRef: JSON.stringify({ kind: 'detached', pid: 111 }), logPath, exitPath, specPath, logOffset: 13,
    taskJson: JSON.stringify(task), launchJson: JSON.stringify({ repo: task.repo, mode: 'ticket', ticketId: task.ticketId }) };
  db.insertRun(row); db.appendEvent(id, 'run-complete', 'failed', row.endedAt!);
  const host: RunHost = { kind: 'detached', isAlive: vi.fn(async () => false), stop: vi.fn(async () => {}), launch: vi.fn(async (spec: LaunchSpec) => {
    writeFileSync(spec.specPath, JSON.stringify(spec));
    appendFileSync(spec.logPath, 'new stage\n');
    return { kind: 'detached' as const, pid: 222 };
  }) };
  const deps = { db, host, runsDir, now: () => '2026-09-18T02:00:00Z' };
  return { root, db, row, deps, task, settings, spec, artifacts, cwd, baseSha, headSha, git };
}

describe('same-voyage pre-PR continuation', () => {
  it('validates a saved round and allows only the known summary-length defect', async () => {
    const f = fixture();
    const checkpoint = await inspectPrePrContinuation(f.row, f.deps.runsDir);
    expect(checkpoint.task).toMatchObject({ ...f.task, prePrResume: { baseSha: f.baseSha, headSha: f.headSha, branch: `agent/${f.row.id}`, round: 2,
      reviewerReports: { codex: join(f.artifacts, 'review-2-codex.json'), 'claude-code': join(f.artifacts, 'review-2-claude-code.json') }, metadataPath: join(f.artifacts, 'fix-1.json') } });
    expect(checkpoint.settings).toEqual(f.settings);
  });

  it('relaunches on the preserved worktree and row with appended logs, original costs/context and archived attempt files', async () => {
    const f = fixture();
    const result = await resumeFailedPrePrRun(f.row, f.deps);
    expect(f.deps.host.launch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: f.row.id, status: 'running', attempt: 2, endedAt: null, costUsd: 5.2, logOffset: 13,
      startedAt: f.row.startedAt, worktreePath: f.cwd, hostRef: JSON.stringify({ kind: 'detached', pid: 222 }), launchJson: f.row.launchJson });
    expect(JSON.parse(result.taskJson ?? '{}')).toMatchObject(f.task);
    const launched = JSON.parse(readFileSync(f.row.specPath!, 'utf8')) as LaunchSpec;
    expect(launched.cwd).toBe(f.cwd);
    expect(JSON.parse(launched.args.at(-1)!)).toMatchObject({ settings: f.settings, task: { prePrResume: { headSha: f.headSha, round: 2 } } });
    expect(readFileSync(f.row.logPath!, 'utf8')).toBe('original log\nnew stage\n');
    const archive = readdirSync(f.deps.runsDir).find(name => name.startsWith(`${f.row.id}.attempt-1-`));
    expect(JSON.parse(readFileSync(join(f.deps.runsDir, archive!, 'spec.json'), 'utf8'))).toEqual(f.spec);
    expect(readFileSync(join(f.deps.runsDir, archive!, 'exit'), 'utf8')).toBe('1');
    expect(f.db.listEvents(f.row.id).map(event => event.kind)).toEqual(['run-complete', 'phase']);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.headSha);
  });

  it.each(['dirty', 'changed-head', 'malformed-report', 'missing-report', 'invalid-settings', 'unconsumed-log', 'branch-changed', 'running', 'todo', 'host-alive', 'cancelled'])('rejects %s before launching', async reason => {
    const f = fixture();
    if (reason === 'dirty') writeFileSync(join(f.cwd, 'unrelated.txt'), 'draft');
    if (reason === 'changed-head') { writeFileSync(join(f.cwd, 'task.txt'), 'changed'); f.git('add', '.'); f.git('commit', '--quiet', '-m', 'changed'); }
    if (reason === 'malformed-report') writeFileSync(join(f.artifacts, 'review-2-claude-code.json'), JSON.stringify({ baseSha: f.baseSha, headSha: f.headSha, verdict: 'APPROVE', summary: 'x'.repeat(2064), findings: [{}] }));
    if (reason === 'missing-report') rmSync(join(f.artifacts, 'review-2-claude-code.json'));
    if (reason === 'invalid-settings') writeFileSync(f.row.specPath!, JSON.stringify({ ...f.spec, args: [JSON.stringify({ task: f.task, writerId: 'codex', runsDir: f.deps.runsDir, settings: { ...f.settings, maxRounds: 99 } })] }));
    if (reason === 'unconsumed-log') appendFileSync(f.row.logPath!, 'unread');
    if (reason === 'branch-changed') f.git('checkout', '--quiet', '-b', 'different');
    if (reason === 'running') f.row.status = 'running';
    if (reason === 'todo') f.row.taskJson = JSON.stringify({ ...f.task, todoId: 'TODO-1' });
    if (reason === 'host-alive') vi.mocked(f.deps.host.isAlive).mockResolvedValue(true);
    await expect(resumeFailedPrePrRun(f.row, { ...f.deps, isStopped: () => reason === 'cancelled' })).rejects.toThrow();
    expect(f.deps.host.launch).not.toHaveBeenCalled();
    expect(f.db.getRun(f.row.id)?.status).toBe('failed');
    expect(readFileSync(f.row.exitPath!, 'utf8')).toBe('1');
  });

  it('restores the original row, spec and exit marker when launching fails', async () => {
    const f = fixture();
    vi.mocked(f.deps.host.launch).mockImplementation(async spec => { writeFileSync(spec.specPath, 'replaced'); throw new Error('host failed'); });
    await expect(resumeFailedPrePrRun(f.row, f.deps)).rejects.toThrow('could not start');
    expect(f.db.getRun(f.row.id)).toMatchObject(f.row);
    expect(JSON.parse(readFileSync(f.row.specPath!, 'utf8'))).toEqual(f.spec);
    expect(readFileSync(f.row.exitPath!, 'utf8')).toBe('1');
    expect(readFileSync(f.row.logPath!, 'utf8')).toBe('original log\n');
  });

  it('rejects a report altered after an immutable artifact was recorded, while legacy reports remain resumable', async () => {
    const f = fixture();
    const reportPath = join(f.artifacts, 'review-2-codex.json');
    await createRunArtifactStore(join(f.deps.runsDir, '.artifacts')).write({ runId: f.row.id, stage: 'review', round: 2, reviewer: 'codex' }, readFileSync(reportPath));
    writeFileSync(reportPath, '{"tampered":true}');
    await expect(inspectPrePrContinuation(f.row, f.deps.runsDir)).rejects.toThrow('changed after');
  });
});
