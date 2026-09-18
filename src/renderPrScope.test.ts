import { describe, expect, it } from 'vitest';
import { renderPrLists, renderPrPanel, renderPrView, renderRepoPrs } from './render';
import { renderRunsView } from './renderRuns';
import { DEFAULT_THEME_ID } from './data/themes';
import type { PrStatusView } from './data/pr';

const pr: PrStatusView = {
  repo: 'other/panel', number: 42, state: 'open', draft: false, merged: false,
  isOwnPr: true, headRefName: 'feature', reviewDecision: 'REVIEW_REQUIRED', comments: 0,
  checks: { passed: 0, pending: 0, failed: 0 }, url: 'https://github.com/other/panel/pull/42',
};
const list = { prs: [{ number: 42, title: 'Panel PR', repo: pr.repo, reviewDecision: '', draft: false, createdAt: '2026-09-18T00:00:00Z' }], loading: false, degraded: false, truncated: false };
const mount = (html: string) => {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
};
const target = (link: Element) => new URL(link.getAttribute('href') ?? '', 'https://helmsman.test').searchParams;

describe('PR panel repository overrides', () => {
  it.each([null, 'owner/header'])('preserves header scope %j in crew review and relaunch links', selectedRepo => {
    const element = mount(renderPrPanel(pr, true, false, selectedRepo));
    const links = [...element.querySelectorAll('.pr-voyage-links a')];
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(target(link).get('repo')).toBe(selectedRepo);
      expect(target(link).get('prRepo')).toBe(pr.repo);
      expect(target(link).get('pr')).toBe('42');
    }
  });

  it.each([null, 'owner/header'])('preserves header scope %j when selecting an inbox PR', selectedRepo => {
    const element = mount(renderPrLists({ reviewRequests: list, authored: list }, selectedRepo));
    const links = [...element.querySelectorAll('.pr-list-row .app-link')];
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(target(link).get('repo')).toBe(selectedRepo);
      expect(target(link).get('prRepo')).toBe(pr.repo);
    }
  });

  it('retains the Helm repository when selecting one of its open PRs', () => {
    const element = mount(renderRepoPrs(pr.repo, list));
    const link = element.querySelector('.pr-list-row .app-link');
    expect(link).not.toBeNull();
    expect(target(link!).get('repo')).toBe(pr.repo);
    expect(target(link!).get('prRepo')).toBe(pr.repo);
  });

  it('scopes GitHub list links while retaining their review and authorship filters', () => {
    const element = mount(renderPrLists({ reviewRequests: list, authored: list }, 'owner/header'));
    const review = element.querySelector('.pr-review-requests .pr-list-github');
    const authored = element.querySelector('.pr-authored .pr-list-github');
    expect(target(review!).get('q')).toBe('is:open is:pr review-requested:@me repo:owner/header');
    expect(target(authored!).get('q')).toBe('is:open is:pr author:@me repo:owner/header');
  });

  it.each([null, 'owner/header'])('propagates header scope %j through PR and voyage pages', selectedRepo => {
    const state = { repo: pr.repo, number: pr.number, pr, diff: null, loading: false };
    const opts = { repos: ['owner/header', pr.repo], selectedRepo, themeId: DEFAULT_THEME_ID, runs: [], lists: { reviewRequests: list, authored: list } };
    for (const html of [renderPrView(state, opts), renderRunsView(state, opts)]) {
      const element = mount(html);
      expect(element.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe(selectedRepo ?? '');
      const links = [...element.querySelectorAll('.pr-voyage-links a, .pr-list-row .app-link, [data-pane="newrun"] .runs-pane-link')];
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(target(link).get('repo')).toBe(selectedRepo);
        expect(target(link).get('prRepo')).toBe(pr.repo);
        expect(target(link).get('pr')).toBe('42');
      }
    }
  });
});
