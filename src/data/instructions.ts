export interface RunInstruction {
  id: string;
  targetId: string;
  provider: string;
  stage: string;
  text: string;
  status: 'sending' | 'delivered' | 'failed' | 'unknown';
  createdAt: string;
  error?: string;
}

export interface InstructionState {
  available: boolean;
  reason?: string;
  targets: { id: string; provider: string; stage: string }[];
  instructions: RunInstruction[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function instruction(value: unknown): value is RunInstruction {
  const item = record(value);
  return !!item && ['id', 'targetId', 'provider', 'stage', 'text', 'createdAt'].every(key => typeof item[key] === 'string')
    && ['sending', 'delivered', 'failed', 'unknown'].includes(String(item.status))
    && (item.error === undefined || typeof item.error === 'string');
}

async function request(runId: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api/agents/${encodeURIComponent(runId)}/instructions`, { ...init, signal: AbortSignal.timeout(init?.method === 'POST' ? 30_000 : 15_000) });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof record(body)?.error === 'string' ? String(record(body)?.error) : `Request failed (${response.status}).`);
  return body;
}

export async function fetchInstructions(runId: string): Promise<InstructionState> {
  const body = record(await request(runId));
  if (!body || typeof body.available !== 'boolean' || !Array.isArray(body.targets) || !Array.isArray(body.instructions)) throw new Error('Invalid instruction response.');
  return {
    available: body.available,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
    targets: body.targets.filter((value): value is InstructionState['targets'][number] => {
      const target = record(value);
      return !!target && ['id', 'provider', 'stage'].every(key => typeof target[key] === 'string');
    }),
    instructions: body.instructions.filter(instruction),
  };
}

export async function sendInstruction(runId: string, input: { id: string; targetId: string; text: string }): Promise<RunInstruction> {
  const body = await request(runId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!instruction(body)) throw new Error('Invalid instruction response.');
  return body;
}
