import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

export interface Tail {
  stop(): void;
}

export function tailLog(
  logPath: string,
  startOffset: number,
  onLine: (line: string) => void,
  onOffset: (offset: number) => void,
): Tail {
  let offset: number = startOffset;
  let buffer: string = '';
  let stopped: boolean = false;

  const pump = (): void => {
    if (stopped) return;
    let fd: number | null = null;
    try {
      fd = openSync(logPath, 'r');
      const size: number = fstatSync(fd).size;
      if (size > offset) {
        const len: number = size - offset;
        const buf: Buffer = Buffer.alloc(len);
        const read: number = readSync(fd, buf, 0, len, offset);
        offset += read;
        buffer += buf.subarray(0, read).toString('utf8');
        let nl: number = buffer.indexOf('\n');
        while (nl !== -1) {
          onLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
        }
        onOffset(offset - Buffer.byteLength(buffer, 'utf8'));
      }
    } catch {
      void 0;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  };

  const timer: ReturnType<typeof setInterval> = setInterval(pump, 250);
  pump();
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
