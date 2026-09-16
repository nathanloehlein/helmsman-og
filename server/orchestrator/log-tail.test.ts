import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tailLog } from './log-tail';

describe('tailLog', () => {
  it('emits complete lines and advances the offset, buffering partial lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tail-'));
    const log = join(dir, 'run.log');
    writeFileSync(log, 'alpha\nbeta\n');
    const lines: string[] = [];
    let offset = 0;
    const t = tailLog(log, 0, (l) => lines.push(l), (o) => { offset = o; });
    await vi.waitFor(() => expect(lines).toEqual(['alpha', 'beta']));
    appendFileSync(log, 'gam');
    appendFileSync(log, 'ma\n');
    await vi.waitFor(() => expect(lines).toEqual(['alpha', 'beta', 'gamma']));
    expect(offset).toBe('alpha\nbeta\ngamma\n'.length);
    t.stop();
  });

  it('resumes from a nonzero start offset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tail-'));
    const log = join(dir, 'run.log');
    writeFileSync(log, 'one\ntwo\n');
    const lines: string[] = [];
    const t = tailLog(log, 'one\n'.length, (l) => lines.push(l), () => {});
    await vi.waitFor(() => expect(lines).toEqual(['two']));
    t.stop();
  });
});
