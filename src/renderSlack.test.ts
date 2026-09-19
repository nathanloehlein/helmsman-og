import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPirateMode } from './logic/terminology';
import { renderSlack } from './renderSlack';
import { unavailableSlack, type SlackNotification, type VoyageNotification } from './data/slack';

const item: SlackNotification = {
  id: 'one', repo: 'org/repo', prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42',
  sourceUrl: 'https://company.slack.com/archives/C123/p123456789', author: '<script>bad()</script>', channelName: 'airo-editing',
  status: 'launched', runId: 'run-42', createdAt: '2026-09-17T12:00:00Z', updatedAt: '2026-09-17T12:00:00Z', readAt: null, error: null,
};
const voyage: VoyageNotification = {
  ...item, kind: 'voyage-completed', id: 'voyage-42', title: 'Fix task switching', status: 'succeeded', runId: 'run-42',
  sourceUrl: '/runs?run=run-42', author: 'Helmsman', channelName: 'Helmsman voyages', error: null,
};

beforeEach(() => setPirateMode(true));
afterEach(() => localStorage.removeItem('helmsman.pirateMode'));

describe('Slack notification center', () => {
  it.each([true, false])('renders completed voyage outcomes with mode-specific labels (%s)', pirate => {
    setPirateMode(pirate);
    const state = unavailableSlack();
    state.notifications = (['succeeded', 'failed', 'stopped'] as const).map(status => ({
      ...voyage, id: status, status, updatedAt: '2026-09-17T12:10:00Z',
    }));
    document.body.innerHTML = renderSlack(state, true, null, new Date('2026-09-17T12:15:00Z'));
    expect([...document.querySelectorAll('.slack-status')].map(node => node.textContent)).toEqual(
      pirate ? ['Shipshape', 'Marooned', 'Stopped'] : ['Succeeded', 'Failed', 'Stopped'],
    );
    expect(document.querySelector('h2')?.textContent).toBe('Notifications');
    expect(document.querySelector('.slack-voyage-title')?.textContent).toBe(voyage.title);
    expect(document.querySelector('.slack-author')?.textContent).toBe(`${pirate ? 'Voyage' : 'Run'} · org/repo`);
    expect(document.querySelector('.app-link')?.textContent).toBe(pirate ? 'View voyage' : 'View run');
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-17T12:10:00Z');
    expect(document.querySelector('time')?.textContent).toBe('5m ago');
    expect(document.querySelector('a[target="_blank"]')?.textContent).toBe(pirate ? 'Bounty #42' : 'PR #42');
    expect(document.querySelectorAll('[data-slack-read]')).toHaveLength(3);
  });

  it('scopes mixed completed voyages and reviews and unread counts to the header selection', () => {
    const state = unavailableSlack();
    state.notifications = [item, { ...voyage, prNumber: null, prUrl: '' },
      { ...voyage, id: 'read', readAt: voyage.createdAt }, { ...voyage, id: 'other', repo: 'org/other' }];
    document.body.innerHTML = renderSlack(state, true, null, new Date(), 'ORG/REPO');
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 2 unread');
    expect(document.querySelectorAll('.slack-notification')).toHaveLength(3);
    expect(document.querySelector('[data-notification-id="other"]')).toBeNull();
    const completed = document.querySelector('[data-notification-id="voyage-42"]');
    expect(completed?.querySelector('.app-link')?.getAttribute('href')).toBe('/runs?repo=ORG%2FREPO&run=run-42');
    expect(completed?.querySelector('a[target="_blank"]')).toBeNull();
    expect(document.querySelector('[data-notification-id="read"] [data-slack-read]')).toBeNull();
    expect(document.querySelector('[data-notification-id="read"] .slack-read')?.textContent).toBe('Read');
  });

  it('escapes completed-voyage text and ignores unsafe PR or source links', () => {
    const state = unavailableSlack();
    state.notifications = [{ ...voyage, title: '<img src=x onerror=bad()>', model: '<script>bad()</script>',
      sourceUrl: 'javascript:bad()', prUrl: 'https://evil.test/org/repo/pull/42' }];
    document.body.innerHTML = renderSlack(state, true);
    expect(document.querySelector('img, script, a[href^="javascript:"], a[target="_blank"]')).toBeNull();
    expect(document.querySelector('.slack-voyage-title')?.textContent).toBe('<img src=x onerror=bad()>');
    expect(document.querySelector('.slack-routing')?.textContent).toBe('<script>bad()</script>');
    expect(document.querySelector('.app-link')?.getAttribute('href')).toBe('/runs?run=run-42');
  });

  it('uses a general empty state for the notification center', () => {
    document.body.innerHTML = renderSlack(unavailableSlack(), true);
    expect(document.querySelector('.slack-popover')?.getAttribute('aria-label')).toBe('Notifications');
    expect(document.querySelector('.slack-empty')?.textContent).toBe('No notifications yet.');
  });

  it.each([true, false])('uses mode-specific labels without rewriting external notification text (%s)', pirate => {
    setPirateMode(pirate);
    const state = unavailableSlack();
    state.notifications = [{ ...item, status: 'failed', channelName: 'Helmsman created PRs', sourceUrl: '/runs?run=parent-42', error: 'PR review failed for agent in galleon', model: 'agent-review-model' }];
    document.body.innerHTML = renderSlack(state, true);
    expect(document.querySelector('h2')?.textContent).toBe('Notifications');
    expect(document.querySelector('.slack-status')?.textContent).toBe(pirate ? 'Inspection: Marooned' : 'Review: Failed');
    expect(document.querySelector('.slack-notification-actions')?.textContent).toContain(pirate ? 'Original voyage' : 'Original run');
    expect(document.querySelector('.slack-notification .slack-error')?.textContent).toBe('PR review failed for agent in galleon');
    expect(document.querySelector('.slack-routing')?.textContent).toBe('agent-review-model');
    expect(document.querySelector('.slack-status')?.classList.contains('slack-status--failed')).toBe(true);
    expect(document.querySelector('.app-link')?.getAttribute('href')).toBe('/runs?run=run-42');
  });

  it('identifies created-PR reviews and safely links their original voyage', () => {
    const state = unavailableSlack();
    state.notifications = [{ ...item, channelName: 'Helmsman created PRs', author: 'Helmsman', sourceUrl: '/runs?run=parent-42' }];
    document.body.innerHTML = renderSlack(state, true);
    expect(document.querySelector('.slack-author')?.textContent).toBe('Helmsman inspection · newly opened Bounty');
    expect([...document.querySelectorAll('.app-link')].find(link => link.textContent === 'Original voyage')?.getAttribute('href')).toBe('/runs?run=parent-42');
    state.notifications[0]!.sourceUrl = '//untrusted.example/runs?run=parent-42';
    document.body.innerHTML = renderSlack(state, true);
    expect(document.body.textContent).not.toContain('Original voyage');
  });

  it('distinguishes queued and launched reviews, preserves read history, and links to runs', () => {
    const state = unavailableSlack();
    state.notifications = [item, { ...item, id: 'two', status: 'queued', runId: null, readAt: item.createdAt }];
    document.body.innerHTML = renderSlack(state, true);
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 1 unread');
    expect(document.querySelector('[data-slack-toggle]')?.classList.contains('has-unread')).toBe(true);
    expect(document.querySelector('[data-slack-toggle]')?.textContent?.trim()).toBe('1');
    expect(document.querySelectorAll('.slack-notification')).toHaveLength(2);
    expect(document.querySelectorAll('[data-slack-read]')).toHaveLength(1);
    expect(document.querySelectorAll('.slack-status')[0]?.textContent).toBe('Inspection started');
    expect(document.querySelectorAll('.slack-status')[1]?.textContent).toBe('Inspection queued');
    expect(document.querySelector('.app-link')?.getAttribute('href')).toBe('/runs?run=run-42');
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('.slack-author')?.textContent).toContain(item.author);
  });

  it('scopes notifications and unread counts to the header galleon and preserves it in voyage links', () => {
    const state = unavailableSlack();
    state.notifications = [
      { ...item, channelName: 'Helmsman created PRs', sourceUrl: '/runs?run=parent-42' },
      { ...item, id: 'other', repo: 'org/other', runId: 'other-run' },
    ];
    document.body.innerHTML = renderSlack(state, true, null, new Date(), 'ORG/REPO');
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 1 unread');
    expect(document.querySelectorAll('.slack-notification')).toHaveLength(1);
    expect(document.querySelector('[data-notification-id="other"]')).toBeNull();
    expect([...document.querySelectorAll('.app-link')].map(link => link.getAttribute('href'))).toEqual([
      '/runs?repo=ORG%2FREPO&run=run-42', '/runs?repo=ORG%2FREPO&run=parent-42',
    ]);
    document.body.innerHTML = renderSlack(state, true);
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 2 unread');
    expect(document.querySelectorAll('.slack-notification')).toHaveLength(2);
    document.body.innerHTML = renderSlack(state, true, null, new Date(), 'org/empty');
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 0 unread');
    expect(document.querySelector('.slack-empty')).not.toBeNull();
  });

  it('hides the disclosure when closed and renders reader failures with saved history', () => {
    const state = unavailableSlack();
    state.notifications = [{ ...item, status: 'blocked', sourceUrl: 'javascript:bad()', error: '<img src=x onerror=bad()>' }];
    document.body.innerHTML = renderSlack(state, false, 'Could not mark notification read. Try again.');
    expect(document.querySelector<HTMLElement>('#slack-notifications')?.hidden).toBe(true);
    expect(document.querySelector('.slack-health')?.textContent).toContain('Reader unavailable');
    expect(document.querySelector('.slack-health strong')?.textContent).toBe('Slack');
    expect(document.querySelector('.slack-status')?.textContent).toBe('Inspection blocked');
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Try again');
  });

  it('only links launched or failed runs and labels asynchronous failures accurately', () => {
    const state = unavailableSlack();
    state.notifications = [
      { ...item, id: 'queued', status: 'queued' },
      { ...item, id: 'blocked', status: 'blocked' },
      { ...item, id: 'failed', status: 'failed' },
      { ...item, id: 'launch-error', status: 'failed', runId: null },
    ];
    document.body.innerHTML = renderSlack(state, true);
    expect(document.querySelector('[data-notification-id="queued"] .app-link')).toBeNull();
    expect(document.querySelector('[data-notification-id="blocked"] .app-link')).toBeNull();
    expect(document.querySelector('[data-notification-id="failed"] .app-link')).not.toBeNull();
    expect(document.querySelector('[data-notification-id="failed"] .slack-status')?.textContent).toBe('Inspection: Marooned');
    expect(document.querySelector('[data-notification-id="launch-error"] .app-link')).toBeNull();
  });

  it('shows separate Slack and GitHub health and the selected review model', () => {
    const state = unavailableSlack();
    state.health = { ...state.health, enabled: true, status: 'healthy', channelName: 'airo-editing', error: null };
    state.githubHealth = { ...state.health, channelName: 'GitHub requested reviews' };
    state.notifications = [{ ...item, sourceUrl: item.prUrl, channelName: 'GitHub requested reviews', model: 'gpt-5.6-sol', effort: 'medium', complexity: 'low' }];
    document.body.innerHTML = renderSlack(state, true);
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 1 unread');
    expect(document.querySelector('h2')?.textContent).toBe('Notifications');
    const health = Array.from(document.querySelectorAll('.slack-health'));
    expect(health[0]?.textContent).toContain('Slack #airo-editing');
    expect(health[1]?.textContent).toContain('GitHub requested inspections');
    expect(health.every(item => item.textContent?.includes('Scanning every 5 min'))).toBe(true);
    expect(document.querySelector('.slack-author')?.textContent).toContain('GitHub inspection request');
    expect(document.querySelector('.slack-routing')?.textContent).toBe('low complexity · gpt-5.6-sol · medium effort');
    expect(document.querySelector('.slack-notification-actions a[target="_blank"]')?.getAttribute('href')).toBe(item.prUrl);
  });

  it('rejects unrelated GitHub source links and escapes model descriptions', () => {
    const state = unavailableSlack();
    state.notifications = [{ ...item, sourceUrl: 'https://github.com/other/repo/pull/42', channelName: 'GitHub requested reviews', model: '<img src=x onerror=bad()>' }];
    document.body.innerHTML = renderSlack(state, true);
    expect(document.querySelector('.slack-notification-actions a[target="_blank"]')).toBeNull();
    expect(document.querySelector('.slack-routing')?.textContent).toContain('<img');
    expect(document.querySelector('img')).toBeNull();
  });

  it('stops signaling unread notifications after they are read', () => {
    const state = unavailableSlack();
    state.notifications = [{ ...item, readAt: item.createdAt }];
    document.body.innerHTML = renderSlack(state, false);
    const toggle = document.querySelector('[data-slack-toggle]');
    expect(toggle?.getAttribute('aria-label')).toBe('Notifications, 0 unread');
    expect(toggle?.classList.contains('has-unread')).toBe(false);
    expect(toggle?.textContent?.trim()).toBe('');
    expect(toggle?.querySelector('svg')).not.toBeNull();
    expect(toggle?.querySelector('.slack-count')).toBeNull();
  });
});
