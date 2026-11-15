import test from 'node:test';
import assert from 'node:assert/strict';
import { ceilings } from '../src/budget.js';
import { fakeUpstream, startServer, Phone, panel } from './helpers.js';

const S = { plus_price_brl: 19.9, store_fee_pct: 15, margin_pct: 30, usd_brl: 5.6666, budget_floor_usd: 5 };

test('the ceilings come from what Novelo+ brings in, with the profit kept', () => {
  const none = ceilings(S, 0);
  // R$ 19,90 − 15% da loja = R$ 16,91; − 30% de lucro = R$ 11,84 pra inteligência; ÷ 5,6666 = US$ 2,0895 por aparelho no mês.
  assert.equal(none.net_brl, 16.91);
  assert.equal(none.ai_brl, 11.84);
  assert.equal(none.device_month_usd, 2.0895);
  assert.equal(none.device_day_usd, 0.0696);
  // Nobody subscribed yet: the floor.
  assert.equal(none.budget_month_usd, 5);
  assert.equal(none.budget_day_usd, 0.16);
  const many = ceilings(S, 100);
  assert.equal(many.budget_month_usd, 208.95);
  assert.equal(many.budget_day_usd, 6.96);
  // Whatever the numbers, a phone's month never costs more than it brings in minus the profit.
  assert.ok(many.device_day_usd * 30 * S.usd_brl <= 19.9 * 0.85 * 0.7);
});

test('on "automático" the server writes the three ceilings, follows the subscribers, and ignores hand-set ones', async () => {
  const upstream = await fakeUpstream(() => ({ text: 'ok' }));
  const server = await startServer({ upstream });
  try {
    const call = await panel(server);
    // usd_auto off: no dollar fetched from outside in a test.
    let cfg = (await call('PUT', '/api/settings', { usd_auto: 0, usd_brl: 5.6666, budget_auto: 1 })).json;
    assert.equal(cfg.settings.device_day_usd, 0.0696);
    assert.equal(cfg.settings.budget_month_usd, 5);
    assert.equal(cfg.settings.budget_day_usd, 0.16);
    assert.equal(cfg.budget.plus, 0);
    // A phone comes in as Novelo+: one subscriber.
    await new Phone(server.url).register();
    cfg = (await call('PUT', '/api/settings', { margin_pct: 50 })).json;
    assert.equal(cfg.budget.plus, 1);
    assert.equal(cfg.settings.device_day_usd, 0.0497);
    cfg = (await call('PUT', '/api/settings', { budget_day_usd: 99 })).json;
    assert.equal(cfg.settings.budget_day_usd, 0.16);
    assert.equal((await call('PUT', '/api/settings', { margin_pct: 100 })).status, 422);
    // By hand again: what is typed stays.
    cfg = (await call('PUT', '/api/settings', { budget_auto: 0, budget_day_usd: 3 })).json;
    assert.equal(cfg.settings.budget_day_usd, 3);
  } finally {
    await server.close();
    await upstream.close();
  }
});
