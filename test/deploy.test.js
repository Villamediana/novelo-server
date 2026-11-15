import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../src/config.js';
import { fakeUpstream, startServer, Phone, panel } from './helpers.js';

test('a .env that is a link to data/.env: the real file is written and the link stays', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelo-env-'));
  try {
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data', '.env'), 'ADMIN_PASSWORD=x\n');
    fs.symlinkSync('data/.env', path.join(dir, '.env'));
    // Writing next to the link is not allowed (a sandbox that writes only in data/).
    fs.chmodSync(dir, 0o555);
    const c = new Config(path.join(dir, '.env'), {});
    c.set('OPENROUTER_API_KEY', 'sk-nova');
    const secret = c.serverSecret();
    assert.equal(fs.lstatSync(path.join(dir, '.env')).isSymbolicLink(), true);
    const real = fs.readFileSync(path.join(dir, 'data', '.env'), 'utf8');
    assert.match(real, /^ADMIN_PASSWORD=x$/m);
    assert.match(real, /^OPENROUTER_API_KEY=sk-nova$/m);
    assert.match(real, new RegExp(`^SERVER_SECRET=${secret}$`, 'm'));
    assert.equal(fs.statSync(path.join(dir, 'data', '.env')).mode & 0o777, 0o600);
    assert.equal(new Config(path.join(dir, '.env'), {}).get('OPENROUTER_API_KEY'), 'sk-nova');
    // A link whose file doesn't exist yet: it is made where the link points.
    fs.chmodSync(dir, 0o755);
    fs.symlinkSync('data/outro.env', path.join(dir, 'outro.env'));
    new Config(path.join(dir, 'outro.env'), {}).set('XY', '1');
    assert.equal(fs.readFileSync(path.join(dir, 'data', 'outro.env'), 'utf8'), 'XY=1\n');
    assert.equal(fs.lstatSync(path.join(dir, 'outro.env')).isSymbolicLink(), true);
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('behind the proxy, plain http is refused; https and the local health check go on', async () => {
  const upstream = await fakeUpstream(() => ({ text: 'ok' }));
  const server = await startServer({ upstream, env: 'TRUST_PROXY=cloudflare\n' });
  try {
    server.route('think', 'm');
    const phone = new Phone(server.url);
    await phone.register();
    const http = { 'X-Forwarded-Proto': 'http', 'CF-Visitor': '{"scheme":"http"}' };
    const https = { 'X-Forwarded-Proto': 'https', 'CF-Visitor': '{"scheme":"https"}' };
    assert.equal((await phone.ask('think', undefined, { headers: https })).status, 200);
    const plain = await phone.ask('think', undefined, { headers: http });
    assert.equal(plain.status, 403);
    assert.equal(plain.json.error.code, 'https_required');
    assert.equal((await fetch(`${server.url}/v1/devices/challenge`, { method: 'POST', headers: { 'CF-Visitor': '{"scheme":"http"}' } })).status, 403);
    // Nothing said about the scheme (the supervisor on the machine itself): it goes.
    assert.equal((await phone.ask('think')).status, 200);
    assert.equal((await fetch(`${server.url}/health`, { headers: http })).status, 200);
    // The panel, if published behind the proxy, never over http.
    assert.equal((await fetch(`${server.adminUrl}/`, { headers: http })).status, 403);
    assert.equal((await fetch(`${server.adminUrl}/api/login`, { method: 'POST', headers: { ...http, 'X-Novelo-Admin': '1' }, body: JSON.stringify({ password: server.password }) })).status, 403);
    assert.equal((await fetch(`${server.adminUrl}/`, { headers: https })).status, 200);
  } finally {
    await server.close();
    await upstream.close();
  }
  // Without a proxy that says the scheme, nothing is assumed.
  const up2 = await fakeUpstream(() => ({ text: 'ok' }));
  const s2 = await startServer({ upstream: up2 });
  try {
    s2.route('think', 'm');
    const p = new Phone(s2.url);
    await p.register();
    assert.equal((await p.ask('think', undefined, { headers: { 'X-Forwarded-Proto': 'http' } })).status, 200);
  } finally {
    await s2.close();
    await up2.close();
  }
});

test('the health check says whether each job can answer, and nothing more', async () => {
  const upstream = await fakeUpstream(() => ({ text: 'ok' }));
  const server = await startServer({ upstream });
  try {
    const health = async () => (await fetch(`${server.url}/health`)).json();
    // A fresh server: the key is there (the free models), no model of its own.
    let h = await health();
    assert.deepEqual(h.ready, { hear: false, see: false, think: true });
    assert.equal(h.paused, 0);
    server.job('think', { free_fallback: 0 });
    assert.deepEqual((await health()).ready, { hear: false, see: false, think: false });
    for (const job of ['hear', 'see', 'think']) server.route(job, `m-${job}`);
    assert.deepEqual((await health()).ready, { hear: true, see: true, think: true });
    // The key gone: nothing can answer.
    const call = await panel(server);
    await call('PUT', '/api/providers/1/key', { value: '' });
    h = await health();
    assert.deepEqual(h.ready, { hear: false, see: false, think: false });
    assert.equal(JSON.stringify(h).includes('m-think'), false);
    await call('PUT', '/api/settings', { paused: 1 });
    assert.equal((await health()).paused, 1);
  } finally {
    await server.close();
    await upstream.close();
  }
});
