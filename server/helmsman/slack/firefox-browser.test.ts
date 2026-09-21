import { afterEach, describe, expect, it, vi } from 'vitest';
import { findSlackBrowserSurface, surfaceSelection } from './browser';
import { createFirefoxSlackBrowserTransport } from './firefox-browser';
import { connectFirefoxBidi } from './firefox-bidi';

const treeCommand = ['--id-format', 'both', 'tree', '--all', '--json'];
const slack = 'firefox:slack-tab';
const config = { clientId: 'T123', channelId: 'C123', channelName: 'reviews' };
interface Command { id: number; method: string; params: Record<string, unknown> }

function driver() {
  const calls: Command[] = [];
  const sockets: MockSocket[] = [];
  const contexts = [
    { context: 'original-tab', parent: null, url: 'https://example.com/private', children: null },
    { context: 'slack-tab', parent: null, url: 'https://app.slack.com/client/T123/C123', children: null },
  ];
  let autoReply = true;
  let autoOpen = true;
  let response: ((command: Command) => unknown) | null = null;
  let webSocketUrl: unknown = 'ws://127.0.0.1:9222/session/session-1';
  class MockSocket extends EventTarget {
    readonly url: string;
    close = vi.fn(() => this.dispatchEvent(new Event('close')));
    constructor(url: string) {
      super(); this.url = url; sockets.push(this);
      if (autoOpen) queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    message(value: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    send(data: string): void {
      const command = JSON.parse(data) as Command;
      calls.push(command);
      if (!autoReply) return;
      queueMicrotask(() => {
        if (response) { this.message(response(command)); return; }
        if (command.method === 'browsingContext.getTree') {
          this.message({ type: 'success', id: command.id, result: { contexts } });
          return;
        }
        if (command.method === 'input.performActions') { this.message({ type: 'success', id: command.id, result: {} }); return; }
        if (command.method !== 'script.evaluate') throw new Error('Unexpected BiDi mutation');
        const context = command.params.target as { context: string };
        const url = contexts.find(item => item.context === context.context)?.url ?? 'about:blank';
        let result: unknown;
        try {
          const value = new Function('location', 'document', `return (${String(command.params.expression)})`)(new URL(url), document) as unknown;
          result = { type: 'success', realm: 'realm-1', result: { type: 'string', value } };
        } catch { result = { type: 'exception', exceptionDetails: { text: 'Sensitive page content' } }; }
        this.message({ type: 'success', id: command.id, result });
      });
    }
  }
  vi.stubGlobal('WebSocket', MockSocket);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ value: { sessionId: 'session-1',
    capabilities: { browserName: 'firefox', webSocketUrl } } })));
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => [{ width: 1, height: 1 }] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, right: 110, bottom: 60 } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => document.querySelector('button')) });
  return { calls, sockets, contexts, fetcher,
    setResponse: (value: typeof response) => { response = value; },
    setSocketUrl: (value: unknown) => { webSocketUrl = value; },
    setAutoReply: (value: boolean) => { autoReply = value; },
    setAutoOpen: (value: boolean) => { autoOpen = value; },
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); document.body.innerHTML = ''; Reflect.deleteProperty(document, 'elementFromPoint'); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); });

describe('Firefox background Slack transport', () => {
  it.each(['https://127.0.0.1:4444', 'http://remote.example:4444', 'http://127.0.0.1.evil.test:4444',
    'http://user:secret@localhost:4444', 'http://localhost:4444/session', 'http://localhost:4444/?secret=1', 'bad-url'])('rejects unsafe HTTP endpoint %s', endpoint => {
    const fake = driver();
    expect(() => createFirefoxSlackBrowserTransport(endpoint)).toThrow('local HTTP endpoint');
    expect(fake.fetcher).not.toHaveBeenCalled();
  });

  it.each(['ws://remote.example:9222/session/1', 'ws://127.0.0.1.evil.test:9222/session/1',
    'wss://127.0.0.1:9222/session/1', 'ws://secret@127.0.0.1:9222/session/1', 'ws://127.0.0.1:9222/session/1?secret=1'])('rejects unsafe or mismatched WebSocket endpoint %s', endpoint => {
    const fake = driver(); fake.setSocketUrl(endpoint);
    return expect(createFirefoxSlackBrowserTransport()(treeCommand)).rejects.toThrow('unsafe background automation endpoint');
  });

  it.each([
    ['http://localhost:4444', 'ws://127.0.0.1:9222/session/1'],
    ['http://127.0.0.1:4444', 'ws://localhost:9222/session/1'],
    ['http://127.0.0.1:4444', 'ws://[::1]:9222/session/1'],
  ])('accepts equivalent loopback hosts for %s and %s', async (endpoint, socket) => {
    const fake = driver(); fake.setSocketUrl(socket);
    await createFirefoxSlackBrowserTransport(endpoint)(treeCommand);
    expect(fake.sockets[0]?.url).toBe(socket);
  });

  it('requires BiDi and gives actionable setup guidance without falling back', async () => {
    const fake = driver(); fake.setSocketUrl(undefined);
    await expect(createFirefoxSlackBrowserTransport()(treeCommand)).rejects.toThrow('--marionette --remote-debugging-port 9222');
    expect(fake.sockets).toHaveLength(0);
    expect(fake.fetcher).toHaveBeenCalledOnce();
  });

  it('discovers URLs in the background and treats legacy focus as virtual state only', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    const tree = JSON.parse(await transport(treeCommand)) as unknown;
    expect(findSlackBrowserSurface(tree, config)).toBe(slack);
    expect(surfaceSelection(tree, slack)).toEqual({ surface: slack, selected: 'firefox:original-tab', active: 'firefox:original-tab' });
    await transport(['rpc', 'surface.focus', JSON.stringify({ surface_id: slack })]);
    expect(fake.calls).toEqual([{ id: 1, method: 'browsingContext.getTree', params: { maxDepth: 0 } }]);
    const next = JSON.parse(await transport(treeCommand)) as unknown;
    expect(surfaceSelection(next, slack)?.active).toBe(slack);
    await transport(['rpc', 'surface.focus', JSON.stringify({ surface_id: 'firefox:original-tab' })]);
    expect(fake.fetcher).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:4444/session', expect.objectContaining({
      method: 'POST', redirect: 'error', body: expect.stringContaining('"webSocketUrl":true'),
    }));
    expect(fake.calls.every(call => call.method === 'browsingContext.getTree')).toBe(true);
  });

  it('targets the explicit Slack context with user activation disabled and preserves eval encoding', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    expect(await transport(['browser', slack, 'eval', 'JSON.stringify({messages: []})'])).toBe('{"messages":[]}');
    expect(await transport(['browser', slack, 'eval', 'true'])).toBe('true');
    expect(await transport(['browser', slack, 'eval', 'undefined'])).toBe('null');
    const evaluations = fake.calls.filter(call => call.method === 'script.evaluate');
    for (const call of evaluations) {
      expect(call.params).toMatchObject({ target: { context: 'slack-tab' }, awaitPromise: true, userActivation: false, resultOwnership: 'none' });
      expect(call.params.expression).toContain('if (location.origin !== "https://app.slack.com")');
    }
    expect(fake.fetcher).toHaveBeenCalledOnce();
  });

  it('fills input and textarea with native value setters and bubbling input events', async () => {
    driver();
    document.body.innerHTML = '<input id="query"><textarea id="text"></textarea>';
    const input = document.querySelector<HTMLInputElement>('#query')!;
    const change = vi.fn();
    document.addEventListener('input', change, { once: true });
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    const text = 'in:reviews "quoted" \\ literal';
    await transport(['browser', slack, 'fill', '#query', text]);
    expect(input.value).toBe(text);
    expect(change).toHaveBeenCalledOnce();
    await transport(['browser', slack, 'fill', '#text', 'line1\nline2']);
    expect(document.querySelector<HTMLTextAreaElement>('#text')?.value).toBe('line1\nline2');
  });

  it('fills contenteditable through native insertion without focusing the window', async () => {
    const fake = driver();
    document.body.innerHTML = '<div id="query" contenteditable="true">old query</div>';
    const editor = document.querySelector<HTMLElement>('#query')!;
    Object.defineProperty(editor, 'isContentEditable', { value: true });
    const exec = vi.fn((_command: string, _ui: boolean, value: string) => { editor.textContent = value; return true; });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    await transport(['browser', slack, 'fill', '#query', 'in:reviews after:2026-09-20']);
    expect(exec).toHaveBeenCalledExactlyOnceWith('insertText', false, 'in:reviews after:2026-09-20');
    expect(editor.textContent).toBe('in:reviews after:2026-09-20');
    expect(focus).not.toHaveBeenCalled();
    expect(fake.calls.every(call => ['browsingContext.getTree', 'script.evaluate'].includes(call.method))).toBe(true);
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('clicks a visible enabled control exactly once and waits without activation', async () => {
    const fake = driver();
    document.body.innerHTML = '<button id="query">Search</button><button id="disabled" disabled>Disabled</button>';
    const clicked = vi.fn();
    document.querySelector('#query')!.addEventListener('click', clicked);
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    await transport(['browser', slack, 'wait', '--selector', '#query', '--timeout-ms', '10000']);
    await transport(['browser', slack, 'click', '#query']);
    await expect(transport(['browser', slack, 'click', '#disabled'])).rejects.toThrow('control is unavailable');
    expect(clicked).not.toHaveBeenCalled();
    expect(fake.calls.filter(call => call.method === 'input.performActions')).toEqual([{
      id: expect.any(Number), method: 'input.performActions', params: { context: 'slack-tab', actions: [{
        type: 'pointer', id: 'helmsman-slack-pointer', parameters: { pointerType: 'mouse' }, actions: [
          { type: 'pointerMove', x: 60, y: 40, duration: 0, origin: 'viewport' },
          { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
        ],
      }] },
    }]);
    expect(fake.calls.every(call => ['browsingContext.getTree', 'script.evaluate', 'input.performActions'].includes(call.method))).toBe(true);
    expect(fake.fetcher).toHaveBeenCalledOnce();
  });

  it('scrolls an offscreen control into view before hit testing without activating its window', async () => {
    const fake = driver();
    document.body.innerHTML = '<button id="query">Expand search</button>';
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ left: 10, top: 2000, right: 110, bottom: 2040 } as DOMRect);
    const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView).mockImplementation(() => {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ left: 10, top: 20, right: 110, bottom: 60 } as DOMRect);
    });
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    await expect(transport(['browser', slack, 'click', '#query'])).resolves.toBe('OK');
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'center', inline: 'nearest', behavior: 'instant' });
    expect(fake.calls.filter(call => call.method === 'input.performActions')).toHaveLength(1);
    expect(fake.calls.some(call => call.method === 'browsingContext.activate')).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it.each([
    { left: -200, top: 20, right: -10, bottom: 60 },
    { left: 10, top: 20, right: 10, bottom: 60 },
    { left: NaN, top: 20, right: 110, bottom: 60 },
  ])('refuses native input for invalid or still-offscreen bounds after scrolling %j', async bounds => {
    const fake = driver();
    document.body.innerHTML = '<button id="query">Search</button>';
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(bounds as DOMRect);
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    await expect(transport(['browser', slack, 'click', '#query'])).rejects.toThrow('control is unavailable');
    expect(fake.calls.some(call => call.method === 'input.performActions')).toBe(false);
  });

  it('refuses native input when another element covers the target', async () => {
    const fake = driver();
    document.body.innerHTML = '<button id="query">Search</button><div id="overlay"></div>';
    vi.mocked(document.elementFromPoint).mockReturnValue(document.querySelector('#overlay'));
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    await expect(transport(['browser', slack, 'click', '#query'])).rejects.toThrow('control is unavailable');
    expect(fake.calls.some(call => call.method === 'input.performActions')).toBe(false);
  });

  it('guards against pages leaving Slack before evaluation and does not expose script errors', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    fake.contexts[1]!.url = 'https://example.com/private';
    await expect(transport(['browser', slack, 'eval', 'document.body.innerHTML'])).rejects.toThrow('Check the signed-in Slack tab');
    expect(fake.sockets[0]?.close).toHaveBeenCalledOnce();
  });

  it('refreshes known contexts and refuses removed or unknown tabs', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    fake.contexts.pop();
    await transport(treeCommand);
    await expect(transport(['browser', slack, 'eval', 'true'])).rejects.toThrow('tab is unknown');
    expect(fake.calls.every(call => call.method === 'browsingContext.getTree')).toBe(true);
  });

  it('rejects malformed discovery without retaining old context mappings', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    fake.setResponse(command => ({ type: 'success', id: command.id, result: { contexts: [null] } }));
    await expect(transport(treeCommand)).rejects.toThrow('invalid background tab');
    expect(fake.sockets[0]?.close).toHaveBeenCalledOnce();
    await expect(transport(['browser', slack, 'eval', 'true'])).rejects.toThrow('unknown');
  });

  it('rejects protocol errors without retrying mutations or deleting the session', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    fake.setResponse(command => ({ type: 'error', id: command.id, error: 'unknown error', message: 'secret-cookie=private' }));
    await expect(transport(['browser', slack, 'click', '#query'])).rejects.toThrow('background automation disconnected');
    expect(fake.calls.filter(call => call.method === 'script.evaluate')).toHaveLength(1);
    expect(fake.sockets[0]?.close).toHaveBeenCalledOnce();
    expect(fake.fetcher).toHaveBeenCalledOnce();
  });

  it('does not replay a native click after the driver reports a failure', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    fake.setResponse(command => command.method === 'script.evaluate'
      ? { type: 'success', id: command.id, result: { type: 'success', result: { type: 'string', value: '{"x":60,"y":40}' } } }
      : { type: 'error', id: command.id, error: 'unknown error', message: 'private page details' });
    await expect(transport(['browser', slack, 'click', '#query'])).rejects.toThrow('background automation disconnected');
    expect(fake.calls.filter(call => call.method === 'input.performActions')).toHaveLength(1);
    expect(fake.sockets[0]?.close).toHaveBeenCalledOnce();
    expect(fake.fetcher).toHaveBeenCalledOnce();
  });

  it('bounds RPC timeout, closes the socket, and reconnects only on the next explicit operation', async () => {
    vi.useFakeTimers();
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    fake.setAutoReply(false);
    const result = expect(transport(['browser', slack, 'eval', 'true'])).rejects.toThrow('disconnected');
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(fake.sockets).toHaveLength(1);
    expect(fake.sockets[0]?.close).toHaveBeenCalledOnce();
    fake.setAutoReply(true);
    await transport(treeCommand);
    expect(fake.sockets).toHaveLength(2);
    expect(fake.fetcher).toHaveBeenCalledOnce();
  });

  it('fails bounded waits for missing controls and rejects unsafe keyboard commands', async () => {
    vi.useFakeTimers();
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    const result = expect(transport(['browser', slack, 'wait', '--selector', '#missing', '--timeout-ms', '200'])).rejects.toThrow('before the timeout');
    await vi.advanceTimersByTimeAsync(200);
    await result;
    await expect(transport(['browser', slack, 'press', 'Enter'])).rejects.toThrow('Keyboard presses');
    await expect(transport(['browser', slack, 'navigate', 'https://example.com'])).rejects.toThrow('Unsupported');
    expect(fake.calls.every(call => ['browsingContext.getTree', 'script.evaluate'].includes(call.method))).toBe(true);
  });

  it('matches out-of-order RPC IDs and ignores unrelated events', async () => {
    const fake = driver(); fake.setAutoReply(false);
    const client = await connectFirefoxBidi('ws://127.0.0.1:9222/session/1');
    const first = client.request('browsingContext.getTree', {});
    const second = client.request('browsingContext.getTree', {});
    fake.sockets[0]!.message({ type: 'event', method: 'unrelated', params: {} });
    fake.sockets[0]!.message({ type: 'success', id: 2, result: 'second' });
    fake.sockets[0]!.message({ type: 'success', id: 1, result: 'first' });
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    client.close();
  });

  it('rejects pending requests on socket closure and times out socket connection', async () => {
    vi.useFakeTimers();
    const fake = driver(); fake.setAutoReply(false);
    const client = await connectFirefoxBidi('ws://127.0.0.1:9222/session/1');
    const result = expect(client.request('browsingContext.getTree', {})).rejects.toThrow('disconnected');
    fake.sockets[0]!.dispatchEvent(new Event('close'));
    await result;
    fake.setAutoOpen(false);
    const connection = expect(connectFirefoxBidi('ws://127.0.0.1:9222/session/1')).rejects.toThrow('disconnected');
    await vi.advanceTimersByTimeAsync(15_000);
    await connection;
    expect(fake.sockets[1]?.close).toHaveBeenCalledOnce();
  });
});
