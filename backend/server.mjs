// MyDocs entitlement server (zero dependencies). Configuration comes from the environment:
//   MYDOCS_DB              path of the SQLite file                      (default backend/data/mydocs.sqlite)
//   MYDOCS_SECRETS         folder holding signing-key.pem and pepper.txt (default backend/.secrets; created by `admin.mjs init`)
//   MYDOCS_ALLOWED_ORIGIN  CORS origin of the app's WebView              (default https://localhost)
//   PORT                   listen port                                    (default 8787)
//   PLAY_PACKAGE_NAME, PLAY_PRODUCT_IDS (comma separated), GOOGLE_SERVICE_ACCOUNT_FILE   enable /v1/play/verify
// Put it behind HTTPS (a reverse proxy such as Caddy or nginx, or a platform that terminates TLS). The app only talks to https.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './lib/store.mjs';
import { createApi } from './lib/api.mjs';
import { createPlayVerifier } from './lib/play.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 8 * 1024;

export function createHttpServer({ api, allowedOrigin = 'https://localhost' }) {
  const cors = { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' };
  return createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) { send(413, { error: 'BAD_REQUEST' }); req.destroy(); return; } }
    let body = null;
    if (raw) { try { body = JSON.parse(raw); } catch { send(400, { error: 'BAD_REQUEST' }); return; } }
    const url = new URL(req.url, 'http://x');
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim();
    const { status, body: out } = await api.handle({ method: req.method, path: url.pathname, body, ip });
    send(status, out);
  });
}

function main() {
  const secrets = process.env.MYDOCS_SECRETS ?? join(here, '.secrets');
  const keyFile = join(secrets, 'signing-key.pem');
  const pepperFile = join(secrets, 'pepper.txt');
  if (!existsSync(keyFile) || !existsSync(pepperFile)) { console.error('Missing signing key or pepper. Run: node backend/admin.mjs init'); process.exit(1); }
  const store = openStore(process.env.MYDOCS_DB ?? join(here, 'data', 'mydocs.sqlite'));
  let play = null;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE && process.env.PLAY_PACKAGE_NAME) {
    play = createPlayVerifier({
      packageName: process.env.PLAY_PACKAGE_NAME,
      productIds: (process.env.PLAY_PRODUCT_IDS ?? 'mydocs_pro_lifetime').split(',').map((s) => s.trim()),
      serviceAccount: JSON.parse(readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8')),
    });
  }
  const api = createApi({ store, privateKeyPem: readFileSync(keyFile, 'utf8'), pepper: readFileSync(pepperFile, 'utf8').trim(), play });
  const port = Number(process.env.PORT ?? 8787);
  createHttpServer({ api, allowedOrigin: process.env.MYDOCS_ALLOWED_ORIGIN ?? 'https://localhost' }).listen(port, () => console.log(`MyDocs entitlement server on :${port} (Play verification ${play ? 'on' : 'off'})`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
