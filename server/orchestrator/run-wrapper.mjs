#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { openSync, readFileSync, writeFileSync } from 'node:fs';

const specPath = process.argv[2];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const fd = openSync(spec.logPath, 'a');

const child = spawn(spec.cmd, spec.args ?? [], { cwd: spec.cwd, stdio: ['ignore', fd, fd] });
child.on('exit', (code) => {
  writeFileSync(spec.exitPath, String(code ?? 1));
  process.exit(0);
});
child.on('error', (err) => {
  try { writeFileSync(spec.logPath, `run-wrapper: cannot start ${spec.cmd}: ${err.message}\n`, { flag: 'a' }); } catch {}
  writeFileSync(spec.exitPath, '127');
  process.exit(0);
});
