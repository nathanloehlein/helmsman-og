import { describe, expect, it } from 'vitest';
import { CodexCostUsageTracker } from './codex-cost-usage';

function context(model: unknown): string {
  return JSON.stringify({ type: 'turn_context', payload: { model } });
}

function tokens(input: unknown, cached: unknown, output: unknown): string {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
  } } });
}

describe('Codex cmux usage estimates', () => {
  it('prices cumulative deltas once, ignoring repeated totals and alternate usage records', () => {
    const tracker = new CodexCostUsageTracker();
    tracker.consumeLine(context('gpt-6-astra'));
    tracker.consumeLine(tokens(1_000, 200, 100));
    tracker.consumeLine(tokens(1_000, 200, 100));
    tracker.consumeLine(JSON.stringify({ type: 'token_usage_record', payload: { usage: { input_tokens: 1_000 } } }));
    tracker.consumeLine(tokens(2_000, 600, 300));
    expect(tracker.summary()).toMatchObject({
      coverage: 'complete', usageEvents: 2, inputTokens: 2_000, cachedInputTokens: 600, outputTokens: 300,
      models: ['gpt-6-astra'],
    });
    expect(tracker.summary().estimatedCostUsd).toBeCloseTo(0.0296);
  });

  it('uses the model belonging to each delta after a model switch', () => {
    const tracker = new CodexCostUsageTracker();
    tracker.consumeLine(context('gpt-6-astra'));
    tracker.consumeLine(tokens(1_000, 0, 100));
    tracker.consumeLine(context('gpt-5.6-sol'));
    tracker.consumeLine(tokens(2_000, 0, 200));
    expect(tracker.summary().estimatedCostUsd).toBeCloseTo(0.021);
    expect(tracker.summary().models).toEqual(['gpt-6-astra', 'gpt-5.6-sol']);
  });

  it('keeps unknown model segments unpriced while preserving known estimates', () => {
    const tracker = new CodexCostUsageTracker();
    tracker.consumeLine(tokens(100, 0, 10));
    tracker.consumeLine(context('future-model'));
    tracker.consumeLine(tokens(200, 0, 20));
    tracker.consumeLine(context('gpt-6-astra'));
    tracker.consumeLine(tokens(300, 0, 30));
    expect(tracker.summary()).toMatchObject({ coverage: 'partial', estimatedUsageEvents: 1, unknownUsageEvents: 2 });
    expect(tracker.summary().estimatedCostUsd).toBeCloseTo(0.0015);
  });

  it('does not guess cached token counts or price a delta across a missing count', () => {
    const tracker = new CodexCostUsageTracker();
    tracker.consumeLine(context('gpt-6-astra'));
    tracker.consumeLine(tokens(100, undefined, 10));
    tracker.consumeLine(tokens(200, 50, 20));
    tracker.consumeLine(tokens(300, 60, 30));
    expect(tracker.summary()).toMatchObject({ coverage: 'partial', estimatedUsageEvents: 1, unknownUsageEvents: 2, cachedInputTokens: null });
    expect(tracker.summary().estimatedCostUsd).toBeCloseTo(0.00141);
  });

  it.each([
    [90, 20, 20], [200, 10, 5], [200, 0, 20],
  ])('rebases decreasing cumulative counters without billing the reset snapshot: %j', (input, cached, output) => {
    const tracker = new CodexCostUsageTracker();
    tracker.consumeLine(context('gpt-6-astra'));
    tracker.consumeLine(tokens(100, 10, 10));
    tracker.consumeLine(tokens(input, cached, output));
    tracker.consumeLine(tokens(input + 100, cached + 10, output + 10));
    expect(tracker.summary()).toMatchObject({ coverage: 'partial', estimatedUsageEvents: 2, unknownUsageEvents: 1, inputTokens: 200, outputTokens: 20 });
    expect(tracker.summary().estimatedCostUsd).toBeCloseTo(0.00282);
  });

  it.each([[null, 0, 10], [-1, 0, 10], [1.5, 0, 10], [100, 101, 10], [100, 0, null]])(
    'rebases after invalid usage instead of double charging old totals: %j', (input, cached, output) => {
      const tracker = new CodexCostUsageTracker();
      tracker.consumeLine(context('gpt-6-astra'));
      tracker.consumeLine(tokens(100, 0, 10));
      tracker.consumeLine(tokens(input, cached, output));
      tracker.consumeLine(tokens(300, 0, 30));
      tracker.consumeLine(tokens(400, 0, 40));
      expect(tracker.summary()).toMatchObject({ coverage: 'partial', estimatedUsageEvents: 2, unknownUsageEvents: 2, inputTokens: 200 });
      expect(tracker.summary().estimatedCostUsd).toBeCloseTo(0.003);
    },
  );

  it('does not retain prompt content and tolerates malformed, partial, null and unrelated lines', () => {
    const tracker = new CodexCostUsageTracker();
    for (const line of ['', 'null', '[]', '{}', '{"type":',
      JSON.stringify({ type: 'response_item', payload: { content: 'private prompt' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
    ]) tracker.consumeLine(line);
    tracker.consumeLine(context('gpt-6-astra'));
    tracker.consumeLine(tokens(100, 0, 10));
    expect(tracker.summary()).toMatchObject({ coverage: 'partial', estimatedUsageEvents: 1, unknownUsageEvents: 1 });
    expect(JSON.stringify(tracker)).not.toContain('private prompt');
  });

  it('returns unknown before usage and does not fabricate zero cost for a zero snapshot', () => {
    const tracker = new CodexCostUsageTracker();
    tracker.consumeLine(context('gpt-6-astra'));
    tracker.consumeLine(tokens(0, 0, 0));
    expect(tracker.summary()).toMatchObject({ estimatedCostUsd: null, coverage: 'unknown', usageEvents: 0 });
  });

  it('clears the model after a malformed context rather than inheriting a stale model', () => {
    const tracker = new CodexCostUsageTracker();
    tracker.consumeLine(context('gpt-6-astra'));
    tracker.consumeLine(tokens(100, 0, 10));
    tracker.consumeLine(context(null));
    tracker.consumeLine(tokens(200, 0, 20));
    expect(tracker.summary()).toMatchObject({ coverage: 'partial', estimatedUsageEvents: 1, unknownUsageEvents: 1 });
  });

  it('round trips numeric metadata checkpoints without charging already parsed usage twice', () => {
    const tracker = new CodexCostUsageTracker();
    tracker.consumeLine(context('gpt-6-astra'));
    tracker.consumeLine(tokens(1_000, 100, 100));
    const restored = CodexCostUsageTracker.restore(JSON.parse(JSON.stringify(tracker.checkpoint())));
    expect(restored?.summary()).toEqual(tracker.summary());
    restored?.consumeLine(tokens(1_000, 100, 100));
    restored?.consumeLine(tokens(2_000, 200, 200));
    expect(restored?.summary().estimatedCostUsd).toBeCloseTo(0.0282);
    expect(restored?.summary().usageEvents).toBe(2);
  });

  it.each([null, {}, { version: 1 }, { ...new CodexCostUsageTracker().checkpoint(), estimatedCost: Infinity },
    { ...new CodexCostUsageTracker().checkpoint(), model: 'private prompt text' },
    { ...new CodexCostUsageTracker().checkpoint(), cached: 100 },
    { ...new CodexCostUsageTracker().checkpoint(), previous: { input: 0, cached: 1, output: 0 } },
  ])('rejects corrupt checkpoints: %j', checkpoint => {
    expect(CodexCostUsageTracker.restore(checkpoint)).toBeNull();
  });

  it('does not charge an inherited first cumulative snapshot to a forked session', () => {
    const tracker = new CodexCostUsageTracker();
    tracker.consumeLine(JSON.stringify({ type: 'session_meta', payload: { forked_from_id: 'parent' } }));
    tracker.consumeLine(context('gpt-6-astra'));
    tracker.consumeLine(tokens(1_000_000, 500_000, 100_000));
    tracker.consumeLine(tokens(1_000_100, 500_000, 100_010));
    expect(tracker.summary()).toMatchObject({ coverage: 'partial', inputTokens: 100, outputTokens: 10 });
    expect(tracker.summary().estimatedCostUsd).toBeCloseTo(0.0015);
  });
});
