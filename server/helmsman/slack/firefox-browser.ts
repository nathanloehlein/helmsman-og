import type { SlackBrowserTransport } from './browser';
import { connectFirefoxBidi, type FirefoxBidiClient } from './firefox-bidi';

const UNAVAILABLE = 'Firefox background automation is unavailable. Restart Firefox with --marionette --remote-debugging-port 9222, then restart the local Firefox bridge.';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function endpointUrl(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Firefox WebDriver must use a local HTTP endpoint.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Firefox WebDriver must use a local HTTP endpoint without credentials, a path, or query parameters.');
  }
  return url;
}

function slackControl(doc: Document, selector: string, operation: 'click' | 'fill' | 'wait', text?: string): boolean {
  const element = Array.from(doc.querySelectorAll<HTMLElement>(selector)).find(item => {
    const style = doc.defaultView?.getComputedStyle(item);
    return item.isConnected && item.getClientRects().length > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
  });
  if (!element) return false;
  if (operation === 'wait') return true;
  if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return false;
  if (operation === 'click') { element.click(); return true; }
  if (typeof text !== 'string') return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element.readOnly) return false;
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(element, text);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element.value === text;
  }
  if (!element.isContentEditable || typeof doc.execCommand !== 'function') return false;
  if (element.textContent === text) return true;
  const selection = doc.getSelection();
  if (!selection) return false;
  element.focus({ preventScroll: true });
  const range = doc.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return doc.execCommand(text ? 'insertText' : 'delete', false, text);
}

export function createFirefoxSlackBrowserTransport(endpoint = 'http://127.0.0.1:4444'): SlackBrowserTransport {
  const base = endpointUrl(endpoint);
  let session: Promise<string> | null = null;
  let connection: Promise<FirefoxBidiClient> | null = null;
  const contexts = new Map<string, string>();
  let virtualSelection: string | null = null;

  function getSession(): Promise<string> {
    session ??= (async () => {
      let payload: Record<string, unknown> | null;
      try {
        const response = await fetch(`${base.origin}/session`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: 'firefox', webSocketUrl: true,
            timeouts: { implicit: 0, pageLoad: 15_000, script: 15_000 } } } }),
        });
        if (!response.ok) throw new Error();
        payload = record(await response.json());
      } catch { throw new Error(UNAVAILABLE); }
      const value = record(payload?.value);
      const capabilities = record(value?.capabilities);
      if (typeof value?.sessionId !== 'string' || !value.sessionId || capabilities?.browserName !== 'firefox'
        || typeof capabilities.webSocketUrl !== 'string') throw new Error(UNAVAILABLE);
      let socket: URL;
      try { socket = new URL(capabilities.webSocketUrl); } catch { throw new Error(UNAVAILABLE); }
      if (socket.protocol !== 'ws:' || socket.hostname !== base.hostname || socket.username || socket.password || socket.search || socket.hash) {
        throw new Error('Firefox returned an unsafe background automation endpoint. Restart the local Firefox bridge.');
      }
      return socket.href;
    })().catch(error => { session = null; throw error; });
    return session;
  }

  async function client(): Promise<FirefoxBidiClient> {
    if (connection) {
      const current = await connection;
      if (!current.closed) return current;
      connection = null;
    }
    const pending = getSession().then(url => connectFirefoxBidi(url));
    connection = pending;
    try { return await pending; }
    catch (error) { if (connection === pending) connection = null; throw error; }
  }

  return async args => {
    const tree = args.length === 5 && args.join(' ') === '--id-format both tree --all --json'
      || args.length === 2 && args[0] === 'tree' && args[1] === '--json';
    const focus = args.length === 3 && args[0] === 'rpc' && args[1] === 'surface.focus';
    const operation = args[0] === 'browser' ? args[2] : undefined;
    if (!tree && !focus && !['eval', 'click', 'fill', 'wait'].includes(operation ?? '')) {
      throw new Error('Unsupported Firefox background Slack command. Keyboard presses and browser activation are unavailable.');
    }
    if (tree) {
      contexts.clear();
      const bidi = await client();
      const value = record(await bidi.request('browsingContext.getTree', { maxDepth: 0 }));
      if (!Array.isArray(value?.contexts) || value.contexts.length > 100) {
        bidi.close();
        throw new Error('Firefox returned invalid background tab discovery.');
      }
      const next = new Map<string, string>();
      const surfaces = value.contexts.map(item => {
        const context = record(item);
        if (typeof context?.context !== 'string' || !context.context || typeof context.url !== 'string'
          || context.parent !== null && context.parent !== undefined) {
          bidi.close();
          throw new Error('Firefox returned an invalid background tab.');
        }
        const ref = `firefox:${encodeURIComponent(context.context)}`;
        if (next.has(ref)) { bidi.close(); throw new Error('Firefox returned duplicate background tabs.'); }
        next.set(ref, context.context);
        return { ref, id: ref, type: 'browser', url: context.url };
      });
      for (const [ref, context] of next) contexts.set(ref, context);
      if (!virtualSelection || !contexts.has(virtualSelection)) virtualSelection = surfaces[0]?.ref ?? null;
      return JSON.stringify({ active: { surface_ref: virtualSelection }, windows: [{ workspaces: [{ panes: [{ selected_surface_ref: virtualSelection, surfaces }] }] }] });
    }
    let surface: string | undefined = args[1];
    if (focus) {
      let value: Record<string, unknown> | null;
      try { value = record(JSON.parse(args[2] ?? '')); } catch { value = null; }
      surface = typeof value?.surface_id === 'string' ? value.surface_id : undefined;
    }
    const context = surface ? contexts.get(surface) : undefined;
    if (!context) throw new Error('Firefox Slack tab is unknown. Refresh browser discovery.');
    if (focus) { virtualSelection = surface!; return 'OK'; }
    const evaluate = async (expression: string, timeoutMs = 15_000): Promise<unknown> => {
      const bidi = await client();
      const value = record(await bidi.request('script.evaluate', {
        expression: `((__name) => { if (location.origin !== "https://app.slack.com") throw new Error("Slack tab changed"); const value = (${expression}); return JSON.stringify(value === undefined ? null : value); })((value) => value)`,
        target: { context }, awaitPromise: true, userActivation: false, resultOwnership: 'none',
      }, timeoutMs));
      const result = record(value?.result);
      if (value?.type !== 'success' || result?.type !== 'string' || typeof result.value !== 'string') {
        bidi.close();
        throw new Error('Firefox could not complete the background Slack operation. Check the signed-in Slack tab and retry.');
      }
      try { return JSON.parse(result.value) as unknown; }
      catch { bidi.close(); throw new Error('Firefox returned an invalid background Slack result.'); }
    };
    if (operation === 'eval') {
      if (args.length !== 4 || !args[3]) throw new Error('Invalid Firefox Slack evaluation.');
      const result = await evaluate(args[3]);
      return typeof result === 'string' ? result : JSON.stringify(result);
    }
    const control = (selector: string, action: 'click' | 'fill' | 'wait', text?: string, timeoutMs?: number) => evaluate(
      `(${slackControl.toString()})(document, ${JSON.stringify(selector)}, ${JSON.stringify(action)}, ${JSON.stringify(text ?? null)})`, timeoutMs,
    );
    if (operation === 'wait') {
      const timeout = Number(args[6]);
      if (args.length !== 7 || args[3] !== '--selector' || !args[4] || args[5] !== '--timeout-ms'
        || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15_000) throw new Error('Invalid Firefox Slack wait command.');
      const deadline = Date.now() + timeout;
      do {
        if (await control(args[4], 'wait', undefined, Math.max(1, deadline - Date.now())) === true) return 'OK';
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
      } while (Date.now() < deadline);
      throw new Error('The Slack browser control did not appear before the timeout.');
    }
    if (!args[3] || operation === 'click' && args.length !== 4 || operation === 'fill' && args.length !== 5) {
      throw new Error('Invalid Firefox Slack control command.');
    }
    if (await control(args[3], operation as 'click' | 'fill', args[4]) !== true) {
      throw new Error('The Slack browser control is unavailable or changed. Retry after the page settles.');
    }
    return 'OK';
  };
}
