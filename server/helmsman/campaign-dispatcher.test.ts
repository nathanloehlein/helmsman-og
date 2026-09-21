import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCampaignStore, type CampaignStore } from './campaigns';
import { createCampaignDispatcher, type CampaignDispatcherOptions, type CampaignLaunch } from './campaign-dispatcher';

const stores: CampaignStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup(concurrency = 2, sameRepo = false) {
  let clock = Date.parse('2026-09-18T00:00:00.000Z');
  const store = openCampaignStore(':memory:', { now: () => new Date(clock).toISOString() }); stores.push(store);
  const campaign = store.create({ name: 'Campaign', repo: 'org/a', workflowRef: 'coding@v1', concurrency });
  const phase = store.createPhase(campaign.id, { name: 'Phase' });
  const preview = store.previewImport({ phaseId: phase.id, format: 'jsonl', allowedRepos: ['org/a', 'org/b', 'org/c'],
    content: sameRepo ? '{"task":"A"}\n{"task":"B"}\n{"task":"C"}' : '{"task":"A"}\n{"task":"B","repo":"org/b"}\n{"task":"C","repo":"org/c"}' });
  const tasks = store.confirmImport(preview.id);
  store.setPhaseState(phase.id, 'start');
  const runs = new Map<string, { status: 'running' | 'succeeded' | 'failed' | 'stopped' }>();
  const launch = vi.fn((task: CampaignLaunch) => { runs.set(task.runId, { status: 'running' }); return task.runId; });
  const stop = vi.fn((runId: string) => { runs.set(runId, { status: 'stopped' }); });
  const options: CampaignDispatcherOptions = { store, canStart: () => true, getRun: id => runs.get(id) ?? null,
    launch, stop, now: () => clock, claimTtlMs: 1000 };
  return { store, campaign, phase, tasks, runs, launch, stop, options, advance: () => { clock += 1001; }, dispatcher: createCampaignDispatcher(options) };
}

describe('campaign dispatcher', () => {
  it('starts independent tasks in the same galleon up to campaign capacity', async () => {
    const f = setup(2, true);
    await f.dispatcher.poll();
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.launch.mock.calls.every(([task]) => task.repo === 'org/a')).toBe(true);
  });

  it('starts bounded work with stable IDs and pinned workflow, then fills freed capacity', async () => {
    const f = setup();
    await f.dispatcher.poll();
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.launch.mock.calls[0]?.[0]).toMatchObject({ runId: f.tasks[0]?.runId, workflowRef: 'coding@v1', campaignId: f.campaign.id, phaseId: f.phase.id });
    f.runs.set(f.tasks[0]!.runId, { status: 'succeeded' });
    await f.dispatcher.poll();
    expect(f.launch).toHaveBeenCalledTimes(3);
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('succeeded');
    await f.dispatcher.poll();
    expect(f.launch).toHaveBeenCalledTimes(3);
  });

  it('pauses new work without stopping and stops active runs after a durable stop', async () => {
    const f = setup(1);
    await f.dispatcher.poll();
    f.store.setPhaseState(f.phase.id, 'pause');
    await f.dispatcher.poll();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.store.setPhaseState(f.phase.id, 'stop');
    const restarted = createCampaignDispatcher(f.options);
    await restarted.poll();
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(f.tasks[0]!.runId);
    await restarted.poll();
    expect(f.store.tasks(f.phase.id).every(task => task.state === 'cancelled')).toBe(true);
  });

  it('reconciles an ambiguous launch with a recorded run before any retry', async () => {
    const f = setup(1);
    f.launch.mockImplementation(task => { f.runs.set(task.runId, { status: 'running' }); throw new Error('Lost response'); });
    await f.dispatcher.poll();
    f.advance();
    await createCampaignDispatcher(f.options).poll();
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('running');
  });

  it('retains an unconfirmed start until its claim expires, then reuses its original run ID', async () => {
    const f = setup(1);
    f.launch.mockImplementationOnce(() => { throw new Error('No acknowledgement'); });
    await f.dispatcher.poll();
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('claiming');
    await f.dispatcher.poll();
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.advance();
    await createCampaignDispatcher(f.options).poll();
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.launch.mock.calls[0]?.[0].runId).toBe(f.launch.mock.calls[1]?.[0].runId);
  });

  it('keeps an acknowledged launch claim until a durable run exists so preflight crashes recover', async () => {
    const f = setup(1);
    f.launch.mockImplementationOnce(task => task.runId);
    await f.dispatcher.poll();
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('claiming');
    f.advance();
    await createCampaignDispatcher(f.options).poll();
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.launch.mock.calls[0]?.[0].runId).toBe(f.launch.mock.calls[1]?.[0].runId);
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('running');
  });

  it('does not release a stale claim while the galleon is externally busy', async () => {
    const f = setup(1);
    f.store.claim(f.tasks[0]!.id);
    f.advance();
    await createCampaignDispatcher({ ...f.options, canStart: () => false }).poll();
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('claiming');
    expect(f.launch).not.toHaveBeenCalled();
  });

  it('coalesces polls and competing dispatchers do not duplicate asynchronous launches', async () => {
    const f = setup(1);
    let resolve!: (id: string) => void;
    const launch = vi.fn((_task: CampaignLaunch) => new Promise<string>(done => { resolve = done; }));
    const a = createCampaignDispatcher({ ...f.options, launch });
    const b = createCampaignDispatcher({ ...f.options, launch });
    const first = a.poll();
    expect(a.poll()).toBe(first);
    await b.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    resolve(f.tasks[0]!.runId);
    await first;
  });

  it('finishing a phase cancels queued work but lets its active work finish', async () => {
    const f = setup(1);
    await f.dispatcher.poll();
    f.store.setPhaseState(f.phase.id, 'finish');
    await f.dispatcher.poll();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledTimes(1);
    f.runs.set(f.tasks[0]!.runId, { status: 'succeeded' });
    await f.dispatcher.poll();
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('succeeded');
  });

  it('keeps a stale preflight claim while its run reservation is active despite free capacity', async () => {
    const f = setup(1);
    f.store.claim(f.tasks[0]!.id);
    f.advance();
    await createCampaignDispatcher({ ...f.options, isRunActive: id => id === f.tasks[0]?.runId }).poll();
    expect(f.store.task(f.tasks[0]!.id)?.state).toBe('claiming');
    expect(f.launch).not.toHaveBeenCalled();
  });
});
