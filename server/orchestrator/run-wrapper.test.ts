import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const WRAPPER = join(__dirname, 'run-wrapper.mjs');

describe('run-wrapper', () => {
  it('captures stdout+stderr to the log and the exit code to the sentinel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    const specPath = join(dir, 'spec.json');
    const logPath = join(dir, 'run.log');
    const exitPath = join(dir, 'run.exit');
    writeFileSync(specPath, JSON.stringify({ cmd: 'node', args: ['-e', 'process.stdout.write("out\\n");process.stderr.write("err\\n");process.exit(5)'], cwd: dir, logPath, exitPath }));
    spawnSync('node', [WRAPPER, specPath], { encoding: 'utf8' });
    expect(readFileSync(logPath, 'utf8')).toContain('out');
    expect(readFileSync(logPath, 'utf8')).toContain('err');
    expect(readFileSync(exitPath, 'utf8').trim()).toBe('5');
  });

  it('writes exit 127 and logs the error when the command cannot be spawned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    const specPath = join(dir, 'spec.json');
    const logPath = join(dir, 'run.log');
    const exitPath = join(dir, 'run.exit');
    writeFileSync(specPath, JSON.stringify({ cmd: 'definitely-not-a-real-binary-xyz', args: [], cwd: dir, logPath, exitPath }));
    spawnSync('node', [WRAPPER, specPath], { encoding: 'utf8' });
    expect(existsSync(exitPath)).toBe(true);
    expect(readFileSync(exitPath, 'utf8').trim()).toBe('127');
  });
});
