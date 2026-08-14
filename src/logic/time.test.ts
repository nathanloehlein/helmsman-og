import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './time';

describe('formatRelativeTime', () => {
  const now = new Date('2026-08-14T12:00:00Z');

  it('reports seconds-old timestamps as just now', () => {
    expect(formatRelativeTime('2026-08-14T11:59:45Z', now)).toBe('just now');
  });

  it('reports minutes ago under an hour', () => {
    expect(formatRelativeTime('2026-08-14T11:34:00Z', now)).toBe('26m ago');
  });

  it('reports hours ago under a day', () => {
    expect(formatRelativeTime('2026-08-14T08:00:00Z', now)).toBe('4h ago');
  });

  it('reports days ago at a day or more', () => {
    expect(formatRelativeTime('2026-08-12T12:00:00Z', now)).toBe('2d ago');
  });
});
