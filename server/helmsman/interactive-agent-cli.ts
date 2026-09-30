import { runInteractiveAgent, type InteractiveAgentConfig } from './interactive-agent';

const abort = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => abort.abort());
try {
  const value: unknown = JSON.parse(process.argv.slice(2).join(''));
  if (!value || typeof value !== 'object' || !('provider' in value) || !['codex', 'claude-code'].includes(String(value.provider))
    || !('task' in value) || !value.task || typeof value.task !== 'object' || !('instructionsDir' in value.task)
    || typeof value.task.instructionsDir !== 'string') throw new Error('Invalid interactive agent invocation');
  await runInteractiveAgent(value as InteractiveAgentConfig, { signal: abort.signal });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Interactive agent failed'}\n`);
  process.exitCode = 1;
}
