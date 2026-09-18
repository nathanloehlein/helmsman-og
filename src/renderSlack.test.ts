import { describe, expect, it } from 'vitest';
import { renderSlack } from './renderSlack';
import { unavailableSlack, type SlackNotification } from './data/slack';

const item: SlackNotification = {
  id: 'one', repo: 'org/repo', prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42',
  sourceUrl: 'https://company.slack.com/archives/C123/p123456789', author: '<script>bad()</script>', channelName: 'airo-editing',
  status: 'launched', runId: 'run-42', createdAt: '2026-09-17T12:00:00Z', updatedAt: '2026-09-17T12:00:00Z', readAt: null, error: null,
};

describe('Slack notification center', () => {
  it('identifies created-PR reviews and safely links their original voyage', () => {
    const state = unavailableSlack();
    state.notifications = [{ ...item, channelName: 'Helmsman created PRs', author: 'Helmsman', sourceUrl: '/runs?run=parent-42' }];
    document.body.innerHTML = renderSlack(state, true);
    expect(document.querySelector('.slack-author')?.textContent).toBe('Helmsman review · newly opened PR');
    expect([...document.querySelectorAll('.app-link')].find(link => link.textContent === 'Original voyage')?.getAttribute('href')).toBe('/runs?repo=org%2Frepo&run=parent-42');
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
    expect(document.querySelectorAll('.slack-status')[0]?.textContent).toBe('Review started');
    expect(document.querySelectorAll('.slack-status')[1]?.textContent).toBe('Review queued');
    expect(document.querySelector('.app-link')?.getAttribute('href')).toBe('/runs?repo=org%2Frepo&run=run-42');
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('.slack-author')?.textContent).toContain(item.author);
  });

  it('hides the disclosure when closed and renders reader failures with saved history', () => {
    const state = unavailableSlack();
    state.notifications = [{ ...item, status: 'blocked', sourceUrl: 'javascript:bad()', error: '<img src=x onerror=bad()>' }];
    document.body.innerHTML = renderSlack(state, false, 'Could not mark notification read. Try again.');
    expect(document.querySelector<HTMLElement>('#slack-notifications')?.hidden).toBe(true);
    expect(document.querySelector('.slack-health')?.textContent).toContain('Reader unavailable');
    expect(document.querySelector('.slack-health strong')?.textContent).toBe('Slack');
    expect(document.querySelector('.slack-status')?.textContent).toBe('Review blocked');
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
    expect(document.querySelector('[data-notification-id="failed"] .slack-status')?.textContent).toBe('Review failed');
    expect(document.querySelector('[data-notification-id="launch-error"] .app-link')).toBeNull();
  });

  it('shows separate Slack and GitHub health and the selected review model', () => {
    const state = unavailableSlack();
    state.health = { ...state.health, enabled: true, status: 'healthy', channelName: 'airo-editing', error: null };
    state.githubHealth = { ...state.health, channelName: 'GitHub requested reviews' };
    state.notifications = [{ ...item, sourceUrl: item.prUrl, channelName: 'GitHub requested reviews', model: 'gpt-5.6-sol', effort: 'medium', complexity: 'low' }];
    document.body.innerHTML = renderSlack(state, true);
    expect(document.querySelector('[data-slack-toggle]')?.getAttribute('aria-label')).toBe('Notifications, 1 unread');
    expect(document.querySelector('h2')?.textContent).toBe('Automatic reviews');
    const health = Array.from(document.querySelectorAll('.slack-health'));
    expect(health[0]?.textContent).toContain('Slack #airo-editing');
    expect(health[1]?.textContent).toContain('GitHub requested reviews');
    expect(health.every(item => item.textContent?.includes('Scanning every 5 min'))).toBe(true);
    expect(document.querySelector('.slack-author')?.textContent).toContain('GitHub review request');
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
