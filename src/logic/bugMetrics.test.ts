import { describe, expect, it } from 'vitest';
import {
  priorityRank, daysUntil, ageDays, slaLabel, percentile, sortBugs, assembleCard,
} from './bugMetrics';
import type { BugRow } from '../types';

const NOW = new Date('2026-09-15T16:00:00Z');

function row(over: Partial<BugRow> = {}): BugRow {
  return {
    key: 'AB-1', title: 't', priority: 'P2 - Medium', severity: 'S2 - Medium',
    sla: { text: 'SLA in 3d', overdue: false, days: 3 }, ...over,
  };
}

describe('priorityRank', () => {
  it('parses the leading P<n>', () => {
    expect(priorityRank('P1 - High')).toBe(1);
    expect(priorityRank('P3 - Low')).toBe(3);
  });
  it('ranks unknown/null last', () => {
    expect(priorityRank(null)).toBeGreaterThan(900);
    expect(priorityRank('Blocker')).toBeGreaterThan(900);
  });
});

describe('daysUntil', () => {
  it('returns negative days when duedate is in the past', () => {
    expect(daysUntil('2026-09-08', NOW)).toBe(-7);
  });
  it('returns 0 when duedate is today (UTC midnight)', () => {
    expect(daysUntil('2026-09-15', NOW)).toBe(0);
  });
  it('returns positive days when duedate is in the future', () => {
    expect(daysUntil('2026-09-21', NOW)).toBe(6);
  });
  it('returns null when duedate is null', () => {
    expect(daysUntil(null, NOW)).toBeNull();
  });
});

describe('daysUntil / slaLabel', () => {
  it('is negative and overdue when duedate is in the past', () => {
    const s = slaLabel('2026-09-08', NOW);
    expect(s.overdue).toBe(true);
    expect(s.text).toBe('Past SLA by 7d');
    expect(s.days).toBe(-7);
  });
  it('is future and not overdue when ahead', () => {
    const s = slaLabel('2026-09-21', NOW);
    expect(s.overdue).toBe(false);
    expect(s.text).toBe('SLA in 6d');
    expect(s.days).toBe(6);
  });
  it('treats due-today as SLA in 0d, not overdue', () => {
    const s = slaLabel('2026-09-15', NOW);
    expect(s.overdue).toBe(false);
    expect(s.text).toBe('SLA in 0d');
    expect(s.days).toBe(0);
  });
  it('renders a dash when duedate is null', () => {
    const s = slaLabel(null, NOW);
    expect(s).toEqual({ text: '—', overdue: false, days: null });
  });
});

describe('ageDays', () => {
  it('counts whole days since a date', () => {
    expect(ageDays('2026-06-25T16:00:00Z', NOW)).toBe(82);
  });
});

describe('percentile', () => {
  it('returns null for empty input', () => {
    expect(percentile([], 75)).toBeNull();
  });
  it('returns the only value for a single element', () => {
    expect(percentile([9.4], 75)).toBe(9.4);
  });
  it('interpolates the 75th percentile', () => {
    expect(percentile([1, 2, 3, 4, 5], 75)).toBe(4);
  });
});

describe('sortBugs', () => {
  it('orders by priority, then overdue-first, then soonest due, then key', () => {
    const rows: BugRow[] = [
      row({ key: 'C', priority: 'P3 - Low', sla: { text: '', overdue: false, days: 5 } }),
      row({ key: 'A', priority: 'P1 - High', sla: { text: '', overdue: false, days: 6 } }),
      row({ key: 'B', priority: 'P2 - Medium', sla: { text: '', overdue: true, days: -2 } }),
      row({ key: 'D', priority: 'P2 - Medium', sla: { text: '', overdue: false, days: 1 } }),
    ];
    expect(sortBugs(rows).map((r) => r.key)).toEqual(['A', 'B', 'D', 'C']);
  });
});

describe('assembleCard', () => {
  it('computes delta, oldest age, p75, and sorts rows (not capped)', () => {
    const card = assembleCard({
      project: 'AIROBUILD', repo: 'o/a', label: 'Airo Editing', jiraBaseUrl: 'https://x', now: NOW,
      open: 20, createdLast7d: 10, completedLast7d: 6, pastSla: 7,
      oldestKey: 'AB-2992', oldestCreated: '2026-06-25T16:00:00Z',
      rows: [row({ key: 'Z', priority: 'P3 - Low' }), row({ key: 'Y', priority: 'P1 - High' })],
      durations: [1, 2, 3, 4, 5], durationsTotal: 5,
    });
    expect(card.open).toBe(20);
    expect(card.delta).toBe(4);
    expect(card.completed).toBe(6);
    expect(card.pastSla).toBe(7);
    expect(card.oldest).toEqual({ key: 'AB-2992', ageDays: 82 });
    expect(card.p75).toEqual({ days: 4, n: 5, capped: false });
    expect(card.rows.map((r) => r.key)).toEqual(['Y', 'Z']);
    expect(card.degraded).toBe(false);
  });
  it('flags p75 capped when durationsTotal exceeds the sample size', () => {
    const card = assembleCard({
      project: 'P', repo: null, label: 'P', jiraBaseUrl: null, now: NOW,
      open: 0, createdLast7d: 0, completedLast7d: 0, pastSla: 0,
      oldestKey: null, oldestCreated: null, rows: [],
      durations: new Array(100).fill(5), durationsTotal: 140,
    });
    expect(card.p75).toEqual({ days: 5, n: 140, capped: true });
    expect(card.oldest).toBeNull();
  });
});
