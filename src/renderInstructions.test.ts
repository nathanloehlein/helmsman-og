import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunInstructions } from './renderInstructions';
import type { InstructionState, RunInstruction } from './data/instructions';

const fetchInstructions = vi.hoisted(() => vi.fn());
const sendInstruction = vi.hoisted(() => vi.fn());
vi.mock('./data/instructions', () => ({ fetchInstructions, sendInstruction }));
let controller: ReturnType<typeof createRunInstructions>;
let root: HTMLElement;
const target = { id: 'first-target', provider: 'codex', stage: 'review' };
const state = (overrides: Partial<InstructionState> = {}): InstructionState => ({ available: true, targets: [target], instructions: [], ...overrides });
const delivered = (input: Partial<RunInstruction> = {}): RunInstruction => ({ id: 'instruction', targetId: target.id, provider: target.provider, stage: target.stage, text: 'Check the retry path', status: 'delivered', createdAt: '2026-09-30T12:00:00Z', ...input });
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
function type(text: string): void {
  const field = root.querySelector('textarea')!;
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
function submit(): void { root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fetchInstructions.mockResolvedValue(state());
  document.body.innerHTML = '<div id="test"></div>';
  root = document.querySelector('#test')!;
  controller = createRunInstructions();
});
afterEach(() => { controller.destroy(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('live instructions', () => {
  it('sends to the selected reviewer once, shows receipt, and clears the acknowledged draft', async () => {
    fetchInstructions.mockResolvedValue(state({ targets: [target, { ...target, id: 'second-target', stage: 'security' }] }));
    let resolve!: (value: RunInstruction) => void;
    sendInstruction.mockImplementation(() => new Promise<RunInstruction>(done => { resolve = done; }));
    controller.mount(root, 'run-one', false);
    await flush();
    const selector = root.querySelector('select')!;
    selector.value = 'second-target';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
    type('Check the retry path');
    submit(); submit();
    expect(sendInstruction).toHaveBeenCalledTimes(1);
    expect(sendInstruction).toHaveBeenCalledWith('run-one', expect.objectContaining({ targetId: 'second-target', text: 'Check the retry path' }));
    expect(root.querySelector('button')?.disabled).toBe(true);
    resolve(delivered({ ...sendInstruction.mock.calls[0]![1] }));
    await flush();
    expect(root.querySelector('textarea')?.value).toBe('');
    expect(root.textContent).toContain('Received by agent');
    expect(root.textContent).toContain('not that the work is complete');
  });

  it('shows queued delivery immediately, blocks sending again, and confirms receipt through polling', async () => {
    sendInstruction.mockImplementation(async (_runId, input) => delivered({ ...input, status: 'sending' }));
    controller.mount(root, 'run-one', false);
    await flush();
    type('Check the retry path');
    submit(); await flush();
    expect(root.querySelector('details')?.open).toBe(true);
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Waiting for the agent');
    expect(root.querySelector('button')?.disabled).toBe(true);
    expect(root.querySelector('textarea')?.disabled).toBe(false);
    submit();
    expect(sendInstruction).toHaveBeenCalledTimes(1);
    type('Next instruction draft');
    const sent = sendInstruction.mock.calls[0]?.[1];
    fetchInstructions.mockResolvedValue(state({ instructions: [delivered(sent)] }));
    root.querySelector('details')!.open = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(root.querySelector('button')?.disabled).toBe(false);
    expect(root.querySelector('textarea')?.value).toBe('Next instruction draft');
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Received by agent');
  });

  it('refreshes the final receipt when the voyage completes before POST returns', async () => {
    let resolve!: (value: RunInstruction) => void;
    sendInstruction.mockImplementation(() => new Promise<RunInstruction>(done => { resolve = done; }));
    controller.mount(root, 'run-one', false);
    await flush();
    type('Check the retry path'); submit();
    controller.mount(root, 'run-one', true);
    await flush();
    expect(root.querySelector('form')).toBeNull();
    const sent = sendInstruction.mock.calls[0]?.[1];
    fetchInstructions.mockResolvedValue(state({ available: false, targets: [], instructions: [delivered(sent)] }));
    resolve(delivered({ ...sent, status: 'sending' }));
    await flush();
    expect(fetchInstructions).toHaveBeenCalledTimes(2);
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Received by agent');
    expect(root.textContent).not.toContain('Waiting for the agent');
    expect(root.querySelector('[data-instruction-status="sending"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetchInstructions).toHaveBeenCalledTimes(2);
  });

  it('preserves drafts across redraws and tab switches and ignores old poll responses', async () => {
    controller.mount(root, 'run-one', false);
    await flush();
    type('First draft');
    root.innerHTML = '';
    controller.mount(root, 'run-one', false);
    expect(root.querySelector('textarea')?.value).toBe('First draft');
    let resolve!: (value: InstructionState) => void;
    fetchInstructions.mockImplementationOnce(() => new Promise<InstructionState>(done => { resolve = done; }));
    await vi.advanceTimersByTimeAsync(2000);
    controller.mount(root, 'run-two', false);
    await flush();
    type('Second draft');
    resolve(state({ available: false, reason: 'stale response' }));
    await flush();
    expect(root.textContent).not.toContain('stale response');
    expect(root.querySelector('textarea')?.value).toBe('Second draft');
    controller.mount(root, 'run-one', false);
    expect(root.querySelector('textarea')?.value).toBe('First draft');
  });

  it('retains failed drafts and reuses request identity after an unconfirmed response', async () => {
    sendInstruction.mockRejectedValue(new Error('Connection lost'));
    controller.mount(root, 'run-one', false);
    await flush();
    type('Check the retry path');
    submit(); await flush();
    expect(root.querySelector('textarea')?.value).toBe('Check the retry path');
    expect(root.textContent).toContain('Delivery is unconfirmed');
    submit(); await flush();
    expect(sendInstruction.mock.calls[0]?.[1].id).toBe(sendInstruction.mock.calls[1]?.[1].id);
    const pending = sendInstruction.mock.calls[0]?.[1];
    fetchInstructions.mockResolvedValue(state({ instructions: [delivered(pending)] }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(root.querySelector('textarea')?.value).toBe('');
    expect(root.textContent).toContain('Received by agent');
  });

  it('shows unavailable reasons and retains failed and unknown history after completion', async () => {
    fetchInstructions.mockResolvedValue(state({ available: false, reason: 'Started before live instructions were enabled.', instructions: [delivered({ id: 'failed', status: 'failed', error: 'Agent stopped' }), delivered({ id: 'unknown', status: 'unknown' })] }));
    controller.mount(root, 'old-run', false);
    await flush();
    expect(root.querySelector('form')).toBeNull();
    expect(root.textContent).toContain('Started before live instructions were enabled.');
    controller.mount(root, 'old-run', true);
    await flush();
    expect(root.textContent).not.toContain('Send instruction');
    expect(root.textContent).toContain('Agent stopped');
    expect(root.textContent).toContain('Delivery unknown');
    const calls = fetchInstructions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetchInstructions).toHaveBeenCalledTimes(calls);
  });

  it('does not clear another tab draft after a send finishes and cancels polling on destroy', async () => {
    let resolve!: (value: RunInstruction) => void;
    sendInstruction.mockImplementation(() => new Promise<RunInstruction>(done => { resolve = done; }));
    controller.mount(root, 'run-one', false);
    await flush();
    type('First draft'); submit();
    controller.mount(root, 'run-two', false);
    await flush();
    type('Second draft');
    resolve(delivered());
    await flush();
    expect(root.querySelector('textarea')?.value).toBe('Second draft');
    controller.destroy();
    const calls = fetchInstructions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetchInstructions).toHaveBeenCalledTimes(calls);
    expect(root.innerHTML).toBe('');
  });
});
