import { term } from '../logic/terminology';
import { RUN_LOG_LINE_LIMIT } from '../logic/runLog';

export interface LaunchResult {
  runId: string;
}

export interface LaunchRunBody {
  ticketId?: string;
  todoId?: string;
  title?: string;
  repo: string;
  task?: string;
  mode?: 'ticket' | 'freeform' | 'rerun' | 'review' | 'todo';
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
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === 'string' ? body.error : `launch ${res.status}`);
  }
  return res.json() as Promise<LaunchResult>;
}

export async function launchAgent(ticketId: string, title: string, repo: string): Promise<LaunchResult> {
  return launchRun({ ticketId, title, repo, mode: 'ticket' });
}

export async function retryRun(runId: string): Promise<LaunchResult> {
  if (typeof runId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(runId)) throw new Error(term('invalidRunId'));
  const response = await fetch(`/api/agents/${encodeURIComponent(runId)}/retry`, { method: 'POST' });
  const result: unknown = await response.json().catch(() => null);
  const body = result && typeof result === 'object' ? result as Record<string, unknown> : null;
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Retry failed (${response.status}).`);
  if (typeof body?.runId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(body.runId) || body.runId === runId) {
    throw new Error(term('missingRetryRunId'));
  }
  return { runId: body.runId };
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
  reviewOutcome?: RunSummary['reviewOutcome'];
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
      ...(run.status === 'succeeded' && (run.reviewOutcome === 'APPROVE' || run.reviewOutcome === 'REQUEST_CHANGES' || run.reviewOutcome === 'COMMENT')
        ? { reviewOutcome: run.reviewOutcome } : {}),
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
  const response = await fetch(`/api/repos/${encodeURIComponent(repo)}/auto-claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new Error('Unable to update auto-claim.');
}

export type RunStreamState = 'connecting' | 'live' | 'reconnecting' | 'unavailable';

export function openRunStream(runId: string, onEvent: (e: RunEvent) => void, onState?: (state: RunStreamState) => void): () => void {
  if (typeof runId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(runId)) {
    onState?.('unavailable');
    return () => {};
  }
  const delays = [1_000, 2_000, 4_000, 5_000, 5_000];
  let closed = false;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let lastPersistedId = 0;
  let state: RunStreamState | undefined;
  const updateState = (next: RunStreamState): void => {
    if (state === next) return;
    state = next;
    onState?.(next);
  };
  const disconnect = (): void => {
    if (!source) return;
    source.onopen = null;
    source.onerror = null;
    source.onmessage = null;
    source.close();
    source = null;
  };
  const close = (): void => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    disconnect();
  };
  const retry = (): void => {
    if (closed || timer !== null) return;
    disconnect();
    const delay = delays[retries++];
    if (delay === undefined) {
      close();
      updateState('unavailable');
      return;
    }
    updateState('reconnecting');
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  };
  const connect = (): void => {
    if (closed) return;
    let current: EventSource;
    try { current = new EventSource(`/api/agents/${encodeURIComponent(runId)}/log`); }
    catch { retry(); return; }
    source = current;
    const isCurrent = () => !closed && source === current;
    const live = (): void => {
      retries = 0;
      updateState('live');
    };
    current.onopen = (): void => { if (isCurrent()) live(); };
    current.onerror = (): void => {
      if (!isCurrent()) return;
      if (current.readyState === 2) retry();
      else updateState('reconnecting');
    };
    current.onmessage = (m: MessageEvent<string>): void => {
      if (!isCurrent()) return;
      let event: Partial<RunEvent> | null;
      try { event = JSON.parse(m.data) as Partial<RunEvent> | null; } catch { return; }
      if (!event || typeof event.kind !== 'string' || !/^[a-z][a-z\d_-]*$/i.test(event.kind) || typeof event.text !== 'string'
        || event.runId !== undefined && event.runId !== runId) return;
      live();
      const id = typeof event.id === 'number' && Number.isSafeInteger(event.id) && event.id > 0 ? event.id : 0;
      if (id && id <= lastPersistedId) return;
      if (id) lastPersistedId = id;
      const normalized: RunEvent = {
        id,
        runId,
        ts: typeof event.ts === 'string' ? event.ts : new Date().toISOString(),
        kind: event.kind,
        text: event.text.length > RUN_LOG_LINE_LIMIT ? `${event.text.slice(0, RUN_LOG_LINE_LIMIT)}… [full entry in downloaded log]` : event.text,
      };
      if (event.kind === 'run-complete') close();
      onEvent(normalized);
    };
  };
  updateState('connecting');
  connect();
  return close;
}
