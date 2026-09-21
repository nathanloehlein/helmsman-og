import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CampaignConflictError, CampaignValidationError, openCampaignStore, parseCampaignImport, type CampaignStore } from './campaigns';

const roots: string[] = [];
const stores: CampaignStore[] = [];
const now = '2026-09-18T00:00:00.000Z';
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'campaigns-')); roots.push(root);
  const path = join(root, 'runs.sqlite');
  const store = openCampaignStore(path, { now: () => now }); stores.push(store);
  const campaign = store.create({ name: 'Dependency updates', repo: 'org/app', workflowRef: 'coding@v1', concurrency: 2 });
  const phase = store.createPhase(campaign.id, { name: 'Canary' });
  const preview = (content = '{"task":"Update package"}', format = 'jsonl') => store.previewImport({ phaseId: phase.id, format, content });
  return { path, store, campaign, phase, preview };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('campaign intake', () => {
  it('previews without queuing, confirms idempotently and persists across connections', () => {
    const { path, store, campaign, phase, preview } = setup();
    const importPreview = preview();
    expect(store.tasks(phase.id)).toEqual([]);
    const tasks = store.confirmImport(importPreview.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.state).toBe('queued');
    expect(store.confirmImport(importPreview.id)).toEqual(tasks);
    const reopened = openCampaignStore(path); stores.push(reopened);
    expect(reopened.get(campaign.id)).toEqual(campaign);
    expect(reopened.tasks(phase.id)).toEqual(tasks);
    expect(reopened.list('ORG/APP')).toEqual([campaign]);
    expect(reopened.list('org/elsewhere')).toEqual([]);
    expect(preview().duplicateCount).toBe(1);
  });

  it('deduplicates equivalent CSV/JSONL records, duplicate uploads and repeated records across phases', () => {
    const { store, campaign, phase, preview } = setup();
    const csv = preview('task,repo\n"Update package",ORG/APP\n"Update package",org/app', 'csv');
    expect(csv.records).toHaveLength(1);
    expect(csv.duplicateCount).toBe(1);
    store.confirmImport(csv.id);
    const json = preview('{"repo":"org/app","task":"Update package"}');
    expect(json.digest).toBe(csv.digest);
    expect(json.duplicateCount).toBe(1);
    store.confirmImport(json.id);
    const next = store.createPhase(campaign.id, { name: 'Broad rollout' });
    const repeated = store.previewImport({ phaseId: next.id, format: 'jsonl', content: '{"task":"Update package"}' });
    expect(repeated.duplicateCount).toBe(1);
    expect(store.confirmImport(repeated.id)[0]?.phaseId).toBe(phase.id);
    expect(store.tasks(next.id)).toEqual([]);
  });

  it('handles quoted commas/newlines and literal punctuation without executing or interpreting task text', () => {
    const result = parseCampaignImport({ repo: 'org/app', format: 'csv', content: 'task,title\r\n"Fix \"\"quoted\"\", broken\nlabels; $(do-not-run)",UI\r\n' });
    expect(result[0]).toMatchObject({ mode: 'freeform', task: 'Fix "quoted", broken\nlabels; $(do-not-run)', title: 'UI' });
  });

  it('defaults scope to the header galleon and permits explicit configured row overrides', () => {
    expect(parseCampaignImport({ repo: 'org/app', format: 'jsonl', content: '{"ticketId":"abc-2"}' })[0]).toMatchObject({ repo: 'org/app', mode: 'ticket', ticketId: 'ABC-2' });
    expect(() => parseCampaignImport({ repo: 'org/app', format: 'jsonl', content: '{"repo":"org/other","task":"Fix"}' })).toThrow('allowed galleon');
    expect(parseCampaignImport({ repo: 'org/app', allowedRepos: ['org/app', 'Org/Other'], format: 'jsonl', content: '{"repo":"org/other","task":"Fix"}' })[0]?.repo).toBe('Org/Other');
  });

  it.each([null, {}, { format: 'yaml', content: 'a' }, { format: 'jsonl', content: 'null' },
    { format: 'jsonl', content: '{"task":null}' }, { format: 'jsonl', content: '{"task":"x","ticketId":"ABC-1"}' },
    { format: 'jsonl', content: '{"task":"x","model":"unsupported"}' }, { format: 'jsonl', content: '{bad}' },
    { format: 'csv', content: 'task,task\nx,y' }, { format: 'csv', content: 'task\n"unterminated' },
    { format: 'csv', content: 'task,title\nx' }, { format: 'jsonl', content: 'x'.repeat(1_000_001) },
    { format: 'jsonl', content: Array(201).fill('{"task":"x"}').join('\n') },
  ])('rejects invalid/oversized imports %j', input => {
    expect(() => parseCampaignImport(input && typeof input === 'object' ? { repo: 'org/app', ...input } : input)).toThrow(CampaignValidationError);
  });
});

describe('campaign lifecycle and claims', () => {
  it('requires confirmed records, honors phase barriers and prevents changes after completion', () => {
    const { store, campaign, phase, preview } = setup();
    expect(() => store.setPhaseState(phase.id, 'start')).toThrow('Import and confirm');
    const [task] = store.confirmImport(preview().id);
    const second = store.createPhase(campaign.id, { name: 'Second' });
    const secondPreview = store.previewImport({ phaseId: second.id, format: 'jsonl', content: '{"task":"Other work"}' });
    store.confirmImport(secondPreview.id);
    expect(() => store.setPhaseState(second.id, 'start')).toThrow(CampaignConflictError);
    store.setPhaseState(phase.id, 'start');
    expect(() => preview('task\nMore work', 'csv')).toThrow(CampaignConflictError);
    const claim = store.claim(task!.id)!;
    expect(store.markLaunched(claim.id, claim.claimToken!)).toBe(true);
    store.setPhaseState(phase.id, 'finish');
    expect(() => store.setPhaseState(second.id, 'start')).toThrow(CampaignConflictError);
    store.settle(claim.id, claim.runId, 'succeeded');
    expect(store.setPhaseState(second.id, 'start').state).toBe('running');
    expect(() => store.retryTask(claim.id)).toThrow('Only failed');
    expect(() => store.setPhaseState(phase.id, 'resume')).toThrow('already finished');
  });

  it('atomically claims across connections and permits independent writers within the campaign cap', () => {
    const { store, path, phase } = setup();
    const preview = store.previewImport({ phaseId: phase.id, format: 'jsonl', allowedRepos: ['org/app', 'org/b', 'org/c'],
      content: ['{"task":"A"}', '{"task":"B"}', '{"task":"C","repo":"org/b"}', '{"task":"D","repo":"org/c"}'].join('\n') });
    const tasks = store.confirmImport(preview.id);
    store.setPhaseState(phase.id, 'start');
    const second = openCampaignStore(path); stores.push(second);
    const firstClaim = store.claim(tasks[0]!.id)!;
    expect(second.claim(tasks[0]!.id)).toBeNull();
    expect(second.claim(tasks[1]!.id)).not.toBeNull();
    expect(second.claim(tasks[2]!.id)).toBeNull();
    expect(store.claim(tasks[3]!.id)).toBeNull();
    expect(store.releaseClaim(firstClaim.id, 'wrong-token')).toBe(false);
    expect(store.releaseClaim(firstClaim.id, firstClaim.claimToken!)).toBe(true);
    expect(second.claim(tasks[3]!.id)).not.toBeNull();
  });

  it('prevents simultaneous claims for the same ticket across campaigns', () => {
    const { store, phase, preview } = setup();
    const [first] = store.confirmImport(preview('{"ticketId":"T-1"}').id);
    store.setPhaseState(phase.id, 'start');
    const other = store.create({ name: 'Another campaign', repo: 'org/app', workflowRef: 'coding@v1', concurrency: 2 });
    const otherPhase = store.createPhase(other.id, { name: 'Tasks' });
    const otherPreview = store.previewImport({ phaseId: otherPhase.id, format: 'jsonl', content: '{"ticketId":"T-1"}\n{"ticketId":"T-2"}' });
    const tasks = store.confirmImport(otherPreview.id);
    store.setPhaseState(otherPhase.id, 'start');
    expect(store.claim(first!.id)).not.toBeNull();
    expect(store.claim(tasks[0]!.id)).toBeNull();
    expect(store.claim(tasks[1]!.id)).not.toBeNull();
  });

  it('pause retains active work, finish cancels queued and retry changes IDs only for failed tasks', () => {
    const { store, phase, preview } = setup();
    const tasks = store.confirmImport(preview('{"task":"One"}\n{"task":"Two"}').id);
    store.setPhaseState(phase.id, 'start');
    const claimed = store.claim(tasks[0]!.id)!;
    store.markLaunched(claimed.id, claimed.claimToken!);
    store.setPhaseState(phase.id, 'pause');
    expect(store.task(claimed.id)?.state).toBe('running');
    expect(store.claim(tasks[1]!.id)).toBeNull();
    store.settle(claimed.id, claimed.runId, 'failed', 'Build failed');
    const retry = store.retryTask(claimed.id);
    expect(retry.attempt).toBe(2);
    expect(retry.runId).not.toBe(claimed.runId);
    expect(store.settle(claimed.id, claimed.runId, 'succeeded')).toBe(false);
    store.setPhaseState(phase.id, 'finish');
    expect(store.tasks(phase.id).every(item => item.state === 'cancelled')).toBe(true);
  });

  it('completes drained phases and permits an explicit failed-task retry without repeating successful tasks', () => {
    const { store, phase, preview } = setup();
    const [task] = store.confirmImport(preview().id);
    store.setPhaseState(phase.id, 'start');
    const claimed = store.claim(task!.id)!;
    store.settle(claimed.id, claimed.runId, 'failed');
    store.completePhases();
    expect(store.phase(phase.id)?.state).toBe('completed');
    const retry = store.retryTask(task!.id);
    expect(store.phase(phase.id)?.state).toBe('paused');
    store.setPhaseState(phase.id, 'resume');
    const next = store.claim(retry.id)!;
    store.settle(next.id, next.runId, 'succeeded');
    store.completePhases();
    expect(() => store.retryTask(task!.id)).toThrow('Only failed');
  });
});
