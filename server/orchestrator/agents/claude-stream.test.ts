import { describe, expect, it } from 'vitest';
import { mapStreamLine } from './claude-stream';

describe('mapStreamLine', () => {
  it('maps an assistant tool_use to a tool event', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
    expect(mapStreamLine(line)).toEqual({ kind: 'tool', text: 'Bash: npm test' });
  });

  it('maps assistant text to a log event', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Exploring the repo' }] } });
    expect(mapStreamLine(line)).toEqual({ kind: 'log', text: 'Exploring the repo' });
  });

  it('maps the final result with cost', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.42, result: 'done' });
    expect(mapStreamLine(line)).toEqual({ kind: 'result', text: 'done', costUsd: 0.42 });
  });

  it('ignores unknown / non-JSON lines', () => {
    expect(mapStreamLine('')).toBeNull();
    expect(mapStreamLine('not json')).toBeNull();
    expect(mapStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull();
  });
});
