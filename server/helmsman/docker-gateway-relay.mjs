const http = require('node:http');
const upstream = new URL(process.argv[1]);
if (upstream.protocol !== 'http:' || !['host.docker.internal', '127.0.0.1'].includes(upstream.hostname)
  || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) throw new Error('Invalid gateway upstream');
const server = http.createServer((request, response) => {
  const path = request.url ?? '';
  if (request.method === 'GET' && path === '/health') { response.writeHead(204); response.end(); return; }
  if (!['GET', 'POST'].includes(request.method ?? '') || !path.startsWith('/') || path.startsWith('//')
    || /[\\#\r\n]/.test(path)) { response.writeHead(403); response.end(); return; }
  const headers = {};
  for (const key of ['authorization', 'x-api-key', 'content-type', 'anthropic-version', 'anthropic-beta', 'accept']) {
    const value = request.headers[key];
    if (typeof value === 'string') headers[key] = value;
  }
  const forwarded = http.request({ hostname: upstream.hostname, port: upstream.port || 80, path,
    method: request.method, headers, timeout: 300_000 }, result => {
    response.writeHead(result.statusCode ?? 502, { 'content-type': result.headers['content-type'] ?? 'application/json', 'cache-control': 'no-store' });
    result.pipe(response);
    result.on('error', () => response.destroy());
  });
  forwarded.on('timeout', () => forwarded.destroy());
  forwarded.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.on('aborted', () => forwarded.destroy());
  response.on('close', () => forwarded.destroy());
  request.pipe(forwarded);
});
server.on('connect', (_request, socket) => socket.destroy());
server.listen(Number(process.argv[2] ?? 8080), '0.0.0.0', () => process.stdout.write('ready\n'));
