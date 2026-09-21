import { describe, expect, it } from 'vitest';
import type { RunSummary } from '../data/agents';
import type { OpenPr, Ticket } from '../types';
import { resolveUnderwayTarget, type UnderwayOptions } from './underway';

const ticket: Ticket = { id: 'ABC-1', title: 'Fix issue', priority: 'P2', status: 'in-review', repo: 'display label' };
const run = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  id: 'run-1', ticketId: 'ABC-1', repo: 'org/app', status: 'succeeded', attempt: 1,
  prNumber: 12, startedAt: '2026-09-20T10:00:00Z', costUsd: null, ...overrides,
});
const pr = (overrides: Partial<OpenPr> = {}): OpenPr => ({
  repo: 'org/app', number: 12, title: 'Fix issue', reviewDecision: 'REVIEW_REQUIRED',
  draft: false, createdAt: '2026-09-20T11:00:00Z', ...overrides,
});
const options = (overrides: Partial<UnderwayOptions> = {}): UnderwayOptions => ({
  selectedRepo: null, runs: [], prs: [], prsAvailable: true, ...overrides,
});

describe('resolveUnderwayTarget', () => {
  it('links exact persisted PR identity even when the title lacks its ticket', () => {
    const matching = run();
    expect(resolveUnderwayTarget(ticket, options({ runs: [matching], prs: [pr()] }))).toEqual({
      run: matching, prs: [{ repo: 'org/app', number: 12, canRequest: true }],
    });
  });

  it('selects the latest exact-ticket run without mutating input', () => {
    const older = run();
    const latest = run({ id: 'run-2', startedAt: '2026-09-21T10:00:00Z' });
    const unrelated = run({ id: 'other', ticketId: 'ABC-10', startedAt: '2026-09-22T10:00:00Z' });
    const runs = [older, latest, unrelated];
    expect(resolveUnderwayTarget(ticket, options({ runs })).run).toBe(latest);
    expect(runs).toEqual([older, latest, unrelated]);
  });

  it('prefers an active run for in-progress tickets but the newest run for review', () => {
    const active = run({ status: 'running' });
    const latest = run({ id: 'run-2', startedAt: '2026-09-21T10:00:00Z' });
    const input = options({ runs: [active, latest] });
    expect(resolveUnderwayTarget({ ...ticket, status: 'in-progress' }, input).run).toBe(active);
    expect(resolveUnderwayTarget(ticket, input).run).toBe(latest);
  });

  it('honors header scope with case-insensitive identities', () => {
    const matching = run({ repo: 'Org/App' });
    expect(resolveUnderwayTarget(ticket, options({ selectedRepo: 'org/app', runs: [matching, run({ repo: 'org/other' })],
      prs: [pr(), pr({ repo: 'org/other', title: 'ABC-1 fix' })] }))).toEqual({
      run: matching, prs: [{ repo: 'org/app', number: 12, canRequest: true }],
    });
  });

  it('keeps explicit PR choices but does not guess a run across galleons', () => {
    const result = resolveUnderwayTarget(ticket, options({
      runs: [run(), run({ id: 'other', repo: 'org/other' })], prs: [pr(), pr({ repo: 'org/other' })],
    }));
    expect(result.run).toBeNull();
    expect(result.prs).toEqual([
      { repo: 'org/app', number: 12, canRequest: true }, { repo: 'org/other', number: 12, canRequest: true },
    ]);
  });

  it('uses whole Jira tokens for authored-open title matches and preserves multiple choices', () => {
    const result = resolveUnderwayTarget(ticket, options({ prs: [
      pr({ number: 1, title: '[ABC-1] fix' }), pr({ number: 2, title: 'Fix ABC-1: tests' }),
      pr({ number: 3, title: 'ABC-10 fix' }), pr({ number: 4, title: 'XABC-1 fix' }),
      pr({ number: 5, title: 'ABC-1-extra fix' }),
    ] }));
    expect(result).toEqual({ run: null, prs: [
      { repo: 'org/app', number: 1, canRequest: true }, { repo: 'org/app', number: 2, canRequest: true },
    ] });
  });

  it('deduplicates persisted and title matches, keeping drafts navigable without send actions', () => {
    expect(resolveUnderwayTarget(ticket, options({ runs: [run(), run({ id: 'older' })],
      prs: [pr({ title: 'ABC-1 fix', draft: true })] })).prs).toEqual([
      { repo: 'org/app', number: 12, canRequest: false },
    ]);
  });

  it('allows persisted PR navigation without GitHub but never trusts unavailable title data for sending', () => {
    expect(resolveUnderwayTarget(ticket, options({ runs: [run()], prsAvailable: false,
      prs: [pr(), pr({ number: 99, title: 'ABC-1 fix' })] })).prs).toEqual([
      { repo: 'org/app', number: 12, canRequest: false },
    ]);
  });

  it('omits persisted PRs no longer present in an available authored-open list', () => {
    expect(resolveUnderwayTarget(ticket, options({ runs: [run()] })).prs).toEqual([]);
  });

  it('does not guess a run when a title match identifies another galleon', () => {
    expect(resolveUnderwayTarget(ticket, options({ runs: [run()], prs: [pr({ repo: 'org/other', title: 'ABC-1 fix' })] })).run).toBeNull();
  });

  it('handles missing and malformed external items', () => {
    const input = options({ runs: [null, {}, run({ repo: '../bad', prNumber: -1 })] as RunSummary[],
      prs: [null, {}, pr({ number: NaN }), pr({ repo: 'org/..' })] as OpenPr[] });
    expect(resolveUnderwayTarget(ticket, input)).toEqual({ run: null, prs: [] });
    expect(resolveUnderwayTarget(null as unknown as Ticket, input)).toEqual({ run: null, prs: [] });
    expect(resolveUnderwayTarget(ticket, options({ runs: undefined, prs: undefined }))).toEqual({ run: null, prs: [] });
  });

  it('does not infer PRs from non-Jira task identifiers', () => {
    expect(resolveUnderwayTarget({ ...ticket, id: 'freeform' }, options({ prs: [pr({ title: 'freeform task' })] })).prs).toEqual([]);
  });
});
