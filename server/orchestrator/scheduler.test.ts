import { describe, expect, it, vi } from 'vitest';
import { AutoClaimScheduler, type SchedulerDeps } from './scheduler';

describe('AutoClaimScheduler', () => {
  it('tick() launches enabled idle repos with top backlog tickets, skipping busy repos', async () => {
    const launchSpy = vi.fn();
    const fetchTopBacklogIdle = vi.fn().mockResolvedValue({ ticketId: 'TICK-1', title: 'Idle ticket' });
    const fetchTopBacklogBusy = vi.fn();
    const canStartIdle = vi.fn().mockReturnValue(true);
    const canStartBusy = vi.fn().mockReturnValue(false);

    const deps: SchedulerDeps = {
      canStart: (repo: string) => repo === 'idle-repo' ? canStartIdle() : canStartBusy(),
      fetchTopBacklog: (repo: string) => repo === 'idle-repo' ? fetchTopBacklogIdle() : fetchTopBacklogBusy(),
      launch: launchSpy,
    };

    const scheduler = new AutoClaimScheduler(deps);
    scheduler.setEnabled('idle-repo', true);
    scheduler.setEnabled('busy-repo', true);

    await scheduler.tick();

    expect(launchSpy).toHaveBeenCalledOnce();
    expect(launchSpy).toHaveBeenCalledWith({
      ticketId: 'TICK-1',
      title: 'Idle ticket',
      repo: 'idle-repo',
    });
    expect(fetchTopBacklogBusy).not.toHaveBeenCalled();
  });

  it('isEnabled and enabledRepos reflect setEnabled toggles', () => {
    const deps: SchedulerDeps = {
      canStart: () => true,
      fetchTopBacklog: async () => null,
      launch: () => {},
    };

    const scheduler = new AutoClaimScheduler(deps);
    expect(scheduler.isEnabled('repo-a')).toBe(false);
    expect(scheduler.enabledRepos()).toEqual([]);

    scheduler.setEnabled('repo-a', true);
    expect(scheduler.isEnabled('repo-a')).toBe(true);
    expect(scheduler.enabledRepos()).toContain('repo-a');

    scheduler.setEnabled('repo-b', true);
    expect(scheduler.enabledRepos().sort()).toEqual(['repo-a', 'repo-b']);

    scheduler.setEnabled('repo-a', false);
    expect(scheduler.isEnabled('repo-a')).toBe(false);
    expect(scheduler.enabledRepos()).toEqual(['repo-b']);
  });

  it('does not launch when fetchTopBacklog returns null', async () => {
    const launchSpy = vi.fn();
    const deps: SchedulerDeps = {
      canStart: () => true,
      fetchTopBacklog: async () => null,
      launch: launchSpy,
    };

    const scheduler = new AutoClaimScheduler(deps);
    scheduler.setEnabled('repo', true);

    await scheduler.tick();

    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('catches fetchTopBacklog rejection and continues with other repos', async () => {
    const launchSpy = vi.fn();
    const logSpy = vi.fn();
    const fetchRepo1 = vi.fn().mockRejectedValue(new Error('backlog fetch failed'));
    const fetchRepo2 = vi.fn().mockResolvedValue({ ticketId: 'TICK-2', title: 'Second ticket' });

    const deps: SchedulerDeps = {
      canStart: () => true,
      fetchTopBacklog: (repo: string) => repo === 'repo-1' ? fetchRepo1() : fetchRepo2(),
      launch: launchSpy,
      onLog: logSpy,
    };

    const scheduler = new AutoClaimScheduler(deps);
    scheduler.setEnabled('repo-1', true);
    scheduler.setEnabled('repo-2', true);

    await scheduler.tick();

    expect(launchSpy).toHaveBeenCalledOnce();
    expect(launchSpy).toHaveBeenCalledWith({
      ticketId: 'TICK-2',
      title: 'Second ticket',
      repo: 'repo-2',
    });
    expect(logSpy).toHaveBeenCalled();
  });

  it('does not launch when canStart flips to false during the backlog fetch await (TOCTOU close)', async () => {
    const launchSpy = vi.fn();
    const canStartSpy = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const fetchSpy = vi.fn().mockResolvedValue({ ticketId: 'TICK-1', title: 'Ticket' });

    const deps: SchedulerDeps = {
      canStart: canStartSpy,
      fetchTopBacklog: fetchSpy,
      launch: launchSpy,
    };

    const scheduler = new AutoClaimScheduler(deps);
    scheduler.setEnabled('repo', true);

    await scheduler.tick();

    expect(canStartSpy).toHaveBeenCalledTimes(2);
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('launches once when canStart stays true on both the initial gate and the re-check', async () => {
    const launchSpy = vi.fn();
    const canStartSpy = vi.fn().mockReturnValue(true);
    const fetchSpy = vi.fn().mockResolvedValue({ ticketId: 'TICK-1', title: 'Ticket' });

    const deps: SchedulerDeps = {
      canStart: canStartSpy,
      fetchTopBacklog: fetchSpy,
      launch: launchSpy,
    };

    const scheduler = new AutoClaimScheduler(deps);
    scheduler.setEnabled('repo', true);

    await scheduler.tick();

    expect(canStartSpy).toHaveBeenCalledTimes(2);
    expect(launchSpy).toHaveBeenCalledOnce();
    expect(launchSpy).toHaveBeenCalledWith({
      ticketId: 'TICK-1',
      title: 'Ticket',
      repo: 'repo',
    });
  });

  it('disabling a repo stops it from being ticked', async () => {
    const launchSpy = vi.fn();
    const fetchSpy = vi.fn().mockResolvedValue({ ticketId: 'TICK-1', title: 'Ticket' });
    const canStartSpy = vi.fn().mockReturnValue(true);

    const deps: SchedulerDeps = {
      canStart: canStartSpy,
      fetchTopBacklog: fetchSpy,
      launch: launchSpy,
    };

    const scheduler = new AutoClaimScheduler(deps);
    scheduler.setEnabled('repo', true);
    scheduler.setEnabled('repo', false);

    await scheduler.tick();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
  });
});
