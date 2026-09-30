import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AgentTask } from './agents/adapter';
import { buildPrompt } from './agents/prompt';
import { codexSettings } from './agent-attribution';
import { validEffort, validModel } from '../../src/logic/agentOptions';
import { goCaasKey, goCaasLaunch, goCodePath, type ModelProvider } from './gocaas';
import { startInstructionEndpoint, InstructionDeliveryUnknownError } from './instruction-channel';

export interface InteractiveAgentConfig { provider: ModelProvider; task: AgentTask; }
interface Command { cmd: string; args: string[]; env?: NodeJS.ProcessEnv; }

export function interactiveAgentCommand(task: AgentTask, provider: ModelProvider): Command {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of JSON.stringify({ provider, task })) {
    if (chunk.length + character.length > 256) { chunks.push(chunk); chunk = ''; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return { cmd: process.execPath, args: ['--import', import.meta.resolve('tsx'),
    fileURLToPath(new URL('./interactive-agent-cli.ts', import.meta.url)), ...chunks] };
}

export async function interactiveProviderCommand({ provider, task }: InteractiveAgentConfig): Promise<Command> {
  const { effort } = codexSettings(task);
  const claudeModel = validModel(task.model);
  const claudeEffort = validEffort(task.effort);
  const args = provider === 'codex'
    ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
      ...((task.review || task.prePr?.stage === 'review') && !task.prePr?.summaryCorrection ? ['-c', 'features.multi_agent=true'] : []),
      'app-server', '--stdio']
    : ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--replay-user-messages', '--verbose',
      '--dangerously-skip-permissions', ...(claudeModel ? ['--model', claudeModel] : []), ...(claudeEffort ? ['--effort', claudeEffort] : [])];
  if (task.modelRouting === 'gocaas') {
    await goCaasKey();
    return goCaasLaunch(provider, args, process.env, goCodePath());
  }
  return { cmd: provider === 'codex' ? 'codex' : 'claude', args };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function runInteractiveAgent(config: InteractiveAgentConfig, options: {
  command?: Command;
  output?: (line: string) => void;
  diagnostic?: (line: string) => void;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<void> {
  const { provider, task } = config;
  if (!task.instructionsDir || task.dockerExecution) throw new Error('Interactive agent requires a local instruction directory');
  const command = options.command ?? await interactiveProviderCommand(config);
  const output = options.output ?? (line => process.stdout.write(`${line}\n`));
  const diagnostic = options.diagnostic ?? (line => process.stderr.write(line));
  const emit = (value: unknown) => output(JSON.stringify(value));
  const child = spawn(command.cmd, command.args, { env: command.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }>();
  let endpoint: Awaited<ReturnType<typeof startInstructionEndpoint>> | undefined;
  let endpointStarting: Promise<void> | undefined;
  let active = false;
  let completed = false;
  let closing = false;
  let failure: Error | undefined;
  let threadId = '';
  let turnId = '';
  let lastUsage: unknown;
  let claudeResult: Record<string, unknown> | undefined;
  let buffer = '';
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const rejectPending = (error: Error) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  const stop = (error: Error) => {
    failure ??= error;
    active = false;
    rejectPending(new InstructionDeliveryUnknownError('Agent disconnected before acknowledging the instruction'));
    child.kill('SIGTERM');
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    stopTimer.unref();
  };
  const write = (value: unknown) => {
    if (child.stdin.destroyed || child.exitCode !== null || child.signalCode !== null) throw new Error('Agent connection is closed');
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const request = (id: string, value: unknown, instruction = false): Promise<unknown> => new Promise((resolve, reject) => {
    const timer = provider === 'claude-code' && instruction ? undefined : setTimeout(() => {
      pending.delete(id);
      reject(instruction ? new InstructionDeliveryUnknownError('Agent did not acknowledge the instruction in time') : new Error('Agent protocol request timed out'));
    }, options.requestTimeoutMs ?? 20_000);
    pending.set(id, { resolve, reject, timer });
    try { write(value); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const rpc = (method: string, params: unknown, instruction = false, id = randomUUID()) => request(id, { id, method, params }, instruction);
  const receiveAck = (id: string, result: unknown, error?: Error) => {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(id);
    if (error) entry.reject(error); else entry.resolve(result);
  };
  const openEndpoint = (): Promise<void> => endpointStarting ??= (async () => {
    if (!active || closing) return;
    const stage = `${task.prePr?.stage ?? (task.review ? 'review' : 'implement')}${task.prePr?.round === undefined ? '' : ` · round ${task.prePr.round}`}`;
    endpoint = await startInstructionEndpoint({ directory: task.instructionsDir!, provider, stage }, async (text, id) => {
      if (!active || closing) throw new Error('Agent has finished this stage');
      if (provider === 'codex') {
        const expectedTurnId = turnId;
        const response = record(await rpc('turn/steer', { threadId, expectedTurnId, clientUserMessageId: id,
          input: [{ type: 'text', text }] }, true));
        if (response?.turnId !== expectedTurnId) throw new InstructionDeliveryUnknownError('Agent returned an unexpected turn acknowledgment');
      } else {
        await request(id, { type: 'user', uuid: id, session_id: threadId, message: { role: 'user', content: text }, parent_tool_use_id: null }, true);
      }
    });
    if (!active || closing) await endpoint.close();
  })();
  const finish = () => {
    if (closing) return;
    closing = true;
    active = false;
    void (async () => {
      await endpointStarting;
      const close = endpoint?.close();
      if (provider === 'claude-code') child.stdin.end();
      await close;
      if (provider !== 'codex') return;
      child.stdin.end();
      stopTimer ??= setTimeout(() => {
        stopTimer = undefined;
        if (provider === 'codex' && completed && !failure) {
          child.kill('SIGTERM');
          stopTimer = setTimeout(() => stop(new Error('Agent failed to shut down')), 5000);
          stopTimer.unref();
        }
        else stop(new Error('Agent did not finish after its final result'));
      }, 5000);
      stopTimer.unref();
    })().catch(error => stop(error instanceof Error ? error : new Error(String(error))));
  };
  const codexMessage = (message: Record<string, unknown>) => {
    if (typeof message.id === 'string' && !message.method) {
      const error = record(message.error);
      receiveAck(message.id, message.result, error ? new Error(typeof error.message === 'string' ? error.message : 'Agent rejected the request') : undefined);
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      write({ id: message.id, error: { code: -32601, message: 'Helmsman does not support this interactive request' } });
      return;
    }
    const params = record(message.params);
    if (!params || params.threadId !== threadId) return;
    if (message.method === 'thread/tokenUsage/updated') lastUsage = record(params.tokenUsage)?.total;
    if (message.method === 'item/completed' || message.method === 'item/started') {
      const item = record(params.item);
      const type = message.method === 'item/completed' ? 'item.completed' : 'item.started';
      if (item?.type === 'agentMessage' && type === 'item.completed') emit({ type, item: { id: item.id, type: 'agent_message', text: item.text } });
      if (item?.type === 'commandExecution') emit({ type, item: { id: item.id, type: 'command_execution', command: item.command,
        aggregated_output: item.aggregatedOutput, exit_code: item.exitCode, status: item.status } });
    }
    if (message.method === 'error') {
      const error = record(params.error);
      if (params.willRetry !== true) failure ??= new Error(typeof error?.message === 'string' ? error.message : 'Agent reported an error');
      diagnostic(`${typeof error?.message === 'string' ? error.message : 'Agent reported an error'}\n`);
    }
    if (message.method === 'turn/completed') {
      const turn = record(params.turn);
      if (turn?.id !== turnId && turnId) return;
      completed = turn?.status === 'completed';
      if (!completed) failure ??= new Error(typeof record(turn?.error)?.message === 'string' ? String(record(turn?.error)?.message) : `Agent turn ${String(turn?.status ?? 'failed')}`);
      emit({ type: completed ? 'turn.completed' : 'turn.failed', turn_id: turn?.id, usage: lastUsage,
        ...(failure ? { error: { message: failure.message } } : {}) });
      finish();
    }
  };
  const claudeMessage = (message: Record<string, unknown>) => {
    if (message.type !== 'result') output(JSON.stringify(message));
    if (message.type === 'system' && message.subtype === 'init') {
      threadId = typeof message.session_id === 'string' ? message.session_id : '';
      if (!closing) { active = true; void openEndpoint().catch(error => stop(error)); }
    }
    if (message.type === 'user' && typeof message.uuid === 'string') receiveAck(message.uuid, message);
    if (message.type === 'result') {
      claudeResult = message;
      if (message.is_error === true || (typeof message.subtype === 'string' && message.subtype.startsWith('error'))) failure ??= new Error('Agent reported an unsuccessful result');
      completed = !failure && pending.size === 0;
      if (failure || pending.size === 0) finish();
    }
  };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const message = record(JSON.parse(line));
        if (!message) throw new Error('Malformed agent protocol output');
        if (provider === 'codex') codexMessage(message); else claudeMessage(message);
      } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    }
    if (buffer.length > 8 * 1024 * 1024) stop(new Error('Agent protocol output exceeded its limit'));
  });
  child.stderr.setEncoding('utf8').on('data', diagnostic);
  child.stdin.on('error', error => {
    rejectPending(new InstructionDeliveryUnknownError('Agent input disconnected before acknowledging the instruction'));
    if (!closing) stop(error);
  });
  child.once('error', error => stop(error));
  child.once('close', (code, signal) => {
    active = false;
    if (stopTimer) clearTimeout(stopTimer);
    if (!completed || code !== 0 && !(provider === 'codex' && closing && signal === 'SIGTERM')) failure ??= new Error(`Agent exited ${signal ?? code} before successful completion`);
    if (claudeResult) emit(claudeResult);
    rejectPending(new InstructionDeliveryUnknownError('Agent exited before acknowledging the instruction'));
    resolveExit();
  });
  const abort = () => stop(new Error('Voyage stopped'));
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) abort();
    else if (provider === 'codex') {
      await rpc('initialize', { clientInfo: { name: 'helmsman', version: '0.3.0' }, capabilities: {} });
      write({ method: 'initialized' });
      const { model, effort } = codexSettings(task);
      const result = record(await rpc('thread/start', { cwd: process.cwd(), model, approvalPolicy: 'never', sandbox: 'danger-full-access' }));
      const thread = record(result?.thread);
      if (typeof thread?.id !== 'string') throw new Error('Agent returned no thread ID');
      threadId = thread.id;
      const started = record(await rpc('turn/start', { threadId, input: [{ type: 'text', text: buildPrompt(task, 'codex') }], effort }));
      const turn = record(started?.turn);
      if (typeof turn?.id !== 'string') throw new Error('Agent returned no turn ID');
      turnId = turn.id;
      if (!closing) { active = true; await openEndpoint(); }
    } else {
      write({ type: 'user', uuid: randomUUID(), session_id: '', message: { role: 'user', content: buildPrompt(task) }, parent_tool_use_id: null });
    }
    await exited;
  } catch (error) {
    stop(error instanceof Error ? error : new Error(String(error)));
    await exited;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await endpointStarting;
    await endpoint?.close();
  }
  if (failure) throw failure;
}
