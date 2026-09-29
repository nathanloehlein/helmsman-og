import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const WRAPPER = join(__dirname, 'run-wrapper.mjs');

describe('run-wrapper', () => {
  it.each([
    ['process.exit(9)', '9', 'exited with code 9'],
    ['process.kill(process.pid, "SIGTERM")', '1', 'terminated by signal SIGTERM'],
  ])('records silent child termination: %s', (script, exitCode, diagnostic) => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    const specPath = join(dir, 'spec.json');
    const logPath = join(dir, 'run.log');
    const exitPath = join(dir, 'run.exit');
    writeFileSync(specPath, JSON.stringify({ cmd: process.execPath, args: ['-e', script], cwd: dir, logPath, exitPath }));
    spawnSync(process.execPath, [WRAPPER, specPath], { encoding: 'utf8' });
    expect(readFileSync(logPath, 'utf8')).toContain(diagnostic);
    expect(readFileSync(logPath, 'utf8')).not.toContain(script);
    expect(readFileSync(exitPath, 'utf8').trim()).toBe(exitCode);
  });

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

  it('separates diagnostics from a final structured event without a newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    const specPath = join(dir, 'spec.json');
    const logPath = join(dir, 'run.log');
    const exitPath = join(dir, 'run.exit');
    const event = JSON.stringify({ type: 'error', message: 'Review failed' });
    writeFileSync(specPath, JSON.stringify({ cmd: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(event)}); process.exit(1)`], cwd: dir, logPath, exitPath }));
    spawnSync(process.execPath, [WRAPPER, specPath], { encoding: 'utf8' });
    expect(readFileSync(logPath, 'utf8').split('\n')).toEqual([event, 'run-wrapper: agent exited with code 1', '']);
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

  it('still records the exit sentinel when the diagnostic log cannot be appended', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    const specPath = join(dir, 'spec.json');
    const logPath = join(dir, 'run.log');
    const exitPath = join(dir, 'run.exit');
    const script = 'const fs = require("node:fs"); fs.unlinkSync(process.argv[1]); fs.mkdirSync(process.argv[1]); process.exit(9)';
    writeFileSync(specPath, JSON.stringify({ cmd: process.execPath, args: ['-e', script, logPath], cwd: dir, logPath, exitPath }));
    const result = spawnSync(process.execPath, [WRAPPER, specPath], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(readFileSync(exitPath, 'utf8').trim()).toBe('9');
  });
});
