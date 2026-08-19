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

export interface RunSummary {
  status: string;
  prNumber: number | null;
  repo: string;
}

interface AgentsListResponse {
  runs: Array<{ id: string; status: string; prNumber: number | null; repo: string }>;
}

export async function getRun(runId: string): Promise<RunSummary | null> {
  try {
    const res: Response = await fetch('/api/agents');
    if (!res.ok) return null;
    const payload: AgentsListResponse = (await res.json()) as AgentsListResponse;
    const row: AgentsListResponse['runs'][number] | undefined = payload.runs.find((r) => r.id === runId);
    if (!row) return null;
    return { status: row.status, prNumber: row.prNumber, repo: row.repo };
  } catch {
    return null;
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
