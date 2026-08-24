/* LEVEL — shared-event server. No dependencies: node:http for transport,
   node:sqlite for storage, Server-Sent Events for live push.
   PORT and LEVEL_DB are the only knobs a host needs. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './server/db.js';
import { handleApi } from './server/api.js';
import { closeAll } from './server/sse.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendFile(res, file, status = 200) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(status, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      /* the markup is a shell; all data arrives over the API */
      'cache-control': 'no-cache'
    });
    res.end(buf);
  });
}

export function createServer(store) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (await handleApi(req, res, store)) return;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }

    /* the app shell — the client reads the event id out of the path */
    if (pathname === '/' ) return sendFile(res, path.join(PUBLIC, 'new.html'));
    if (pathname === '/recent') return sendFile(res, path.join(PUBLIC, 'recent.html'));
    if (/^\/e\/[^/]+$/.test(pathname)) return sendFile(res, path.join(PUBLIC, 'index.html'));

    /* static, with the usual traversal guard */
    const file = path.join(PUBLIC, pathname);
    if (!file.startsWith(PUBLIC + path.sep)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    sendFile(res, file);
  });
}

/* started directly, not imported by a test */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = openDb();
  const server = createServer(store);
  const port = Number(process.env.PORT) || 8731;
  server.listen(port, () => {
    console.log(`LEVEL on http://localhost:${port}  (db: ${process.env.LEVEL_DB || './level.db'})`);
  });
  const bye = () => { closeAll(); server.close(() => { store.close(); process.exit(0); }); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
