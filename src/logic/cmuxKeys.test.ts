import { describe, expect, it } from 'vitest';
import { mapKeyEvent } from './cmuxKeys';

interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

function evt(over: Partial<KeyEventLike>): KeyEventLike {
  return { key: '', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...over };
}

describe('mapKeyEvent', () => {
  it('ignores meta-held keys', () => {
    expect(mapKeyEvent(evt({ key: 'c', metaKey: true }))).toEqual({ kind: 'ignore' });
  });

  it('maps ctrl+letter to a lowercase ctrl token', () => {
    expect(mapKeyEvent(evt({ key: 'C', ctrlKey: true }))).toEqual({ kind: 'key', token: 'ctrl+c' });
  });

  it('maps named special keys', () => {
    expect(mapKeyEvent(evt({ key: 'ArrowUp' }))).toEqual({ kind: 'key', token: 'up' });
    expect(mapKeyEvent(evt({ key: 'ArrowDown' }))).toEqual({ kind: 'key', token: 'down' });
    expect(mapKeyEvent(evt({ key: 'ArrowLeft' }))).toEqual({ kind: 'key', token: 'left' });
    expect(mapKeyEvent(evt({ key: 'ArrowRight' }))).toEqual({ kind: 'key', token: 'right' });
    expect(mapKeyEvent(evt({ key: 'Tab' }))).toEqual({ kind: 'key', token: 'tab' });
    expect(mapKeyEvent(evt({ key: 'Escape' }))).toEqual({ kind: 'key', token: 'escape' });
    expect(mapKeyEvent(evt({ key: 'Backspace' }))).toEqual({ kind: 'key', token: 'backspace' });
    expect(mapKeyEvent(evt({ key: 'Enter' }))).toEqual({ kind: 'key', token: 'enter' });
    expect(mapKeyEvent(evt({ key: 'Home' }))).toEqual({ kind: 'key', token: 'home' });
    expect(mapKeyEvent(evt({ key: 'End' }))).toEqual({ kind: 'key', token: 'end' });
    expect(mapKeyEvent(evt({ key: 'PageUp' }))).toEqual({ kind: 'key', token: 'pageup' });
    expect(mapKeyEvent(evt({ key: 'PageDown' }))).toEqual({ kind: 'key', token: 'pagedown' });
  });

  it('maps a printable character to text', () => {
    expect(mapKeyEvent(evt({ key: 'a' }))).toEqual({ kind: 'text', text: 'a' });
  });

  it('keeps shift-produced casing for text', () => {
    expect(mapKeyEvent(evt({ key: 'A', shiftKey: true }))).toEqual({ kind: 'text', text: 'A' });
  });

  it('ignores unmapped multi-char keys', () => {
    expect(mapKeyEvent(evt({ key: 'F1' }))).toEqual({ kind: 'ignore' });
  });

  it('ignores a printable char held with alt', () => {
    expect(mapKeyEvent(evt({ key: 'a', altKey: true }))).toEqual({ kind: 'ignore' });
  });

  it('ignores ctrl held with a non-letter', () => {
    expect(mapKeyEvent(evt({ key: '1', ctrlKey: true }))).toEqual({ kind: 'ignore' });
  });
});
