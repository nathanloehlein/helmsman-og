export const CODEX_COST_RULE_IDS = ['helmsman-codex-cost-hooks', 'helmsman-codex-cost-close', 'helmsman-codex-cost-move', 'helmsman-codex-cost-stop'] as const;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function updateCostAutomations(input: unknown, command: string | null): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a cmux automation configuration object.');
  const config = input as Record<string, unknown>;
  if (config.version !== 1 || !Array.isArray(config.rules)) throw new Error('Expected cmux automation version 1 and a rules array.');
  const rules = config.rules.filter(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || typeof rule.id !== 'string') throw new Error('Existing cmux automation rule is invalid; configuration was not changed.');
    return !CODEX_COST_RULE_IDS.some(id => id === rule.id);
  });
  if (command !== null) {
    if (!command.trim()) throw new Error('A refresh command is required.');
    const action = { action: 'run', command, timeout_seconds: 45 };
    rules.push({ id: CODEX_COST_RULE_IDS[0], when: { event: 'agent.hook.*' }, where: { agent: 'codex', hook_event_name: { not: 'Stop' } },
      rate_limit: { interval_seconds: 3, maximum: 1 }, then: [action] });
    const completionAction = { ...action, command: `${command} --wait` };
    rules.push({ id: CODEX_COST_RULE_IDS[3], when: { event: 'agent.hook.Stop' }, where: { agent: 'codex' },
      rate_limit: { interval_seconds: 0.001, maximum: 10 }, then: [completionAction] });
    for (const [index, event] of ['surface.closed', 'surface.moved'].entries()) {
      rules.push({ id: CODEX_COST_RULE_IDS[index + 1], when: { event }, then: [completionAction] });
    }
  }
  return { ...config, rules };
}
