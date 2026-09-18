import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { openDb, type Db, type RunRow } from './db';
import { RunBus } from './event-bus';
import { handleRunLog } from './run-log';

let db: Db;
let bus: RunBus;
let server: Server;
let base: string;

function insertRun(status: RunRow['status'] = 'succeeded'): void {
  db.insertRun({ id: 'r1', ticketId: 'PR-42', repo: 'o/r', adapter: 'codex', status, attempt: 1, prNumber: 42,
    startedAt: '2026-09-17T00:00:00Z', endedAt: null, costUsd: null, worktreePath: null });
}

function decodeEvents(text: string): Array<{ kind: string; text: string; id?: number; runId: string; costUsd?: number }> {
  return text.split('\n\n').filter(Boolean).map((line) => JSON.parse(line.slice('data: '.length)));
}

beforeEach(async () => {
  db = openDb(':memory:');
  bus = new RunBus();
  server = createServer((req, res) => {
    void handleRunLog(req, res, new URL(req.url ?? '/', 'http://localhost').pathname, db, bus).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe('run log HTTP routes', () => {
  it('replays only the newest 300 of a large historical log and closes', async () => {
    insertRun();
    for (let index = 0; index < 12_642; index++) db.appendEvent('r1', 'log', `entry ${index}`, 't');
    const response = await fetch(`${base}/r1/log`);
    const events = decodeEvents(await response.text());
    expect(events[0]?.kind).toBe('log-notice');
    const logs = events.filter((event) => event.kind === 'log');
    expect(logs).toHaveLength(300);
    expect(logs[0]?.text).toBe('entry 12342');
    expect(logs.at(-1)?.text).toBe('entry 12641');
    expect(events.at(-1)).toEqual({ kind: 'run-complete', text: 'succeeded', runId: 'r1' });
  });

  it('clips large display entries while the download retains every complete entry', async () => {
    insertRun();
    const texts = Array.from({ length: 350 }, (_, index) => index === 349 ? '🛟'.repeat(8000) : `entry ${index}\nsecond line`);
    for (const text of texts) db.appendEvent('r1', 'log', text, 't');
    db.appendEvent('r1', 'run-complete', 'succeeded', 'end');
    const events = decodeEvents(await (await fetch(`${base}/r1/log`)).text());
    expect(events[0]?.kind).toBe('log-notice');
    expect(events.filter((event) => event.kind === 'run-complete')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'log').every((event) => event.text.length <= 4000)).toBe(true);
    const download = await fetch(`${base}/r1/log/download`);
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="helmsman-r1.log"');
    expect(await download.text()).toBe(texts.map((text) => `[t] log: ${text}\n`).join('') + '[end] run-complete: succeeded\n');
  });

  it('reports clipping even when the historical log has fewer than 300 entries', async () => {
    insertRun('failed');
    db.appendEvent('r1', 'error', 'x'.repeat(10_000), 't');
    const events = decodeEvents(await (await fetch(`${base}/r1/log`)).text());
    expect(events[0]?.kind).toBe('log-notice');
    expect(events[1]?.text).toHaveLength(4000);
    expect(events.at(-1)?.text).toBe('failed');
  });

  it('subscribes to future events, preserving extra fields and closing on completion', async () => {
    insertRun('running');
    db.appendEvent('r1', 'phase', 'started', 't');
    const response = await fetch(`${base}/r1/log`);
    const received = response.text();
    bus.publish('r1', { kind: 'log', text: 'x'.repeat(8000) });
    bus.publish('r1', { kind: 'run-complete', text: 'succeeded', costUsd: 0.12 });
    const events = decodeEvents(await received);
    expect(events.map((event) => event.kind)).toEqual(['phase', 'log', 'run-complete']);
    expect(events[1]?.text).toHaveLength(4000);
    expect(events[2]?.costUsd).toBe(0.12);
  });

  it('closes empty historical streams and downloads', async () => {
    insertRun('stopped');
    expect(decodeEvents(await (await fetch(`${base}/r1/log`)).text())).toEqual([{ kind: 'run-complete', text: 'stopped', runId: 'r1' }]);
    expect(await (await fetch(`${base}/r1/log/download`)).text()).toBe('');
  });

  it('connects to a live run before its first event', async () => {
    insertRun('running');
    const response = await fetch(`${base}/r1/log`);
    bus.publish('r1', { kind: 'run-complete', text: 'succeeded' });
    expect(decodeEvents(await response.text())).toEqual([{ kind: 'run-complete', text: 'succeeded', runId: 'r1' }]);
  });

  it('disconnects and unsubscribes a stalled live client before its buffer grows without bound', async () => {
    insertRun('running');
    const connection = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false, writableLength: 0,
      writeHead: vi.fn(), flushHeaders: vi.fn(), end: vi.fn(),
      write: vi.fn((chunk: string) => { connection.writableLength += Buffer.byteLength(chunk); return false; }),
      destroy: vi.fn(() => { connection.destroyed = true; connection.emit('close'); }),
    });
    const subscribe = bus.subscribe.bind(bus);
    const unsubscribe = vi.fn();
    vi.spyOn(bus, 'subscribe').mockImplementation((id, callback) => {
      const off = subscribe(id, callback);
      return () => { unsubscribe(); off(); };
    });
    await handleRunLog({ method: 'GET' } as IncomingMessage, connection as unknown as ServerResponse, '/api/agents/r1/log', db, bus);
    for (let index = 0; index < 1000; index++) bus.publish('r1', { kind: 'log', text: 'x'.repeat(8000) });
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(connection.writableLength).toBeLessThan(2 * 1024 * 1024 + 5000);
    const writes = connection.write.mock.calls.length;
    bus.publish('r1', { kind: 'log', text: 'after disconnect' });
    expect(connection.write).toHaveBeenCalledTimes(writes);
  });

  it.each(['log', 'log/download'])('rejects missing or malformed runs for %s', async (suffix) => {
    expect((await fetch(`${base}/missing/${suffix}`)).status).toBe(404);
    expect((await fetch(`${base}/bad%0Aid/${suffix}`)).status).toBe(400);
  });
});
