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

export function openRunStream(runId: string, onEvent: (e: RunEvent) => void): () => void {
  const src: EventSource = new EventSource(`/api/agents/${encodeURIComponent(runId)}/log`);
  src.onmessage = (m: MessageEvent<string>): void => {
    const event: RunEvent = JSON.parse(m.data) as RunEvent;
    onEvent(event);
    if (event.kind === 'result' || event.kind === 'error') src.close();
  };
  return (): void => src.close();
}
