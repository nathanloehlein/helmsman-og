import type { AgentEvent } from './adapter';

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface StreamLine {
  type?: string;
  subtype?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
  uuid?: string;
}

const PR_URL_RE: RegExp = /github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/i;

export function parsePrNumber(text: string): number | undefined {
  const match: RegExpMatchArray | null = text.match(PR_URL_RE);
  return match ? Number(match[1]) : undefined;
}

function toolText(block: ContentBlock): string {
  const input: Record<string, unknown> = block.input ?? {};
  const detail: string =
    typeof input.command === 'string'
      ? input.command
      : typeof input.file_path === 'string'
        ? input.file_path
        : '';
  return detail ? `${block.name}: ${detail}` : String(block.name);
}

export function mapStreamLine(line: string): AgentEvent | null {
  const trimmed: string = line.trim();
  if (!trimmed) return null;
  let parsed: StreamLine;
  try {
    parsed = JSON.parse(trimmed) as StreamLine;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.type === 'result') {
    const text = typeof parsed.result === 'string' ? parsed.result : 'done';
    const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    const inputTokens = parsed.usage?.input_tokens;
    const cachedInputTokens = parsed.usage?.cache_read_input_tokens;
    const outputTokens = parsed.usage?.output_tokens;
    const usage = { ...(valid(inputTokens) ? { inputTokens } : {}), ...(valid(cachedInputTokens) ? { cachedInputTokens } : {}), ...(valid(outputTokens) ? { outputTokens } : {}) };
    return { kind: 'result', text, ...(typeof parsed.total_cost_usd === 'number' && Number.isFinite(parsed.total_cost_usd) && parsed.total_cost_usd >= 0 ? { costUsd: parsed.total_cost_usd } : {}),
      ...(Object.keys(usage).length ? { usage } : {}), ...(typeof parsed.uuid === 'string' ? { eventId: parsed.uuid } : {}), prNumber: parsePrNumber(text) };
  }

  if (parsed.type === 'assistant') {
    const blocks = Array.isArray(parsed.message?.content) ? parsed.message.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') return { kind: 'tool', text: toolText(block) };
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        const text: string = block.text.trim();
        return { kind: 'log', text, prNumber: parsePrNumber(text) };
      }
    }
  }

  return null;
}
