import type { Clarification, ClarificationOwner, TrustedContact } from './clarifications';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { ...init, signal: AbortSignal.timeout(10_000) });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof record(body)?.error === 'string' ? record(body)!.error as string : `Request failed (${response.status}).`);
  const result = record(body);
  if (!result) throw new Error('Invalid server response.');
  return result;
}

export async function fetchClarifications(repo: string | null): Promise<Clarification[]> {
  const query = new URLSearchParams();
  if (repo) query.set('repo', repo);
  const body = await request(`/api/clarifications${query.size ? `?${query}` : ''}`);
  return Array.isArray(body.clarifications) ? body.clarifications as Clarification[] : [];
}

export async function answerClarification(id: string, repo: string | null, answer: string): Promise<Clarification> {
  const query = new URLSearchParams();
  if (repo) query.set('repo', repo);
  const body = await request(`/api/clarifications/${encodeURIComponent(id)}/answer${query.size ? `?${query}` : ''}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }),
  });
  return (body.clarification ?? body) as Clarification;
}

export async function createClarification(input: { runId: string; id: string; prompt: string; required: boolean; owner: ClarificationOwner; timeoutAt?: string }): Promise<Clarification> {
  const body = await request('/api/clarifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  return (body.clarification ?? body) as Clarification;
}

export async function fetchTrustedContacts(): Promise<TrustedContact[]> {
  const body = await request('/api/trusted-contacts');
  return Array.isArray(body.contacts) ? body.contacts as TrustedContact[] : [];
}

export async function saveTrustedContact(input: Partial<TrustedContact> & Pick<TrustedContact, 'name' | 'address'>): Promise<TrustedContact> {
  const body = await request('/api/trusted-contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  return (body.contact ?? body) as TrustedContact;
}
