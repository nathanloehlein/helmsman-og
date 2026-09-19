import { afterEach, describe, expect, it } from 'vitest';
import { renderThemePreview } from './renderThemePreview';
import { setPirateMode } from './logic/terminology';

afterEach(() => { setPirateMode(true); localStorage.clear(); });

describe('renderThemePreview', () => {
  it.each([true, false])('updates review labels at render time for pirate mode=%s without changing verdict meanings', enabled => {
    setPirateMode(enabled);
    document.body.innerHTML = renderThemePreview();
    const swatches = [...document.querySelectorAll('.theme-preview-swatch')];
    expect(swatches[7]?.textContent?.trim()).toBe(enabled ? 'Inspection' : 'Review');
    expect(document.querySelector('.chip-review')?.textContent).toBe(enabled ? 'Inspection needed' : 'Review needed');
    expect(document.querySelector('.chip-done')?.textContent).toBe('Approved');
    expect(document.querySelector('.chip-blocked')?.textContent).toBe('Changes requested');
  });

  it('identifies palette and status samples without adding controls or live status announcements', () => {
    document.body.innerHTML = renderThemePreview();

    expect(document.querySelector('#theme-preview-title')?.textContent).toBe('Selected theme preview');
    expect(document.querySelector('[aria-label="Sample statuses"]')?.textContent).toContain('Status examples');
    expect(document.querySelector('button, input, select, a, [role="status"], [aria-live]')).toBeNull();
    for (const swatch of document.querySelectorAll('.theme-preview-swatch')) {
      expect(swatch.textContent?.trim()).toBeTruthy();
      expect(swatch.querySelector('.theme-preview-color')?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('inherits every displayed color from the selected theme rather than capturing a palette at render time', () => {
    document.body.innerHTML = renderThemePreview();
    const colors = Array.from(document.querySelectorAll<HTMLElement>('.theme-preview-color'), (element) => element.style.background);

    expect(colors).toEqual([
      'var(--bg)', 'var(--panel)', 'var(--panel-hi)', 'var(--accent)', 'var(--text)',
      'var(--text-dim)', 'var(--good)', 'var(--review)', 'var(--queued)', 'var(--bad)',
    ]);
  });
});
