// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { interactiveAgentCommand, interactiveProviderCommand, runInteractiveAgent } from './interactive-agent';
import { readInstructions, sendInstruction as postInstruction } from './instruction-channel';
import { goCaasKey } from './gocaas';
import type { AgentTask } from './agents/adapter';
import { codexAdapter } from './agents/codex';
import { claudeCodeAdapter } from './agents/claude-code';

vi.mock('./gocaas', async importOriginal => ({ ...await importOriginal<typeof import('./gocaas')>(),
  goCaasKey: vi.fn(async () => 'test-token'), goCodePath: () => '/test/gocode',
}));

const directories: string[] = [];
const agents: AbortController[] = [];
afterEach(async () => {
  for (const abort of agents.splice(0)) abort.abort();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function task(): Promise<AgentTask> {
  const instructionsDir = await mkdtemp(join(tmpdir(), 'hm-agent-test-'));
  directories.push(instructionsDir);
  return { ticketId: 'AB-1', title: 'Test', repo: 'owner/repo', jiraBaseUrl: '', instructionsDir };
}

async function target(directory: string) {
  let found: Awaited<ReturnType<typeof readInstructions>> | undefined;
  await vi.waitFor(async () => {
    found = await readInstructions(directory, true);
    expect(found.targets).toHaveLength(1);
  });
  return found!.targets[0]!;
}

async function sendInstruction(directory: string, input: { id: string; targetId: string; text: string }) {
  const receipt = await postInstruction(directory, input);
  if (receipt.status !== 'sending') return receipt;
  let result = receipt;
  await vi.waitFor(async () => {
    result = (await readInstructions(directory, true)).instructions.find(item => item.id === input.id) ?? receipt;
    expect(result.status).not.toBe('sending');
  });
  return result;
}

function fakeCodex(mode = 'success') {
  return { cmd: process.execPath, args: ['-e', `
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const notification = (method, params) => send({ method, params: { threadId: 'thread-1', ...params } });
    const complete = () => {
      notification('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 15, cachedInputTokens: 3, outputTokens: 5 }, last: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 1 } } });
      notification('item/completed', { item: { id: 'item-1', type: 'agentMessage', text: 'Updated implementation' } });
      notification('turn/completed', { turn: { id: 'turn-1', status: '${mode}' === 'turn-failure' ? 'failed' : 'completed', error: { message: 'Provider model failed' } } });
    };
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'thread/start') {
        if (message.params.approvalPolicy !== 'never' || message.params.sandbox !== 'danger-full-access') process.exit(9);
        send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      }
      if (message.method === 'turn/start') send({ id: message.id, result: { turn: { id: 'turn-1' } } });
      if (message.method === 'turn/steer') {
        if (message.params.expectedTurnId !== 'turn-1' || message.params.threadId !== 'thread-1' || !message.params.clientUserMessageId) process.exit(8);
        if ('${mode}' === 'disconnect') return process.exit(1);
        if ('${mode}' === 'timeout') return setTimeout(complete, 150);
        if ('${mode}' === 'completion-race') complete();
        setTimeout(() => {
          send('${mode}' === 'rejected' ? { id: message.id, error: { message: 'This turn has already finished' } }
            : { id: message.id, result: { turnId: 'turn-1' } });
          if ('${mode}' !== 'completion-race') setTimeout(complete, 30);
        }, 100);
      }
    });
  `] };
}

function run(task: AgentTask, provider: 'codex' | 'claude-code', command: { cmd: string; args: string[] }, timeout?: number) {
  const abort = new AbortController(); agents.push(abort);
  const output: string[] = [];
  const promise = runInteractiveAgent({ task, provider }, { command, output: line => output.push(line), diagnostic: () => {}, signal: abort.signal, requestTimeoutMs: timeout });
  void promise.catch(() => {});
  return { promise, output, abort };
}

describe('interactive agent provider transport', () => {
  it('waits for Codex steer acknowledgment, preserves stage identity, and maps output/usage', async () => {
    const input = await task();
    input.prePr = { stage: 'fix', round: 2, baseSha: 'a', reportPath: '/tmp/report' };
    const agent = run(input, 'codex', fakeCodex());
    const endpoint = await target(input.instructionsDir!);
    expect(endpoint).toMatchObject({ provider: 'codex', stage: 'fix · round 2' });
    let acknowledged = false;
    const delivery = sendInstruction(input.instructionsDir!, { id: randomUUID(), targetId: endpoint.id, text: 'Keep the existing API' })
      .then(result => { acknowledged = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(acknowledged).toBe(false);
    expect((await delivery).status).toBe('delivered');
    await agent.promise;
    expect(agent.output.map(line => codexAdapter.parseLine(line))).toContainEqual({ kind: 'result', text: 'Updated implementation', eventId: 'item-1' });
    expect(agent.output.map(line => codexAdapter.parseLine(line))).toContainEqual({ kind: 'usage', text: 'Codex turn completed', eventId: 'turn-1', usage: { inputTokens: 15, cachedInputTokens: 3, outputTokens: 5 } });
    expect((await readInstructions(input.instructionsDir!, true)).targets).toHaveLength(0);
    await expect(sendInstruction(input.instructionsDir!, { id: randomUUID(), targetId: endpoint.id, text: 'Too late' })).rejects.toThrow('finished');
  });

  it('records provider rejections without claiming delivery or failing an otherwise completed voyage', async () => {
    const input = await task();
    const agent = run(input, 'codex', fakeCodex('rejected'));
    const endpoint = await target(input.instructionsDir!);
    expect(await sendInstruction(input.instructionsDir!, { id: randomUUID(), targetId: endpoint.id, text: 'Late instruction' }))
      .toMatchObject({ status: 'failed', error: 'This turn has already finished' });
    await agent.promise;
  });

  it('settles an in-flight steer acknowledgment even if completion arrives first', async () => {
    const input = await task();
    const agent = run(input, 'codex', fakeCodex('completion-race'));
    const endpoint = await target(input.instructionsDir!);
    expect((await sendInstruction(input.instructionsDir!, { id: randomUUID(), targetId: endpoint.id, text: 'Last instruction' })).status).toBe('delivered');
    await agent.promise;
  });

  it.each(['disconnect', 'timeout'])('records uncertain delivery after %s', async mode => {
    const input = await task();
    const agent = run(input, 'codex', fakeCodex(mode), 80);
    const endpoint = await target(input.instructionsDir!);
    expect((await sendInstruction(input.instructionsDir!, { id: randomUUID(), targetId: endpoint.id, text: 'Uncertain instruction' })).status).toBe('unknown');
    if (mode === 'disconnect') await expect(agent.promise).rejects.toThrow('Agent exited');
    else await agent.promise;
  });

  it('requires Claude replay acknowledgment and drains a submitted instruction after the first result', async () => {
    const input = await task();
    const agent = run(input, 'claude-code', { cmd: process.execPath, args: ['-e', `
      const readline = require('node:readline');
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      let inputs = 0;
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (++inputs === 1) return send({ type: 'system', subtype: 'init', session_id: 'claude-1' });
        if (message.session_id !== 'claude-1') return process.exit(9);
        send({ type: 'result', subtype: 'success', result: 'Initial work complete', total_cost_usd: 0.01 });
        setTimeout(() => {
          send({ type: 'user', uuid: message.uuid, message: message.message });
          setTimeout(() => {
            send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Instruction applied' }] } });
            send({ type: 'result', subtype: 'success', result: 'Follow-up complete', total_cost_usd: 0.02 });
          }, 5200);
        }, 100);
      });
    `] }, 25);
    const endpoint = await target(input.instructionsDir!);
    let acknowledged = false;
    const delivery = sendInstruction(input.instructionsDir!, { id: randomUUID(), targetId: endpoint.id, text: 'Also fix the label' })
      .then(result => { acknowledged = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(acknowledged).toBe(false);
    expect((await delivery).status).toBe('delivered');
    await agent.promise;
    expect(agent.output.map(line => claudeCodeAdapter.parseLine(line))).toContainEqual(expect.objectContaining({ kind: 'log', text: 'Instruction applied' }));
    expect(agent.output.map(line => JSON.parse(line)).filter(line => line.type === 'result'))
      .toEqual([expect.objectContaining({ result: 'Follow-up complete', total_cost_usd: 0.02 })]);
  }, 10_000);

  it('stops the provider and closes instruction targets when aborted', async () => {
    const input = await task();
    const agent = run(input, 'codex', fakeCodex());
    await target(input.instructionsDir!);
    agent.abort.abort();
    await expect(agent.promise).rejects.toThrow('Voyage stopped');
    expect((await readInstructions(input.instructionsDir!, true)).targets).toHaveLength(0);
  });

  it('keeps Claude follow-up work steerable across intermediate results', async () => {
    const input = await task();
    const agent = run(input, 'claude-code', { cmd: process.execPath, args: ['-e', `
      let inputs = 0;
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (++inputs === 1) return send({ type: 'system', subtype: 'init', session_id: 'claude-1' });
        send({ type: 'result', subtype: 'success', result: 'Prior work complete', total_cost_usd: 0.01 * inputs });
        setTimeout(() => {
          send({ type: 'user', uuid: message.uuid, message: message.message });
          if (inputs === 3) setTimeout(() => send({ type: 'result', subtype: 'success', result: 'Both instructions applied', total_cost_usd: 0.04 }), 50);
        }, 100);
      });
    `] }, 25);
    const endpoint = await target(input.instructionsDir!);
    expect((await sendInstruction(input.instructionsDir!, { id: randomUUID(), targetId: endpoint.id, text: 'First instruction' })).status).toBe('delivered');
    expect((await readInstructions(input.instructionsDir!, true)).targets).toContainEqual(endpoint);
    expect((await sendInstruction(input.instructionsDir!, { id: randomUUID(), targetId: endpoint.id, text: 'Second instruction' })).status).toBe('delivered');
    await agent.promise;
    expect(agent.output.map(line => JSON.parse(line)).filter(line => line.type === 'result'))
      .toEqual([expect.objectContaining({ result: 'Both instructions applied', total_cost_usd: 0.04 })]);
  });

  it('marks a queued Claude instruction unknown when the agent exits before replaying it', async () => {
    const input = await task();
    const agent = run(input, 'claude-code', { cmd: process.execPath, args: ['-e', `
      let inputs = 0;
      require('node:readline').createInterface({ input: process.stdin }).on('line', () => {
        if (++inputs === 1) process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-1' }) + '\\n');
        else {
          process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'Initial task complete' }) + '\\n');
          setTimeout(() => process.exit(0), 25);
        }
      });
    `] }, 25);
    const endpoint = await target(input.instructionsDir!);
    expect((await sendInstruction(input.instructionsDir!, { id: randomUUID(), targetId: endpoint.id, text: 'Queued instruction' })).status).toBe('unknown');
    await expect(agent.promise).rejects.toThrow('Agent exited');
  });

  it('fails when Codex reports an unsuccessful turn even if its process exits zero', async () => {
    const input = await task();
    const agent = run(input, 'codex', fakeCodex('turn-failure'));
    const endpoint = await target(input.instructionsDir!);
    await sendInstruction(input.instructionsDir!, { id: randomUUID(), targetId: endpoint.id, text: 'Continue' });
    await expect(agent.promise).rejects.toThrow('Provider model failed');
    expect(agent.output.map(line => codexAdapter.parseLine(line))).toContainEqual({ kind: 'error', text: 'Provider model failed', eventId: 'turn-1' });
  });

  it('fails when Claude reports an error result even if its process exits zero', async () => {
    const input = await task();
    const agent = run(input, 'claude-code', { cmd: process.execPath, args: ['-e', `
      require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }) + '\\n');
      });
    `] });
    await expect(agent.promise).rejects.toThrow('unsuccessful result');
  });

  it('preserves prompts and unicode across short launch arguments and keeps legacy adapters unchanged', async () => {
    const input = { ...await task(), task: `${'😀'.repeat(500)}\nquoted "text" \\` };
    const command = interactiveAgentCommand(input, 'codex');
    expect(command.args.slice(3).every(chunk => chunk.length <= 256)).toBe(true);
    expect(JSON.parse(command.args.slice(3).map(chunk => Buffer.from(chunk).toString()).join(''))).toEqual({ task: input, provider: 'codex' });
    expect(codexAdapter.buildCommand(input)).toEqual(command);
    expect(claudeCodeAdapter.buildCommand(input)).toEqual(interactiveAgentCommand(input, 'claude-code'));
    expect(codexAdapter.buildCommand({ ...input, instructionsDir: undefined }).cmd).toBe('codex');
    expect(claudeCodeAdapter.buildCommand({ ...input, instructionsDir: undefined }).cmd).toBe('claude');
  });

  it.each(['codex', 'claude-code'] as const)('routes interactive %s through GoCaaS and refuses an auth failure', async provider => {
    const input = { ...await task(), modelRouting: 'gocaas' as const };
    const command = await interactiveProviderCommand({ task: input, provider });
    expect(goCaasKey).toHaveBeenCalledOnce();
    expect(command.args.join(' ')).toContain(provider === 'codex' ? 'model_provider="helmsman_gocaas"' : 'apiKeyHelper');
    expect(command.args).toContain(provider === 'codex' ? 'app-server' : '--replay-user-messages');
    vi.mocked(goCaasKey).mockRejectedValueOnce(new Error('GoCode unavailable'));
    await expect(interactiveProviderCommand({ task: input, provider })).rejects.toThrow('GoCode unavailable');
  });
});
