import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface InstructionRecord {
  id: string;
  targetId: string;
  provider: string;
  stage: string;
  text: string;
  status: 'sending' | 'delivered' | 'failed' | 'unknown';
  createdAt: string;
  error?: string;
}

export interface InstructionTarget { id: string; provider: string; stage: string }
interface Endpoint extends InstructionTarget { available: boolean; instructions: InstructionRecord[] }
export interface InstructionSnapshot { available: boolean; reason?: string; targets: InstructionTarget[]; instructions: InstructionRecord[] }
export class InstructionDeliveryUnknownError extends Error {}
export class InstructionError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

const ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const INSTRUCTION_LIMIT = 8000;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function instructionDirectory(runsDir: string, runId: string): string {
  if (!/^[a-z\d_-]{1,128}$/i.test(runId)) throw new InstructionError('Invalid run ID.', 400);
  return join(runsDir, `${runId}.runtime`, 'instructions');
}

function socketPath(directory: string, id: string): string {
  const hash = createHash('sha256').update(resolve(directory)).update(id).digest('hex').slice(0, 32);
  return join(tmpdir(), `hm-${hash}.sock`);
}

function save(directory: string, endpoint: Endpoint): void {
  const path = join(directory, `${endpoint.id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(endpoint), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function readEndpoints(directory: string): Endpoint[] {
  let files: string[];
  try { files = readdirSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  return files.filter(file => file.endsWith('.json') && ID.test(file.slice(0, -5))).flatMap(file => {
    try {
      const row = object(JSON.parse(readFileSync(join(directory, file), 'utf8')));
      if (row?.id !== file.slice(0, -5) || typeof row.provider !== 'string' || typeof row.stage !== 'string' || !Array.isArray(row.instructions)) return [];
      const instructions = row.instructions.filter((item): item is InstructionRecord => {
        const entry = object(item);
        return Boolean(entry && typeof entry.id === 'string' && ID.test(entry.id) && entry.targetId === row.id
          && typeof entry.text === 'string' && typeof entry.createdAt === 'string' && typeof entry.provider === 'string' && typeof entry.stage === 'string'
          && ['sending', 'delivered', 'failed', 'unknown'].includes(String(entry.status)));
      });
      return [{ id: row.id as string, provider: row.provider, stage: row.stage, available: row.available === true, instructions }];
    } catch { return []; }
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startInstructionEndpoint(
  options: { directory: string; provider: string; stage: string },
  deliver: (text: string, id: string) => Promise<void>,
): Promise<{ close(): Promise<void> }> {
  const { directory, provider, stage } = options;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const endpoint: Endpoint = { id: randomUUID(), provider, stage, available: true, instructions: [] };
  const pending = new Map<string, Promise<InstructionRecord>>();
  const socket = socketPath(directory, endpoint.id);
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') { respond(res, 200, { available: endpoint.available }); return; }
      if (req.method !== 'POST' || req.url !== '/') { respond(res, 404, { error: 'Not found.' }); return; }
      let raw = '';
      req.setEncoding('utf8');
      for await (const chunk of req) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 64_000) throw new InstructionError('Instruction is too long.', 400);
      }
      let body: Record<string, unknown> | null;
      try { body = object(JSON.parse(raw)); } catch { throw new InstructionError('Invalid instruction.', 400); }
      const id = body?.id;
      const text = body?.text;
      if (typeof id !== 'string' || !ID.test(id) || typeof text !== 'string' || !text.trim() || text.length > INSTRUCTION_LIMIT) {
        throw new InstructionError(`Enter an instruction of 1–${INSTRUCTION_LIMIT} characters and a valid message ID.`, 400);
      }
      const previous = endpoint.instructions.find(item => item.id === id);
      if (previous) {
        if (previous.text !== text) throw new InstructionError('Message ID already belongs to a different instruction.');
        respond(res, 200, previous); return;
      }
      if (!endpoint.available) throw new InstructionError('This agent has finished accepting instructions.');
      if (pending.size) throw new InstructionError('Wait for the previous instruction to be acknowledged.');
      if (endpoint.instructions.length >= 100) throw new InstructionError('This agent has reached its instruction limit.');
      const record: InstructionRecord = { id, targetId: endpoint.id, provider, stage, text, status: 'sending', createdAt: new Date().toISOString() };
      endpoint.instructions.push(record);
      try { save(directory, endpoint); } catch (error) { endpoint.instructions.pop(); throw error; }
      const delivery = Promise.resolve().then(() => deliver(text, id)).then(() => { record.status = 'delivered'; }, error => {
        record.status = error instanceof InstructionDeliveryUnknownError ? 'unknown' : 'failed';
        record.error = error instanceof Error ? error.message : 'Agent did not acknowledge the instruction.';
      }).then(() => { save(directory, endpoint); return record; }).finally(() => { pending.delete(id); });
      pending.set(id, delivery);
      void delivery.catch(() => { process.stderr.write('Could not persist instruction acknowledgment.\n'); });
      respond(res, 200, record);
    } catch (error) {
      respond(res, error instanceof InstructionError ? error.status : 500, { error: error instanceof InstructionError ? error.message : 'Could not record the instruction.' });
    }
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(socket, done); });
  chmodSync(socket, 0o600);
  save(directory, endpoint);
  let closing: Promise<void> | undefined;
  return { close() {
    if (closing) return closing;
    endpoint.available = false;
    save(directory, endpoint);
    closing = Promise.allSettled(pending.values())
      .then(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())))
      .then(() => { save(directory, endpoint); try { unlinkSync(socket); } catch {} });
    return closing;
  } };
}

function call(directory: string, targetId: string, body?: unknown): Promise<unknown> {
  return new Promise((done, reject) => {
    const req = request({ socketPath: socketPath(directory, targetId), path: '/', method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (text.length > 128_000) req.destroy(new Error('Oversized instruction response.')); });
      res.on('end', () => {
        try {
          const result: unknown = JSON.parse(text);
          if ((res.statusCode ?? 500) >= 400) reject(new InstructionError(String(object(result)?.error ?? 'Agent is unavailable.'), res.statusCode));
          else done(result);
        } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.setTimeout(body === undefined ? 1000 : 25_000, () => req.destroy(new Error('Instruction acknowledgement timed out.')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export async function readInstructions(directory: string, active: boolean, reason?: string): Promise<InstructionSnapshot> {
  const endpoints = readEndpoints(directory);
  const live = new Set<string>();
  const connected = new Set<string>();
  if (active) await Promise.all(endpoints.filter(endpoint => endpoint.available || endpoint.instructions.some(item => item.status === 'sending')).map(async endpoint => {
    try {
      const status = object(await call(directory, endpoint.id));
      if (typeof status?.available === 'boolean') connected.add(endpoint.id);
      if (status?.available === true) live.add(endpoint.id);
    } catch {}
  }));
  const instructions = readEndpoints(directory).flatMap(endpoint => endpoint.instructions.map(item => item.status === 'sending' && !connected.has(endpoint.id)
    ? { ...item, status: 'unknown' as const, error: 'Agent disconnected before delivery could be confirmed.' } : item))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const targets = endpoints.filter(endpoint => live.has(endpoint.id)).map(({ id, provider, stage }) => ({ id, provider, stage }));
  return { available: targets.length > 0, targets, instructions,
    ...(targets.length ? {} : { reason: reason ?? (active ? 'Waiting for an agent that can receive instructions.' : 'This voyage is no longer running.') }) };
}

export async function sendInstruction(directory: string, input: unknown): Promise<InstructionRecord> {
  const body = object(input);
  if (typeof body?.id !== 'string' || !ID.test(body.id) || typeof body.targetId !== 'string' || !ID.test(body.targetId)
    || typeof body.text !== 'string' || !body.text.trim() || body.text.length > INSTRUCTION_LIMIT) {
    throw new InstructionError(`Enter an instruction of 1–${INSTRUCTION_LIMIT} characters and select an active agent.`, 400);
  }
  const target = readEndpoints(directory).find(endpoint => endpoint.id === body.targetId);
  if (!target) throw new InstructionError('This agent is no longer available. Refresh the instruction targets.');
  const previous = target.instructions.find(item => item.id === body.id);
  if (previous && previous.text !== body.text) throw new InstructionError('Message ID already belongs to a different instruction.');
  if (previous && previous.status !== 'sending') return previous;
  if (!target.available) throw new InstructionError('This agent has finished accepting instructions.');
  try { return await call(directory, target.id, { id: body.id, text: body.text }) as InstructionRecord; }
  catch (error) {
    if (error instanceof InstructionError) throw error;
    const record = readEndpoints(directory).find(endpoint => endpoint.id === target.id)?.instructions.find(item => item.id === body.id);
    if (record) return record.status === 'sending' ? { ...record, status: 'unknown', error: 'Delivery could not be confirmed. Check instruction history before sending again.' } : record;
    throw new InstructionError('Agent is unavailable; the instruction was not sent.');
  }
}
