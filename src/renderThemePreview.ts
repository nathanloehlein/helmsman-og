import './themePreview.css';
import { term } from './logic/terminology';

const SWATCHES = [
  ['Background', '--bg'],
  ['Panel', '--panel'],
  ['Raised', '--panel-hi'],
  ['Accent', '--accent'],
  ['Text', '--text'],
  ['Muted', '--text-dim'],
  ['Approved', '--good'],
  ['Review', '--review'],
  ['Queued', '--queued'],
  ['Changes', '--bad'],
] as const;

export function renderThemePreview(): string {
  return `<section class="theme-preview" aria-labelledby="theme-preview-title">
    <div class="theme-preview-heading">
      <h3 id="theme-preview-title">Selected theme preview</h3>
      <span class="theme-preview-caption">Palette &amp; sample statuses</span>
    </div>
    <ul class="theme-preview-palette" aria-label="Theme colors">
      ${SWATCHES.map(([label, variable]) => `<li class="theme-preview-swatch">
        <span class="theme-preview-color" style="background: var(${variable})" aria-hidden="true"></span>
        <span>${variable === '--review' ? term('review') : label}</span>
      </li>`).join('')}
    </ul>
    <div class="theme-preview-statuses" role="group" aria-label="Sample statuses">
      <span class="theme-preview-caption">Status examples</span>
      <span class="chip chip-done">Approved</span>
      <span class="chip chip-review">${term('review')} needed</span>
      <span class="chip chip-queued">Queued</span>
      <span class="chip chip-blocked">Changes requested</span>
    </div>
  </section>`;
}
