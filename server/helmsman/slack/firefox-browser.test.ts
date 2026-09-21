import { afterEach, describe, expect, it, vi } from 'vitest';
import { findSlackBrowserSurface, surfaceSelection } from './browser';
import { createFirefoxSlackBrowserTransport } from './firefox-browser';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const treeCommand = ['--id-format', 'both', 'tree', '--all', '--json'];
const slack = 'firefox:slack-tab';
const config = { clientId: 'T123', channelId: 'C123', channelName: 'reviews' };
type Call = { path: string; method: string; body: Record<string, unknown> | null };

function driver() {
  const calls: Call[] = [];
  const urls = new Map([['original-tab', 'https://example.com/private'], ['slack-tab', 'https://app.slack.com/client/T123/C123']]);
  let selected = 'original-tab';
  let field = 'old query';
  let matches: unknown[] = [{ [ELEMENT]: 'editor' }];
  let evaluation: unknown = '{"messages":[]}';
  let failure: { path: string; code: string; message?: string } | null = null;
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify({ value }), { status });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/session\/session-1/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ path, method, body });
    if (failure?.path === path) return reply({ error: failure.code, message: failure.message ?? 'Sensitive browser page details' }, 500);
    if (path === '/session' && method === 'POST') return reply({ sessionId: 'session-1', capabilities: { browserName: 'firefox' } });
    if (path === '/window/handles') return reply([...urls.keys()]);
    if (path === '/window' && method === 'GET') return reply(selected);
    if (path === '/window' && method === 'POST') { selected = String(body?.handle); return reply(null); }
    if (path === '/url' && method === 'GET') return reply(urls.get(selected));
    if (path === '/execute/sync') return reply(evaluation);
    if (path === '/elements') return reply(matches);
    if (/\/displayed$/.test(path)) return reply(true);
    if (/\/clear$/.test(path)) { field = ''; return reply(null); }
    if (/\/value$/.test(path)) { field += String(body?.text); return reply(null); }
    if (/\/click$/.test(path) || path === '/actions') return reply(null);
    throw new Error(`Unexpected mocked WebDriver command ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return { calls, urls, fetcher, selected: () => selected, field: () => field,
    setMatches: (value: unknown[]) => { matches = value; },
    setEvaluation: (value: unknown) => { evaluation = value; },
    setFailure: (value: typeof failure) => { failure = value; },
    setSelected: (value: string) => { selected = value; },
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Firefox Slack WebDriver transport', () => {
  it.each(['https://127.0.0.1:4444', 'http://remote.example:4444', 'http://127.0.0.1.evil.test:4444',
    'http://user:secret@localhost:4444', 'http://localhost:4444/session', 'http://localhost:4444/?secret=1', 'bad-url'])('rejects unsafe endpoint %s before connecting', endpoint => {
    const fake = driver();
    expect(() => createFirefoxSlackBrowserTransport(endpoint)).toThrow('local HTTP endpoint');
    expect(fake.fetcher).not.toHaveBeenCalled();
  });

  it.each(['http://127.0.0.1:4444', 'http://localhost:5555', 'http://[::1]:4444'])('accepts local endpoint %s', async endpoint => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport(endpoint);
    await transport(treeCommand);
    expect(String(fake.fetcher.mock.calls[0]?.[0])).toBe(`${endpoint}/session`);
  });

  it('discovers URLs without reading unrelated page contents and restores the original tab', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    const tree = JSON.parse(await transport(treeCommand)) as unknown;
    expect(findSlackBrowserSurface(tree, config)).toBe(slack);
    expect(surfaceSelection(tree, slack)).toEqual({ surface: slack, selected: 'firefox:original-tab', active: 'firefox:original-tab' });
    expect(fake.selected()).toBe('original-tab');
    expect(fake.calls.some(call => ['/execute/sync', '/elements'].includes(call.path))).toBe(false);
    expect(fake.calls.filter(call => call.path === '/url')).toHaveLength(2);
    expect(fake.calls[0]).toEqual({ path: '/session', method: 'POST', body: { capabilities: { alwaysMatch: {
      browserName: 'firefox', timeouts: { implicit: 0, pageLoad: 15_000, script: 15_000 },
    } } } });
  });

  it('confirms delayed tab selection before discovery and retries restoration to the original tab', async () => {
    const fake = driver();
    const fetcher = fake.fetcher.getMockImplementation()!;
    const delayed = new Set<string>();
    fake.fetcher.mockImplementation(async (input, init) => {
      const original = fake.selected();
      const response = await fetcher(input, init);
      if (String(input).endsWith('/window') && init?.method === 'POST') {
        const target = String((JSON.parse(String(init.body)) as { handle: string }).handle);
        if (!delayed.has(target)) { delayed.add(target); fake.setSelected(original); }
      }
      return response;
    });
    const transport = createFirefoxSlackBrowserTransport();
    const tree = JSON.parse(await transport(treeCommand)) as unknown;
    expect(findSlackBrowserSurface(tree, config)).toBe(slack);
    expect(fake.selected()).toBe('original-tab');
    expect(fake.calls.filter(call => call.path === '/window' && call.method === 'POST').map(call => call.body?.handle))
      .toEqual(['slack-tab', 'slack-tab', 'original-tab', 'original-tab']);
    expect(fake.calls.filter(call => call.path === '/url')).toHaveLength(2);
    expect(surfaceSelection(tree, slack)?.active).toBe('firefox:original-tab');
  });

  it('fails safely within two seconds when selection cannot be confirmed', async () => {
    vi.useFakeTimers();
    const fake = driver();
    const fetcher = fake.fetcher.getMockImplementation()!;
    fake.fetcher.mockImplementation(async (input, init) => {
      const original = fake.selected();
      const response = await fetcher(input, init);
      if (String(input).endsWith('/window') && init?.method === 'POST') fake.setSelected(original);
      return response;
    });
    const transport = createFirefoxSlackBrowserTransport();
    const result = expect(transport(treeCommand)).rejects.toThrow('could not confirm the selected tab');
    await vi.advanceTimersByTimeAsync(2_000);
    await result;
    expect(fake.selected()).toBe('original-tab');
    expect(fake.calls.filter(call => call.path === '/url')).toHaveLength(1);
    expect(fake.calls.some(call => ['/execute/sync', '/elements'].includes(call.path))).toBe(false);
    expect(fake.calls.filter(call => call.path === '/window' && call.method === 'POST')).toHaveLength(20);
  });

  it('rejects a URL read when selection changes instead of mislabeling another tab', async () => {
    const fake = driver();
    const fetcher = fake.fetcher.getMockImplementation()!;
    fake.fetcher.mockImplementation(async (input, init) => {
      const response = await fetcher(input, init);
      if (String(input).endsWith('/url') && fake.selected() === 'slack-tab') fake.setSelected('original-tab');
      return response;
    });
    await expect(createFirefoxSlackBrowserTransport()(treeCommand)).rejects.toThrow('tab selection changed');
    expect(fake.selected()).toBe('original-tab');
  });

  it('confirms selection before a control mutation without retrying that mutation', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    const fetcher = fake.fetcher.getMockImplementation()!;
    let delayed = false;
    fake.fetcher.mockImplementation(async (input, init) => {
      const original = fake.selected();
      const response = await fetcher(input, init);
      if (!delayed && String(input).endsWith('/window') && init?.method === 'POST') {
        delayed = true;
        fake.setSelected(original);
      }
      return response;
    });
    await transport(['browser', slack, 'click', '[data-qa="query"]']);
    expect(fake.calls.filter(call => call.path.endsWith('/click'))).toHaveLength(1);
    expect(fake.selected()).toBe('original-tab');
  });

  it('reuses its session across discovery and guarded Slack evaluations without double encoding', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    expect(await transport(['browser', slack, 'eval', 'JSON.stringify({messages: []})'])).toBe('{"messages":[]}');
    expect(fake.calls.filter(call => call.path === '/session')).toHaveLength(1);
    expect(fake.calls.find(call => call.path === '/execute/sync')?.body).toEqual({
      script: 'if (location.origin !== "https://app.slack.com") throw new Error("Slack tab changed"); return (JSON.stringify({messages: []}));', args: [],
    });
    expect(fake.selected()).toBe('original-tab');
    fake.setEvaluation(true);
    expect(await transport(['browser', slack, 'eval', 'true'])).toBe('true');
  });

  it('focuses a discovered tab explicitly and preserves that selection during commands', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    await transport(['rpc', 'surface.focus', JSON.stringify({ surface_id: slack })]);
    await transport(['browser', slack, 'eval', 'true']);
    expect(fake.selected()).toBe('slack-tab');
    await transport(['rpc', 'surface.focus', JSON.stringify({ surface_id: 'firefox:original-tab' })]);
    expect(fake.selected()).toBe('original-tab');
  });

  it('fills contenteditable through native clear and input endpoints, preserving literal text', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    const value = 'in:reviews "quoted" \\ text\nnext';
    await transport(['browser', slack, 'fill', '[role="combobox"]', value]);
    expect(fake.field()).toBe(value);
    expect(fake.calls.filter(call => /\/(clear|value)$/.test(call.path))).toEqual([
      { path: '/element/editor/clear', method: 'POST', body: {} },
      { path: '/element/editor/value', method: 'POST', body: { text: value } },
    ]);
    expect(fake.calls.find(call => call.path === '/elements')?.body).toEqual({ using: 'css selector', value: '[role="combobox"]' });
    await transport(['browser', slack, 'fill', '[role="combobox"]', '']);
    expect(fake.field()).toBe('');
  });

  it('waits for visible controls and clicks through WebDriver', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    expect(await transport(['browser', slack, 'wait', '--selector', '[data-qa="query"]', '--timeout-ms', '10000'])).toBe('OK');
    await transport(['browser', slack, 'click', '[data-qa="query"]']);
    expect(fake.calls.filter(call => call.path.endsWith('/click'))).toEqual([{ path: '/element/editor/click', method: 'POST', body: {} }]);
  });

  it('times out missing controls and validates wait limits', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    fake.setMatches([]);
    await expect(transport(['browser', slack, 'wait', '--selector', '#missing', '--timeout-ms', '1'])).rejects.toThrow('before the timeout');
    await expect(transport(['browser', slack, 'wait', '--selector', '#missing', '--timeout-ms', '999999'])).rejects.toThrow('Invalid Firefox Slack wait');
    expect(fake.selected()).toBe('original-tab');
  });

  it('supports bounded key presses and refuses arbitrary keys', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    await transport(['browser', slack, 'press', 'Escape']);
    expect(fake.calls.find(call => call.path === '/actions')?.body).toEqual({ actions: [{ type: 'key', id: 'helmsman-slack-keyboard',
      actions: [{ type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' }] }] });
    await expect(transport(['browser', slack, 'press', 'arbitrary message'])).rejects.toThrow('Unsupported Firefox Slack key');
  });

  it('refuses unknown surfaces and non-Slack pages without reading their DOM', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    await expect(transport(['browser', 'firefox:unknown', 'eval', 'document.body.innerHTML'])).rejects.toThrow('unknown');
    await expect(transport(['browser', 'firefox:original-tab', 'eval', 'document.body.innerHTML'])).rejects.toThrow('signed-in app.slack.com');
    fake.urls.set('slack-tab', 'https://app.slack.com.evil.test/client/T123/C123');
    await expect(transport(['browser', slack, 'click', 'button'])).rejects.toThrow('signed-in app.slack.com');
    expect(fake.calls.some(call => ['/execute/sync', '/elements'].includes(call.path))).toBe(false);
  });

  it('sanitizes remote failures and never retries mutations or deletes the browser session', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    fake.setFailure({ path: '/element/editor/click', code: 'unknown error', message: 'secret-cookie=abc content=private' });
    await expect(transport(['browser', slack, 'click', 'button'])).rejects.toThrow('Firefox could not complete');
    expect(fake.calls.filter(call => call.path.endsWith('/click'))).toHaveLength(1);
    expect(fake.selected()).toBe('original-tab');
    expect(fake.calls.some(call => call.method === 'DELETE')).toBe(false);
  });

  it('reconnects after an invalid session only on a subsequent command', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    fake.setFailure({ path: '/window', code: 'invalid session id' });
    await expect(transport(treeCommand)).rejects.toThrow('Firefox automation is unavailable');
    expect(fake.calls.filter(call => call.path === '/session')).toHaveLength(1);
    fake.setFailure(null);
    await transport(treeCommand);
    expect(fake.calls.filter(call => call.path === '/session')).toHaveLength(2);
  });

  it('reports driver availability without propagating network error details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('sensitive network details')));
    await expect(createFirefoxSlackBrowserTransport()(treeCommand)).rejects.toThrow('Restart the bridge after restarting Helmsman or Firefox');
  });

  it('does not restore over a user-changed selection', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await transport(treeCommand);
    const fetcher = fake.fetcher.getMockImplementation()!;
    fake.fetcher.mockImplementation(async (input, init) => {
      const result = await fetcher(input, init);
      if (String(input).endsWith('/execute/sync')) fake.setSelected('user-selected-tab');
      return result;
    });
    await transport(['browser', slack, 'eval', 'true']);
    expect(fake.selected()).toBe('user-selected-tab');
  });

  it('rejects unsupported commands before creating any session', async () => {
    const fake = driver();
    const transport = createFirefoxSlackBrowserTransport();
    await expect(transport(['browser', slack, 'navigate', 'https://example.com'])).rejects.toThrow('Unsupported');
    await expect(transport(['rpc', 'surface.close', '{}'])).rejects.toThrow('Unsupported');
    expect(fake.fetcher).not.toHaveBeenCalled();
  });
});
