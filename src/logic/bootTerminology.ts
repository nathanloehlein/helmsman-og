import { term } from './terminology';

const BOOT_TERMS = ['bootTagline', 'bootNavigation', 'bootHeading', 'bootCourse', 'bootCrew', 'bootReady'] as const;

export function applyBootTerminology(boot: HTMLElement): void {
  boot.setAttribute('aria-label', term('bootStatus'));
  for (const key of BOOT_TERMS) {
    for (const element of boot.querySelectorAll<HTMLElement>(`[data-boot-term="${key}"]`)) {
      element.textContent = term(key);
    }
  }
}
