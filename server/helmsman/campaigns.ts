import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { isGithubRepo } from '../pr-lists';
import type { Campaign, CampaignPhase, CampaignPhaseState, CampaignPreview, CampaignRecord, CampaignTask, CampaignTaskState } from '../../src/data/campaigns';

export class CampaignValidationError extends Error {}
export class CampaignConflictError extends Error {}
export type PhaseAction = 'start' | 'pause' | 'resume' | 'finish' | 'stop';
export interface CampaignStore {
  create(input: unknown): Campaign;
  get(id: string): Campaign | null;
  list(repo?: string | null): Campaign[];
  createPhase(campaignId: string, input: unknown): CampaignPhase;
  phase(id: string): CampaignPhase | null;
  phases(campaignId: string): CampaignPhase[];
  setPhaseState(phaseId: string, action: PhaseAction): CampaignPhase;
  previewImport(input: unknown): CampaignPreview;
  preview(id: string): CampaignPreview | null;
  confirmImport(previewId: string): CampaignTask[];
  tasks(phaseId: string): CampaignTask[];
  task(id: string): CampaignTask | null;
  retryTask(id: string): CampaignTask;
  queuedTasks(): CampaignTask[];
  activeTasks(): CampaignTask[];
  claim(id: string): CampaignTask | null;
  markLaunched(id: string, claimToken: string): boolean;
  settle(id: string, runId: string, state: 'succeeded' | 'failed' | 'cancelled', error?: string | null): boolean;
  releaseClaim(id: string, claimToken: string, error?: string | null): boolean;
  claimError(id: string, claimToken: string, error: string): void;
  completePhases(): void;
  close(): void;
}

const TERMINAL = ['completed', 'finished', 'stopped'];
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const taskId = (campaignId: string, record: CampaignRecord): string => `ct-${hash([campaignId, record])}`;
const runId = (id: string, attempt: number): string => `${id}-${attempt}`;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CampaignValidationError('Expected an object');
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new CampaignValidationError('Unknown field');
}
function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new CampaignValidationError(`Invalid ${label}`);
  return value.trim();
}
function id(value: unknown): string {
  const valueId = text(value, 'ID', 128);
  if (!/^[a-z\d_-]+$/i.test(valueId)) throw new CampaignValidationError('Invalid ID');
  return valueId;
}
function repo(value: unknown): string {
  const name = text(value, 'galleon', 200);
  if (!isGithubRepo(name)) throw new CampaignValidationError('Galleon must use owner/name');
  return name;
}
function optional(value: unknown, label: string, limit: number): string | null {
  return value === undefined || value === null || value === '' ? null : text(value, label, limit);
}

function parseCsv(content: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closed = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (quoted) {
      if (char === '"' && content[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
      continue;
    }
    if (char === '"') {
      if (field || closed) throw new CampaignValidationError('Malformed CSV quotes');
      quoted = true;
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = ''; closed = false;
      if (char !== ',') {
        if (char === '\r' && content[i + 1] === '\n') i++;
        if (row.some(cell => cell.trim())) rows.push(row);
        row = [];
        if (rows.length > 201) throw new CampaignValidationError('Imports support at most 200 records');
      }
    } else {
      if (closed) throw new CampaignValidationError('Unexpected text after CSV quote');
      field += char;
    }
  }
  if (quoted) throw new CampaignValidationError('Unterminated CSV quote');
  row.push(field);
  if (row.some(cell => cell.trim())) rows.push(row);
  const headers = rows.shift()?.map(header => header.trim()) ?? [];
  if (!headers.length || new Set(headers).size !== headers.length || headers.some(header => !['key', 'repo', 'mode', 'task', 'ticketId', 'title'].includes(header))) {
    throw new CampaignValidationError('CSV requires unique supported headers: key, repo, mode, task, ticketId, title');
  }
  return rows.map(cells => {
    if (cells.length !== headers.length) throw new CampaignValidationError('CSV column count does not match headers');
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
}

export function parseCampaignImport(input: unknown): CampaignRecord[] {
  const value = object(input);
  only(value, ['format', 'content', 'repo', 'allowedRepos']);
  const defaultRepo = repo(value.repo);
  if (typeof value.content !== 'string' || Buffer.byteLength(value.content, 'utf8') > 1_000_000) throw new CampaignValidationError('Import must be text under 1 MB');
  if (value.format !== 'csv' && value.format !== 'jsonl') throw new CampaignValidationError('Use CSV or JSONL');
  let allowed: Map<string, string> | null = null;
  if (value.allowedRepos !== undefined) {
    if (!Array.isArray(value.allowedRepos) || value.allowedRepos.length > 1000) throw new CampaignValidationError('Invalid allowed galleons');
    allowed = new Map(value.allowedRepos.map(item => { const name = repo(item); return [name.toLowerCase(), name]; }));
    if (!allowed.has(defaultRepo.toLowerCase())) throw new CampaignValidationError('Selected galleon is not configured');
  }
  const content = value.content.replace(/^\uFEFF/, '');
  let values: unknown[];
  if (value.format === 'csv') values = parseCsv(content);
  else {
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    if (lines.length > 200) throw new CampaignValidationError('Imports support at most 200 records');
    values = lines.map((line, index) => {
      try { return JSON.parse(line) as unknown; }
      catch { throw new CampaignValidationError(`Invalid JSON on line ${index + 1}`); }
    });
  }
  if (!values.length || values.length > 200) throw new CampaignValidationError('Provide between 1 and 200 records');
  return values.map((item, index) => {
    const row = object(item);
    only(row, ['key', 'repo', 'mode', 'task', 'ticketId', 'title']);
    const requestedRepo = row.repo === undefined || row.repo === '' ? defaultRepo : repo(row.repo);
    const selectedRepo = allowed?.get(requestedRepo.toLowerCase()) ?? (requestedRepo.toLowerCase() === defaultRepo.toLowerCase() ? defaultRepo : requestedRepo);
    if (allowed && !allowed.has(requestedRepo.toLowerCase())) throw new CampaignValidationError(`Record ${index + 1} uses an unconfigured galleon`);
    if (!allowed && selectedRepo.toLowerCase() !== defaultRepo.toLowerCase()) throw new CampaignValidationError('Explicit galleon overrides require an allowed galleon list');
    const task = optional(row.task, 'task', 20000);
    const ticketId = optional(row.ticketId, 'ticket ID', 80)?.toUpperCase() ?? null;
    if (ticketId && !/^[A-Z][A-Z\d_]*-[1-9]\d*$/.test(ticketId)) throw new CampaignValidationError('Invalid ticket ID');
    const mode = row.mode === undefined || row.mode === '' ? ticketId ? 'ticket' : 'freeform' : row.mode;
    if (mode !== 'ticket' && mode !== 'freeform' || mode === 'ticket' && (!ticketId || task) || mode === 'freeform' && (!task || ticketId)) {
      throw new CampaignValidationError(`Record ${index + 1} must specify either a task or a ticket ID`);
    }
    return { key: optional(row.key, 'record key', 200), repo: selectedRepo, mode, task, ticketId, title: optional(row.title, 'title', 240) };
  });
}

export function openCampaignStore(path: string, options: { now?: () => string } = {}): CampaignStore {
  const sql = new Database(path);
  sql.pragma('journal_mode = WAL');
  const now = () => {
    const value = options.now?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(value))) throw new CampaignValidationError('Invalid clock');
    return new Date(value).toISOString();
  };
  sql.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, repo TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS campaign_phases (
      id TEXT PRIMARY KEY, campaignId TEXT NOT NULL, position INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(campaignId, position)
    );
    CREATE TABLE IF NOT EXISTS campaign_previews (id TEXT PRIMARY KEY, campaignId TEXT NOT NULL, phaseId TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS campaign_tasks (
      id TEXT PRIMARY KEY, campaignId TEXT NOT NULL, phaseId TEXT NOT NULL, repo TEXT NOT NULL, state TEXT NOT NULL,
      runId TEXT NOT NULL UNIQUE, claimToken TEXT, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS campaign_tasks_queue ON campaign_tasks(state, campaignId, phaseId);
  `);
  function read<T>(table: string, key: string): T | null {
    const row = sql.prepare(`SELECT payload FROM ${table} WHERE id = ?`).get(id(key)) as { payload: string } | undefined;
    if (!row) return null;
    try { return object(JSON.parse(row.payload)) as T; }
    catch { throw new CampaignValidationError('Stored campaign data is invalid'); }
  }
  function rows<T>(table: string, where = '', params: unknown[] = []): T[] {
    return (sql.prepare(`SELECT payload FROM ${table} ${where}`).all(...params) as { payload: string }[])
      .map(row => object(JSON.parse(row.payload)) as T);
  }
  const get = (key: string) => read<Campaign>('campaigns', key);
  const phase = (key: string) => read<CampaignPhase>('campaign_phases', key);
  const task = (key: string) => read<CampaignTask>('campaign_tasks', key);
  const phases = (key: string) => rows<CampaignPhase>('campaign_phases', 'WHERE campaignId = ? ORDER BY position', [id(key)]);
  const tasks = (key: string) => rows<CampaignTask>('campaign_tasks', 'WHERE phaseId = ? ORDER BY rowid', [id(key)]);
  function saveTask(item: CampaignTask): void {
    sql.prepare('UPDATE campaign_tasks SET state = ?, runId = ?, claimToken = ?, payload = ? WHERE id = ?')
      .run(item.state, item.runId, item.claimToken, JSON.stringify(item), item.id);
  }
  function savePhase(item: CampaignPhase): void {
    sql.prepare('UPDATE campaign_phases SET state = ?, payload = ? WHERE id = ?').run(item.state, JSON.stringify(item), item.id);
  }
  function requiredPhase(key: string): CampaignPhase {
    const current = phase(key);
    if (!current) throw new CampaignValidationError('Phase not found');
    return current;
  }
  const mutable = (current: CampaignPhase) => {
    if (current.state !== 'draft' && current.state !== 'paused') throw new CampaignConflictError('Pause the phase before importing');
  };
  return {
    create(input) {
      const value = object(input);
      only(value, ['name', 'repo', 'workflowRef', 'concurrency']);
      const workflowRef = text(value.workflowRef, 'workflow reference', 200);
      if (!/^[a-z][a-z\d_.-]*@v?[1-9]\d*$/i.test(workflowRef)) throw new CampaignValidationError('Choose a versioned workflow reference');
      if (typeof value.concurrency !== 'number' || !Number.isInteger(value.concurrency) || value.concurrency < 1 || value.concurrency > 20) throw new CampaignValidationError('Concurrency must be 1–20');
      const item: Campaign = { id: `cp-${randomUUID()}`, name: text(value.name, 'campaign name', 120), repo: repo(value.repo), workflowRef, concurrency: value.concurrency, createdAt: now() };
      sql.prepare('INSERT INTO campaigns (id, repo, payload) VALUES (?, ?, ?)').run(item.id, item.repo, JSON.stringify(item));
      return item;
    },
    get,
    list(scope) { return scope == null ? rows<Campaign>('campaigns', 'ORDER BY rowid DESC') : rows<Campaign>('campaigns', 'WHERE repo = ? COLLATE NOCASE ORDER BY rowid DESC', [repo(scope)]); },
    createPhase: sql.transaction((campaignId: string, input: unknown): CampaignPhase => {
      if (!get(campaignId)) throw new CampaignValidationError('Campaign not found');
      const value = object(input); only(value, ['name']);
      const stamp = now();
      const item: CampaignPhase = { id: `ph-${randomUUID()}`, campaignId, name: text(value.name, 'phase name', 120), position: phases(campaignId).length, state: 'draft', createdAt: stamp, updatedAt: stamp };
      sql.prepare('INSERT INTO campaign_phases (id, campaignId, position, state, payload) VALUES (?, ?, ?, ?, ?)').run(item.id, campaignId, item.position, item.state, JSON.stringify(item));
      return item;
    }).immediate,
    phase, phases, tasks, task,
    setPhaseState: sql.transaction((phaseId: string, action: PhaseAction): CampaignPhase => {
      const current = requiredPhase(phaseId);
      const target: Record<PhaseAction, CampaignPhaseState> = { start: 'running', pause: 'paused', resume: 'running', finish: 'finished', stop: 'stopped' };
      if (!Object.hasOwn(target, action)) throw new CampaignValidationError('Invalid phase action');
      if (current.state === target[action]) return current;
      if (TERMINAL.includes(current.state)) throw new CampaignConflictError('Phase is already finished');
      if (action === 'start' && current.state !== 'draft' || action === 'pause' && current.state !== 'running' || action === 'resume' && current.state !== 'paused') throw new CampaignConflictError('Invalid phase transition');
      if ((action === 'start' || action === 'resume') && (phases(current.campaignId).some(other => other.position < current.position && !TERMINAL.includes(other.state))
        || phases(current.campaignId).some(other => other.position < current.position && tasks(other.id).some(item => item.state === 'claiming' || item.state === 'running'))
        || phases(current.campaignId).some(other => other.id !== current.id && other.state === 'running'))) throw new CampaignConflictError('Finish earlier phases before starting this phase');
      if (action === 'start' && tasks(phaseId).length === 0) throw new CampaignConflictError('Import and confirm tasks before starting');
      const stamp = now();
      const updated = { ...current, state: target[action], updatedAt: stamp };
      savePhase(updated);
      if (action === 'finish' || action === 'stop') {
        for (const item of tasks(phaseId)) if (item.state === 'queued') saveTask({ ...item, state: 'cancelled', updatedAt: stamp });
      }
      return updated;
    }).immediate,
    previewImport(input) {
      const value = object(input); only(value, ['phaseId', 'format', 'content', 'repo', 'allowedRepos']);
      const current = requiredPhase(id(value.phaseId)); mutable(current);
      const campaign = get(current.campaignId);
      if (!campaign) throw new CampaignValidationError('Campaign not found');
      const imported = parseCampaignImport({ format: value.format, content: value.content, repo: value.repo ?? campaign.repo, ...(value.allowedRepos !== undefined ? { allowedRepos: value.allowedRepos } : {}) });
      const unique = new Map(imported.map(item => [taskId(campaign.id, item), item]));
      const records = [...unique.values()];
      const digest = hash(records);
      const previewId = `pv-${hash([current.id, digest])}`;
      const existing = read<CampaignPreview>('campaign_previews', previewId);
      if (existing) return { ...existing, duplicateCount: imported.length - records.length + [...unique.keys()].filter(key => task(key)).length };
      const preview: CampaignPreview = { id: previewId, campaignId: campaign.id, phaseId: current.id, digest, records,
        duplicateCount: imported.length - records.length + [...unique.keys()].filter(key => task(key)).length, createdAt: now(), importedAt: null };
      sql.prepare('INSERT OR IGNORE INTO campaign_previews (id, campaignId, phaseId, payload) VALUES (?, ?, ?, ?)').run(preview.id, campaign.id, current.id, JSON.stringify(preview));
      return preview;
    },
    preview: key => read<CampaignPreview>('campaign_previews', key),
    confirmImport: sql.transaction((previewId: string): CampaignTask[] => {
      const preview = read<CampaignPreview>('campaign_previews', previewId);
      if (!preview) throw new CampaignValidationError('Preview not found');
      const current = requiredPhase(preview.phaseId);
      if (!preview.importedAt) mutable(current);
      const stamp = now();
      const result: CampaignTask[] = [];
      for (const record of preview.records) {
        const key = taskId(preview.campaignId, record);
        const existing = task(key);
        if (existing) { result.push(existing); continue; }
        if (preview.importedAt) throw new CampaignConflictError('Previously imported task is missing');
        const item: CampaignTask = { id: key, campaignId: preview.campaignId, phaseId: preview.phaseId, record, state: 'queued', attempt: 1, runId: runId(key, 1), claimToken: null, claimedAt: null, error: null, createdAt: stamp, updatedAt: stamp };
        sql.prepare('INSERT INTO campaign_tasks (id, campaignId, phaseId, repo, state, runId, claimToken, payload) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
          .run(item.id, item.campaignId, item.phaseId, record.repo, item.state, item.runId, JSON.stringify(item));
        result.push(item);
      }
      sql.prepare('UPDATE campaign_previews SET payload = ? WHERE id = ?').run(JSON.stringify({ ...preview, importedAt: preview.importedAt ?? stamp }), preview.id);
      return result;
    }).immediate,
    retryTask: sql.transaction((key: string): CampaignTask => {
      const current = task(key);
      if (!current) throw new CampaignValidationError('Task not found');
      if (current.state !== 'failed') throw new CampaignConflictError('Only failed tasks can be retried');
      const owner = requiredPhase(current.phaseId);
      if (owner.state === 'finished' || owner.state === 'stopped') throw new CampaignConflictError('Finished phases cannot be retried');
      const attempt = current.attempt + 1;
      if (attempt > 100) throw new CampaignConflictError('Task retry limit reached');
      const next = { ...current, attempt, state: 'queued' as const, runId: runId(current.id, attempt), claimToken: null, claimedAt: null, error: null, updatedAt: now() };
      if (owner.state === 'completed') savePhase({ ...owner, state: 'paused', updatedAt: now() });
      saveTask(next);
      return next;
    }).immediate,
    queuedTasks: () => rows<CampaignTask>('campaign_tasks', "WHERE state = 'queued' ORDER BY rowid"),
    activeTasks: () => rows<CampaignTask>('campaign_tasks', "WHERE state IN ('claiming', 'running') ORDER BY rowid"),
    claim: sql.transaction((key: string): CampaignTask | null => {
      const current = task(key);
      if (!current || current.state !== 'queued' || phase(current.phaseId)?.state !== 'running') return null;
      const campaign = get(current.campaignId);
      if (!campaign) return null;
      const active = rows<CampaignTask>('campaign_tasks', "WHERE state IN ('claiming', 'running')");
      if (active.filter(item => item.campaignId === current.campaignId).length >= campaign.concurrency
        || current.record.ticketId && active.some(item => item.record.ticketId?.toLowerCase() === current.record.ticketId?.toLowerCase())) return null;
      const claimed: CampaignTask = { ...current, state: 'claiming', claimToken: randomUUID(), claimedAt: now(), updatedAt: now() };
      saveTask(claimed);
      return claimed;
    }).immediate,
    markLaunched: sql.transaction((key: string, token: string): boolean => {
      const current = task(key);
      if (!current || current.state !== 'claiming' || current.claimToken !== token) return false;
      saveTask({ ...current, state: 'running', updatedAt: now(), error: null }); return true;
    }).immediate,
    settle: sql.transaction((key: string, expectedRunId: string, state: 'succeeded' | 'failed' | 'cancelled', error: string | null = null): boolean => {
      if (!['succeeded', 'failed', 'cancelled'].includes(state)) throw new CampaignValidationError('Invalid task result');
      const current = task(key);
      if (!current || current.runId !== expectedRunId || !['claiming', 'running'].includes(current.state)) return false;
      saveTask({ ...current, state, error: error === null ? null : text(error, 'error', 2000), claimToken: null, claimedAt: null, updatedAt: now() }); return true;
    }).immediate,
    releaseClaim: sql.transaction((key: string, token: string, error: string | null = null): boolean => {
      const current = task(key);
      if (!current || current.state !== 'claiming' || current.claimToken !== token) return false;
      const state: CampaignTaskState = TERMINAL.includes(phase(current.phaseId)?.state ?? '') ? 'cancelled' : 'queued';
      saveTask({ ...current, state, error: error === null ? null : text(error, 'error', 2000), claimToken: null, claimedAt: null, updatedAt: now() }); return true;
    }).immediate,
    claimError: sql.transaction((key: string, token: string, error: string): void => {
      const current = task(key);
      if (current?.state === 'claiming' && current.claimToken === token) saveTask({ ...current, error: text(error, 'error', 2000), updatedAt: now() });
    }).immediate,
    completePhases: sql.transaction(() => {
      for (const current of rows<CampaignPhase>('campaign_phases', "WHERE state = 'running'")) {
        const items = tasks(current.id);
        if (items.length && items.every(item => ['succeeded', 'failed', 'cancelled'].includes(item.state))) savePhase({ ...current, state: 'completed', updatedAt: now() });
      }
    }).immediate,
    close: () => sql.close(),
  };
}
