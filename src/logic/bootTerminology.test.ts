import html from '../../index.html?raw';
import { afterEach, describe, expect, it } from 'vitest';
import { applyBootTerminology } from './bootTerminology';
import { setPirateMode } from './terminology';

afterEach(() => { setPirateMode(true); localStorage.clear(); });

function bootElement(): HTMLElement {
  const document = new DOMParser().parseFromString(html, 'text/html');
  return document.querySelector<HTMLElement>('#boot')!;
}

describe('boot terminology', () => {
  it('uses neutral initial HTML before the saved mode loads', () => {
    const boot = bootElement();
    expect(boot.getAttribute('aria-label')).toBe('Helmsman is starting');
    expect(boot.querySelector('.boot-tag')?.textContent).toBe('LOADING DASHBOARD · PREPARING WORKSPACE');
    expect(boot.textContent).not.toMatch(/helm\b|crew|underway|charted|plotted/i);
  });

  it.each([true, false])('applies mode %s to actual boot labels and accessibility text', enabled => {
    setPirateMode(enabled);
    const boot = bootElement();
    const emblem = boot.querySelector('svg');
    const progress = boot.querySelector('.boot-pct');
    applyBootTerminology(boot);
    expect(boot.getAttribute('aria-label')).toBe(enabled ? 'Helmsman preparing to get underway' : 'Helmsman is starting');
    expect(boot.querySelector('.boot-tag')?.textContent).toBe(enabled ? 'TAKING THE HELM · CHARTING THE COURSE' : 'LOADING DASHBOARD · PREPARING WORKSPACE');
    expect([...boot.querySelectorAll('.boot-log li')].map(row => row.textContent)).toEqual(enabled
      ? ['navigation · ready', 'heading · set', 'course · plotted', 'crew · standing by', 'ready to get underway']
      : ['navigation · ready', 'settings · loaded', 'workspace · ready', 'agents · standing by', 'ready to start']);
    expect(boot.querySelector('svg')).toBe(emblem);
    expect(boot.querySelector('.boot-pct')).toBe(progress);
    expect(progress?.textContent).toBe('0');
  });

  it('changes only recognized boot labels inside the supplied root', () => {
    setPirateMode(false);
    const boot = bootElement();
    const userContent = document.createElement('span');
    userContent.dataset.bootTerm = 'unknown';
    userContent.textContent = 'Crew reviewing voyage';
    boot.append(userContent);
    applyBootTerminology(boot);
    expect(userContent.textContent).toBe('Crew reviewing voyage');
    expect(() => applyBootTerminology(document.createElement('div'))).not.toThrow();
  });
});
