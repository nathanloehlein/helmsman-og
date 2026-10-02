import './themePreview.css';
import { term } from './logic/terminology';

const SWATCHES = [
  ['Background', '--bg'],
  ['Panel', '--panel'],
  ['Raised', '--panel-hi'],
  ['Accent', '--accent'],
  ['Companion', '--secondary'],
  ['Text', '--text'],
  ['Muted', '--text-dim'],
] as const;

export function renderThemePreview(): string {
  return `<section class="theme-preview" aria-labelledby="theme-preview-title">
    <div class="theme-preview-heading">
      <h3 id="theme-preview-title">Selected theme preview</h3>
    </div>
    <div class="theme-preview-samples">
      <div class="theme-preview-palette-group">
        <span class="theme-preview-caption" id="theme-palette-label">Surfaces &amp; accents</span>
        <ul class="theme-preview-palette" aria-labelledby="theme-palette-label">
          ${SWATCHES.map(([label, variable]) => `<li class="theme-preview-swatch">
            <span class="theme-preview-color" style="background: var(${variable})" aria-hidden="true"></span>
            <span>${label}</span>
          </li>`).join('')}
        </ul>
      </div>
      <div class="theme-preview-status-group" role="group" aria-label="Sample statuses">
        <span class="theme-preview-caption">Status examples</span>
        <div class="theme-preview-statuses">
          <span class="chip chip-done">Approved</span>
          <span class="chip chip-review">${term('review')} needed</span>
          <span class="chip chip-queued">Queued</span>
          <span class="chip chip-blocked">Changes requested</span>
        </div>
      </div>
    </div>
  </section>`;
}
