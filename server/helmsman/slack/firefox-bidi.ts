const UNAVAILABLE = 'Firefox background automation disconnected. Check Firefox and restart the local bridge if needed.';

export interface FirefoxBidiClient {
  readonly closed: boolean;
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

export function connectFirefoxBidi(url: string): Promise<FirefoxBidiClient> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try { socket = new WebSocket(url); } catch { reject(new Error(UNAVAILABLE)); return; }
    let closed = false;
    let nextId = 0;
    const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const fail = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(openTimer);
      reject(new Error(UNAVAILABLE));
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(UNAVAILABLE)); }
      pending.clear();
      try { socket.close(); } catch {}
    };
    const openTimer = setTimeout(fail, 15_000);
    socket.addEventListener('error', fail);
    socket.addEventListener('close', fail);
    socket.addEventListener('message', event => {
      let value: unknown;
      try { if (typeof event.data !== 'string') throw new Error(); value = JSON.parse(event.data); }
      catch { fail(); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { fail(); return; }
      const message = value as Record<string, unknown>;
      if (message.type === 'event') return;
      if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) { fail(); return; }
      const request = pending.get(message.id);
      if (!request) return;
      if (message.type !== 'success' || !Object.hasOwn(message, 'result')) { fail(); return; }
      clearTimeout(request.timer);
      pending.delete(message.id);
      request.resolve(message.result);
    });
    socket.addEventListener('open', () => {
      if (closed) return;
      clearTimeout(openTimer);
      resolve({
        get closed() { return closed; },
        close: fail,
        request(method, params, timeoutMs = 15_000) {
          if (closed) return Promise.reject(new Error(UNAVAILABLE));
          return new Promise((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(fail, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            try { socket.send(JSON.stringify({ id, method, params })); } catch { fail(); }
          });
        },
      });
    });
  });
}
