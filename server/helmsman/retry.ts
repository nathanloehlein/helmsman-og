import type { RunRow } from './db';
import { isGithubRepo } from '../pr-lists';
import { validModel, validEffort } from '../../src/logic/agentOptions';

export interface LaunchIntent {
  repo: string;
  mode?: string;
  todoId?: string;
  ticketId?: string;
  title?: string;
  task?: string;
  prNumber?: number;
  feedback?: string;
  model?: string;
  effort?: string;
  adapter?: 'codex' | 'claude-code' | 'command';
}

export class RetryError extends Error {}

function parsedRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function launchIntentJson(body: LaunchIntent): string {
  return JSON.stringify(Object.fromEntries(['repo', 'mode', 'todoId', 'ticketId', 'title', 'task', 'prNumber', 'feedback', 'model', 'effort', 'adapter']
    .flatMap(key => body[key as keyof LaunchIntent] === undefined ? [] : [[key, body[key as keyof LaunchIntent]]])));
}

export function retryIntent(row: RunRow): LaunchIntent {
  if (row.status !== 'failed') throw new RetryError('Only failed voyages can be retried.');
  if (!isGithubRepo(row.repo)) throw new RetryError('The original repository is invalid. Start a new voyage with a valid repository.');
  const saved = parsedRecord(row.launchJson);
  const task = parsedRecord(row.taskJson);
  if (row.launchJson && !saved || row.taskJson && !task && !saved) {
    throw new RetryError('The original voyage metadata is unreadable. Start a new voyage with its requirements.');
  }
  const source = saved ?? task;
  if (source?.repo !== undefined && source.repo !== row.repo) throw new RetryError('The saved repository does not match this voyage. Start a new voyage.');
  const adapter = row.adapter.replace(/^pre-pr:/, '');
  if (adapter !== 'codex' && adapter !== 'claude-code' && adapter !== 'command') throw new RetryError('The original agent provider is unavailable. Start a new voyage with a configured provider.');
  const model = validModel(typeof task?.model === 'string' ? task.model : typeof source?.model === 'string' ? source.model : null);
  const rawEffort = typeof task?.effort === 'string' ? task.effort : typeof source?.effort === 'string' ? source.effort : null;
  const effort = rawEffort === 'minimal' ? rawEffort : validEffort(rawEffort);
  const base: LaunchIntent = { repo: row.repo, adapter, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  const mode = saved?.mode;
  const todoId = source?.todoId;
  if (mode === 'todo' || typeof todoId === 'string') {
    if (typeof todoId !== 'string' || !/^TODO-[1-9]\d*$/.test(todoId)) throw new RetryError('The original todo is missing. Start a voyage from Todos.');
    return { ...base, mode: 'todo', todoId };
  }
  if (mode === 'review' || !saved && (task?.review === true || row.ticketId === 'review')) {
    const prNumber = source?.prNumber ?? row.prNumber;
    if (!positive(prNumber)) throw new RetryError('The original PR number is missing. Start a new PR review.');
    return { ...base, mode: 'review', prNumber };
  }
  if (mode === 'rerun' || !saved && (task?.prBranch || row.ticketId === 'rerun')) {
    const prNumber = source?.prNumber ?? row.prNumber;
    const feedback = saved ? saved.feedback ?? '' : task?.task;
    if (!positive(prNumber) || typeof feedback !== 'string') throw new RetryError('The original PR feedback is missing. Start a new PR update with the requested feedback.');
    return { ...base, mode: 'rerun', prNumber, feedback };
  }
  if (mode === 'freeform' || typeof source?.task === 'string' && source.task.trim()) {
    if (typeof source?.task !== 'string' || !source.task.trim()) throw new RetryError('The original freeform requirements are missing. Start a new voyage with the task description.');
    return { ...base, mode: 'freeform', task: source.task };
  }
  const ticketId = source?.ticketId ?? row.ticketId;
  if ((mode === undefined || mode === 'ticket') && typeof ticketId === 'string' && /^(?!TODO-)[a-z][a-z\d_]*-[1-9]\d*$/i.test(ticketId)) {
    return { ...base, mode: 'ticket', ticketId };
  }
  throw new RetryError('The original voyage requirements are missing. Start a new voyage with the task description.');
}
