import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchInstructions, sendInstruction } from './instructions';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

describe('instruction client', () => {
  it('filters malformed targets and history records without rendering unsafe values', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ available: true, targets: [null, { id: 'one', provider: 'codex', stage: 'review' }], instructions: [null, { id: 'one', status: 'unexpected' }] })));
    await expect(fetchInstructions('run')).resolves.toEqual({ available: true, reason: undefined, targets: [{ id: 'one', provider: 'codex', stage: 'review' }], instructions: [] });
  });

  it('sends a stable request ID and surfaces rejected delivery', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ error: 'The agent has stopped.' }, 409));
    vi.stubGlobal('fetch', fetcher);
    const input = { id: 'instruction-id', targetId: 'target-id', text: 'Review retries' };
    await expect(sendInstruction('run-id', input)).rejects.toThrow('The agent has stopped.');
    expect(fetcher).toHaveBeenCalledWith('/api/agents/run-id/instructions', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
  });

  it('rejects invalid state and delivery responses instead of claiming receipt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(response(null))));
    await expect(fetchInstructions('run')).rejects.toThrow('Invalid instruction response.');
    await expect(sendInstruction('run', { id: 'id', targetId: 'target', text: 'text' })).rejects.toThrow('Invalid instruction response.');
  });
});
