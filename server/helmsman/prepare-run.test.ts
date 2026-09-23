import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareExecution } from './prepare-run';
import { openWorkflowStore } from './workflow-snapshots';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'helmsman-prepare-')); roots.push(root);
  const skills = join(root, 'skills'); await mkdir(join(skills, 'review-agent'), { recursive: true }); await writeFile(join(skills, 'review-agent', 'SKILL.md'), '# review');
  return { root, skills, task: { ticketId: 'T-1', title: 'task', repo: 'o/r', jiraBaseUrl: '' }, settings: { reviewerCount: 2, maxRounds: 3, stageTimeoutMinutes: 45 } };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('prepare execution', () => {
  it('preflights required review skills, pins a snapshot, and provisions a private runtime', async () => {
    const f = await fixture();
    const result = await prepareExecution({ runId: 'run_1', runsDir: join(f.root, 'runs'), workflowDbPath: join(f.root, 'workflow.db'), task: f.task, workflow: 'review', reviewSettings: f.settings, skills: ['review-agent'], skillsRoots: [f.skills] });
    expect(result.task).toMatchObject({ workflowSnapshotId: result.snapshotId, skillsPath: join(f.root, 'runs', 'run_1.runtime'), promptRevision: 'helmsman-review-v1' });
    expect(result.skills).toHaveLength(1);
  });
  it('fails before launch when a required review skill is missing', async () => {
    const f = await fixture();
    await expect(prepareExecution({ runId: 'run_1', runsDir: join(f.root, 'runs'), workflowDbPath: join(f.root, 'workflow.db'), task: f.task, workflow: 'review', reviewSettings: f.settings, skills: ['review-agent'], skillsRoots: [] })).rejects.toThrow('Required skill review-agent');
  });
  it('reuses a saved snapshot and its frozen choices on retry', async () => {
    const f = await fixture();
    const initial = await prepareExecution({ runId: 'run_1', runsDir: join(f.root, 'runs'), workflowDbPath: join(f.root, 'workflow.db'), task: f.task, workflow: 'review', reviewSettings: f.settings, model: 'gpt-6-astra', effort: 'high', skills: ['review-agent'], skillsRoots: [f.skills] });
    const retry = await prepareExecution({ runId: 'run_1', runsDir: join(f.root, 'runs'), workflowDbPath: join(f.root, 'workflow.db'), task: initial.task, workflow: 'review', reviewSettings: { ...f.settings, maxRounds: 1 }, model: 'other', effort: 'low', skillsRoots: [f.skills] });
    expect(retry).toMatchObject({ snapshotId: initial.snapshotId, model: 'gpt-6-astra', effort: 'high', reviewSettings: f.settings });
  });
  it('pins known Codex defaults and retains them when retry preferences change', async () => {
    const f = await fixture();
    const base = { runId: 'run_1', runsDir: join(f.root, 'runs'), workflowDbPath: join(f.root, 'workflow.db'), task: f.task, workflow: 'coding' as const, provider: 'codex' as const, reviewSettings: f.settings, skillsRoots: [f.skills] };
    const initial = await prepareExecution(base);
    expect(initial.task).toMatchObject({ model: 'gpt-6-astra', effort: 'medium' });
    const retry = await prepareExecution({ ...base, task: initial.task, model: 'gpt-5.5', effort: 'high' });
    expect(retry.task).toMatchObject({ model: 'gpt-6-astra', effort: 'medium', workflowSnapshotId: initial.snapshotId });
  });
  it('keeps unreported Claude defaults unknown', async () => {
    const f = await fixture();
    const result = await prepareExecution({ runId: 'run_1', runsDir: join(f.root, 'runs'), workflowDbPath: join(f.root, 'workflow.db'), task: f.task, workflow: 'coding', provider: 'claude-code', reviewSettings: f.settings, skillsRoots: [f.skills] });
    expect(result.task.model).toBeUndefined(); expect(result.task.effort).toBeUndefined();
  });

  it('upgrades only prompt code on explicit continuation while preserving old snapshots and frozen choices', async () => {
    const f = await fixture();
    const store = openWorkflowStore(join(f.root, 'workflow.db'));
    try {
      const input = { runId: 'run_1', runsDir: join(f.root, 'runs'), workflowDbPath: join(f.root, 'workflow.db'), task: f.task,
        workflow: 'coding' as const, reviewSettings: f.settings, model: 'gpt-5.6-sol', effort: 'high', skillsRoots: [f.skills], store };
      const current = await prepareExecution(input);
      const snapshot = store.resolveSnapshot(current.snapshotId)!;
      const old = store.createSnapshot({ ...snapshot, promptCodeHash: 'a'.repeat(64) });
      const task = { ...current.task, workflowSnapshotId: old.id };
      await expect(prepareExecution({ ...input, task })).rejects.toThrow('Prompt implementation does not match');
      const upgraded = await prepareExecution({ ...input, task, model: 'other', effort: 'low', reviewSettings: { ...f.settings, maxRounds: 1 }, allowPromptUpgrade: true });
      expect(upgraded).toMatchObject({ snapshotId: current.snapshotId, model: old.model, effort: old.effort, reviewSettings: f.settings });
      expect(upgraded.snapshotId).not.toBe(old.id);
      expect(store.resolveSnapshot(upgraded.snapshotId)).toMatchObject({ workflowId: old.workflowId, version: old.version, definition: old.definition, skills: old.skills });
      expect(store.resolveSnapshot(old.id)).toEqual(old);
      const retry = await prepareExecution({ ...input, task: upgraded.task });
      expect(retry.snapshotId).toBe(upgraded.snapshotId);
    } finally { store.close(); }
  });

  it.each(['source', 'provisioned'] as const)('rejects %s skill drift even during explicit prompt upgrades', async target => {
    const f = await fixture();
    const store = openWorkflowStore(join(f.root, 'workflow.db'));
    try {
      const input = { runId: 'run_1', runsDir: join(f.root, 'runs'), workflowDbPath: join(f.root, 'workflow.db'), task: f.task,
        workflow: 'coding' as const, reviewSettings: f.settings, skillsRoots: [f.skills], store };
      const current = await prepareExecution(input);
      const old = store.createSnapshot({ ...store.resolveSnapshot(current.snapshotId)!, promptCodeHash: 'a'.repeat(64) });
      const source = target === 'source' ? f.skills : join(current.task.skillsPath, 'skills');
      await writeFile(join(source, 'review-agent', 'SKILL.md'), '# changed');
      await expect(prepareExecution({ ...input, task: { ...current.task, workflowSnapshotId: old.id }, allowPromptUpgrade: true }))
        .rejects.toThrow(target === 'source' ? 'Required skills do not match' : 'Provisioned skill review-agent no longer matches');
      expect(store.resolveSnapshot(old.id)).toEqual(old);
    } finally { store.close(); }
  });

});
