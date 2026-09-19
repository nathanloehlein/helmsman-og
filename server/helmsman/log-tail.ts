import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

export interface Tail { stop(): void }
export type LogLineConsumer = (line: string, byteOffset: number) => void;

export function readLogLines(logPath: string, startOffset: number, onLine: LogLineConsumer, final = false): number {
  let fd: number;
  try { fd = openSync(logPath, 'r'); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return startOffset;
    throw error;
  }
  let committed = startOffset;
  let cursor = startOffset;
  let pending: Buffer = Buffer.alloc(0);
  try {
    const size = fstatSync(fd).size;
    while (cursor < size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, size - cursor));
      const count = readSync(fd, chunk, 0, chunk.length, cursor);
      if (!count) break;
      cursor += count;
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let newline = pending.indexOf(10);
      while (newline !== -1) {
        onLine(pending.subarray(0, newline).toString('utf8'), committed);
        committed += newline + 1;
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(10);
      }
      if (pending.length > 8 * 1024 * 1024) throw new Error('Agent log line exceeds 8 MiB');
    }
    if (final && pending.length) {
      onLine(pending.toString('utf8'), committed);
      committed += pending.length;
    }
    return committed;
  } finally { closeSync(fd); }
}

export function tailLog(logPath: string, startOffset: number, onLine: LogLineConsumer,
  onOffset: (offset: number) => void, onError?: (error: unknown) => void): Tail {
  let offset = startOffset;
  let stopped = false;
  const pump = (): void => {
    if (stopped) return;
    try {
      offset = readLogLines(logPath, offset, onLine);
      onOffset(offset);
    } catch (error) { onError?.(error); }
  };
  const timer = setInterval(pump, 250);
  pump();
  return { stop() { stopped = true; clearInterval(timer); } };
}
