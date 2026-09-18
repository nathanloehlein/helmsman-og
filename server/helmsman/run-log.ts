import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Db } from './db';
import type { RunBus } from './event-bus';
import { RUN_LOG_PREVIEW_LIMIT, RUN_LOG_LINE_LIMIT } from '../../src/logic/runLog';

function displayEvent<T extends { text: string }>(event: T): T {
  return { ...event, text: event.text.length > RUN_LOG_LINE_LIMIT ? `${event.text.slice(0, RUN_LOG_LINE_LIMIT - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : event.text };
}

function encodeEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function* fullLog(db: Db, runId: string, throughId: number): AsyncGenerator<string> {
  let afterId = 0;
  while (afterId < throughId) {
    const page = db.eventPage(runId, afterId, throughId, 50);
    if (page.length === 0) break;
    for (const event of page) {
      yield `[${event.ts}] ${event.kind}: ${event.text}\n`;
      afterId = event.id;
    }
  }
}

export async function handleRunLog(req: IncomingMessage, res: ServerResponse, pathname: string, db: Db, bus: RunBus): Promise<boolean> {
  const match = pathname.match(/^\/api\/agents\/([^/]+)\/log(\/download)?$/);
  if (!match || req.method !== 'GET') return false;
  const runId = match[1];
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(runId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid run ID' }));
    return true;
  }
  const run = db.getRun(runId);
  if (!run) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Run not found' }));
    return true;
  }
  if (match[2]) {
    const throughId = db.recentEvents(runId, 1, 0)[0]?.id ?? 0;
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="helmsman-${runId}.log"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    try {
      await pipeline(Readable.from(fullLog(db, runId, throughId)), res);
    } catch (error: unknown) {
      res.destroy(error instanceof Error ? error : undefined);
    }
    return true;
  }

  const recent = db.recentEvents(runId, RUN_LOG_PREVIEW_LIMIT + 1, RUN_LOG_LINE_LIMIT + 1);
  const events = recent.slice(-RUN_LOG_PREVIEW_LIMIT);
  const truncated = recent.length > RUN_LOG_PREVIEW_LIMIT || events.some((event) => event.text.length > RUN_LOG_LINE_LIMIT);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  if (truncated) {
    res.write(encodeEvent({ kind: 'log-notice', runId, text: `Showing the latest ${RUN_LOG_PREVIEW_LIMIT} log entries; long entries may be shortened. Download the full log for complete output.` }));
  }
  res.write(events.map((event) => encodeEvent(displayEvent(event))).join(''));
  if (run.status !== 'running') {
    if (!events.some((event) => event.kind === 'run-complete')) {
      res.write(encodeEvent({ kind: 'run-complete', text: run.status, runId }));
    }
    res.end();
    return true;
  }

  const off = bus.subscribe(runId, (event) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 2 * 1024 * 1024) {
      res.destroy();
      return;
    }
    res.write(encodeEvent(displayEvent({ ...event, runId })));
    if (event.kind === 'run-complete') {
      off();
      res.end();
    }
  });
  res.on('close', off);
  return true;
}
