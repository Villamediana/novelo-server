// A server on a temporary folder, a made-up model API in front of it, and a phone that registers
// and signs its requests the way the app does.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.js';
import { build } from '../src/app.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** A model API. [script](request json, headers) → { status?, text?, body?, headers?, delay? }. */
export async function fakeUpstream(script) {
  const calls = [];
  const state = { script, models: [] };
  const { server, url } = await listen((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: state.models }));
        return;
      }
      const json = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      calls.push({ json, headers: req.headers });
      const r = (await state.script(json, req.headers, calls.length)) ?? {};
      if (r.delay) await sleep(r.delay);
      const status = r.status ?? 200;
      const body = r.body ?? (status === 200
        ? { choices: [{ message: { role: 'assistant', content: r.text ?? 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, ...(r.cost !== undefined ? { cost: r.cost } : {}), ...(r.cached !== undefined ? { prompt_tokens_details: { cached_tokens: r.cached } } : {}) } }
        : { error: { message: r.message ?? `erro ${status}` } });
      res.writeHead(status, { 'Content-Type': 'application/json', ...(r.headers ?? {}) }).end(JSON.stringify(body));
    });
  });
  return { url, calls, state, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

/** The server, with its API (and the panel) listening on free ports. */
export async function startServer({ upstream, heartbeatMs, password = 'senha-de-teste', env = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelo-server-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, `ADMIN_PASSWORD=${password}\nOPENROUTER_API_KEY=sk-test-1234\n${env}`);
  const config = new Config(envFile, {});
  const app = build({ config, dataDir: path.join(dir, 'data'), heartbeatMs, roots: [] });
  if (upstream) app.db.prepare('UPDATE providers SET base_url = ? WHERE id = 1').run(upstream.url);
  app.router.reload();
  const api = await listen((q, s) => app.api.handle(q, s));
  const admin = await listen((q, s) => app.admin.handle(q, s));
  return {
    app, dir, envFile, url: api.url, adminUrl: admin.url, password,
    route(job, model, more = {}) {
      const pos = app.db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM routes WHERE job = ?').get(job).p;
      const r = { provider_id: 1, max_concurrency: 32, rpm: 0, price_in: 0, price_out: 0, timeout_s: 30, extra: '{}', ...more };
      const id = app.db.prepare('INSERT INTO routes(job,position,provider_id,model,max_concurrency,rpm,price_in,price_out,timeout_s,extra) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(job, pos, r.provider_id, model, r.max_concurrency, r.rpm, r.price_in, r.price_out, r.timeout_s, r.extra).lastInsertRowid;
      app.router.reload();
      return Number(id);
    },
    job(key, fields) {
      for (const [k, v] of Object.entries(fields)) app.db.prepare(`UPDATE jobs SET ${k} = ? WHERE key = ?`).run(v, key);
      app.router.reload();
    },
    async close() {
      for (const s of [api.server, admin.server]) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
      }
      app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A phone: a P-256 key, registered, signing each request. */
export class Phone {
  constructor(url) {
    this.url = url;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = privateKey;
    this.spki = publicKey.export({ type: 'spki', format: 'der' });
    this.id = null;
  }

  async register(extra = {}) {
    const { challenge } = await (await fetch(`${this.url}/v1/devices/challenge`, { method: 'POST' })).json();
    const proof = crypto.sign('sha256', Buffer.from(`novelo-device-v1\n${challenge}`), { key: this.privateKey, dsaEncoding: 'der' }).toString('base64');
    const res = await fetch(`${this.url}/v1/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge, public_key: this.spki.toString('base64'), proof, app: { version: '1.73.0', package: 'com.villamediana.novelo' }, ...extra }),
    });
    const json = await res.json();
    if (res.ok) this.id = json.device;
    return { status: res.status, json };
  }

  headers(path, body, { request = crypto.randomUUID(), time = Date.now(), not, method = 'POST' } = {}) {
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    const text = `v1\n${method}\n${path}\n${time}\n${request}\n${hash}`;
    return {
      'Content-Type': 'application/json',
      'X-Novelo-Device': this.id,
      'X-Novelo-Time': String(time),
      'X-Novelo-Request': request,
      'X-Novelo-Signature': crypto.sign('sha256', Buffer.from(text), { key: this.privateKey, dsaEncoding: 'der' }).toString('base64'),
      ...(not ? { 'X-Novelo-Not': not } : {}),
    };
  }

  async ask(job, payload = { messages: [{ role: 'user', content: 'oi' }] }, opts = {}) {
    const path = `/v1/ask/${job}`;
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const res = await fetch(this.url + path, { method: 'POST', headers: { ...this.headers(path, body, opts), ...(opts.headers ?? {}) }, body });
    const raw = await res.text();
    return { status: res.status, raw, json: JSON.parse(raw), headers: res.headers };
  }
}

/** Any signed request of a phone: [body] a Buffer, a string or nothing. Returns { status, json, data }. */
export async function signed(phone, method, path, body, headers = {}) {
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const res = await fetch(phone.url + path, { method, headers: { ...phone.headers(path, raw, { method }), ...headers }, body: raw.length ? raw : undefined });
  const data = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(data.toString());
  } catch { /* bytes */ }
  return { status: res.status, json, data, headers: res.headers };
}

/** The panel, logged in. */
export async function panel(server) {
  const login = await fetch(`${server.adminUrl}/api/login`, { method: 'POST', headers: { 'X-Novelo-Admin': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: server.password }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  return async (method, p, body) => {
    const res = await fetch(server.adminUrl + p, { method, headers: { Cookie: cookie, 'X-Novelo-Admin': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
}
