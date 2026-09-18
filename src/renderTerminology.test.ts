import { afterEach, describe, expect, it } from 'vitest';
import { renderConfigView, renderHelmHead, renderVoyage, runTabStatus } from './render';
import { DEFAULT_THEME_ID } from './data/themes';
import { setPirateMode } from './logic/terminology';

afterEach(() => { setPirateMode(true); localStorage.clear(); });

const mount = (html: string) => {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
};
const opts = { repos: ['org/agent-review'], selectedRepo: 'org/agent-review', themeId: DEFAULT_THEME_ID };

describe('pirate interface wording', () => {
  it.each([true, false])('renders escaped personal greetings and switchable navigation with mode=%s', enabled => {
    setPirateMode(enabled);
    const element = mount(renderHelmHead({ ...opts, active: 'dashboard', readout: { running: 1, queued: 0, review: 2 }, greetingName: '<img src=x> Review' }));
    expect(element.querySelector('[data-greeting]')?.textContent).toBe(`${enabled ? 'Ahoy' : 'Hello'}, <img src=x> Review!`);
    expect(element.querySelector('img')).toBeNull();
    expect(element.querySelector('[data-view="dashboard"]')?.textContent).toBe(enabled ? 'Helm' : 'Dashboard');
    expect(element.querySelector('[data-view="prs"]')?.textContent).toBe(enabled ? 'Bounties' : 'PRs');
    expect(element.querySelector('[data-view="runs"]')?.textContent).toBe(enabled ? 'Voyages' : 'Runs');
    expect(element.querySelector('.repo-select')?.getAttribute('aria-label')).toBe(enabled ? 'Scope by galleon' : 'Scope by repository');
    expect(element.querySelector('[data-readout-label="review"]')?.textContent).toBe(enabled ? 'inspection' : 'review');
    expect(element.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/agent-review');
  });

  it.each([true, false])('preserves user titles, repository IDs and machine status with mode=%s', enabled => {
    setPirateMode(enabled);
    const element = mount(renderVoyage({ id: 'review-agent', ticketId: 'Review PR tokens voyage', repo: 'org/agent-review', status: 'failed', attempt: 1, prNumber: null, startedAt: '', costUsd: null }));
    expect(element.querySelector('.ticket-id')?.textContent).toBe('Review PR tokens voyage');
    expect(element.querySelector('.agent-repo')?.getAttribute('title')).toBe('org/agent-review');
    expect(element.querySelector('[data-retry-run-id]')?.getAttribute('data-retry-run-id')).toBe('review-agent');
    expect(runTabStatus('failed')).toEqual({ kind: 'failed', label: enabled ? 'Marooned' : 'Failed' });
  });

  it.each([true, false])('reflects mode=%s in Appearance and keeps credential tokens literal', enabled => {
    setPirateMode(enabled);
    const element = mount(renderConfigView({ config: {}, overridden: [] }, opts));
    expect(element.querySelector<HTMLInputElement>('[data-pirate-mode]')?.checked).toBe(enabled);
    expect(element.querySelectorAll('.terminology-reference tbody tr')).toHaveLength(10);
    expect(element.querySelector('#config-SLACK_BOT_TOKEN')?.getAttribute('placeholder')).toBe('Paste bot token to update');
    expect(element.querySelector('#work-source-title')?.textContent).toBe(enabled ? 'Voyage source' : 'Run source');
  });
});
