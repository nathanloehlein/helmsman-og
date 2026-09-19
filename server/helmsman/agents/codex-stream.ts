import type { AgentEvent, AgentUsage } from './adapter';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function identifier(value: unknown): string | undefined {
  const valueText = text(value);
  return valueText && valueText.length <= 512 ? valueText : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usd(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usage(value: unknown): AgentUsage | undefined {
  const source = record(value);
  if (!source) return undefined;
  const inputTokens = tokenCount(source.input_tokens ?? source.inputTokens);
  const cachedInputTokens = tokenCount(source.cached_input_tokens ?? source.cachedInputTokens);
  const outputTokens = tokenCount(source.output_tokens ?? source.outputTokens);
  const totalTokens = tokenCount(source.total_tokens ?? source.totalTokens);
  const parsed: AgentUsage = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
  return Object.keys(parsed).length ? parsed : undefined;
}

function messageForError(value: unknown): string | null {
  const source = record(value);
  return text(source?.message) ?? text(source?.error) ?? text(value);
}

export function parseCodexStreamLine(line: string): AgentEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const event = record(value);
  const type = text(event?.type);
  if (!event || !type) return null;

  if (type === 'item.completed') {
    const item = record(event.item);
    const itemType = text(item?.type);
    const eventId = identifier(item?.id);
    if (itemType === 'agent_message') {
      const itemText = text(item?.text);
      return itemText ? { kind: 'result', text: itemText, ...(eventId ? { eventId } : {}) } : null;
    }
    if (itemType === 'command_execution') {
      const command = text(item?.command);
      return command ? { kind: 'tool', text: command, ...(eventId ? { eventId } : {}) } : null;
    }
    return null;
  }

  if (type === 'turn.completed') {
    const parsedUsage = usage(event.usage);
    const costUsd = usd(record(event.usage)?.cost_usd ?? record(event.usage)?.costUsd ?? event.cost_usd ?? event.costUsd);
    const eventId = identifier(event.turn_id ?? event.id);
    return parsedUsage || costUsd !== undefined
      ? {
        kind: 'usage',
        text: 'Codex turn completed',
        ...(eventId ? { eventId } : {}),
        ...(parsedUsage ? { usage: parsedUsage } : {}),
        ...(costUsd === undefined ? {} : { costUsd }),
      }
      : null;
  }

  if (type === 'error' || type === 'turn.failed') {
    const message = messageForError(event.error) ?? messageForError(event);
    const eventId = identifier(event.turn_id ?? event.id);
    return message ? { kind: 'error', text: message, ...(eventId ? { eventId } : {}) } : null;
  }

  return null;
}
