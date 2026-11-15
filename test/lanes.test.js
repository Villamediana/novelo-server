import test from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher, Lane } from '../src/lanes.js';

const far = () => Date.now() + 60_000;

test('a lane takes so many at once and the rest wait in order', async () => {
  const d = new Dispatcher();
  d.setRoutes({ think: [{ id: 1, max_concurrency: 2, rpm: 0 }] });
  const a = await d.acquire('think', { deadline: far() });
  const b = await d.acquire('think', { deadline: far() });
  const order = [];
  const c = d.acquire('think', { deadline: far() }).then((l) => { order.push('c'); return l; });
  const e = d.acquire('think', { deadline: far() }).then((l) => { order.push('e'); return l; });
  assert.equal(d.waiting('think'), 2);
  a.release();
  (await c).release();
  b.release();
  (await e).release();
  assert.deepEqual(order, ['c', 'e']);
  assert.equal(d.lanes.get(1).inFlight, 0);
});

test('a full lane overflows to the next one of the job', async () => {
  const d = new Dispatcher();
  d.setRoutes({ think: [{ id: 1, max_concurrency: 1, rpm: 0 }, { id: 2, max_concurrency: 1, rpm: 0 }] });
  const a = await d.acquire('think', { deadline: far() });
  const b = await d.acquire('think', { deadline: far() });
  assert.deepEqual([a.lane.id, b.lane.id], [1, 2]);
});

test('429: the lane steps aside, takes fewer, and comes back', async () => {
  let t = 1000;
  const d = new Dispatcher({ now: () => t });
  d.setRoutes({ think: [{ id: 1, max_concurrency: 10, rpm: 0 }] });
  const lane = d.lanes.get(1);
  lane.tooMany(t, 2000);
  assert.equal(lane.ready(t), false);
  assert.equal(Math.floor(lane.limit), 7);
  const out = await d.acquire('think', { deadline: t + 60_000 });
  assert.equal(out.none, true);
  assert.ok(out.wakeAt >= 3000 && out.wakeAt < 3300);
  t = 3300;
  const again = await d.acquire('think', { deadline: t + 60_000 });
  assert.equal(again.lane.id, 1);
  for (let i = 0; i < 40; i++) lane.success();
  assert.equal(Math.floor(lane.limit), 10);
});

test('requests per minute are respected', () => {
  const lane = new Lane(1, { maxConcurrency: 100, rpm: 2 });
  lane.take(0); lane.release();
  lane.take(10); lane.release();
  assert.equal(lane.ready(20), false);
  assert.equal(lane.wakeAt(20), 60_000);
  assert.equal(lane.ready(60_001), true);
});

test('the deadline ends the wait; excluded and not allowed lanes are not used', async () => {
  const d = new Dispatcher();
  d.setRoutes({ think: [{ id: 1, max_concurrency: 1, rpm: 0 }, { id: 2, max_concurrency: 1, rpm: 0 }] });
  const a = await d.acquire('think', { deadline: far(), exclude: new Set([1]) });
  assert.equal(a.lane.id, 2);
  const none = await d.acquire('think', { deadline: far(), allowed: () => false });
  assert.equal(none.none, true);
  // (The line's own timer doesn't hold the process; in the server the listeners do.)
  const keep = setTimeout(() => {}, 5000);
  const late = await d.acquire('think', { deadline: Date.now() + 40, exclude: new Set([1]) });
  clearTimeout(keep);
  assert.equal(late.timeout, true);
  const ticket = {};
  const left = d.acquire('think', { deadline: far(), exclude: new Set([1]), ticket });
  ticket.cancel();
  assert.equal((await left).left, true);
  assert.equal(d.waiting(), 0);
  d.stop();
});
