import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { CODEX_COST_RULE_IDS, shellQuote, updateCostAutomations } from './codex-cost-install';

describe('cmux cost automation installation', () => {
  it('preserves unrelated rules and installs idempotently', () => {
    const original = { version: 1, rules: [{ id: 'existing', when: { event: 'workspace.created' }, then: [] }], custom: true };
    const installed = updateCostAutomations(original, "'/path with spaces/node' '/refresh.mjs'");
    expect(installed.custom).toBe(true);
    expect(installed.rules).toHaveLength(5);
    expect((installed.rules as unknown[])[0]).toEqual(original.rules[0]);
    expect(original.rules).toHaveLength(1);
    expect(updateCostAutomations(installed, "'/new/node' '/refresh.mjs'").rules).toHaveLength(5);
    expect(JSON.stringify(installed)).toContain('agent.hook.*');
    expect(JSON.stringify(installed)).toContain('codex');
  });

  it('uninstalls only the owned rules', () => {
    const other = { id: 'custom-codex', then: [] };
    const installed = updateCostAutomations({ version: 1, rules: [other] }, 'refresh');
    expect(updateCostAutomations(installed, null)).toEqual({ version: 1, rules: [other] });
    expect(CODEX_COST_RULE_IDS).toHaveLength(4);
  });

  it('keeps completion refresh separate from throttled activity and waits for active refreshes', () => {
    const installed = updateCostAutomations({ version: 1, rules: [] }, 'refresh');
    const rules = installed.rules as Array<Record<string, unknown>>;
    expect(rules.find(rule => rule.id === 'helmsman-codex-cost-hooks')?.where).toEqual({ agent: 'codex', hook_event_name: { not: 'Stop' } });
    expect(rules.find(rule => rule.id === 'helmsman-codex-cost-stop')).toMatchObject({
      when: { event: 'agent.hook.Stop' }, rate_limit: { interval_seconds: 0.001, maximum: 10 },
      then: [{ action: 'run', command: 'refresh --wait' }],
    });
  });

  it.each([null, [], {}, { version: 2, rules: [] }, { version: 1, rules: null }, { version: 1, rules: [null] }])('rejects unknown or malformed existing configuration', value => {
    expect(() => updateCostAutomations(value, 'refresh')).toThrow();
  });

  it.skipIf(process.platform === 'win32')('quotes literal shell metacharacters without expanding them', () => {
    const value = "a file's $(printf unsafe) `printf unsafe` $HOME\nsecond line";
    const result = execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(value)}`], { encoding: 'utf8' });
    expect(result).toBe(value);
  });
});
