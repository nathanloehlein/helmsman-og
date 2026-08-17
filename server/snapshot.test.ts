import { describe, expect, it } from 'vitest';
import {
  issueToTicket,
  mapPriority,
  mapPrStatus,
  mapStatus,
  parseTicketId,
  prToShipped,
} from './snapshot';
import type { GithubPr, JiraIssue } from './types';

function pr(over: Partial<GithubPr> = {}): GithubPr {
  return {
    number: 10,
    title: 'AIROBUILD-482 add retry',
    headRef: 'feature/AIROBUILD-482-retry',
    authorLogin: 'bot',
    mergedAt: null,
    createdAt: '2026-08-17T00:00:00.000Z',
    reviewDecision: null,
    ...over,
  };
}

function issue(over: Partial<JiraIssue['fields']> = {}): JiraIssue {
  return {
    key: 'AIROBUILD-1',
    fields: {
      summary: 'Do a thing',
      status: { name: 'Backlog', statusCategory: { key: 'new' } },
      priority: { name: 'P2 - Medium' },
      resolutiondate: null,
      ...over,
    },
  };
}

describe('mapPriority', () => {
  it.each([
    ['P1 - Critical', 'P1'],
    ['Highest', 'P1'],
    ['High', 'P1'],
    ['P2 - Medium', 'P2'],
    ['Medium', 'P2'],
    ['P3 - Low', 'P3'],
    ['Low', 'P3'],
    [null, 'P3'],
    ['Weird', 'P3'],
  ])('%s -> %s', (input, expected) => {
    expect(mapPriority(input)).toBe(expected);
  });
});

describe('mapStatus', () => {
  it.each([
    ['Backlog', 'new', 'backlog'],
    ['To Do', 'new', 'backlog'],
    ['In Progress', 'indeterminate', 'in-progress'],
    ['In Review', 'indeterminate', 'in-review'],
    ['Done', 'done', 'done'],
  ])('%s/%s -> %s', (name, cat, expected) => {
    expect(mapStatus(name, cat)).toBe(expected);
  });
});

describe('parseTicketId', () => {
  it('reads id from the title', () => {
    expect(parseTicketId(pr({ title: 'AIROBUILD-482 add retry' }))).toBe('AIROBUILD-482');
  });
  it('falls back to the branch', () => {
    expect(parseTicketId(pr({ title: 'add retry', headRef: 'x/DEVX-9-y' }))).toBe('DEVX-9');
  });
  it('returns null when neither matches', () => {
    expect(parseTicketId(pr({ title: 'add retry', headRef: 'main' }))).toBeNull();
  });
});

describe('mapPrStatus', () => {
  it('merged wins', () => {
    expect(mapPrStatus(pr({ mergedAt: '2026-08-17T01:00:00.000Z' }))).toBe('merged');
  });
  it('changes requested', () => {
    expect(mapPrStatus(pr({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe('changes-requested');
  });
  it('defaults to in-review', () => {
    expect(mapPrStatus(pr())).toBe('in-review');
  });
});

describe('issueToTicket', () => {
  it('maps fields', () => {
    const t = issueToTicket(issue(), 'o/r');
    expect(t).toEqual({ id: 'AIROBUILD-1', title: 'Do a thing', priority: 'P2', status: 'backlog', repo: 'o/r' });
  });
});

describe('prToShipped', () => {
  it('maps a merged PR', () => {
    const s = prToShipped(pr({ number: 5, title: 'AIROBUILD-3 fix', mergedAt: '2026-08-17T02:00:00.000Z' }));
    expect(s).toEqual({ number: 5, title: 'AIROBUILD-3 fix', ticketId: 'AIROBUILD-3', status: 'merged', openedAt: '2026-08-17T00:00:00.000Z' });
  });
  it('uses em dash when no ticket id', () => {
    expect(prToShipped(pr({ title: 'fix', headRef: 'main' })).ticketId).toBe('—');
  });
});

import { buildActivity, buildSteps } from './snapshot';
import type { ActivityEvent, WorkStep } from '../src/types';

const CURRENT: JiraIssue = {
  key: 'AIROBUILD-482',
  fields: {
    summary: 'Add retry',
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'P2 - Medium' },
    resolutiondate: null,
  },
  changelog: {
    histories: [
      { created: '2026-08-17T00:00:00.000Z', items: [{ field: 'status', fromString: null, toString: 'Backlog' }] },
      { created: '2026-08-17T01:00:00.000Z', items: [{ field: 'status', fromString: 'Backlog', toString: 'In Progress' }] },
    ],
  },
};

describe('buildActivity', () => {
  it('merges status transitions and PR events, newest first', () => {
    const prs: GithubPr[] = [
      { number: 7, title: 'AIROBUILD-482 retry', headRef: 'f/AIROBUILD-482', authorLogin: 'bot', mergedAt: '2026-08-17T03:00:00.000Z', createdAt: '2026-08-17T01:00:00.000Z', reviewDecision: null },
    ];
    const feed = buildActivity([CURRENT], prs);
    expect(feed[0].time).toBe('2026-08-17T03:00:00.000Z');
    expect(feed[0].text).toContain('merged');
    expect(feed[0].accent).toBe(true);
    const times = feed.map((e) => e.time);
    expect(times).toEqual([...times].sort().reverse());
  });

  it('caps at 12 events', () => {
    const many: JiraIssue[] = Array.from({ length: 20 }, (_, i) => ({
      key: `K-${i}`,
      fields: { summary: 's', status: { name: 'Done', statusCategory: { key: 'done' } }, priority: null, resolutiondate: null },
      changelog: { histories: [{ created: `2026-08-1${i % 9}T00:00:00.000Z`, items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }] }] },
    }));
    expect(buildActivity(many, []).length).toBe(12);
  });
});

describe('buildSteps', () => {
  it('turns transitions into done steps and marks the tail active while in progress', () => {
    const steps = buildSteps(CURRENT, []);
    expect(steps[0].state).toBe('done');
    expect(steps[steps.length - 1].state).toBe('active');
  });

  it('adds a step for a linked PR', () => {
    const prs: GithubPr[] = [
      { number: 9, title: 'AIROBUILD-482 retry', headRef: 'f/AIROBUILD-482', authorLogin: 'bot', mergedAt: null, createdAt: '2026-08-17T02:00:00.000Z', reviewDecision: null },
    ];
    const steps = buildSteps(CURRENT, prs);
    expect(steps.some((s) => s.text.includes('#9'))).toBe(true);
  });
});
