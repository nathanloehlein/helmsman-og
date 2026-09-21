import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

const available = port => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port });
  const finish = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(2000);
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.once('timeout', () => finish(false));
});

if (!await available(2828) || !await available(9222)) {
  console.error('Firefox background automation is unavailable. Restart your regular Firefox with --marionette --remote-debugging-port 9222, then run this command again.');
  process.exit(1);
}

const driver = spawn('geckodriver', [
  '--connect-existing', '--host', '127.0.0.1', '--port', '4444', '--marionette-port', '2828',
], { stdio: 'inherit' });
driver.on('error', error => {
  console.error(error.code === 'ENOENT' ? 'Install geckodriver first (macOS: brew install geckodriver).' : 'Could not start the Firefox bridge.');
  process.exitCode = 1;
});
driver.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => driver.kill(signal));
