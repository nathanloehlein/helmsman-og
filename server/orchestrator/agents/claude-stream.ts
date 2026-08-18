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

  if (parsed.type === 'result') {
    return { kind: 'result', text: parsed.result ?? 'done', costUsd: parsed.total_cost_usd };
  }

  if (parsed.type === 'assistant') {
    const blocks: ContentBlock[] = parsed.message?.content ?? [];
    for (const block of blocks) {
      if (block.type === 'tool_use') return { kind: 'tool', text: toolText(block) };
      if (block.type === 'text' && block.text?.trim()) return { kind: 'log', text: block.text.trim() };
    }
  }

  return null;
}
