import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { shellQuote, updateCostAutomations } from '../server/helmsman/cmux/codex-cost-install.ts';

try {
  const uninstall = process.argv.includes('--uninstall');
  if (process.argv.slice(2).some(arg => arg !== '--uninstall')) throw new Error('Usage: install-cmux-codex-cost.mjs [--uninstall]');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer is required.');
  const configuredPath = join(homedir(), '.cmuxterm', 'automations.json');
  const configPath = existsSync(configuredPath) ? realpathSync(configuredPath) : configuredPath;
  const bundled = '/Applications/cmux.app/Contents/Resources/bin/cmux';
  const cmuxPath = existsSync(bundled) ? bundled : execFileSync('which', ['cmux'], { encoding: 'utf8' }).trim();
  if (!isAbsolute(cmuxPath)) throw new Error('Could not locate cmux.');
  const nodePath = existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath;
  const nodeVersion = execFileSync(nodePath, ['--version'], { encoding: 'utf8', timeout: 5_000 }).trim();
  if (!/^v(?:2[4-9]|[3-9]\d)\./.test(nodeVersion)) throw new Error('The automation Node executable must be version 24 or newer.');
  const scriptPath = fileURLToPath(new URL('./cmux-codex-cost.mjs', import.meta.url));
  const command = [nodePath, scriptPath, '--cmux', cmuxPath].map(shellQuote).join(' ');
  const original = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
  const existing = original === null ? { version: 1, rules: [] } : JSON.parse(original);
  const config = updateCostAutomations(existing, uninstall ? null : command);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  if ((existsSync(configPath) ? readFileSync(configPath, 'utf8') : null) !== original) throw new Error('cmux configuration changed during installation; try again.');
  if (existsSync(configPath)) copyFileSync(configPath, `${configPath}.${new Date().toISOString().replaceAll(':', '-')}.bak`);
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, configPath);
  execFileSync(cmuxPath, ['automation', 'reload'], { stdio: 'inherit', timeout: 10_000 });
  execFileSync(nodePath, [scriptPath, '--cmux', cmuxPath, ...(uninstall ? ['--clear'] : [])], { stdio: 'inherit', timeout: 45_000 });
  process.stdout.write(uninstall ? 'Removed Helmsman Codex cost automation rules.\n' : 'Installed native cmux Codex cost estimates.\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error && !(error instanceof SyntaxError) && !('stderr' in error) ? error.message : 'Could not install cmux cost automations. Check cmux access and the existing configuration.'}\n`);
  process.exitCode = 1;
}
