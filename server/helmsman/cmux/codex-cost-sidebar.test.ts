import { mkdtemp, readFile, writeFile, appendFile, rm, rename, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CODEX_COST_STATUS_PREFIX, refreshCodexCostSidebar } from './codex-cost-sidebar';

const workspace = '11111111-1111-1111-1111-111111111111';
const movedWorkspace = '55555555-5555-5555-5555-555555555555';
const surface = '22222222-2222-2222-2222-222222222222';
const session = '33333333-3333-3333-3333-333333333333';
const otherSession = '44444444-4444-4444-4444-444444444444';
const staleKey = `${CODEX_COST_STATUS_PREFIX}66666666-6666-6666-6666-666666666666`;
const currentKey = `${CODEX_COST_STATUS_PREFIX}${surface}`;
const folders: string[] = [];

function tokens(input: number, cached = 0, output = 100): string {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
  } } });
}

const context = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra' } });

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'cmux-cost-test-'));
  folders.push(folder);
  const transcript = join(folder, `rollout-2026-09-19-${session}.jsonl`);
  const stateDir = join(folder, 'state');
  await writeFile(transcript, `${context}\n${tokens(1_000)}\n`);
  const rows: Record<string, unknown>[] = [{ agent: 'codex', session_id: session, surface_id: surface,
    workspace_id: workspace, transcript_path: transcript, updated_at: '2026-09-19T01:00:00Z', stored_pid_exists: true,
    active_for_surface: false, launch_arguments: ['secret-launch-arg'] }];
  const live = { id: workspace, panes: [{ surfaces: [{ id: surface, ref: 'surface:9', type: 'terminal' }] }] };
  const workspaces = [live];
  const calls: string[][] = [];
  const statusLines = new Map<string, string>([[workspace, `codex=Idle\n${staleKey}=old\nother=value`]]);
  const runCmux = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes('tree')) return JSON.stringify({ windows: [{ workspaces }] });
    if (args.includes('sessions')) return JSON.stringify({ sessions: rows });
    if (args[0] === 'list-status') return statusLines.get(args[2] ?? '') ?? '';
    return 'OK';
  };
  return { folder, transcript, stateDir, rows, live, workspaces, calls, statusLines, runCmux,
    options: { cmuxPath: '/mock/cmux', stateDir, runCmux } };
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
});

describe('native cmux Codex sidebar', () => {
  it('publishes the explicit live surface estimate and clears only owned stale status keys', async () => {
    const f = await fixture();
    const report = await refreshCodexCostSidebar(f.options);
    expect(report.warnings).toEqual([]);
    expect(report.statuses).toEqual([{ workspaceId: workspace, surfaceId: surface, key: currentKey, label: 'Codex surface:9 · $0.02 est' }]);
    expect(f.calls).toContainEqual(['clear-status', staleKey, '--workspace', workspace]);
    expect(f.calls.some(args => args[0] === 'clear-status' && args[1] === 'codex')).toBe(false);
    const stored = await readFile(join(f.stateDir, 'usage-cache.json'), 'utf8');
    expect(stored).not.toContain('secret-launch-arg');
    expect(stored).not.toContain(f.transcript);
    expect((await stat(join(f.stateDir, 'usage-cache.json'))).mode & 0o777).toBe(0o600);
  });

  it('increments cached state across appends and defers partial JSON until its newline arrives', async () => {
    const f = await fixture();
    await refreshCodexCostSidebar(f.options);
    await appendFile(f.transcript, tokens(2_000, 0, 200));
    expect((await refreshCodexCostSidebar(f.options)).statuses[0]?.label).toBe('Codex surface:9 · $0.02 est');
    await appendFile(f.transcript, '\n');
    expect((await refreshCodexCostSidebar(f.options)).statuses[0]?.label).toBe('Codex surface:9 · $0.03 est');
    const state = JSON.parse(await readFile(join(f.stateDir, 'usage-cache.json'), 'utf8'));
    expect(state.sessions[`${surface}:${session}`].checkpoint.estimatedEvents).toBe(2);
    await refreshCodexCostSidebar(f.options);
    expect(JSON.parse(await readFile(join(f.stateDir, 'usage-cache.json'), 'utf8')).sessions[`${surface}:${session}`].checkpoint.estimatedEvents).toBe(2);
  });

  it('selects the newest session per surface without resurrecting an older running session', async () => {
    const f = await fixture();
    f.rows.push({ ...f.rows[0], session_id: otherSession, updated_at: '2026-09-19T02:00:00Z', stored_pid_exists: false });
    expect((await refreshCodexCostSidebar(f.options)).statuses).toEqual([]);
    expect(f.calls.some(args => args[0] === 'set-status')).toBe(false);
  });

  it('uses current workspace ownership after a surface move and clears the old workspace status', async () => {
    const f = await fixture();
    f.live.id = movedWorkspace;
    f.workspaces.push({ id: workspace, panes: [] });
    f.statusLines.set(workspace, `${currentKey}=old`);
    const report = await refreshCodexCostSidebar(f.options);
    expect(report.statuses[0]?.workspaceId).toBe(movedWorkspace);
    expect(f.calls).toContainEqual(['clear-status', currentKey, '--workspace', workspace]);
  });

  it('never guesses another transcript from a matching cwd or inherited metadata', async () => {
    const f = await fixture();
    f.rows[0]!.transcript_path = join(f.folder, `rollout-${otherSession}.jsonl`);
    await writeFile(String(f.rows[0]!.transcript_path), `${context}\n${tokens(10_000)}\n`);
    const report = await refreshCodexCostSidebar(f.options);
    expect(report.statuses[0]?.label).toBe('Codex surface:9 · cost unavailable');
    expect(report.warnings).toHaveLength(1);
  });

  it('replaces a previously visible cost with unavailable if the transcript disappears', async () => {
    const f = await fixture();
    await refreshCodexCostSidebar(f.options);
    await rm(f.transcript);
    const report = await refreshCodexCostSidebar(f.options);
    expect(report.statuses[0]?.label).toBe('Codex surface:9 · cost unavailable');
  });

  it('resets counters when a transcript is replaced or its cached boundary changes', async () => {
    const f = await fixture();
    await refreshCodexCostSidebar(f.options);
    await rename(f.transcript, `${f.transcript}.old`);
    await writeFile(f.transcript, `${context}\n${tokens(3_000, 0, 300)}\n`);
    expect((await refreshCodexCostSidebar(f.options)).statuses[0]?.label).toBe('Codex surface:9 · $0.05 est');
    await writeFile(f.transcript, `${context}\n${tokens(5_000, 0, 500)}\n`);
    expect((await refreshCodexCostSidebar(f.options)).statuses[0]?.label).toBe('Codex surface:9 · $0.08 est');
  });

  it('marks oversized records partial and never persists their content', async () => {
    const f = await fixture();
    await appendFile(f.transcript, `${JSON.stringify({ type: 'response_item', payload: 'private'.repeat(180_000) })}\n${tokens(2_000, 0, 200)}\n`);
    const report = await refreshCodexCostSidebar(f.options);
    expect(report.statuses[0]?.label).toBe('Codex surface:9 · $0.03 est (partial)');
    expect(await readFile(join(f.stateDir, 'usage-cache.json'), 'utf8')).not.toContain('private');
  });

  it('dry run reads estimates without filesystem or sidebar mutations', async () => {
    const f = await fixture();
    expect((await refreshCodexCostSidebar({ ...f.options, dryRun: true })).statuses).toHaveLength(1);
    expect(f.calls.every(args => args[0] === '--json')).toBe(true);
    await expect(stat(f.stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('clears owned estimates on uninstall without touching the existing Codex status', async () => {
    const f = await fixture();
    f.statusLines.set(workspace, `${currentKey}=cost\ncodex=Idle`);
    const report = await refreshCodexCostSidebar({ ...f.options, clear: true });
    expect(report.statuses).toEqual([]);
    expect(f.calls).toContainEqual(['clear-status', currentKey, '--workspace', workspace]);
    expect(f.calls.some(args => args[0] === 'set-status')).toBe(false);
  });

  it('reports only sanitized warnings when cmux commands fail with sensitive output', async () => {
    const f = await fixture();
    const report = await refreshCodexCostSidebar({ ...f.options, runCmux: async () => { throw new Error('sensitive secret'); } });
    expect(report.statuses).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('sensitive secret');
  });

  it('clears stale costs when session inventory is malformed', async () => {
    const f = await fixture();
    f.statusLines.set(workspace, `${currentKey}=cost`);
    const report = await refreshCodexCostSidebar({ ...f.options, runCmux: args => args.includes('sessions') ? Promise.resolve('null') : f.runCmux(args) });
    expect(report.statuses).toEqual([]);
    expect(f.calls).toContainEqual(['clear-status', currentKey, '--workspace', workspace]);
    expect(report.warnings).toHaveLength(1);
  });

  it('does not race another refresh with an active lock', async () => {
    const f = await fixture();
    await mkdir(f.stateDir);
    await writeFile(join(f.stateDir, 'refresh.lock'), String(process.pid));
    const report = await refreshCodexCostSidebar(f.options);
    expect(report.warnings).toEqual(['A cost refresh is already running.']);
    expect(f.calls).toEqual([]);
  });

  it('invalidates cached prices when the rate card date changes', async () => {
    const f = await fixture();
    await refreshCodexCostSidebar(f.options);
    const path = join(f.stateDir, 'usage-cache.json');
    const cache = JSON.parse(await readFile(path, 'utf8'));
    cache.ratesAsOf = '2000-01-01';
    cache.sessions[`${surface}:${session}`].checkpoint.estimatedCost = 50;
    await writeFile(path, JSON.stringify(cache));
    expect((await refreshCodexCostSidebar(f.options)).statuses[0]?.label).toBe('Codex surface:9 · $0.02 est');
  });
});
