import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

export type FixedWorkflowId = 'coding' | 'review';

export interface SkillDeclaration {
  name: string;
  contentHash: string;
}

export interface WorkflowDefinition {
  id: FixedWorkflowId;
  version: number;
  promptRevision: string;
  prompt: string;
}

export interface WorkflowSnapshotInput {
  workflowId: FixedWorkflowId;
  version?: number;
  model?: string;
  effort?: string;
  promptCodeHash: string;
  reviewSettings?: Record<string, unknown>;
  skills: readonly SkillDeclaration[];
}

export interface WorkflowSnapshot extends WorkflowSnapshotInput {
  id: string;
  definition: WorkflowDefinition;
  createdAt: string;
  contentHash: string;
}

export interface WorkflowStore {
  seedFixedWorkflows(): void;
  createSnapshot(input: WorkflowSnapshotInput): WorkflowSnapshot;
  resolveSnapshot(id: string): WorkflowSnapshot | null;
  getDefinition(id: FixedWorkflowId, version?: number): WorkflowDefinition | null;
  close(): void;
}

const FIXED: readonly WorkflowDefinition[] = [
  { id: 'coding', version: 1, promptRevision: 'helmsman-coding-v1', prompt: 'Helmsman fixed coding workflow.' },
  { id: 'review', version: 1, promptRevision: 'helmsman-review-v1', prompt: 'Helmsman fixed review workflow.' },
];

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

function validSkill(skill: SkillDeclaration): boolean {
  return typeof skill?.name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(skill.name)
    && typeof skill.contentHash === 'string' && /^[a-f\d]{64}$/i.test(skill.contentHash);
}

function validate(input: WorkflowSnapshotInput): void {
  if (!input || !['coding', 'review'].includes(input.workflowId) || (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 1))
    || (input.model !== undefined && (!input.model || input.model.length > 128))
    || (input.effort !== undefined && (!input.effort || input.effort.length > 64)) || !/^[a-f\d]{64}$/i.test(input.promptCodeHash)
    || !Array.isArray(input.skills) || input.skills.some(skill => !validSkill(skill))
    || new Set(input.skills.map(skill => skill.name)).size !== input.skills.length) throw new Error('Invalid immutable workflow snapshot');
}

function row(value: unknown): WorkflowSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { json?: string };
  try { return record.json ? JSON.parse(record.json) as WorkflowSnapshot : null; } catch { return null; }
}

export function openWorkflowStore(path: string, now: () => string = () => new Date().toISOString()): WorkflowStore {
  const sql = new Database(path);
  sql.pragma('journal_mode = WAL');
  sql.exec(`CREATE TABLE IF NOT EXISTS workflow_definitions (id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, contentHash TEXT NOT NULL, PRIMARY KEY (id, version));
    CREATE TABLE IF NOT EXISTS workflow_snapshots (id TEXT PRIMARY KEY, json TEXT NOT NULL, contentHash TEXT NOT NULL, createdAt TEXT NOT NULL);`);
  const getDefinition = (id: FixedWorkflowId, version?: number): WorkflowDefinition | null => {
    const result = version === undefined
      ? sql.prepare('SELECT json FROM workflow_definitions WHERE id = ? ORDER BY version DESC LIMIT 1').get(id)
      : sql.prepare('SELECT json FROM workflow_definitions WHERE id = ? AND version = ?').get(id, version);
    const parsed = row(result) as unknown as WorkflowDefinition | null;
    return parsed?.id === id && Number.isSafeInteger(parsed.version) ? parsed : null;
  };
  const seedFixedWorkflows = () => {
    for (const definition of FIXED) {
      const contentHash = hash(definition);
      const existing = sql.prepare('SELECT contentHash FROM workflow_definitions WHERE id = ? AND version = ?').get(definition.id, definition.version) as { contentHash: string } | undefined;
      if (existing && existing.contentHash !== contentHash) throw new Error(`Workflow definition ${definition.id}@${definition.version} changed`);
      if (!existing) sql.prepare('INSERT INTO workflow_definitions (id, version, json, contentHash) VALUES (?, ?, ?, ?)')
        .run(definition.id, definition.version, JSON.stringify(definition), contentHash);
    }
  };
  seedFixedWorkflows();
  return {
    seedFixedWorkflows,
    getDefinition,
    createSnapshot(input) {
      validate(input);
      const definition = getDefinition(input.workflowId, input.version);
      if (!definition) throw new Error('Requested fixed workflow version is unavailable');
      const stableInput = { workflowId: input.workflowId, version: definition.version, model: input.model, effort: input.effort, promptCodeHash: input.promptCodeHash,
        reviewSettings: input.reviewSettings ?? {}, skills: [...input.skills].sort((a, b) => a.name.localeCompare(b.name)) };
      const contentHash = hash({ definition, ...stableInput });
      const snapshot: WorkflowSnapshot = { id: contentHash, ...stableInput, definition, createdAt: now(), contentHash };
      const existing = row(sql.prepare('SELECT json FROM workflow_snapshots WHERE id = ?').get(snapshot.id));
      if (existing) return existing;
      sql.prepare('INSERT INTO workflow_snapshots (id, json, contentHash, createdAt) VALUES (?, ?, ?, ?)')
        .run(snapshot.id, JSON.stringify(snapshot), snapshot.contentHash, snapshot.createdAt);
      return snapshot;
    },
    resolveSnapshot(id) {
      if (typeof id !== 'string' || !/^[a-f\d]{64}$/i.test(id)) return null;
      const snapshot = row(sql.prepare('SELECT json FROM workflow_snapshots WHERE id = ?').get(id));
      return snapshot?.id === id && snapshot.contentHash === id ? snapshot : null;
    },
    close() { sql.close(); },
  };
}
