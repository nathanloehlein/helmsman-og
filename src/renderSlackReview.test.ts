import { describe, expect, it } from 'vitest';
import type { PrStatusView } from './data/pr';
import { renderConfigView, renderPrLists, renderPrPanel, renderRepoPrs } from './render';

const pr = { repo: 'org/repo', number: 42, title: 'Improve search', draft: false, reviewDecision: '', createdAt: '2026-09-18T12:00:00Z' };
const list = { prs: [pr], loading: false, degraded: false, truncated: false };
const status = (overrides: Partial<PrStatusView> = {}): PrStatusView => ({
  repo: 'org/repo', number: 42, state: 'open', isOwnPr: true, draft: false, merged: false, headRefName: 'topic',
  reviewDecision: '', comments: 0, checks: { passed: 1, failed: 0, pending: 0 }, url: 'https://github.com/org/repo/pull/42', ...overrides,
});
function mount(html: string): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('Slack review controls', () => {
  it('offers sending only on the authored inbox list', () => {
    const root = mount(renderPrLists({ authored: list, reviewRequests: list }));
    expect(root.querySelectorAll('.pr-authored [data-slack-review-request]')).toHaveLength(1);
    expect(root.querySelector('.pr-review-requests [data-slack-review-request]')).toBeNull();
    expect(mount(renderRepoPrs('org/repo', list)).querySelector('[data-slack-review-request]')).toBeNull();
    const button = root.querySelector<HTMLButtonElement>('[data-slack-review-request]');
    expect(button?.dataset.repo).toBe('org/repo');
    expect(button?.dataset.number).toBe('42');
  });

  it.each([
    [{ isOwnPr: true, state: 'open' }, true],
    [{ isOwnPr: false, state: 'open' }, false],
    [{ isOwnPr: undefined, state: 'open' }, false],
    [{ isOwnPr: true, state: 'closed' }, false],
    [{ isOwnPr: true, state: 'merged', merged: true }, false],
  ] as const)('limits the PR panel request button to owned open PRs: %o', (overrides, allowed) => {
    expect(Boolean(mount(renderPrPanel(status(overrides), true)).querySelector('[data-slack-review-request]'))).toBe(allowed);
  });

  it('renders Slack destinations with browser setup and no bot credentials', () => {
    const root = mount(renderConfigView({ config: {}, overridden: [] }, { repos: [], selectedRepo: null, themeId: 'quarterdeck' }));
    expect(root.querySelector<HTMLInputElement>('#config-SLACK_REVIEW_CHANNEL')?.value).toBe('airo-editing');
    expect(root.querySelector<HTMLInputElement>('#config-SLACK_REVIEW_MENTION')?.value).toBe('airo-editing-squad');
    expect(root.querySelector('#config-SLACK_BOT_TOKEN')).toBeNull();
    expect(root.querySelector('#slack-review-setup')?.textContent).toContain('signed-in Slack browser');
    expect(root.querySelector('.slack-review-config')?.textContent).toContain('only when you click');
  });

  it('escapes saved Slack destinations inside configuration fields', () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const root = mount(renderConfigView({ config: { SLACK_REVIEW_CHANNEL: payload, SLACK_REVIEW_MENTION: payload }, overridden: [] }, { repos: [], selectedRepo: null, themeId: 'quarterdeck' }));
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('#config-SLACK_REVIEW_CHANNEL')?.value).toBe(payload);
    expect(root.querySelector('.slack-review-config input[type=password]')).toBeNull();
  });
});
