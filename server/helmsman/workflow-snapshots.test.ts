import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openWorkflowStore } from './workflow-snapshots';

const roots: string[] = [];
function store() {
  const root = mkdtempSync(join(tmpdir(), 'helmsman-workflows-'));
  roots.push(root);
  return openWorkflowStore(join(root, 'workflows.db'), () => '2026-09-18T00:00:00.000Z');
}
const skill = { name: 'review-agent', contentHash: 'a'.repeat(64) };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('workflow snapshots', () => {
  it('seeds only fixed coding and review workflows and snapshots canonical execution content', () => {
    const workflows = store();
    expect(workflows.getDefinition('coding')).toMatchObject({ version: 1, promptRevision: 'helmsman-coding-v1' });
    const snapshot = workflows.createSnapshot({ workflowId: 'review', model: 'gpt-6-astra', effort: 'high', promptCodeHash: 'b'.repeat(64), reviewSettings: { maxRounds: 3, reviewerCount: 2 }, skills: [skill] });
    expect(snapshot).toMatchObject({ id: snapshot.contentHash, workflowId: 'review', version: 1, definition: { promptRevision: 'helmsman-review-v1' }, skills: [skill] });
    expect(workflows.resolveSnapshot(snapshot.id)).toEqual(snapshot);
    workflows.close();
  });

  it('deduplicates equivalent snapshots and separates immutable changes', () => {
    const workflows = store();
    const input = { workflowId: 'coding' as const, promptCodeHash: 'b'.repeat(64), skills: [skill] };
    const first = workflows.createSnapshot({ ...input, reviewSettings: { b: 2, a: 1 } });
    const same = workflows.createSnapshot({ ...input, reviewSettings: { a: 1, b: 2 } });
    const changed = workflows.createSnapshot({ ...input, reviewSettings: { a: 2, b: 2 } });
    expect(same.id).toBe(first.id);
    expect(changed.id).not.toBe(first.id);
    workflows.close();
  });

  it('rejects unknown versions, duplicate skills, and invalid snapshot lookup', () => {
    const workflows = store();
    expect(() => workflows.createSnapshot({ workflowId: 'review', version: 2, promptCodeHash: 'b'.repeat(64), skills: [] })).toThrow('unavailable');
    expect(() => workflows.createSnapshot({ workflowId: 'review', promptCodeHash: 'b'.repeat(64), skills: [skill, skill] })).toThrow('Invalid');
    expect(workflows.resolveSnapshot('../bad')).toBeNull();
    workflows.close();
  });
});
