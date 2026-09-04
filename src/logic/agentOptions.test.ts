import { describe, expect, it } from 'vitest';
import { EFFORT_OPTIONS, MODEL_OPTIONS, validEffort, validModel } from './agentOptions';

describe('agentOptions', () => {
  it('leads both option lists with a blank Default entry', () => {
    expect(MODEL_OPTIONS[0]).toEqual({ value: '', label: 'Default model' });
    expect(EFFORT_OPTIONS[0]).toEqual({ value: '', label: 'Default effort' });
  });

  it('validEffort accepts only the five CLI levels', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) expect(validEffort(e)).toBe(e);
    expect(validEffort('')).toBeNull();
    expect(validEffort('turbo')).toBeNull();
    expect(validEffort(undefined)).toBeNull();
    expect(validEffort('high; rm -rf /')).toBeNull();
  });

  it('validModel accepts safe aliases/ids and rejects junk', () => {
    expect(validModel('opus')).toBe('opus');
    expect(validModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(validModel('')).toBeNull();
    expect(validModel(undefined)).toBeNull();
    expect(validModel('opus --dangerously')).toBeNull();
    expect(validModel('-flag')).toBeNull();
  });
});
