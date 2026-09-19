import { estimateUnreportedUsage } from '../cost-estimates.ts';

type TokenCounts = { input: number; cached: number | null; output: number };

export interface CodexCostCheckpoint {
  version: 1;
  model: string | null;
  previous: TokenCounts | null;
  estimatedCost: number;
  estimatedEvents: number;
  unknownEvents: number;
  input: number;
  cached: number | null;
  output: number;
  models: string[];
}

export interface CodexCostSummary {
  estimatedCostUsd: number | null;
  coverage: 'complete' | 'partial' | 'unknown';
  usageEvents: number;
  estimatedUsageEvents: number;
  unknownUsageEvents: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  models: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function modelName(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : null;
}

export class CodexCostUsageTracker {
  private model: string | null = null;
  private previous: TokenCounts | null = { input: 0, cached: 0, output: 0 };
  private estimatedCost = 0;
  private estimatedEvents = 0;
  private unknownEvents = 0;
  private input = 0;
  private cached: number | null = 0;
  private output = 0;
  private models = new Set<string>();

  static restore(value: unknown): CodexCostUsageTracker | null {
    const checkpoint = record(value);
    if (!checkpoint || checkpoint.version !== 1
      || !['estimatedEvents', 'unknownEvents', 'input', 'output'].every(key => tokenCount(checkpoint[key]) !== null)
      || (checkpoint.cached !== null && (tokenCount(checkpoint.cached) === null || (checkpoint.cached as number) > (checkpoint.input as number)))
      || typeof checkpoint.estimatedCost !== 'number' || !Number.isFinite(checkpoint.estimatedCost) || checkpoint.estimatedCost < 0
      || (checkpoint.model !== null && modelName(checkpoint.model) === null)
      || !Array.isArray(checkpoint.models) || checkpoint.models.length > 100
      || checkpoint.models.some(model => modelName(model) === null)) return null;
    const previous = record(checkpoint.previous);
    if (checkpoint.previous !== null && (!previous || tokenCount(previous.input) === null || tokenCount(previous.output) === null
      || (previous.cached !== null && (tokenCount(previous.cached) === null || (previous.cached as number) > (previous.input as number))))) return null;
    const tracker = new CodexCostUsageTracker();
    tracker.model = checkpoint.model as string | null;
    tracker.previous = previous ? { input: previous.input as number, cached: previous.cached as number | null, output: previous.output as number } : null;
    tracker.estimatedCost = checkpoint.estimatedCost;
    tracker.estimatedEvents = checkpoint.estimatedEvents as number;
    tracker.unknownEvents = checkpoint.unknownEvents as number;
    tracker.input = checkpoint.input as number;
    tracker.cached = checkpoint.cached as number | null;
    tracker.output = checkpoint.output as number;
    tracker.models = new Set(checkpoint.models as string[]);
    return tracker;
  }

  checkpoint(): CodexCostCheckpoint {
    return {
      version: 1, model: this.model, previous: this.previous ? { ...this.previous } : null,
      estimatedCost: this.estimatedCost, estimatedEvents: this.estimatedEvents, unknownEvents: this.unknownEvents,
      input: this.input, cached: this.cached, output: this.output, models: [...this.models],
    };
  }

  markIncomplete(): void {
    this.unknownEvents += 1;
  }

  consumeLine(line: string): void {
    let event: Record<string, unknown> | null;
    try {
      event = record(JSON.parse(line));
    } catch {
      if (line.trim()) this.unknownEvents += 1;
      return;
    }
    const payload = record(event?.payload);
    if (event?.type === 'session_meta' && typeof payload?.forked_from_id === 'string' && payload.forked_from_id) {
      this.previous = null;
      return;
    }
    if (event?.type === 'turn_context') {
      this.model = modelName(payload?.model);
      return;
    }
    if (event?.type !== 'event_msg' || payload?.type !== 'token_count') return;
    const info = record(payload.info);
    if (!info) return;
    const usage = record(info.total_token_usage);
    const input = tokenCount(usage?.input_tokens);
    const cached = tokenCount(usage?.cached_input_tokens);
    const output = tokenCount(usage?.output_tokens);
    if (input === null || output === null || (cached !== null && cached > input)) {
      this.previous = null;
      this.unknownEvents += 1;
      return;
    }
    const current = { input, cached, output };
    const previous = this.previous;
    this.previous = current;
    if (!previous || input < previous.input || output < previous.output
      || (cached !== null && previous.cached !== null && cached < previous.cached)) {
      this.unknownEvents += 1;
      return;
    }
    if (input === previous.input && output === previous.output && cached === previous.cached) return;
    const inputDelta = input - previous.input;
    const outputDelta = output - previous.output;
    const cachedDelta = cached !== null && previous.cached !== null ? cached - previous.cached : null;
    this.input += inputDelta;
    this.output += outputDelta;
    this.cached = this.cached !== null && cachedDelta !== null && cachedDelta <= inputDelta ? this.cached + cachedDelta : null;
    if (this.model && this.models.size < 100) this.models.add(this.model);
    const estimate = estimateUnreportedUsage({
      runId: 'cmux', attempt: 1, eventId: 'usage', provider: 'codex', model: this.model,
      inputTokens: inputDelta, cachedInputTokens: cachedDelta, outputTokens: outputDelta,
      totalTokens: inputDelta + outputDelta, costUsd: null,
    });
    if (estimate === null) {
      this.unknownEvents += 1;
    } else {
      this.estimatedCost += estimate;
      this.estimatedEvents += 1;
    }
  }

  summary(): CodexCostSummary {
    return {
      estimatedCostUsd: this.estimatedEvents ? this.estimatedCost : null,
      coverage: !this.estimatedEvents ? 'unknown' : this.unknownEvents ? 'partial' : 'complete',
      usageEvents: this.estimatedEvents + this.unknownEvents,
      estimatedUsageEvents: this.estimatedEvents,
      unknownUsageEvents: this.unknownEvents,
      inputTokens: this.input,
      cachedInputTokens: this.cached,
      outputTokens: this.output,
      models: [...this.models],
    };
  }
}
