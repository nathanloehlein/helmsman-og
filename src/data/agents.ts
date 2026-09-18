import { RUN_LOG_LINE_LIMIT } from '../logic/runLog';

export interface LaunchResult {
  runId: string;
}

export interface LaunchRunBody {
  ticketId?: string;
  title?: string;
  repo: string;
  task?: string;
  mode?: 'ticket' | 'freeform' | 'rerun' | 'review';
  prNumber?: number;
  feedback?: string;
  model?: string;
  effort?: string;
}

export async function launchRun(body: LaunchRunBody): Promise<LaunchResult> {
  const res: Response = await fetch('/api/agents/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`launch ${res.status}`);
  return res.json() as Promise<LaunchResult>;
}

export async function launchAgent(ticketId: string, title: string, repo: string): Promise<LaunchResult> {
  return launchRun({ ticketId, title, repo, mode: 'ticket' });
}

export interface RunEvent {
  id: number;
  runId: string;
  ts: string;
  kind: string;
  text: string;
}

export interface RunStatusSummary {
  status: string;
  prNumber: number | null;
  repo: string;
  ticketId?: string;
}

export interface RunSummary {
  id: string;
  ticketId: string;
  repo: string;
  status: string;
  attempt: number;
  prNumber: number | null;
  startedAt: string;
  costUsd: number | null;
  reviewOutcome?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  reviewVerdict?: string;
}

export interface AgentCaps {
  maxAttempts: number;
  maxCostUsd: number | null;
}

const DEFAULT_CAPS: AgentCaps = { maxAttempts: 1, maxCostUsd: null };

interface AgentsListResponse {
  runs: RunSummary[];
  autoClaim?: string[];
  caps?: AgentCaps;
}

export async function getRun(runId: string): Promise<RunStatusSummary | null> {
  if (typeof runId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(runId)) return null;
  try {
    const res: Response = await fetch(`/api/agents/${encodeURIComponent(runId)}`);
    if (!res.ok) return null;
    const run = (await res.json()) as Partial<RunSummary> | null;
    if (!run || run.id !== runId || typeof run.status !== 'string' || typeof run.repo !== 'string') return null;
    const prNumber = typeof run.prNumber === 'number' && Number.isSafeInteger(run.prNumber) && run.prNumber > 0 ? run.prNumber : null;
    return {
      status: run.status,
      prNumber,
      repo: run.repo,
      ...(typeof run.ticketId === 'string' ? { ticketId: run.ticketId } : {}),
    };
  } catch {
    return null;
  }
}

export async function fetchAgents(): Promise<{ runs: RunSummary[]; autoClaim: string[]; caps: AgentCaps }> {
  try {
    const res: Response = await fetch('/api/agents');
    if (!res.ok) return { runs: [], autoClaim: [], caps: DEFAULT_CAPS };
    const payload: AgentsListResponse = (await res.json()) as AgentsListResponse;
    return { runs: payload.runs ?? [], autoClaim: payload.autoClaim ?? [], caps: payload.caps ?? DEFAULT_CAPS };
  } catch {
    return { runs: [], autoClaim: [], caps: DEFAULT_CAPS };
  }
}

export async function stopAgent(runId: string): Promise<void> {
  try {
    await fetch(`/api/agents/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
  } catch {
    return;
  }
}

export async function setAutoClaim(repo: string, enabled: boolean): Promise<void> {
  try {
    await fetch(`/api/repos/${encodeURIComponent(repo)}/auto-claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
  } catch {
    return;
  }
}

export function openRunStream(runId: string, onEvent: (e: RunEvent) => void): () => void {
  if (typeof runId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(runId)) return () => {};
  const src: EventSource = new EventSource(`/api/agents/${encodeURIComponent(runId)}/log`);
  let closed = false;
  const close = (): void => { closed = true; src.close(); };
  src.onmessage = (m: MessageEvent<string>): void => {
    if (closed) return;
    let event: Partial<RunEvent> | null;
    try { event = JSON.parse(m.data) as Partial<RunEvent> | null; } catch { return; }
    if (!event || typeof event.kind !== 'string' || !/^[a-z][a-z\d_-]*$/i.test(event.kind) || typeof event.text !== 'string'
      || event.runId !== undefined && event.runId !== runId) return;
    const normalized: RunEvent = {
      id: typeof event.id === 'number' && Number.isSafeInteger(event.id) ? event.id : 0,
      runId,
      ts: typeof event.ts === 'string' ? event.ts : new Date().toISOString(),
      kind: event.kind,
      text: event.text.length > RUN_LOG_LINE_LIMIT ? `${event.text.slice(0, RUN_LOG_LINE_LIMIT)}… [full entry in downloaded log]` : event.text,
    };
    if (event.kind === 'run-complete') close();
    onEvent(normalized);
  };
  return close;
}
