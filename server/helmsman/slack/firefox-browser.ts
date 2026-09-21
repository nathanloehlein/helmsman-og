import type { SlackBrowserTransport } from './browser';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const DRIVER_UNAVAILABLE = 'Firefox automation is unavailable. Enable Firefox Marionette and start the local bridge with npm run slack:firefox. Restart the bridge after restarting Helmsman or Firefox.';
const KEYS: Record<string, string> = {
  Enter: '\uE007', Escape: '\uE00C', Tab: '\uE004', Backspace: '\uE003', Delete: '\uE017',
  ArrowLeft: '\uE012', ArrowUp: '\uE013', ArrowRight: '\uE014', ArrowDown: '\uE015', Home: '\uE011', End: '\uE010',
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

class FirefoxCommandError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code === 'invalid session id' || code === 'session not created' ? DRIVER_UNAVAILABLE
      : code === 'no such window' ? 'The selected Firefox tab is unavailable. Reopen signed-in Slack and retry.'
      : code === 'no such element' || code === 'stale element reference' ? 'The Slack browser control is unavailable or changed. Retry after the page settles.'
      : 'Firefox could not complete the Slack browser operation. Check the signed-in tab and retry.');
    this.code = code;
  }
}

function endpointUrl(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Firefox WebDriver must use a local HTTP endpoint.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Firefox WebDriver must use a local HTTP endpoint without credentials, a path, or query parameters.');
  }
  return url.origin;
}

export function createFirefoxSlackBrowserTransport(endpoint = 'http://127.0.0.1:4444'): SlackBrowserTransport {
  const base = endpointUrl(endpoint);
  let session: Promise<string> | null = null;
  const knownHandles = new Map<string, string>();

  async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    let response: Response;
    let payload: Record<string, unknown> | null;
    try {
      response = await fetch(`${base}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      payload = record(await response.json());
    } catch { throw new Error(DRIVER_UNAVAILABLE); }
    const failure = record(payload?.value);
    if (!response.ok || typeof failure?.error === 'string') {
      const allowed = ['invalid session id', 'session not created', 'no such window', 'no such element', 'stale element reference'];
      const code = typeof failure?.error === 'string' && allowed.includes(failure.error) ? failure.error : 'webdriver error';
      if (code === 'invalid session id') { session = null; knownHandles.clear(); }
      throw new FirefoxCommandError(code);
    }
    if (!payload || !Object.hasOwn(payload, 'value')) throw new Error('Firefox returned an invalid automation response.');
    return payload.value;
  }

  function getSession(): Promise<string> {
    session ??= request('/session', 'POST', { capabilities: { alwaysMatch: { browserName: 'firefox',
      timeouts: { implicit: 0, pageLoad: 15_000, script: 15_000 } } } }).then(value => {
      const result = record(value);
      const capabilities = record(result?.capabilities);
      if (typeof result?.sessionId !== 'string' || !result.sessionId || capabilities?.browserName !== 'firefox') {
        throw new Error('Firefox returned an invalid automation session.');
      }
      return result.sessionId;
    }).catch(error => { session = null; throw error; });
    return session;
  }

  const surfaceRef = (handle: string) => `firefox:${encodeURIComponent(handle)}`;

  return async args => {
    const tree = args.length === 5 && args.join(' ') === '--id-format both tree --all --json'
      || args.length === 2 && args[0] === 'tree' && args[1] === '--json';
    const focus = args.length === 3 && args[0] === 'rpc' && args[1] === 'surface.focus';
    const operation = args[0] === 'browser' ? args[2] : undefined;
    if (!tree && !focus && !['eval', 'click', 'fill', 'wait', 'press'].includes(operation ?? '')) {
      throw new Error('Unsupported Firefox Slack browser command.');
    }
    const id = await getSession();
    const path = `/session/${encodeURIComponent(id)}`;
    const command = (suffix: string, method = 'GET', body?: unknown) => request(`${path}${suffix}`, method, body);
    const currentHandle = async (): Promise<string> => {
      const value = await command('/window');
      if (typeof value !== 'string' || !value) throw new Error('Firefox tab selection is unavailable.');
      return value;
    };
    const select = (handle: string) => command('/window', 'POST', { handle });
    const restore = async (original: string, selected: string) => {
      if (original === selected) return;
      try { if (await currentHandle() === selected) await select(original); } catch {}
    };

    if (tree) {
      const original = await currentHandle();
      const handles = await command('/window/handles');
      if (!Array.isArray(handles) || handles.length > 100 || handles.some(handle => typeof handle !== 'string' || !handle)) {
        throw new Error('Firefox tab discovery returned invalid window handles.');
      }
      let selected = original;
      const surfaces: { ref: string; id: string; type: string; url: string }[] = [];
      const discovered = new Map<string, string>();
      try {
        for (const handle of handles as string[]) {
          try {
            if (selected !== handle) { await select(handle); selected = handle; }
            const url = await command('/url');
            if (typeof url !== 'string') throw new Error('Firefox returned an invalid tab URL.');
            const ref = surfaceRef(handle);
            discovered.set(ref, handle);
            surfaces.push({ ref, id: ref, type: 'browser', url });
          } catch (error) {
            if (!(error instanceof FirefoxCommandError) || error.code !== 'no such window') throw error;
          }
        }
      } finally { await restore(original, selected); }
      knownHandles.clear();
      for (const [ref, handle] of discovered) knownHandles.set(ref, handle);
      const active = surfaceRef(await currentHandle());
      return JSON.stringify({ active: { surface_ref: active }, windows: [{ workspaces: [{ panes: [{ selected_surface_ref: active, surfaces }] }] }] });
    }

    let surface: string | undefined = args[1];
    if (focus) {
      let input: Record<string, unknown> | null;
      try { input = record(JSON.parse(args[2] ?? '')); } catch { input = null; }
      surface = typeof input?.surface_id === 'string' ? input.surface_id : undefined;
    }
    const handle = surface ? knownHandles.get(surface) : undefined;
    if (!handle) throw new Error('Firefox Slack tab is unknown. Refresh browser discovery and select a Firefox surface.');
    if (focus) { await select(handle); return 'OK'; }
    const original = await currentHandle();
    try {
      if (original !== handle) await select(handle);
      const url = await command('/url');
      try {
        if (typeof url !== 'string' || new URL(url).origin !== 'https://app.slack.com') throw new Error();
      } catch { throw new Error('Firefox Slack automation requires a signed-in app.slack.com tab.'); }
      if (operation === 'eval') {
        if (args.length !== 4 || !args[3]) throw new Error('Invalid Firefox Slack evaluation.');
        const value = await command('/execute/sync', 'POST', { script: `if (location.origin !== "https://app.slack.com") throw new Error("Slack tab changed"); return (${args[3]});`, args: [] });
        return typeof value === 'string' ? value : JSON.stringify(value);
      }
      const element = async (selector: string): Promise<string | null> => {
        const matches = await command('/elements', 'POST', { using: 'css selector', value: selector });
        if (!Array.isArray(matches)) throw new Error('Firefox returned invalid Slack controls.');
        for (const match of matches) {
          const elementId = record(match)?.[ELEMENT];
          if (typeof elementId !== 'string' || !elementId) throw new Error('Firefox returned an invalid Slack control.');
          if (await command(`/element/${encodeURIComponent(elementId)}/displayed`) === true) return elementId;
        }
        return null;
      };
      if (operation === 'wait') {
        const timeout = Number(args[6]);
        if (args.length !== 7 || args[3] !== '--selector' || !args[4] || args[5] !== '--timeout-ms'
          || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15_000) throw new Error('Invalid Firefox Slack wait command.');
        const deadline = Date.now() + timeout;
        do {
          if (await element(args[4])) return 'OK';
          if (Date.now() >= deadline) break;
          await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
        } while (Date.now() <= deadline);
        throw new Error('The Slack browser control did not appear before the timeout.');
      }
      if (operation === 'press') {
        const key = args[3] ? KEYS[args[3]] : undefined;
        if (args.length !== 4 || !key) throw new Error('Unsupported Firefox Slack key.');
        await command('/actions', 'POST', { actions: [{ type: 'key', id: 'helmsman-slack-keyboard', actions: [
          { type: 'keyDown', value: key }, { type: 'keyUp', value: key },
        ] }] });
        return 'OK';
      }
      if (!args[3] || operation === 'click' && args.length !== 4 || operation === 'fill' && args.length !== 5) {
        throw new Error('Invalid Firefox Slack control command.');
      }
      const elementId = await element(args[3]);
      if (!elementId) throw new FirefoxCommandError('no such element');
      const target = `/element/${encodeURIComponent(elementId)}`;
      if (operation === 'click') await command(`${target}/click`, 'POST', {});
      else {
        await command(`${target}/clear`, 'POST', {});
        if (args[4]) await command(`${target}/value`, 'POST', { text: args[4] });
      }
      return 'OK';
    } finally { await restore(original, handle); }
  };
}
