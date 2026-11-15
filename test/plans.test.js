import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
    assert.deepEqual(reg.json.plan, { kind: 'plus', active: true });
    assert.deepEqual((await signed(a, 'GET', '/v1/me')).json.plan, { kind: 'plus', active: true });
    // Whatever the phone sends about itself changes nothing.
    assert.equal((await a.ask('think', { messages: [{ role: 'user', content: 'oi' }], plan: 'plus' }, { headers: { 'X-Novelo-Plan': 'plus' } })).status, 200);

    s.server.app.settings.set('new_plan', 'trial');
    s.server.app.settings.set('trial_days', 7);
    const b = new Phone(s.server.url);
    const id = install();
    const trial = (await b.register({ install: id })).json.plan;
    assert.equal(trial.kind, 'trial');
    assert.ok(Math.abs(trial.trial_ends - (Date.now() + 7 * DAY)) < 5000);
    assert.equal((await b.ask('think')).status, 200);

    // Day 8: the Novelo's intelligence is over for it; nothing reaches a model.
    s.server.app.db.prepare('UPDATE installs SET trial_start = ? WHERE id = ?').run(Date.now() - 8 * DAY, `i:${id}`);
    s.server.app.plans.cache.clear();
    const calls = s.upstream.calls.length;
    const over = await b.ask('think', { messages: [{ role: 'user', content: 'oi' }] }, { headers: { 'X-Novelo-Plan': 'plus' } });
    assert.equal(over.status, 402);
    assert.equal(over.json.error.code, 'plan');
    assert.deepEqual(over.json.error.plan, { kind: 'ended', active: false });
    assert.equal(s.upstream.calls.length, calls);
    assert.equal((await signed(b, 'GET', '/v1/me')).json.plan.kind, 'ended');

    // Installing the app again (a new key) on the same phone doesn't start the trial over.
    const again = new Phone(s.server.url);
    assert.equal((await again.register({ install: id })).json.plan.kind, 'ended');
    assert.equal((await again.ask('think')).status, 402);
    // The first phone is still Novelo+.
    assert.equal((await a.ask('think')).status, 200);
    // One key per phone: the key from before the reinstall is gone (and the day's count goes on, on the phone).
    assert.equal((await b.ask('think')).json.error.code, 'unknown_device');

    // The panel makes it Novelo+ (what a confirmed purchase will do), and takes it back.
    const call = await panel(s.server);
    const listed = (await call('GET', '/api/devices')).json.devices;
    assert.equal(listed.find((d) => d.id === again.id).plan.kind, 'ended');
    assert.equal((await call('PUT', `/api/devices/${again.id}`, { plan: 'plus' })).status, 200);
    assert.equal((await again.ask('think')).status, 200);
    assert.equal((await call('PUT', `/api/devices/${again.id}`, { plan: 'trial' })).status, 200);
    assert.equal((await signed(again, 'GET', '/v1/me')).json.plan.kind, 'trial');
    assert.equal((await call('PUT', `/api/devices/${again.id}`, { plan: 'gratis' })).status, 422);
    // Erased at the person's request: nothing of that phone is left; the app, still installed, comes in again as new.
    s.server.app.flush();
    const phoneOf = s.server.app.db.prepare('SELECT install FROM devices WHERE id = ?').get(again.id).install;
    assert.ok(s.server.app.db.prepare('SELECT COUNT(*) n FROM requests WHERE device = ?').get(again.id).n > 0);
    assert.equal((await call('DELETE', `/api/devices/${again.id}`)).status, 200);
    for (const [table, col, val] of [['devices', 'id', again.id], ['requests', 'device', again.id], ['installs', 'id', phoneOf], ['usage_day', 'device', phoneOf]]) {
      assert.equal(s.server.app.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${col} = ?`).get(val).n, 0, table);
    }
    assert.equal((await again.ask('think')).json.error.code, 'unknown_device');
    assert.equal((await again.register({ install: id })).json.plan.kind, 'trial');
    assert.equal((await call('DELETE', `/api/devices/${'x'.repeat(24)}`)).status, 422);
    const ov = (await call('GET', '/api/overview')).json;
    assert.deepEqual(ov.plans, { plus: 1, trial: 1, ended: 0 });
    assert.equal(ov.devices.total, 2);
  } finally {
    await s.close();
  }
});
