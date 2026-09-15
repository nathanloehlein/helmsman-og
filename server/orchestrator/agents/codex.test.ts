import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexArgs, validCodexEffort, codexAdapter } from './codex';
import type { AgentEvent, AgentTask } from './adapter';

function task(over: Partial<AgentTask> = {}): AgentTask {
  return { ticketId: 'AB-1', title: 't', repo: 'o/r', jiraBaseUrl: '', ...over };
}

describe('validCodexEffort', () => {
  it('accepts codex efforts', () => {
    for (const e of ['minimal', 'low', 'medium', 'high']) expect(validCodexEffort(e)).toBe(e);
  });
  it('rejects non-codex efforts and blanks', () => {
    for (const e of ['xhigh', 'max', '', null, undefined]) expect(validCodexEffort(e)).toBeNull();
  });
});

describe('codexArgs', () => {
  it('defaults to exec, bypass, astra, medium, prompt last', () => {
    const args = codexArgs(task());
    expect(args[0]).toBe('exec');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-6-astra');
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="medium"');
    expect(args[args.length - 1]).toContain('AB-1'); // prompt is last, references the ticket
  });
  it('honors a provided model and effort', () => {
    const args = codexArgs(task({ model: 'opus', effort: 'high' }));
    expect(args[args.indexOf('-m') + 1]).toBe('opus');
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"');
  });
  it('clamps an unsupported effort to medium', () => {
    const args = codexArgs(task({ effort: 'max' }));
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="medium"');
  });
  it('falls back to astra for a blank model', () => {
    expect(codexArgs(task({ model: '' })) [codexArgs(task({ model: '' })).indexOf('-m') + 1]).toBe('gpt-6-astra');
  });
});

describe('codexAdapter.start', () => {
  it('has id codex', () => {
    expect(codexAdapter.id).toBe('codex');
  });

  it('parses a PR number from a pull/<n> line arriving on the child stderr', async () => {
    const binDir: string = mkdtempSync(join(tmpdir(), 'codex-bin-'));
    const bin: string = join(binDir, 'codex');
    writeFileSync(bin, '#!/usr/bin/env node\nconsole.error("opened https://github.com/o/r/pull/99");\n');
    chmodSync(bin, 0o755);

    const originalPath: string | undefined = process.env.PATH;
    process.env.PATH = `${binDir}${originalPath ? `:${originalPath}` : ''}`;
    try {
      const events: AgentEvent[] = [];
      const handle = codexAdapter.start(task(), process.cwd(), (e: AgentEvent) => events.push(e));
      const result = await handle.exit;

      expect(result.prNumber).toBe(99);
      expect(events.some((e: AgentEvent) => e.kind === 'log' && e.text.includes('pull/99'))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
