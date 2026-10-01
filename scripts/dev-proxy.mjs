#!/usr/bin/env node
// Local development reverse proxy that mirrors the production Caddy routing:
//   /api/*  → API  (default http://localhost:4000)   — bodies are streamed, never buffered
//   else    → web  (default http://localhost:3000)
// Usage: node scripts/dev-proxy.mjs [--port 8080]   then open http://localhost:8080
// (Next's own /api rewrite buffers request bodies, so large uploads must not go through it.)
import http from 'node:http';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const PORT = Number(arg('port', process.env.DEV_PROXY_PORT ?? 8080));
const API = new URL(process.env.API_INTERNAL_URL ?? 'http://localhost:4000');
const WEB = new URL(process.env.WEB_INTERNAL_URL ?? 'http://localhost:3000');

const server = http.createServer((req, res) => {
  const target = req.url.startsWith('/api/') || req.url === '/api' ? API : WEB;
  const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress, 'x-forwarded-proto': 'http', 'x-forwarded-host': req.headers.host };
  const upstream = http.request(
    { host: target.hostname, port: target.port, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'bad_gateway', message: 'The server is temporarily unavailable.' } }));
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});
server.requestTimeout = 0;
server.listen(PORT, () => console.log(`dev proxy on http://localhost:${PORT}  (/api → ${API.origin}, else → ${WEB.origin})`));
