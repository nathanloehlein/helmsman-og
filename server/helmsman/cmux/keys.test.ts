import { describe, expect, it } from 'vitest';
import { CMUX_KEY_ALLOWLIST, isAllowedKey } from './keys';

describe('cmux keys allowlist', () => {
  it('allows verified tokens', () => {
    expect(isAllowedKey('up')).toBe(true);
    expect(isAllowedKey('tab')).toBe(true);
    expect(isAllowedKey('ctrl+c')).toBe(true);
    expect(isAllowedKey('enter')).toBe(true);
    expect(isAllowedKey('pagedown')).toBe(true);
  });

  it('rejects unsupported tokens', () => {
    expect(isAllowedKey('f1')).toBe(false);
    expect(isAllowedKey('ctrl+1')).toBe(false);
    expect(isAllowedKey('')).toBe(false);
    expect(isAllowedKey('arbitrary')).toBe(false);
    expect(isAllowedKey('ctrl+shift+a')).toBe(false);
  });

  it('enumerates ctrl+a..ctrl+z', () => {
    expect(CMUX_KEY_ALLOWLIST.has('ctrl+a')).toBe(true);
    expect(CMUX_KEY_ALLOWLIST.has('ctrl+z')).toBe(true);
    expect(CMUX_KEY_ALLOWLIST.has('ctrl+m')).toBe(true);
  });
});
