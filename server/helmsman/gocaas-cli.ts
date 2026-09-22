import { spawn } from 'node:child_process';
import { goCaasKey, goCaasLaunch, goCodePath } from './gocaas';

try {
  const provider = process.argv[2];
  const args: unknown = JSON.parse(process.argv[3] ?? 'null');
  if (!['codex', 'claude-code'].includes(provider ?? '') || !Array.isArray(args) || !args.every(arg => typeof arg === 'string')) {
    throw new Error('Invalid GoCaaS agent invocation');
  }
  await goCaasKey();
  const command = goCaasLaunch(provider as 'codex' | 'claude-code', args, process.env, goCodePath());
  const child = spawn(command.cmd, command.args, { env: command.env, stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { child.kill(signal); });
  child.once('error', () => { process.stderr.write('Could not start the GoCaaS agent.\n'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'GoCaaS launch failed'}\n`);
  process.exitCode = 1;
}
