import { afterEach, describe, expect, it } from 'vitest';
import { renderPrLists, renderRepoPrs } from './render';
import { setPirateMode } from './logic/terminology';
import type { OpenPr } from './types';

afterEach(() => { setPirateMode(true); localStorage.clear(); });

const pr: OpenPr = { repo: 'org/alpha', number: 42, title: 'A PR', reviewDecision: '', draft: false, createdAt: '2026-09-18T00:00:00Z' };
const state = (prs: OpenPr[]) => ({ prs, loading: false, degraded: false, truncated: false });
const mount = (html: string) => {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
};
const detailed: OpenPr = { ...pr, comments: 7, reviews: { approved: 2, changesRequested: 1, commented: 3, requested: 4 } };

describe('compact PR list stats', () => {
  it('shows all three requested counts on authored PRs, including zero changes', () => {
    const element = mount(renderPrLists({ reviewRequests: state([]), authored: state([{ ...detailed, reviews: { approved: 2, changesRequested: 0, commented: 3, requested: 0 } }]) }));
    const stats = element.querySelector('.pr-authored .pr-list-stats');
    expect(stats?.querySelectorAll('.pr-list-stat')).toHaveLength(3);
    expect(stats?.querySelector('[data-pr-stat="approved"]')?.getAttribute('aria-label')).toBe('approvals: 2');
    expect(stats?.querySelector('[data-pr-stat="changes"]')?.getAttribute('aria-label')).toBe('changes requested: 0');
    expect(stats?.querySelector('[data-pr-stat="comments"]')?.getAttribute('aria-label')).toBe('comments: 7');
  });

  it('distinguishes unavailable authored counts from confirmed zeros', () => {
    const element = mount(renderPrLists({ reviewRequests: state([]), authored: state([{ ...pr, comments: 0 }]) }));
    const stats = element.querySelector('.pr-authored .pr-list-stats');
    expect(stats?.querySelector('[data-pr-stat="comments"]')?.textContent).toBe('0');
    expect(stats?.querySelector('[data-pr-stat="approved"]')?.textContent).toBe('—');
    expect(stats?.querySelector('[data-pr-stat="changes"]')?.getAttribute('aria-label')).toBe('changes requested: unavailable');
  });

  it('shows supplied counts below the identity with accessible icon labels', () => {
    const element = mount(renderRepoPrs(pr.repo, state([detailed])));
    const stats = element.querySelector('.pr-list-summary .pr-list-stats');
    expect(stats?.previousElementSibling?.classList.contains('agent-repo')).toBe(true);
    for (const [key, value, label] of [['comments', '7', 'comments'], ['approved', '2', 'approvals'], ['changes', '1', 'changes requested'], ['pending', '4', 'pending inspections']]) {
      const stat = stats?.querySelector(`[data-pr-stat="${key}"]`);
      expect(stat?.textContent).toBe(value);
      expect(stat?.getAttribute('role')).toBe('img');
      expect(stat?.getAttribute('aria-label')).toBe(`${label}: ${value}`);
      expect(stat?.getAttribute('title')).toContain(value);
      expect(stat?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(element.querySelector('.pr-list-row')?.getAttribute('aria-label')).toContain(`${label}: ${value}`);
    }
    expect(stats?.querySelectorAll('.pr-list-stat')).toHaveLength(4);
    expect(stats?.querySelector('button, a')).toBeNull();
  });

  it('shows known zero comments and approvals while omitting zero changes and pending counts', () => {
    const element = mount(renderRepoPrs(pr.repo, state([{ ...pr, comments: 0, reviews: { approved: 0, changesRequested: 0, commented: 0, requested: 0 } }])));
    expect(element.querySelectorAll('.pr-list-stat')).toHaveLength(2);
    expect(element.querySelector('[data-pr-stat="comments"]')?.textContent).toBe('0');
    expect(element.querySelector('[data-pr-stat="approved"]')?.textContent).toBe('0');
    expect(element.querySelector('[data-pr-stat="changes"], [data-pr-stat="pending"]')).toBeNull();
  });

  it('omits unknown stats without inventing zero or leaving an empty line', () => {
    const element = mount(renderRepoPrs(pr.repo, state([pr])));
    expect(element.querySelector('.pr-list-stats')).toBeNull();
    expect(element.querySelector('.pr-list-row')?.getAttribute('aria-label')).not.toContain('comments');
  });

  it.each([null, undefined, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', {}, []])('omits malformed counts independently: %j', value => {
    const invalid = { ...pr, comments: value, reviews: { approved: value, changesRequested: value, commented: 0, requested: 1 } } as unknown as OpenPr;
    const element = mount(renderRepoPrs(pr.repo, state([invalid])));
    expect(element.querySelectorAll('.pr-list-stat')).toHaveLength(1);
    expect(element.querySelector('[data-pr-stat="pending"]')?.textContent).toBe('1');
  });

  it.each([null, undefined, 'bad', 42, []])('handles malformed review summaries while retaining valid comments: %j', reviews => {
    const element = mount(renderRepoPrs(pr.repo, state([{ ...pr, comments: 2, reviews } as unknown as OpenPr])));
    expect(element.querySelectorAll('.pr-list-stat')).toHaveLength(1);
    expect(element.querySelector('[data-pr-stat="comments"]')?.textContent).toBe('2');
  });

  it('retains repository scope and renders stats in other lists when supplied', () => {
    const scoped = mount(renderRepoPrs(pr.repo, state([detailed, { ...detailed, repo: 'org/beta', number: 43, comments: 99 }])));
    expect(scoped.querySelectorAll('.pr-list-row')).toHaveLength(1);
    expect(scoped.querySelector('[data-pr-stat="comments"]')?.textContent).toBe('7');
    const href = scoped.querySelector('.app-link')?.getAttribute('href') ?? '';
    expect(new URL(href, 'https://helmsman.test').searchParams.get('repo')).toBe(pr.repo);
    const inbox = mount(renderPrLists({ reviewRequests: state([detailed]), authored: state([]) }, pr.repo));
    expect(inbox.querySelector('[data-pr-stat="approved"]')?.textContent).toBe('2');
  });

  it('uses conventional review wording when Pirate mode is off', () => {
    setPirateMode(false);
    const element = mount(renderRepoPrs(pr.repo, state([detailed])));
    expect(element.querySelector('[data-pr-stat="pending"]')?.getAttribute('aria-label')).toBe('pending reviews: 4');
    expect(element.querySelector('[data-pr-stat="approved"]')?.getAttribute('aria-label')).toBe('approvals: 2');
  });
});
