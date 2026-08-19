export interface LaunchResult {
  runId: string;
}

export async function launchAgent(ticketId: string, title: string, repo: string): Promise<LaunchResult> {
  const res: Response = await fetch('/api/agents/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticketId, title, repo }),
  });
  if (!res.ok) throw new Error(`launch ${res.status}`);
  return res.json() as Promise<LaunchResult>;
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
}

interface AgentsListResponse {
  runs: RunSummary[];
  autoClaim?: string[];
}

export async function getRun(runId: string): Promise<RunStatusSummary | null> {
  try {
    const res: Response = await fetch('/api/agents');
    if (!res.ok) return null;
    const payload: AgentsListResponse = (await res.json()) as AgentsListResponse;
    const row: RunSummary | undefined = payload.runs.find((r) => r.id === runId);
    if (!row) return null;
    return { status: row.status, prNumber: row.prNumber, repo: row.repo };
  } catch {
    return null;
  }
}

export async function fetchAgents(): Promise<{ runs: RunSummary[]; autoClaim: string[] }> {
  try {
    const res: Response = await fetch('/api/agents');
    if (!res.ok) return { runs: [], autoClaim: [] };
    const payload: AgentsListResponse = (await res.json()) as AgentsListResponse;
    return { runs: payload.runs ?? [], autoClaim: payload.autoClaim ?? [] };
  } catch {
    return { runs: [], autoClaim: [] };
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
  const src: EventSource = new EventSource(`/api/agents/${encodeURIComponent(runId)}/log`);
  src.onmessage = (m: MessageEvent<string>): void => {
    const event: RunEvent = JSON.parse(m.data) as RunEvent;
    onEvent(event);
    if (event.kind === 'run-complete') src.close();
  };
  return (): void => src.close();
}
