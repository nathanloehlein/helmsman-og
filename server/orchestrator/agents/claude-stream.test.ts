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

  it('parses the PR number from a github URL in the final result', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 1, result: 'PR open, not merged: https://github.com/gdcorp-partners/airo-app-builder/pull/8922' });
    expect(mapStreamLine(line)).toEqual({ kind: 'result', text: 'PR open, not merged: https://github.com/gdcorp-partners/airo-app-builder/pull/8922', costUsd: 1, prNumber: 8922 });
  });

  it('parses the PR number from a github URL in an assistant text block', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Opened https://github.com/o/r/pull/17' }] } });
    expect(mapStreamLine(line)).toEqual({ kind: 'log', text: 'Opened https://github.com/o/r/pull/17', prNumber: 17 });
  });

  it('does not parse a PR number from a bare pull/N mention without the github host', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'see pull/5 in the docs' }] } });
    const ev = mapStreamLine(line);
    expect(ev?.prNumber).toBeUndefined();
  });
});
