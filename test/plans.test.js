import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fakeUpstream, startServer, Phone, panel, signed } from './helpers.js';

async function setup() {
  const upstream = await fakeUpstream(() => ({ text: 'ok' }));
  const server = await startServer({ upstream });
  server.route('think', 'm');
  return { upstream, server, close: async () => { await server.close(); await upstream.close(); } };
}
const DAY = 24 * 3600_000;
const install = () => crypto.randomBytes(16).toString('hex');

test('the plan is the server\'s word: Novelo+ for whoever registers now, a trial when set so', async () => {
  const s = await setup();
  try {
    const a = new Phone(s.server.url);
    const reg = await a.register({ install: install() });
    assert.deepEqual(reg.json.plan, { kind: 'plus', active: true, backup: true });
    assert.deepEqual((await signed(a, 'GET', '/v1/me')).json.plan, { kind: 'plus', active: true, backup: true });
    // Whatever the phone sends about itself changes nothing.
    assert.equal((await a.ask('think', { messages: [{ role: 'user', content: 'oi' }], plan: 'plus' }, { headers: { 'X-Novelo-Plan': 'plus' } })).status, 200);

    s.server.app.settings.set('new_plan', 'trial');
    s.server.app.settings.set('trial_days', 7);
    const b = new Phone(s.server.url);
    const id = install();
    const trial = (await b.register({ install: id })).json.plan;
    assert.equal(trial.kind, 'trial');
    assert.equal(trial.backup, false);
    assert.ok(Math.abs(trial.trial_ends - (Date.now() + 7 * DAY)) < 5000);
    assert.equal((await b.ask('think')).status, 200);

    // Day 8: the Novelo's intelligence is over for it; nothing reaches a model.
    s.server.app.db.prepare('UPDATE installs SET trial_start = ? WHERE id = ?').run(Date.now() - 8 * DAY, `i:${id}`);
    s.server.app.plans.cache.clear();
    const calls = s.upstream.calls.length;
    const over = await b.ask('think', { messages: [{ role: 'user', content: 'oi' }] }, { headers: { 'X-Novelo-Plan': 'plus' } });
    assert.equal(over.status, 402);
    assert.equal(over.json.error.code, 'plan');
    assert.deepEqual(over.json.error.plan, { kind: 'ended', active: false, backup: false });
    assert.equal(s.upstream.calls.length, calls);
    assert.equal((await signed(b, 'GET', '/v1/me')).json.plan.kind, 'ended');

    // Installing the app again (a new key) on the same phone doesn't start the trial over.
    const again = new Phone(s.server.url);
    assert.equal((await again.register({ install: id })).json.plan.kind, 'ended');
    assert.equal((await again.ask('think')).status, 402);
    // The first phone is still Novelo+.
    assert.equal((await a.ask('think')).status, 200);

    // The panel makes it Novelo+ (what a confirmed purchase will do), and takes it back.
    const call = await panel(s.server);
    const listed = (await call('GET', '/api/devices')).json.devices;
    assert.equal(listed.find((d) => d.id === again.id).plan.kind, 'ended');
    assert.equal((await call('PUT', `/api/devices/${again.id}`, { plan: 'plus' })).status, 200);
    assert.equal((await again.ask('think')).status, 200);
    assert.equal((await b.ask('think')).status, 200, 'the same phone, the other key');
    assert.equal((await call('PUT', `/api/devices/${again.id}`, { plan: 'trial' })).status, 200);
    assert.equal((await signed(again, 'GET', '/v1/me')).json.plan.kind, 'trial');
    assert.equal((await call('PUT', `/api/devices/${again.id}`, { plan: 'gratis' })).status, 422);
    const ov = (await call('GET', '/api/overview')).json;
    assert.deepEqual(ov.plans, { plus: 1, trial: 1, ended: 0 });
  } finally {
    await s.close();
  }
});

const vaultOf = () => ({ id: crypto.randomBytes(24).toString('base64url'), key: crypto.randomBytes(32).toString('base64url') });
const blob = (n = 2000) => {
  const data = crypto.randomBytes(n);
  return { id: crypto.createHash('sha256').update(data).digest('base64url'), data };
};

test('the cloud backup: pieces once, versions kept, read back with the key only', async () => {
  const s = await setup();
  try {
    const phone = new Phone(s.server.url);
    await phone.register({ install: install() });
    const v = vaultOf();
    const key = { 'X-Novelo-Vault': v.key };
    const at = (rest = '') => `/v1/backup/${v.id}${rest}`;

    assert.equal((await signed(phone, 'GET', at(), undefined, key)).json.error.code, 'no_backup');
    const [b1, b2, b3] = [blob(), blob(), blob(300_000)];
    assert.deepEqual((await signed(phone, 'POST', at('/have'), { ids: [b1.id, b2.id] }, key)).json.missing, [b1.id, b2.id]);
    assert.equal((await signed(phone, 'PUT', at(`/blobs/${b1.id}`), b1.data, key)).status, 200);
    assert.equal((await signed(phone, 'PUT', at(`/blobs/${b1.id}`), b1.data, key)).json.had, true);
    // An index may only name pieces that are here.
    const early = await signed(phone, 'PUT', at('/manifest'), { data: Buffer.from('indice-1').toString('base64'), refs: [b1.id, b2.id] }, key);
    assert.equal(early.status, 409);
    assert.deepEqual(early.json.error.missing, [b2.id]);
    await signed(phone, 'PUT', at(`/blobs/${b2.id}`), b2.data, key);
    const m1 = await signed(phone, 'PUT', at('/manifest'), { data: Buffer.from('indice-1').toString('base64'), refs: [b1.id, b2.id] }, key);
    assert.equal(m1.status, 200);

    const info = (await signed(phone, 'GET', at(), undefined, key)).json;
    assert.equal(info.manifests.length, 1);
    assert.equal(info.used, 4000 + 8);

    // Another phone (a new one, restoring) with the key reads it all back; without the key, nothing.
    const other = new Phone(s.server.url);
    await other.register({ install: install() });
    const got = await signed(other, 'GET', at('/manifest'), undefined, key);
    assert.equal(got.data.toString(), 'indice-1');
    assert.equal(got.headers.get('x-novelo-manifest'), String(m1.json.id));
    assert.ok((await signed(other, 'GET', at(`/blobs/${b2.id}`), undefined, key)).data.equals(b2.data));
    assert.equal((await signed(other, 'GET', at('/manifest'), undefined, { 'X-Novelo-Vault': vaultOf().key })).json.error.code, 'vault_key');
    assert.equal((await signed(other, 'GET', at('/manifest'))).json.error.code, 'vault_key');
    assert.equal((await fetch(s.server.url + at('/manifest'), { headers: key })).status, 401);

    // What is on the disk is what was sent (already encrypted on the phone), under a private folder.
    const file = path.join(s.server.app.vaults.dir, v.id, 'blobs', b1.id.slice(0, 2), b1.id);
    assert.ok(fs.readFileSync(file).equals(b1.data));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    // Without Novelo+: nothing new goes up, but what is there can still be read and erased.
    s.server.app.plans.set(other.id ? `i:${s.server.app.db.prepare('SELECT install FROM devices WHERE id = ?').get(other.id).install.slice(2)}` : '', 'ended');
    assert.equal((await signed(other, 'PUT', at(`/blobs/${b3.id}`), b3.data, key)).json.error.code, 'plan');
    assert.equal((await signed(other, 'GET', at(`/blobs/${b1.id}`), undefined, key)).status, 200);

    // Versions: the last ones stay; pieces of no version left go (not the ones just sent).
    s.server.app.settings.set('backup_keep', 2);
    await signed(phone, 'PUT', at(`/blobs/${b3.id}`), b3.data, key);
    s.server.app.db.prepare('UPDATE vault_blobs SET at = ? WHERE vault = ?').run(Date.now() - 2 * DAY, v.id);
    await signed(phone, 'PUT', at('/manifest'), { data: Buffer.from('indice-2').toString('base64'), refs: [b2.id, b3.id] }, key);
    await signed(phone, 'PUT', at('/manifest'), { data: Buffer.from('indice-3').toString('base64'), refs: [b3.id] }, key);
    const after = (await signed(phone, 'GET', at(), undefined, key)).json;
    assert.equal(after.manifests.length, 2);
    assert.equal(fs.existsSync(file), false, 'b1 is in no kept version');
    assert.equal((await signed(phone, 'GET', at(`/blobs/${b2.id}`), undefined, key)).status, 200);
    assert.equal((await signed(phone, 'GET', at(`/manifest/${m1.json.id}`), undefined, key)).status, 404);
    assert.equal((await signed(phone, 'GET', at('/manifest'), undefined, key)).data.toString(), 'indice-3');
    assert.equal(after.used, 2000 + 300_000 + 16);

    // The quota of one backup.
    s.server.app.settings.set('backup_quota_mb', 1);
    const big = blob(900_000);
    const full = await signed(phone, 'PUT', at(`/blobs/${big.id}`), big.data, key);
    assert.equal(full.status, 413);
    assert.equal(full.json.error.code, 'backup_full');
    assert.equal((await signed(phone, 'PUT', at('/blobs/curto'), big.data, key)).status, 404);
    assert.equal((await signed(phone, 'PUT', `/v1/backup/../../etc/blobs/${big.id}`, big.data, key)).status, 404);

    // Erasing takes everything.
    assert.equal((await signed(other, 'DELETE', at(), undefined, key)).status, 200);
    assert.equal(fs.existsSync(path.join(s.server.app.vaults.dir, v.id)), false);
    assert.equal((await signed(phone, 'GET', at(), undefined, key)).json.error.code, 'no_backup');
    assert.deepEqual({ ...s.server.app.vaults.totals() }, { vaults: 0, bytes: 0 });
  } finally {
    await s.close();
  }
});
