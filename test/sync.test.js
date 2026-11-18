// The Novelo on the computer, end to end on a real server: the phone opens its space, a computer
// shows its code and the phone reads it, both write and read records the server cannot open, files,
// conflicts, the wait for news, unlinking, and the computer asking the intelligence in the phone's name.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, fakeUpstream, Phone, signed, sleep } from './helpers.js';
import * as lock from '../web/src/core/crypto.js';
import { Api } from '../web/src/core/api.js';

let upstream, server, phone, keys, master, spaceId;

before(async () => {
  upstream = await fakeUpstream(() => ({ text: '{"reply":"ok"}' }));
  server = await startServer({ upstream });
  server.route('think', 'modelo-de-teste');
  phone = new Phone(server.url);
  assert.equal((await phone.register()).status, 200);
  master = globalThis.crypto.getRandomValues(new Uint8Array(32));
  keys = await lock.spaceKeys(master);
});

after(async () => {
  await server.close();
  await upstream.close();
});

// Each linked computer's signing key (by its token): its requests go signed, as the page's do.
const proofs = new Map();
const web = (token) => async (method, path, body, headers = {}) => {
  const bytes = body == null ? undefined : body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
  const proof = proofs.get(token);
  const sig = proof ? await new Api({ token, proof }).sign(method, path, bytes) : null;
  const res = await fetch(server.url + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(sig ? { 'X-Novelo-Sig': sig } : {}), ...(body && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: bytes,
  });
  const data = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(data.toString());
  } catch { /* bytes */ }
  return { status: res.status, json, data };
};

/** A computer that showed its code and was linked by the phone. */
async function linkComputer(name = 'Chrome no Windows') {
  // Many codes from one address in a few seconds (the tests): the per-minute count starts over.
  server.app.api.knocks.clear();
  server.app.sync.calls.clear();
  const mine = await lock.linkKeys();
  const signer = await lock.proofKeys();
  const start = await web()('POST', '/v1/link', { key: mine.pub, name, proof: signer.pub });
  assert.equal(start.status, 200);
  const waiting = web()('GET', `/v1/link/${start.json.id}?wait=10`, null, { 'X-Novelo-Poll': start.json.poll });
  await sleep(50);
  // The phone read the QR code: link id, the computer's public key and the code's secret.
  const wrapped = await lock.wrapLink(mine.pub, start.json.id, mine.secret, { space: spaceId, key: master, owner: 'Pixel da Ana' });
  const ok = await signed(phone, 'POST', `/v1/link/${start.json.id}/approve`, { wrapped, owner: 'Pixel da Ana' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const got = await waiting;
  assert.equal(got.status, 200);
  assert.equal(got.json.status, 'linked');
  const opened = await lock.unwrapLink(mine.privateKey, start.json.id, mine.secret, got.json.wrapped);
  proofs.set(got.json.token, signer.privateKey);
  return { token: got.json.token, id: start.json.id, opened, poll: start.json.poll, pub: mine.pub, proof: signer.privateKey };
}

test('o celular abre o espaço; outra chave não entra sem recomeçar', async () => {
  const first = await signed(phone, 'POST', '/v1/sync/space', { key_check: keys.check });
  assert.equal(first.status, 200);
  assert.equal(first.json.fresh, true);
  spaceId = first.json.space;
  const again = await signed(phone, 'POST', '/v1/sync/space', { key_check: keys.check });
  assert.equal(again.json.space, spaceId);
  assert.equal(again.json.fresh, false);
  const other = await lock.spaceKeys(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const refused = await signed(phone, 'POST', '/v1/sync/space', { key_check: other.check });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code, 'key_mismatch');
  // Without a phone's signature nothing opens.
  assert.equal((await web()('POST', '/v1/sync/space', { key_check: keys.check })).status, 401);
});

test('registros: o servidor guarda bytes que não lê; versão, conflito e apagado', async () => {
  const k = await lock.recordKey(keys, 'entries', 42);
  assert.match(k, /^[A-Za-z0-9_-]{43}$/);
  const task = { t: 'entries', id: 42, r: { title: 'Ligar pro Pedro', status: 'todo' } };
  const d = await lock.seal(keys, k, task);
  const put = await signed(phone, 'POST', '/v1/sync/push', { items: [{ k, base: 0, d }] });
  assert.equal(put.status, 200);
  const v1 = put.json.results[0].s;
  assert.equal(put.json.results[0].ok, true);
  // Nothing the server keeps says what it is.
  const row = server.app.db.prepare('SELECT data FROM records WHERE key = ?').get(k);
  assert.ok(!Buffer.from(row.data).toString('latin1').includes('Pedro'));
  // Read back and opened.
  const ch = await signed(phone, 'GET', '/v1/sync/changes?since=0');
  const got = ch.json.changes.find((c) => c.k === k);
  assert.deepEqual(await lock.open(keys, k, got.d), task);
  // Opened under another name: refused (the bytes are bound to their name).
  await assert.rejects(lock.open(keys, await lock.recordKey(keys, 'entries', 43), got.d));
  // Someone else wrote after what I saw: not written, what is there comes back to merge.
  const d2 = await lock.seal(keys, k, { ...task, r: { ...task.r, status: 'done' } });
  const ok2 = await signed(phone, 'POST', '/v1/sync/push', { items: [{ k, base: v1, d: d2 }] });
  const v2 = ok2.json.results[0].s;
  const stale = await signed(phone, 'POST', '/v1/sync/push', { items: [{ k, base: v1, d }] });
  assert.equal(stale.json.results[0].ok, false);
  assert.equal(stale.json.results[0].s, v2);
  assert.deepEqual((await lock.open(keys, k, stale.json.results[0].d)).r.status, 'done');
  // Deleted: the name stays with no bytes, so the others know it went.
  const del = await signed(phone, 'POST', '/v1/sync/push', { items: [{ k, base: v2, d: null }] });
  assert.equal(del.json.results[0].ok, true);
  const after = await signed(phone, 'GET', `/v1/sync/changes?since=${v2}`);
  assert.deepEqual(after.json.changes.map((c) => [c.k, c.d]), [[k, null]]);
  // Garbage is refused.
  assert.equal((await signed(phone, 'POST', '/v1/sync/push', { items: [{ k: 'x', base: 0, d }] })).status, 422);
  assert.equal((await signed(phone, 'POST', '/v1/sync/push', { items: [{ k, base: 0, d: 'AAAA' }] })).status, 422);
});

test('o computador lê o código, recebe a chave cifrada pra ele e só uma vez', async () => {
  const c = await linkComputer();
  assert.equal(c.opened.space, spaceId);
  assert.deepEqual([...c.opened.key], [...master]);
  assert.equal(c.opened.owner, 'Pixel da Ana');
  // What the server kept of the answer can't be opened by it: only the computer's key opens it.
  const row = server.app.db.prepare('SELECT * FROM links WHERE id = ?').get(c.id);
  assert.equal(row.wrapped, null);
  assert.notEqual(row.token_hash, c.token);
  // Asked again: it was given once.
  assert.equal((await web()('GET', `/v1/link/${c.id}`, null, { 'X-Novelo-Poll': c.poll })).status, 410);
  // The phone sees it in its list.
  const list = await signed(phone, 'GET', '/v1/links');
  assert.ok(list.json.links.some((l) => l.id === c.id && l.name === 'Chrome no Windows'));
});

test('um código esquecido expira e um código lido por outro não serve', async () => {
  const mine = await lock.linkKeys();
  const start = await web()('POST', '/v1/link', { key: mine.pub, name: 'x', proof: (await lock.proofKeys()).pub });
  // Without the key that will sign its requests, no code.
  assert.equal((await web()('POST', '/v1/link', { key: mine.pub, name: 'x' })).status, 422);
  assert.equal((await web()('GET', `/v1/link/${start.json.id}`, null, { 'X-Novelo-Poll': 'errado' })).status, 404);
  // The secret only counts in its header (never in the address).
  assert.equal((await web()('GET', `/v1/link/${start.json.id}?poll=${start.json.poll}`)).status, 404);
  assert.equal((await web()('GET', `/v1/link/${start.json.id}`, null, { 'X-Novelo-Poll': start.json.poll })).json.status, 'pending');
  server.app.db.prepare('UPDATE links SET created = created - 3600000 WHERE id = ?').run(start.json.id);
  const wrapped = await lock.wrapLink(mine.pub, start.json.id, mine.secret, { space: spaceId, key: master });
  assert.equal((await signed(phone, 'POST', `/v1/link/${start.json.id}/approve`, { wrapped })).status, 410);
  assert.equal((await web()('GET', `/v1/link/${start.json.id}`, null, { 'X-Novelo-Poll': start.json.poll })).status, 410);
  // A bad public key never becomes a code.
  assert.equal((await web()('POST', '/v1/link', { key: 'abc' })).status, 422);
  // Only a phone approves (a token can't).
  const c = await linkComputer('outro');
  const m2 = await lock.linkKeys();
  const s2 = await web()('POST', '/v1/link', { key: m2.pub, proof: (await lock.proofKeys()).pub });
  assert.equal((await web(c.token)('POST', `/v1/link/${s2.json.id}/approve`, { wrapped })).status, 403);
});

test('computador e celular escrevem e leem o mesmo espaço; a espera acorda com novidade', async () => {
  const c = await linkComputer('Firefox no Mac');
  const ckeys = await lock.spaceKeys(c.opened.key);
  assert.equal(ckeys.check, keys.check);
  const as = web(c.token);
  const head = (await as('GET', '/v1/sync/changes?since=0&limit=1')).json.head;
  // The computer waits for news; the phone writes; the wait ends at once with it.
  const t0 = Date.now();
  const waiting = as('GET', `/v1/sync/changes?since=${head}&wait=20`);
  await sleep(100);
  const k = await lock.recordKey(keys, 'entries', 7);
  await signed(phone, 'POST', '/v1/sync/push', { items: [{ k, base: 0, d: await lock.seal(keys, k, { t: 'entries', id: 7, r: { title: 'Comprar pão' } }) }] });
  const got = await waiting;
  assert.ok(Date.now() - t0 < 5000);
  const rec = got.json.changes.find((x) => x.k === k);
  assert.equal((await lock.open(ckeys, k, rec.d)).r.title, 'Comprar pão');
  // The computer writes; the phone reads it.
  const k2 = await lock.recordKey(ckeys, 'entries', 2 ** 46 + 5);
  const put = await as('POST', '/v1/sync/push', { items: [{ k: k2, base: 0, d: await lock.seal(ckeys, k2, { t: 'entries', id: 2 ** 46 + 5, r: { title: 'Escrito no computador' } }) }] });
  assert.equal(put.json.results[0].ok, true);
  const seen = await signed(phone, 'GET', `/v1/sync/changes?since=${got.json.seq}`);
  const mine = seen.json.changes.find((x) => x.k === k2);
  assert.equal((await lock.open(keys, k2, mine.d)).r.title, 'Escrito no computador');
  // Nothing new: the wait ends by itself.
  const quiet = await as('GET', `/v1/sync/changes?since=${seen.json.head}&wait=1`);
  assert.deepEqual(quiet.json.changes, []);
  // The computer can't open or erase the space, nor see the other computers.
  assert.equal((await as('POST', '/v1/sync/space', { key_check: keys.check })).status, 403);
  assert.equal((await as('DELETE', '/v1/sync/space')).status, 403);
  assert.equal((await as('GET', '/v1/links')).status, 403);
});

test('arquivos: sobem cifrados, descem iguais; o celular diz o que fica', async () => {
  const c = await linkComputer('Edge');
  const as = web(c.token);
  const photo = new Uint8Array(crypto.randomBytes(300_000));
  const id = lock.newId();
  const sealed = await lock.sealBlob(keys, id, photo);
  const up = await signed(phone, 'PUT', `/v1/sync/blob/${id}`, Buffer.from(sealed), { 'Content-Type': 'application/octet-stream' });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const down = await as('GET', `/v1/sync/blob/${id}`);
  assert.equal(down.status, 200);
  assert.deepEqual([...(await lock.openBlob(await lock.spaceKeys(c.opened.key), id, down.data))].slice(0, 50), [...photo].slice(0, 50));
  assert.deepEqual((await as('POST', '/v1/sync/blobs/have', { ids: [id, lock.newId()] })).json.have, [id]);
  // The computer sends one too.
  const id2 = lock.newId();
  assert.equal((await as('PUT', `/v1/sync/blob/${id2}`, await lock.sealBlob(keys, id2, new Uint8Array(1000)))).status, 200);
  // The phone keeps only what it uses; a file that just arrived waits a while before going.
  const keep = await signed(phone, 'POST', '/v1/sync/blobs/keep', { ids: [id] });
  assert.equal(keep.json.dropped, 0);
  server.app.db.prepare('UPDATE blobs SET created = 0 WHERE id = ?').run(id2);
  assert.equal((await signed(phone, 'POST', '/v1/sync/blobs/keep', { ids: [id] })).json.dropped, 1);
  assert.equal((await as('GET', `/v1/sync/blob/${id2}`)).status, 404);
  assert.equal((await as('POST', '/v1/sync/blobs/keep', { ids: [] })).status, 403);
  assert.equal((await as('GET', '/v1/sync/blob/../../etc')).status, 404);
});

test('o computador pede a inteligência em nome do celular; desligado, não pede mais nada', async () => {
  const c = await linkComputer('Chrome no Linux');
  const as = web(c.token);
  const me = await as('GET', '/v1/web/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.plan.active, true);
  const ask = await as('POST', '/v1/web/ask/think', { messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'oi' }] }, { 'X-Novelo-Request': crypto.randomUUID() });
  assert.equal(ask.status, 200, ask.data.toString());
  assert.equal(ask.json.choices[0].message.content, '{"reply":"ok"}');
  // Counted on the phone's day.
  const used = server.app.db.prepare("SELECT SUM(requests) n FROM usage_day WHERE job = 'think'").get();
  server.app.flush();
  assert.ok((server.app.db.prepare("SELECT SUM(requests) n FROM usage_day WHERE job = 'think'").get().n ?? 0) >= (used.n ?? 0));
  // Without a request id: refused.
  assert.equal((await as('POST', '/v1/web/ask/think', { messages: [{ role: 'user', content: 'oi' }] })).status, 422);
  // The phone unlinks it: from then on, 401 for everything.
  assert.equal((await signed(phone, 'DELETE', `/v1/links/${c.id}`)).json.ok, true);
  assert.equal((await as('GET', '/v1/sync/changes?since=0')).status, 401);
  assert.equal((await as('GET', '/v1/web/me')).status, 401);
  // A computer can also unlink itself.
  const c2 = await linkComputer('Safari');
  assert.equal((await web(c2.token)('DELETE', '/v1/link')).status, 200);
  assert.equal((await web(c2.token)('GET', '/v1/sync/changes?since=0')).status, 401);
});

test('as páginas: mesma origem, sem script de fora; o Android sabe abrir o código no app', async () => {
  const page = await fetch(`${server.url}/web/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(page.headers.get('content-security-policy'), /require-trusted-types-for 'script'/);
  assert.match(page.headers.get('cache-control'), /no-transform/);
  const etag = page.headers.get('etag');
  assert.equal((await fetch(`${server.url}/web/`, { headers: { 'If-None-Match': etag } })).status, 304);
  // A page of the app (the link from the QR code) is the app itself.
  assert.equal((await fetch(`${server.url}/web/link`)).status, 200);
  assert.equal((await fetch(`${server.url}/web/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${server.url}/web/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${server.url}/web/nada.js`)).status, 404);
  const root = await fetch(`${server.url}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  const al = await (await fetch(`${server.url}/.well-known/assetlinks.json`)).json();
  assert.equal(al[0].target.package_name, 'com.villamediana.novelo');
  assert.match(al[0].target.sha256_cert_fingerprints[0], /^42:8B:EC:FF/);
});

test('o nome que o celular vê não engana; o servidor não guarda o endereço do computador', async () => {
  const mine = await lock.linkKeys();
  const start = await web()('POST', '/v1/link', { key: mine.pub, name: 'Chrome\u202Eswodni\u0007W ', proof: (await lock.proofKeys()).pub });
  const row = server.app.db.prepare('SELECT name, ip FROM links WHERE id = ?').get(start.json.id);
  assert.equal(row.name, 'ChromeswodniW');
  assert.equal(row.ip, '');
});

test('um token que o computador não buscou some; um computador parado há meses é desligado', async () => {
  const sync = server.app.sync;
  // Read by the phone, never fetched: past the code's time, nothing of it stays (its token included).
  const mine = await lock.linkKeys();
  const start = await web()('POST', '/v1/link', { key: mine.pub, name: 'Esquecido', proof: (await lock.proofKeys()).pub });
  const wrapped = await lock.wrapLink(mine.pub, start.json.id, mine.secret, { space: spaceId, key: master });
  assert.equal((await signed(phone, 'POST', `/v1/link/${start.json.id}/approve`, { wrapped })).status, 200);
  server.app.db.prepare('UPDATE links SET created = created - 3600000 WHERE id = ?').run(start.json.id);
  sync.prune();
  assert.equal(server.app.db.prepare('SELECT COUNT(*) n FROM links WHERE id = ?').get(start.json.id).n, 0);
  // Fetched by the computer but never used (its answer lost on the way): gone after the code's time.
  const lost = await linkComputer('Perdido');
  server.app.db.prepare('UPDATE links SET created = created - 3600000, approved = approved - 3600000, last_seen = last_seen - 3600000 WHERE id = ?').run(lost.id);
  sync.prune();
  assert.equal(server.app.db.prepare('SELECT COUNT(*) n FROM links WHERE id = ?').get(lost.id).n, 0);
  // Linked, then not seen for longer than SYNC_IDLE_DAYS: unlinked.
  const c = await linkComputer('Parado');
  assert.equal((await web(c.token)('GET', '/v1/web/me')).status, 200);
  server.app.db.prepare('UPDATE links SET last_seen = last_seen - ? WHERE id = ?').run(91 * 24 * 3600_000, c.id);
  sync.prune();
  assert.equal((await web(c.token)('GET', '/v1/web/me')).status, 401);
});

test('esperas abertas têm limite; o disco nunca enche', async () => {
  const sync = server.app.sync;
  const c = await linkComputer('Muitas abas');
  const head = (await web(c.token)('GET', '/v1/sync/changes?since=0')).json.head;
  const waits = [];
  for (let i = 0; i < sync.maxWaitsPerSpace; i++) waits.push(web(c.token)('GET', `/v1/sync/changes?since=${head}&wait=20`));
  await sleep(150);
  const over = await web(c.token)('GET', `/v1/sync/changes?since=${head}&wait=20`);
  assert.equal(over.status, 429);
  // Something new wakes them all (and frees their places).
  const k = await lock.recordKey(keys, 'entries', 777);
  const item = { k, base: 0, d: await lock.seal(keys, k, { t: 'entries', id: '777', r: { id: 777, title: 'acorda' } }) };
  assert.equal((await web(c.token)('POST', '/v1/sync/push', { items: [item] })).status, 200);
  for (const w of await Promise.all(waits)) assert.equal(w.status, 200);
  assert.equal(sync.waits, 0);
  // Below the free space kept on the disk: nothing more is written.
  const keep = sync.minFree;
  sync.minFree = Number.MAX_SAFE_INTEGER;
  try {
    const k2 = await lock.recordKey(keys, 'entries', 778);
    const full = await web(c.token)('POST', '/v1/sync/push', { items: [{ k: k2, base: 0, d: await lock.seal(keys, k2, { t: 'entries', id: '778', r: { id: 778 } }) }] });
    assert.equal(full.status, 507);
    assert.equal((await web(c.token)('PUT', `/v1/sync/blob/${crypto.randomBytes(18).toString('base64url')}`, crypto.randomBytes(64))).status, 507);
  } finally {
    sync.minFree = keep;
  }
});

test('o token sozinho não serve: cada pedido do computador vai assinado, uma vez só, na hora', async () => {
  const c = await linkComputer('Assinado');
  assert.equal((await web(c.token)('GET', '/v1/web/me')).status, 200);
  const bare = async (path, headers = {}) => fetch(server.url + path, { headers: { Authorization: `Bearer ${c.token}`, ...headers } });
  // Without a signature, with another key's, for another address, or the same one twice: refused —
  // as "bad_proof", which doesn't make the page throw everything away.
  const none = await bare('/v1/web/me');
  assert.equal(none.status, 401);
  assert.equal((await none.json()).error.code, 'bad_proof');
  const other = await lock.proofKeys();
  assert.equal((await bare('/v1/web/me', { 'X-Novelo-Sig': await new Api({ token: c.token, proof: other.privateKey }).sign('GET', '/v1/web/me') })).status, 401);
  const signer = new Api({ token: c.token, proof: c.proof });
  assert.equal((await bare('/v1/web/me', { 'X-Novelo-Sig': await signer.sign('GET', '/v1/sync/changes?since=0') })).status, 401);
  const once = await signer.sign('GET', '/v1/web/me');
  assert.equal((await bare('/v1/web/me', { 'X-Novelo-Sig': once })).status, 200);
  assert.equal((await bare('/v1/web/me', { 'X-Novelo-Sig': once })).status, 401);
  // A body changed on the way doesn't match its signature.
  const items = { items: [] };
  const sig = await signer.sign('POST', '/v1/sync/push', new TextEncoder().encode(JSON.stringify(items)));
  const changed = await fetch(server.url + '/v1/sync/push', { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'X-Novelo-Sig': sig }, body: JSON.stringify({ items: [{}] }) });
  assert.equal(changed.status, 401);
  // A clock far off: the server says its time, the page signs again with it (and gets in).
  const late = new Api({ base: server.url, token: c.token, proof: c.proof });
  late.skew = -10 * 60_000;
  assert.equal((await late.me()).link, c.id);
  assert.ok(Math.abs(late.skew) < 5_000);
  // Only this origin reads what comes from the sync.
  assert.equal(none.headers.get('cross-origin-resource-policy'), 'same-origin');
});

test('computador de outra pessoa: desliga ao fechar a aba, ou sozinho depois de meia hora sem sinal', async () => {
  const sync = server.app.sync;
  const c = await linkComputer('Biblioteca');
  assert.equal((await web(c.token)('POST', '/v1/link/shared')).status, 200);
  assert.equal(server.app.db.prepare('SELECT shared FROM links WHERE id = ?').get(c.id).shared, 1);
  assert.equal((await signed(phone, 'GET', '/v1/links')).json.links.find((l) => l.id === c.id).shared, true);
  server.app.db.prepare('UPDATE links SET last_seen = last_seen - ? WHERE id = ?').run(31 * 60_000, c.id);
  sync.prune();
  assert.equal((await web(c.token)('GET', '/v1/web/me')).status, 401);
  // The tab closing: its farewell, signed ahead of time, goes as a plain DELETE.
  const d = await linkComputer('Lan house');
  const farewell = await new Api({ token: d.token, proof: d.proof }).sign('DELETE', '/v1/link');
  assert.equal((await fetch(server.url + '/v1/link', { method: 'DELETE', headers: { Authorization: `Bearer ${d.token}`, 'X-Novelo-Sig': farewell } })).status, 200);
  assert.equal((await web(d.token)('GET', '/v1/web/me')).status, 401);
  // A computer that is hers isn't touched by it.
  const e = await linkComputer('Meu');
  assert.equal((await web(e.token)('GET', '/v1/web/me')).status, 200);
  server.app.db.prepare('UPDATE links SET last_seen = last_seen - ? WHERE id = ?').run(31 * 60_000, e.id);
  sync.prune();
  assert.equal((await web(e.token)('GET', '/v1/web/me')).status, 200);
});

test('as novidades vêm em páginas de no máximo uns 4 MB', async () => {
  const c = await linkComputer('Páginas');
  const head = (await web(c.token)('GET', '/v1/sync/changes?since=0')).json.head;
  const items = [];
  for (let i = 0; i < 12; i++) {
    const k = await lock.recordKey(keys, 'entries', 5000 + i);
    items.push({ k, base: 0, d: await lock.seal(keys, k, { t: 'entries', id: String(5000 + i), r: { id: 5000 + i, body: 'x'.repeat(380_000) } }) });
  }
  for (let i = 0; i < items.length; i += 4) assert.equal((await web(c.token)('POST', '/v1/sync/push', { items: items.slice(i, i + 4) })).status, 200);
  const page = (await web(c.token)('GET', `/v1/sync/changes?since=${head}&limit=1000`)).json;
  assert.ok(page.more);
  assert.ok(page.changes.length >= 1 && page.changes.length < 12, `${page.changes.length} in one page`);
  const rest = (await web(c.token)('GET', `/v1/sync/changes?since=${page.seq}&limit=1000`)).json;
  assert.ok(rest.changes.length >= 1);
});

test('o celular recomeça com outra chave: tudo do espaço some, computadores inclusive', async () => {
  const c = await linkComputer('Último');
  const other = await lock.spaceKeys(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const fresh = await signed(phone, 'POST', '/v1/sync/space', { key_check: other.check, reset: true });
  assert.equal(fresh.json.fresh, true);
  assert.notEqual(fresh.json.space, spaceId);
  assert.equal((await web(c.token)('GET', '/v1/sync/changes?since=0')).status, 401);
  assert.deepEqual((await signed(phone, 'GET', '/v1/sync/changes?since=0')).json.changes, []);
  assert.equal(server.app.db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0);
});
