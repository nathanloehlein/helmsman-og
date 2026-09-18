import { describe, expect, it } from 'vitest';
import { sortByPriority } from './queue';
import type { Ticket } from '../types';

function ticket(id: string, priority: Ticket['priority']): Ticket {
  return { id, priority, title: id, status: 'backlog', repo: 'test/repo' };
}

describe('sortByPriority', () => {
  it('preserves the full priority range with P0 first and P4 last', () => {
    const input = [ticket('a', 'P4'), ticket('b', 'P2'), ticket('c', 'P0'), ticket('d', 'P3'), ticket('e', 'P1')];
    expect(sortByPriority(input).map((t) => t.id)).toEqual(['c', 'e', 'b', 'd', 'a']);
  });

  it('orders P1 before P2 before P3', () => {
    const input = [ticket('a', 'P3'), ticket('b', 'P1'), ticket('c', 'P2')];
    expect(sortByPriority(input).map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('keeps original order within the same priority', () => {
    const input = [ticket('a', 'P2'), ticket('b', 'P1'), ticket('c', 'P2'), ticket('d', 'P1')];
    expect(sortByPriority(input).map((t) => t.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const input = [ticket('a', 'P3'), ticket('b', 'P1')];
    sortByPriority(input);
    expect(input.map((t) => t.id)).toEqual(['a', 'b']);
  });
});
