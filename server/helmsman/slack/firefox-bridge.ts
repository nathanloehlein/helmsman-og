import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseFirefoxWebDriverUrl } from './config';
import type { FirefoxBridgeStatus } from '../../../src/data/firefoxBridge';

interface BridgeDependencies {
  portOpen: (port: number, host: string) => Promise<boolean>;
  driverRunning: (endpoint: string) => Promise<boolean>;
  launch: () => { exited: () => boolean };
  wait: () => Promise<void>;
  started: () => void;
}

function portOpen(port: number, host: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function driverRunning(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/status`, { redirect: 'error', signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('value' in payload)) return false;
    const value = payload.value;
    return value !== null && typeof value === 'object' && 'ready' in value && typeof value.ready === 'boolean';
  } catch { return false; }
}

function launch(): { exited: () => boolean } {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../../scripts/slack-firefox.mjs', import.meta.url))], {
    detached: true, stdio: 'ignore',
  });
  let exited = false;
  child.once('error', () => { exited = true; });
  child.once('exit', () => { exited = true; });
  child.unref();
  return { exited: () => exited };
}

function localEndpoint(value: string): URL | null {
  try { return new URL(parseFirefoxWebDriverUrl(value)); } catch { return null; }
}

export function createFirefoxBridgeControl(endpoint: () => string, dependencies: Partial<BridgeDependencies> = {}) {
  const deps: BridgeDependencies = { portOpen, driverRunning, launch, started: () => {}, wait: () => new Promise(resolve => setTimeout(resolve, 250)), ...dependencies };
  let managedStarted = false;
  let managedChild: ReturnType<BridgeDependencies['launch']> | null = null;
  let starting: Promise<FirefoxBridgeStatus> | null = null;

  async function status(): Promise<FirefoxBridgeStatus> {
    const url = localEndpoint(endpoint());
    if (!url) return { status: 'blocked', bridgeRunning: false, firefoxReady: false, canStart: false,
      message: 'Set a local HTTP Firefox bridge address without a path or credentials.' };
    const [bridgeRunning, marionette, bidi, occupied] = await Promise.all([
      deps.driverRunning(url.origin), deps.portOpen(2828, '127.0.0.1'), deps.portOpen(9222, '127.0.0.1'),
      deps.portOpen(Number(url.port || 80), url.hostname.replace(/^\[|\]$/g, '')),
    ]);
    const supported = ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '4444';
    if (bridgeRunning && supported && managedChild && !managedChild.exited() && !managedStarted) {
      managedStarted = true;
      deps.started();
    }
    const firefoxReady = marionette && bidi;
    const canStart = !bridgeRunning && !occupied && firefoxReady && supported && (!managedChild || managedChild.exited());
    const message = bridgeRunning
      ? firefoxReady ? 'Bridge running. Firefox automation is available.' : 'Bridge running, but Firefox automation is unavailable. Start Firefox with --marionette --remote-debugging-port 9222.'
      : managedChild && !managedChild.exited() ? 'The Firefox bridge process is starting. Check status shortly.'
      : !supported ? 'Bridge stopped. Start your custom bridge manually, or save http://127.0.0.1:4444 to use Start bridge.'
      : occupied ? 'The bridge address is in use by an unrecognized service. Free port 4444 before starting the bridge.'
      : !firefoxReady ? 'Bridge stopped. Start Firefox with --marionette --remote-debugging-port 9222, then check status.'
      : 'Bridge stopped. Firefox automation is available.';
    return { status: bridgeRunning ? 'running' : canStart ? 'stopped' : 'blocked', bridgeRunning, firefoxReady, canStart, message };
  }

  function start(): Promise<FirefoxBridgeStatus> {
    starting ??= (async () => {
      const before = await status();
      if (!before.canStart) return before;
      let child: ReturnType<BridgeDependencies['launch']>;
      try { child = deps.launch(); managedChild = child; managedStarted = false; }
      catch { return { ...before, message: 'Could not start the Firefox bridge. Check that geckodriver is installed.' }; }
      for (let attempt = 0; attempt < 8; attempt++) {
        await deps.wait();
        const current = await status();
        if (current.bridgeRunning) return current;
        if (child.exited()) return { ...current, message: 'Firefox bridge could not start. Check that geckodriver is installed (macOS: brew install geckodriver).' };
      }
      const current = await status();
      return current.bridgeRunning ? current : { ...current, canStart: false, message: 'Bridge startup is taking longer than expected. Check status before trying again.' };
    })().finally(() => { starting = null; });
    return starting;
  }

  return { status, start };
}
