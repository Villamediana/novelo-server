// The page does what the app does: the app (Novelo, sync/WebParityTest.kt) wrote down its answers on
// fixed cases in test/fixtures/web-parity.json — the dates the model writes, repeats, medicine times,
// the diary, the exact text the model sees, reading its answer, a plan written in, the search and Hoje.
// The page's own code (web/src/core) must give the same, to the character.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Brain from '../web/src/core/brain.js';
import * as R from '../web/src/core/repeat.js';
import * as D from '../web/src/core/doses.js';
import * as Diary from '../web/src/core/diary.js';
import * as T from '../web/src/core/time.js';
import { Recall } from '../web/src/core/recall.js';
import { sectionsFor } from '../web/src/core/sections.js';
import { Data, ridOf } from '../web/src/core/data.js';
import { apply } from '../web/src/core/keeper.js';
import { Categories, isOpenTask, kindOf, statusOf } from '../web/src/core/words.js';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/web-parity.json', import.meta.url), 'utf8'));
const { now, zone: sp } = fx;
const madrid = 'Europe/Madrid';
const day = 86_400_000;
const clock = (s) => { const [h, mi] = s.split(':').map(Number); return { h, mi }; };

test('the prompt is the app\'s, word for word', () => {
  assert.equal(Brain.SYSTEM, fx.system);
});

test('the dates the model writes', () => {
  for (const c of fx.times) {
    assert.deepEqual(Brain.time(c.text, c.zone, now), c.out, `time(${JSON.stringify(c.text)}, ${c.zone})`);
    assert.equal(Brain.remindTime(c.text, c.zone, now), c.remind, `remindTime(${JSON.stringify(c.text)}, ${c.zone})`);
  }
});

test('repeats: written the same, ringing at the same times', () => {
  const at = (y, m, d, h, mi) => T.toMs(y, m, d, h, mi, 0, sp);
  const rules = [
    [R.from('day', [], now, sp, ['10:00', '14h', '20h']), sp],
    [R.from('week', [1, 3, 5], now, sp), sp],
    [R.from('month', [], at(2026, 1, 31, 9, 0), sp), sp],
    [R.from('week', [], now, madrid, ['08:00']), madrid],
  ];
  rules.forEach(([r, z], i) => {
    const c = fx.repeats[i];
    assert.equal(R.write(r), c.json, `rule ${i}`);
    assert.equal(c.zone, z);
    assert.equal(R.next(r, now, z), c.next, `next of rule ${i}`);
    assert.deepEqual(R.between(r, now, now + 40 * day, z).slice(0, 30), c.between, `times of rule ${i}`);
  });
});

test('medicines: the same times, the same amounts', () => {
  for (const c of fx.doses) {
    assert.deepEqual(D.slots(c.med, now - 3 * day, now + 3 * day, sp), c.slots, `slots of ${c.med.id}`);
    assert.deepEqual(D.lastTimes(c.med, 4, now, sp), c.last, `last of ${c.med.id}`);
    assert.equal(D.nearest(c.med, now, sp), c.nearest, `nearest of ${c.med.id}`);
  }
  assert.deepEqual([D.writeTimes(D.every(clock('07:30'), 8)), D.writeTimes(D.every(clock('22:00'), 6))], fx.every);
  for (const c of fx.amounts) assert.equal(D.amount(c.strength, c.dose), c.out, `amount(${c.strength}, ${c.dose})`);
});

test('the diary: joined the same, titled the same', () => {
  for (const c of fx.diary) assert.equal(Diary.merge(c.body, c.more), c.out, `merge(${JSON.stringify(c.body)}, ${JSON.stringify(c.more)})`);
  assert.equal(Diary.title(now, sp, 'pt'), fx.title);
});

const all = fx.context.entries;
const pedro = { id: 1, name: 'Pedro', norm: 'pedro', type: 'person' };

test('the context the model sees, to the character', () => {
  const meds = fx.context.meds;
  const taken = fx.context.taken;
  const open = all.filter(isOpenTask).sort((a, b) => (a.dueAt == null ? 1 : 0) - (b.dueAt == null ? 1 : 0) || (a.dueAt ?? 0) - (b.dueAt ?? 0) || b.createdAt - a.createdAt);
  const live = all.filter((e) => !(kindOf(e) === 'task' && statusOf(e) === 'done')).sort((a, b) => b.createdAt - a.createdAt);
  const hits = new Recall(live, [pedro], [{ entryId: 1, topicId: 1 }], []).search('contrato da torre', 12, now).map((h) => h.entry);
  assert.deepEqual(hits.map((e) => e.id), fx.context.hits, 'what the search found for it');
  const common = { now, zone: sp, openTasks: open, related: hits, focus: null, recent: live.slice(0, 5), typed: true, diary: Brain.todaysDiary(all, now, sp), categories: Categories.inUse(all), meds, taken };
  const text = Brain.context({
    ...common,
    said: 'preciso ligar pro Pedro sobre o contrato da torre',
    photos: [{ id: 40, takenAt: now - day, description: 'recibo do mercado', text: 'Total R$ 32,00' }],
    before: { at: now - 600_000, said: 'lembra de pagar o IPVA', reply: 'Lembrete pra pagar o IPVA às 17h.', items: [[all[1], 'criado']] },
    files: [{ name: 'contrato.pdf', mime: 'application/pdf', size: 230_000, peek: '', about: 'contrato de aluguel' }],
  });
  assert.equal(text, fx.context.text);
  const lookup = Brain.context({ ...common, said: 'o que eu fiz ontem?', looked: 'de 2026-11-10 a 2026-11-10' });
  assert.equal(lookup, fx.context.lookup);
});

test('reading the model\'s answer', () => {
  for (const c of fx.answers) {
    const p = Brain.parse(c.answer);
    if (c.plan === null) {
      assert.equal(p, null, c.answer);
      continue;
    }
    const mine = {
      reply: p.reply,
      create: p.create.map((x) => ({ kind: x.kind, title: x.title, steps: x.steps, related: x.related, photos: x.photos, alarm: x.alarm })),
      update: p.update.map((u) => ({ id: u.id, stepsDone: u.stepsDone, delete: u.delete })),
      search: p.search,
      period: p.period,
      show: p.show,
      showMeds: p.showMeds,
      meds: p.meds.map((m) => ({ id: m.id, taken: m.taken, everyHours: m.everyHours, days: m.days, takenCount: m.takenCount })),
      lookupOnly: Brain.isLookupOnly(p),
    };
    assert.deepEqual(mine, c.plan, c.answer);
  }
});

/** The rows of [data]'s [table] with the computer's new ids as the phone's would be (in the order they were made). */
function phoneIds(data, before) {
  const map = new Map();
  for (const t of ['entries', 'entities', 'meds', 'captures', 'progress']) {
    let next = Math.max(0, ...(before[t] ?? [])) + 1;
    for (const row of data.tables[t].values()) if (!(before[t] ?? []).includes(row.id) && !map.has(row.id)) map.set(row.id, next++);
  }
  return (x) => JSON.parse(JSON.stringify(x), (k, v) => (typeof v === 'number' && map.has(v) ? map.get(v) : v));
}

test('a plan written in: the same rows after, on both', () => {
  for (const c of fx.keeper) {
    const data = new Data(() => now);
    for (const e of all) data.put('entries', ridOf('entries', e), { ...e });
    data.put('meds', '1', { ...fx.doses[0].med });
    for (const t of fx.context.taken) data.put('med_taken', ridOf('med_taken', t), { ...t });
    data.put('entities', '1', { ...pedro });
    data.put('entry_topics', '1:1', { entryId: 1, topicId: 1 });
    const before = { entries: all.map((e) => e.id), meds: [1], entities: [1] };
    const result = apply(data, Brain.parse(c.plan), { captureId: 99, saidAt: now - 5_000, zone: sp, now, alarmByDefault: true });
    const fix = phoneIds(data, before);
    const rows = (t, by) => fix([...data.tables[t].values()]).sort(by);
    const label = c.plan.slice(0, 60);
    assert.deepEqual(rows('entries', (a, b) => a.id - b.id), c.entries, `entries · ${label}`);
    assert.deepEqual(rows('meds', (a, b) => a.id - b.id), c.meds, `meds · ${label}`);
    assert.deepEqual(rows('med_taken', (a, b) => a.medId - b.medId || a.at - b.at), c.taken, `taken · ${label}`);
    assert.deepEqual(rows('entities', (a, b) => a.id - b.id), c.topics, `topics · ${label}`);
    assert.deepEqual(rows('entry_topics', (a, b) => a.entryId - b.entryId || a.topicId - b.topicId), c.ties, `ties · ${label}`);
    assert.deepEqual(rows('links', (a, b) => a.a - b.a || a.b - b.b), c.links, `links · ${label}`);
    assert.deepEqual(rows('progress', (a, b) => a.id - b.id), c.progress, `progress · ${label}`);
    assert.deepEqual(fix([...data.tables.captures.values()].map((x) => x.id)), c.captures, `captures · ${label}`);
    assert.deepEqual(fix(result.outcomes.map((o) => ({ entryId: o.entryId, action: o.action }))), c.outcomes, `outcomes · ${label}`);
    assert.deepEqual(fix(result.touched), c.touched, `touched · ${label}`);
    assert.equal(result.medsChanged, c.medsChanged, `medsChanged · ${label}`);
  }
});

test('the search finds the same, in the same order', () => {
  const r = new Recall(all, [pedro], [{ entryId: 1, topicId: 1 }, { entryId: 2, topicId: 1 }], [{ a: 3, b: 4 }]);
  for (const c of fx.recall) assert.deepEqual(r.search(c.q, 12, now).map((h) => h.entry.id), c.ids, c.q);
});

test('Hoje groups the same', () => {
  const words = { late: 'Atrasadas', for_today: 'Pra hoje', through_day: 'Ao longo do dia', doing: 'Em andamento', done_today: 'Feitas hoje' };
  const mine = sectionsFor('today', all, sp, now).map(([k, items]) => ({ label: words[k], ids: items.map((e) => `${e.id}@${e.remindAt}`) }));
  assert.deepEqual(mine, fx.today.sections);
});

test('a time let go (Pular): the same rows, times and rings', () => {
  const e6 = all.find((e) => e.id === 6);
  const wed14 = now - 1_800_000;
  const tue20 = now - day + 5 * 3_600_000 + 1_800_000;
  const skipped = R.skip(e6, wed14, true, now, sp);
  const back = R.skip(skipped, wed14, false, now, sp);
  const done = R.tick(e6, tue20, true, now, sp);
  [['skip', skipped], ['back', back], ['done', done]].forEach(([name, e], i) => {
    const c = fx.skips[i];
    assert.equal(c.name, name);
    assert.deepEqual(e, c.row, `row · ${name}`);
    assert.deepEqual(R.timesOf(e, now + day, sp), c.times, `times · ${name}`);
    assert.equal(R.current(e, now, sp), c.current, `current · ${name}`);
    assert.equal(R.nextRing(e, now, sp), c.nextRing, `nextRing · ${name}`);
  });
});
