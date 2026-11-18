// The page's sync engine (web/src/core/sync.js) on a real server, against a phone: what was deleted and
// made again stays, a page reopened keeps what it had to send, records that aren't the row they name are
// left out. Deterministic (no browser): the store is in memory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, fakeUpstream, Phone, signed } from './helpers.js';
import * as lock from '../web/src/core/crypto.js';
import { Api } from '../web/src/core/api.js';
import { Data } from '../web/src/core/data.js';
import { WebSync, clean } from '../web/src/core/sync.js';

/** The browser's store, in memory (the same calls as web/src/core/store.js). */
class MemoryStore {
  constructor() {
    this.meta = new Map();
    this.recs = new Map();
    this.files = new Map();
  }
  async get(k) { return this.meta.get(k); }
  async set(k, v) { this.meta.set(k, v); }
  async records() { return [...this.recs.values()]; }
  async putRecords(list) { for (const r of list) (r.remove ? this.recs.delete(r.k) : this.recs.set(r.k, r)); }
  async pendingFiles() { return [...this.files.values()]; }
  async putFile(f) { this.files.set(f.id, f); }
  async dropFile(id) { this.files.delete(id); }
}

let upstream, server, phone, keys, master;

before(async () => {
  upstream = await fakeUpstream(() => ({ text: '{}' }));
  server = await startServer({ upstream });
  phone = new Phone(server.url);
  assert.equal((await phone.register()).status, 200);
  master = globalThis.crypto.getRandomValues(new Uint8Array(32));
  keys = await lock.spaceKeys(master);
  const space = (await signed(phone, 'POST', '/v1/sync/space', { key_check: keys.check })).json.space;
  const mine = await lock.linkKeys();
  const signer = await lock.proofKeys();
  globalThis.proof = signer.privateKey;
  const start = await (await fetch(`${server.url}/v1/link`, { method: 'POST', body: JSON.stringify({ key: mine.pub, name: 'teste', proof: signer.pub }) })).json();
  const wrapped = await lock.wrapLink(mine.pub, start.id, mine.secret, { space, key: master });
  assert.equal((await signed(phone, 'POST', `/v1/link/${start.id}/approve`, { wrapped })).status, 200);
  const got = await (await fetch(`${server.url}/v1/link/${start.id}`, { headers: { 'X-Novelo-Poll': start.poll } })).json();
  globalThis.token = got.token;
});

after(async () => {
  await server?.close();
  await upstream?.close();
});

const page = (store = new MemoryStore()) => {
  const data = new Data();
  return { data, store, sync: new WebSync({ api: new Api({ base: server.url, token: globalThis.token, proof: globalThis.proof }), keys, data, store }) };
};

async function phoneRecord(table, rid) {
  const k = await lock.recordKey(keys, table, rid);
  let since = 0;
  let found;
  for (;;) {
    const r = await signed(phone, 'GET', `/v1/sync/changes?since=${since}`);
    for (const c of r.json.changes) if (c.k === k) found = c.d ? (await lock.open(keys, k, c.d)).r : null;
    since = r.json.seq;
    if (!r.json.more) return found;
  }
}

test('desmarcar e marcar de novo a mesma dose (a mesma linha, feita de novo depois de apagada): fica', async () => {
  const { data, sync } = page();
  data.write('med_taken', { medId: 1, at: 1000, takenAt: 1001 });
  await sync.saveLocal();
  assert.equal((await phoneRecord('med_taken', '1:1000')).takenAt, 1001);
  data.remove('med_taken', '1:1000');
  await sync.saveLocal();
  assert.equal(await phoneRecord('med_taken', '1:1000'), null);
  // Its own deletion comes back with the news: it doesn't take away the dose ticked again.
  data.write('med_taken', { medId: 1, at: 1000, takenAt: 1002 });
  await sync.pull();
  assert.ok(data.tables.med_taken.has('1:1000'));
  await sync.saveLocal();
  await sync.pull();
  assert.equal((await phoneRecord('med_taken', '1:1000')).takenAt, 1002);
  assert.equal(data.tables.med_taken.get('1:1000').takenAt, 1002);
  assert.equal(data.dirty.size, 0);
});

test('a página reaberta: uma exclusão que não subiu ainda sobe; uma já feita não volta', async () => {
  const store = new MemoryStore();
  const first = page(store);
  first.data.write('entries', { id: 2 ** 46 + 1, kind: 'note', title: 'Vai sumir', createdAt: 1, updatedAt: 1 });
  first.data.write('entries', { id: 2 ** 46 + 2, kind: 'note', title: 'Fica', createdAt: 1, updatedAt: 1 });
  await first.sync.saveLocal();
  // Deleted, kept in the browser, and the tab closed before it went up.
  first.data.remove('entries', String(2 ** 46 + 1));
  const rows = [...first.data.changed].map((k) => k.split('|'));
  first.data.changed.clear();
  await first.sync.keep(rows);
  assert.equal((await phoneRecord('entries', String(2 ** 46 + 1))).title, 'Vai sumir');
  const again = page(store);
  await again.sync.load();
  await again.sync.push();
  assert.equal(await phoneRecord('entries', String(2 ** 46 + 1)), null);
  assert.equal((await phoneRecord('entries', String(2 ** 46 + 2))).title, 'Fica');
  // Reopened once more: the deletion is known, nothing goes again, and making it again works.
  const third = page(store);
  await third.sync.load();
  assert.equal(third.data.dirty.size, 0);
  third.data.write('entries', { id: 2 ** 46 + 1, kind: 'note', title: 'Voltou', createdAt: 1, updatedAt: 2 });
  await third.sync.saveLocal();
  assert.equal((await phoneRecord('entries', String(2 ** 46 + 1))).title, 'Voltou');
});

test('um registro que não é a linha que diz ser fica de fora; colunas e arquivos estranhos também', async () => {
  // Named entries:900, with the row of entries:901 inside (only someone with the key could write it).
  const k = await lock.recordKey(keys, 'entries', '900');
  const d = await lock.seal(keys, k, { t: 'entries', id: '900', r: { id: 901, title: 'Trocado' } });
  const proto = await lock.recordKey(keys, 'constructor', '1');
  const d2 = await lock.seal(keys, proto, { t: 'constructor', id: '1', r: { id: 1 } });
  const pushed = await signed(phone, 'POST', '/v1/sync/push', { items: [{ k, base: 0, d }, { k: proto, base: 0, d: d2 }] });
  assert.ok(pushed.json.results.every((r) => r.ok));
  const { data, sync } = page();
  await sync.pull();
  assert.ok(!data.entry(900));
  assert.ok(!data.entry(901));
  // Only the table's own columns, of the kinds a row has; a capture's files only when they are files.
  const row = clean('captures', { id: 5, transcript: { x: 1 }, __proto__: { polluted: 1 }, constructor: 'x', toString: 1, media: { image: { id: '../../v1/link', size: 1 }, file: { id: 'a'.repeat(24), size: 3, mime: 'text/html' }, odd: { id: 'b'.repeat(24) } } });
  assert.equal(row.transcript, null);
  assert.equal(Object.hasOwn(row, 'constructor'), false);
  assert.equal(Object.hasOwn(row, 'toString'), false);
  assert.equal(row.polluted, undefined);
  assert.deepEqual(row.media, { file: { id: 'a'.repeat(24), size: 3, mime: 'text/html' } });
});
