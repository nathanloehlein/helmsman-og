import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuestionChime, QuestionAlerts, type QuestionChime } from './questionAlerts';
import type { Clarification } from './data/clarifications';
const question = (id: string, extra: Partial<Clarification> = {}): Clarification => ({ id, repo: 'org/repo', runId: 'run', question: 'Which approach?',
  required: true, owner: 'local', contactId: null, state: 'pending', answer: null, createdAt: '2026-10-01T00:00:00Z', timeoutAt: null, answeredAt: null, ...extra });
let alerts: QuestionAlerts | undefined;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { alerts?.dispose(); alerts = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture() {
  let items: Clarification[] = []; let ready = false;
  const read = vi.fn(async () => items);
  const changed = vi.fn();
  const chime: QuestionChime = { get ready() { return ready; }, unlock: vi.fn(async () => { ready = true; }), play: vi.fn(() => ready), cancel: vi.fn(), dispose: vi.fn() };
  alerts = new QuestionAlerts({ read, changed, chime });
  return { alerts, read, changed, chime, set(items_: Clarification[]) { items = items_; } };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
describe('pending question alerts', () => {
  it('highlights only pending questions in the header scope and chimes once per new batch', async () => {
    const f = fixture(); f.set([question('a'), question('b'), question('answered', { state: 'answered' }), question('closed', { state: 'cancelled' }),
      question('timeout', { state: 'timed-out' }), question('expired', { timeoutAt: '2020-01-01T00:00:00Z' }), question('other', { repo: 'org/other' }), question('already-answered', { answer: 'Done' }), null as never]);
    f.alerts.update('ORG/REPO', false); await flush(); expect(f.alerts.count).toBe(2); expect(f.chime.play).not.toHaveBeenCalled();
    await f.alerts.unlockAudio(); expect(f.chime.play).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15000); expect(f.chime.play).toHaveBeenCalledTimes(1);
    f.set([question('a'), question('b'), question('c'), question('d')]); await f.alerts.refresh();
    expect(f.alerts.count).toBe(4); expect(f.chime.play).toHaveBeenCalledTimes(2);
    f.set([]); await f.alerts.refresh(); expect(f.alerts.count).toBe(0); expect(f.chime.cancel).toHaveBeenCalled();
  });
  it('rechecks initial pending questions on unlock rather than playing a stale queued sound', async () => {
    const f = fixture(); f.set([question('a')]); f.alerts.update(null, false); await flush();
    f.set([question('a', { state: 'answered' })]); await f.alerts.unlockAudio();
    expect(f.chime.play).not.toHaveBeenCalled(); expect(f.alerts.count).toBe(0);
  });
  it('stops on Questions and does not chime again for questions already visited', async () => {
    const f = fixture(); f.set([question('a')]); f.alerts.update(null, false); await flush();
    f.alerts.update(null, true); expect(f.alerts.count).toBe(0); await f.alerts.unlockAudio();
    f.set([question('a'), question('b')]); await f.alerts.refresh(); expect(f.chime.play).not.toHaveBeenCalled();
    f.alerts.update(null, false); await flush(); expect(f.alerts.count).toBe(2); expect(f.chime.play).not.toHaveBeenCalled();
    f.set([question('a'), question('b'), question('c')]); await f.alerts.refresh(); expect(f.chime.play).toHaveBeenCalledTimes(1);
  });
  it('cancels pending audio if the unlocking interaction navigates to Questions', async () => {
    const f = fixture(); f.set([question('a')]); f.alerts.update(null, false); await flush();
    let resume!: () => void; const wait = new Promise<void>(resolve => { resume = resolve; });
    const unlock = vi.mocked(f.chime.unlock).getMockImplementation();
    vi.mocked(f.chime.unlock).mockImplementation(async () => { await wait; await unlock?.(); });
    const unlocking = f.alerts.unlockAudio(); f.alerts.update(null, true); resume(); await unlocking;
    expect(f.chime.ready).toBe(true); expect(f.chime.play).not.toHaveBeenCalled(); expect(f.alerts.count).toBe(0);
  });
  it('fences late reads from a previous galleon and deduplicates questions across scopes', async () => {
    const f = fixture(); await f.alerts.unlockAudio();
    let late!: (items: Clarification[]) => void; f.read.mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    f.alerts.update('org/old', false); f.set([question('new', { repo: 'org/new' })]); f.alerts.update('org/new', false); await flush();
    expect(f.alerts.count).toBe(1); expect(f.chime.play).toHaveBeenCalledTimes(1);
    late([question('old', { repo: 'org/old' })]); await flush(); expect(f.chime.play).toHaveBeenCalledTimes(1);
    f.alerts.update(null, false); await flush(); expect(f.alerts.count).toBe(1); expect(f.chime.play).toHaveBeenCalledTimes(1);
  });
  it('keeps unlocked alerts available when the browser document is hidden', async () => {
    const f = fixture(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    f.set([question('a')]); f.alerts.update(null, false); await flush(); await f.alerts.unlockAudio();
    expect(f.chime.play).toHaveBeenCalledTimes(1); expect(f.alerts.count).toBe(1); vi.restoreAllMocks();
  });
  it('clears unverifiable pending state on read failure and releases timers, reads, and audio on dispose', async () => {
    const f = fixture(); f.set([question('a')]); f.alerts.update(null, false); await flush();
    f.read.mockRejectedValueOnce(new Error('offline')); await f.alerts.refresh(); expect(f.alerts.count).toBe(0);
    const reads = f.read.mock.calls.length; f.alerts.dispose(); await vi.advanceTimersByTimeAsync(20000);
    expect(f.read).toHaveBeenCalledTimes(reads); expect(f.chime.dispose).toHaveBeenCalled();
  });
});

describe('gentle question chime', () => {
  it('fails safely if audio is unavailable or browser autoplay rejects resume', async () => {
    vi.stubGlobal('AudioContext', undefined); const absent = createQuestionChime(); await absent.unlock(); expect(absent.play()).toBe(false); absent.dispose();
    const resume = vi.fn().mockRejectedValue(new Error('NotAllowedError')); const close = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('AudioContext', class { state = 'suspended'; resume = resume; close = close; });
    const chime = createQuestionChime(); await chime.unlock(); expect(chime.ready).toBe(false); expect(chime.play()).toBe(false); chime.dispose(); expect(close).toHaveBeenCalledTimes(1);
  });
  it('schedules a short low-volume two-note chime and cancels its nodes', async () => {
    const oscillators: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
    const ramp = vi.fn(); const close = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('AudioContext', class {
      state = 'running'; currentTime = 1; destination = {}; close = close;
      createOscillator() { const node = { type: '', frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null }; oscillators.push(node); return node; }
      createGain() { return { connect: vi.fn(), disconnect: vi.fn(), gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: ramp, exponentialRampToValueAtTime: vi.fn() } }; }
    });
    const chime = createQuestionChime(); await chime.unlock(); expect(chime.play()).toBe(true);
    expect(oscillators).toHaveLength(2); expect(ramp).toHaveBeenCalledWith(0.025, expect.any(Number));
    expect(oscillators[1]?.stop).toHaveBeenCalledWith(expect.closeTo(1.28));
    chime.cancel(); expect(oscillators.every(node => node.disconnect.mock.calls.length === 1)).toBe(true); chime.dispose(); expect(close).toHaveBeenCalled();
  });
});
