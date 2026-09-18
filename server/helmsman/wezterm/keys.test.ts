import { describe, expect, it } from 'vitest';
import { keyToBytes } from './keys';

describe('keyToBytes', () => {
  it('maps the browser token vocabulary', () => {
    expect(keyToBytes('enter')).toBe('\r');
    expect(keyToBytes('escape')).toBe('\x1b');
    expect(keyToBytes('tab')).toBe('\t');
    expect(keyToBytes('backspace')).toBe('\x7f');
    expect(keyToBytes('up')).toBe('\x1b[A');
    expect(keyToBytes('pagedown')).toBe('\x1b[6~');
  });

  it('maps the cmux action vocabulary so actions.ts needs no changes', () => {
    expect(keyToBytes('Enter')).toBe('\r');
    expect(keyToBytes('Escape')).toBe('\x1b');
    expect(keyToBytes('C-c')).toBe('\x03');
  });

  it('maps ctrl chords in both spellings', () => {
    expect(keyToBytes('ctrl+c')).toBe('\x03');
    expect(keyToBytes('ctrl+a')).toBe('\x01');
    expect(keyToBytes('ctrl+z')).toBe('\x1a');
    expect(keyToBytes('C-z')).toBe('\x1a');
  });

  it("passes single printable characters through, as 'approve' needs", () => {
    expect(keyToBytes('y')).toBe('y');
  });

  it('refuses an unknown token rather than typing it as text', () => {
    expect(keyToBytes('F13')).toBeNull();
    expect(keyToBytes('rm -rf /')).toBeNull();
    expect(keyToBytes('')).toBeNull();
  });
});
