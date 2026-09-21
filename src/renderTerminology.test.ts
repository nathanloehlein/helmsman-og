import { afterEach, describe, expect, it } from 'vitest';
import { renderAppShell, renderConfigView, renderHelmHead, renderVoyage, renderTriageView, runTabStatus } from './render';
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
    expect(element.querySelector('.helm-readout')?.getAttribute('aria-label')).toBe(enabled ? 'Fleet status' : 'System status');
    expect(element.querySelector('[data-readout-label="review"]')?.textContent).toBe(enabled ? 'inspection' : 'review');
    expect(element.querySelector<HTMLSelectElement>('.repo-select')?.value).toBe('org/agent-review');
  });

  it.each([true, false])('uses the same mapped Mine heading in Triage with mode=%s', enabled => {
    setPirateMode(enabled);
    const element = mount(renderTriageView({ unassignedBacklog: [], unassignedTodo: [], mineOpen: [] }, { ...opts, jiraBaseUrl: null, degraded: false }));
    expect(element.querySelector('[data-collapse-id="triage:mine"]')?.closest('.panel')?.querySelector('.panel-title')?.textContent).toContain(enabled ? 'Mine · underway' : 'Mine · running');
  });

  it.each([true, false])('preserves user titles, repository IDs and machine status with mode=%s', enabled => {
    setPirateMode(enabled);
    const element = mount(renderVoyage({ id: 'review-agent', ticketId: 'Review PR tokens voyage', repo: 'org/agent-review', status: 'failed', attempt: 1, prNumber: null, startedAt: '', costUsd: null }));
    expect(element.querySelector('.ticket-id')?.textContent).toBe('Review PR tokens voyage');
    expect(element.querySelector('.agent-repo')?.getAttribute('title')).toBe('org/agent-review');
    expect(element.querySelector('[data-retry-run-id]')?.getAttribute('data-retry-run-id')).toBe('review-agent');
    expect(runTabStatus('failed')).toEqual({ kind: 'failed', label: enabled ? 'Marooned' : 'Failed' });
  });

  it.each([true, false])('reflects mode=%s in the footer and keeps the Appearance reference and browser setup literal', enabled => {
    setPirateMode(enabled);
    const element = mount(renderConfigView({ config: {}, overridden: [] }, opts));
    expect(element.querySelectorAll('[data-pirate-mode]')).toHaveLength(1);
    expect(element.querySelector('.app-footer [data-pirate-mode]')?.getAttribute('aria-pressed')).toBe(String(enabled));
    expect(element.querySelector('.app-footer [data-pirate-mode]')?.getAttribute('title')).toBe(`Turn Pirate mode ${enabled ? 'off' : 'on'}`);
    expect(element.querySelector('.ui-customization-panel [data-pirate-mode]')).toBeNull();
    expect(element.querySelector('#pirate-mode-help')?.textContent).toContain('flag at the bottom-right');
    const rows = Array.from(element.querySelectorAll('.terminology-reference tbody tr'), row => Array.from(row.querySelectorAll('td'), cell => cell.textContent));
    expect(rows).toEqual(expect.arrayContaining([
      ['Dashboard', 'Helm'], ['Runs', 'Voyages'], ['Repositories', 'Galleons'],
      ['Agents', 'Crew'], ['Running', 'Underway'], ['System status', 'Fleet status'],
      ['Completed work', 'Out to sea'], ['Activity log', "Ship's log"],
    ]));
    expect(element.querySelector('#slack-review-setup')?.textContent).toContain('signed-in Slack browser');
    expect(element.querySelector('#work-source-title')?.textContent).toBe(enabled ? 'Voyage source' : 'Run source');
  });

  it.each(['dashboard', 'prs', 'runs', 'todos', 'triage', 'bugs', 'cmux', 'config'] as const)('provides accessible feedback beside one footer flag on %s', active => {
    setPirateMode(false);
    const element = mount(renderAppShell({ ...opts, active, readout: null }, 'Content'));
    const button = element.querySelector<HTMLButtonElement>('.app-footer [data-pirate-mode]');
    expect(element.querySelectorAll('[data-pirate-mode]')).toHaveLength(1);
    expect(button?.type).toBe('button');
    expect(button?.getAttribute('aria-label')).toBe('Pirate mode');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.title).toBe('Turn Pirate mode on');
    expect(button?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(button?.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor');
    const feedback = element.querySelector<HTMLButtonElement>('.app-footer [data-feedback]');
    expect(element.querySelectorAll('[data-feedback]')).toHaveLength(1);
    expect(feedback?.type).toBe('button');
    expect(feedback?.textContent).toBe('Feedback');
    expect(feedback?.nextElementSibling).toBe(button);
    expect(feedback?.parentElement).toBe(button?.parentElement);
    expect(button?.closest('.footer-actions')?.previousElementSibling?.classList.contains('footer-meta')).toBe(true);
  });
});
