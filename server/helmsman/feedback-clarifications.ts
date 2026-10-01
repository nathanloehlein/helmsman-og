import type { AgentTask } from './agents/adapter';
import { CLARIFICATION_OWNERS, CLARIFICATION_STATES } from '../../src/data/clarifications';
import { MAX_CLARIFICATIONS_PER_RUN } from './clarifications';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4000;
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

export async function readFeedbackClarifications(task: AgentTask, runId: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (task.clarification === undefined) return '';
  const raw = task.clarification?.gateUrl;
  if (typeof raw !== 'string' || raw.length > 1024) throw new Error('Feedback clarification gate is unavailable.');
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('Feedback clarification gate URL is invalid.'); }
  if (!/^[a-z\d_-]{1,128}$/i.test(runId) || url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== `/api/runs/${runId}/clarification-gate`
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Feedback clarification gate must match this local voyage.');
  }
  try {
    const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`gate returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || body.ready !== true) throw new Error('required clarification has not been answered');
    if (!Array.isArray(body.clarifications) || body.clarifications.length > MAX_CLARIFICATIONS_PER_RUN) {
      throw new Error('invalid clarification records');
    }
    const ids = new Set<string>();
    const answered: { id: string; question: string; answer: string; owner: string; answeredAt: string; required: boolean }[] = [];
    for (const item of body.clarifications as unknown[]) {
      if (!isRecord(item) || typeof item.id !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(item.id)
        || ids.has(item.id) || item.runId !== runId || typeof item.repo !== 'string'
        || item.repo.toLowerCase() !== task.repo.toLowerCase() || !validText(item.question)
        || typeof item.required !== 'boolean' || typeof item.owner !== 'string'
        || !CLARIFICATION_OWNERS.some(owner => owner === item.owner)
        || typeof item.state !== 'string' || !CLARIFICATION_STATES.some(state => state === item.state)
        || !validTime(item.createdAt) || !(item.timeoutAt === null || validTime(item.timeoutAt))
        || !(item.contactId === null || typeof item.contactId === 'string' && /^[a-z\d_-]{1,128}$/i.test(item.contactId))) {
        throw new Error('invalid clarification record or voyage scope');
      }
      ids.add(item.id);
      if (item.state !== 'answered') {
        if (item.required || item.answer !== null || item.answeredAt !== null) throw new Error('unanswered clarification cannot supply decision evidence');
        continue;
      }
      if (!validText(item.answer) || !validTime(item.answeredAt)) throw new Error('invalid clarification answer');
      answered.push({ id: item.id, question: item.question, answer: item.answer, owner: item.owner,
        answeredAt: item.answeredAt, required: item.required });
    }
    answered.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return answered.length ? JSON.stringify(answered, null, 2) : '';
  } catch (error) {
    throw new Error(`Feedback clarification evidence is unavailable: ${error instanceof Error ? error.message : 'gate unavailable'}`, { cause: error });
  }
}
