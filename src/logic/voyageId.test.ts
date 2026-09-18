import { describe, expect, it } from 'vitest';
import { shortVoyageId } from './voyageId';

describe('shortVoyageId', () => {
  it('uses twelve UUID hex characters, excluding separators', () => {
    expect(shortVoyageId('b5fcda70-6766-461d-a828-bd1fe233a580')).toBe('b5fcda706766');
  });

  it.each(['slack', 'github'])('preserves the %s source and twelve digest characters', source => {
    expect(shortVoyageId(`${source}-1234567890abcdef0123456789abcdef`)).toBe(`${source}-1234567890ab`);
  });

  it('preserves custom IDs and tolerates absent values', () => {
    expect(shortVoyageId('run-123')).toBe('run-123');
    expect(shortVoyageId('github-custom-run')).toBe('github-custom-run');
    expect(shortVoyageId(null)).toBe('');
    expect(shortVoyageId(undefined)).toBe('');
    expect(shortVoyageId(42)).toBe('');
  });
});
