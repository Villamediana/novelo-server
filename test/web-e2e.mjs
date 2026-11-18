// The Novelo on the computer, end to end, in a real browser (Chromium, by playwright-core): the real
// server, a phone (its key, its signature, the same locks as the app) and the page. The computer
// shows its code, the phone links it, what the phone has shows on the page, what is written on the
// page is organized there (a made-up model) and reaches the phone, what the phone changes reaches the
// page. Pictures of each screen in [out]. Not part of npm test (it needs a browser):
//   CHROME=/path/to/chrome node test/web-e2e.mjs /tmp/shots
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, fakeUpstream, Phone, signed, sleep } from './helpers.js';
import * as lock from '../web/src/core/crypto.js';
import { SCHEMA } from '../web/src/core/data.js';

const out = path.resolve(process.argv[2] ?? 'web-shots');
fs.mkdirSync(out, { recursive: true });
const chrome = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`;

const day = 86_400_000;
const now = Date.now();
const zone = 'America/Sao_Paulo';
const tomorrow = new Date(now + day).toLocaleDateString('sv-SE', { timeZone: zone });

let asked = [];
const upstream = await fakeUpstream((json) => {
  const user = JSON.stringify(json.messages.at(-1).content);
  asked.push(user);
  return { text: JSON.stringify({ reply: 'Anotei: ligar pro Pedro amanhã às 9.', create: [{ kind: 'task', title: 'Ligar pro Pedro sobre o contrato', due: `${tomorrow}T09:00`, remind_at: `${tomorrow}T09:00`, steps: ['achar o número dele'], category: 'Trabalho', entities: [{ name: 'Pedro', type: 'person' }] }] }) };
});
const server = await startServer({ upstream });
server.route('think', 'modelo-de-teste');
const phone = new Phone(server.url);
assert.equal((await phone.register()).status, 200);
const master = globalThis.crypto.getRandomValues(new Uint8Array(32));
const keys = await lock.spaceKeys(master);
const space = (await signed(phone, 'POST', '/v1/sync/space', { key_check: keys.check })).json.space;

/** The phone writes rows (as the app reads them: every column). */
async function phonePut(table, rows) {
  const items = [];
  for (const r of rows) {
    const row = { ...SCHEMA[table].defaults, ...r };
    const rid = SCHEMA[table].pk.map((c) => row[c]).join(':');
    const k = await lock.recordKey(keys, table, rid);
    const have = await phoneAll();
    items.push({ k, base: have.get(k)?.s ?? 0, d: await lock.seal(keys, k, { t: table, id: rid, r: row }) });
  }
  const res = await signed(phone, 'POST', '/v1/sync/push', { items });
  assert.ok(res.json.results.every((r) => r.ok), JSON.stringify(res.json));
}

async function phoneAll() {
  const m = new Map();
  let since = 0;
  for (;;) {
    const r = await signed(phone, 'GET', `/v1/sync/changes?since=${since}`);
    for (const c of r.json.changes) m.set(c.k, { s: c.s, rec: c.d ? await lock.open(keys, c.k, c.d) : null });
    since = r.json.seq;
    if (!r.json.more) return m;
  }
}

const at = (h, mi = 0) => {
  const d = new Date(now).toLocaleDateString('sv-SE', { timeZone: zone });
  return new Date(`${d}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00-03:00`).getTime();
};
await phonePut('entries', [
  { id: 1, kind: 'task', title: 'Fechar contrato da torre de Campinas', body: 'Falta a assinatura do proprietário.', status: 'doing', steps: '[{"text":"pedir planta","done":true},{"text":"revisar cláusulas","done":true},{"text":"assinatura"}]', dueAt: now + 2 * day, createdAt: now - 3 * day, updatedAt: now - day, category: 'Trabalho' },
  { id: 2, kind: 'task', title: 'Pagar o IPVA', status: 'todo', remindAt: at(23, 30), createdAt: now - day, updatedAt: now - day, category: 'Casa' },
  { id: 3, kind: 'note', title: 'Senha do wifi de casa', body: 'girassol-2026', sensitive: 1, createdAt: now - 5 * day, updatedAt: now - 5 * day },
  { id: 4, kind: 'note', title: 'Ideias pro aniversário da Ana', body: 'Um piquenique no parque, bolo de cenoura, chamar os primos.', createdAt: now - 2 * day, updatedAt: now - 2 * day },
  { id: 5, kind: 'diary', title: 'Um dia bom', body: 'Fui correr cedo no parque e depois trabalhei de casa.\n\nÀ noite vi um filme com a Ana.', createdAt: now - day, updatedAt: now - day },
]);
await phonePut('meds', [{ id: 1, name: 'Amoxicilina', dose: '1 comprimido', strength: '500 mg', times: '["08:00","16:00","23:59"]', startsAt: now - 2 * day, endsAt: now + 5 * day, createdAt: now - 2 * day, updatedAt: now - 2 * day, person: 'Cooper' }]);

const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
const shot = async (page, name) => {
  await sleep(450); // the screen's own movement settles first
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};
try {
  // ---- the computer shows its code; the phone reads it
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, timezoneId: zone, locale: 'pt-BR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  let pub = null;
  page.on('request', (r) => { if (r.url().endsWith('/v1/link') && r.method() === 'POST') pub = JSON.parse(r.postData()).key; });
  const linkRes = page.waitForResponse((r) => r.url().endsWith('/v1/link') && r.request().method() === 'POST');
  await page.goto(`${server.url}/web/`);
  const link = await (await linkRes).json();
  await page.waitForSelector('.qr svg');
  await shot(page, '01-link');
  const wrapped = await lock.wrapLink(pub, link.id, { space, key: master, owner: 'Pixel da Ana' });
  assert.equal((await signed(phone, 'POST', `/v1/link/${link.id}/approve`, { wrapped, owner: 'Pixel da Ana' })).status, 200);

  // ---- linked: what the phone has is on the page
  await page.waitForSelector('.rail', { timeout: 20_000 });
  await page.waitForSelector('textarea');
  await shot(page, '02-write');
  await page.click('button.nav:has-text("Hoje")');
  await page.waitForSelector('text=Pagar o IPVA');
  await shot(page, '03-today');
  await page.click('button.nav:has-text("Tarefas")');
  await page.waitForSelector('text=Fechar contrato da torre de Campinas');
  await shot(page, '04-tasks');
  await page.click('text=Fechar contrato da torre de Campinas');
  await page.waitForSelector('.panel .title-edit');
  await shot(page, '05-entry');
  await page.keyboard.press('Escape');
  await page.click('button.nav:has-text("Notas")');
  await page.waitForSelector('text=Ideias pro aniversário da Ana');
  assert.equal(await page.locator('text=girassol-2026').count(), 0, 'a sensitive note is hidden');
  await shot(page, '06-notes');
  await page.click('button.nav:has-text("Diário")');
  await page.waitForSelector('text=Um dia bom');
  await shot(page, '07-diary');
  await page.click('button.nav:has-text("Remédios")');
  await page.waitForSelector('text=Amoxicilina');
  await shot(page, '08-meds');

  // ---- written on the computer: organized there, reaches the phone
  await page.click('button.nav:has-text("Escrever")');
  await page.fill('textarea', 'amanhã às 9 preciso ligar pro Pedro sobre o contrato');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.answer .reply', { timeout: 20_000 });
  await page.waitForSelector('.answer >> text=Ligar pro Pedro sobre o contrato');
  await shot(page, '09-answer');
  assert.ok(asked.some((u) => u.includes('O QUE ELA ESCREVEU') && u.includes('ligar pro Pedro')), 'the context the page built');
  assert.ok(asked.some((u) => u.includes('TAREFAS ABERTAS') && u.includes('Fechar contrato da torre de Campinas')), 'the open tasks went with it');
  let mine = null;
  for (let i = 0; i < 40 && !mine; i++) {
    await sleep(250);
    mine = [...(await phoneAll()).values()].map((x) => x.rec).find((r) => r?.t === 'entries' && r.r.title === 'Ligar pro Pedro sobre o contrato');
  }
  assert.ok(mine, 'the phone has the task written on the computer');
  assert.ok(Number(mine.id) >= 2 ** 45, 'with an id of the computer');
  assert.equal(mine.r.category, 'Trabalho');
  const recs = [...(await phoneAll()).values()].map((x) => x.rec).filter(Boolean);
  const cap = recs.find((r) => r.t === 'captures' && r.r.transcript?.includes('ligar pro Pedro'));
  assert.equal(cap?.r.state, 'done', 'what was written went up done (the phone will not organize it again)');
  assert.ok(recs.some((r) => r.t === 'entry_topics' && r.r.entryId === Number(mine.id)), 'its topic too');

  // ---- changed on the phone: the page sees it (no reload)
  await page.click('button.nav:has-text("Notas")');
  await phonePut('entries', [{ id: 4, kind: 'note', title: 'Aniversário da Ana: piquenique', body: 'Um piquenique no parque.', createdAt: now - 2 * day, updatedAt: now }]);
  await page.waitForSelector('text=Aniversário da Ana: piquenique', { timeout: 30_000 });

  // ---- ticked on the page: done on the phone
  await page.click('button.nav:has-text("Tarefas")');
  await page.locator('.card:has-text("Pagar o IPVA") .check').click();
  let done = null;
  for (let i = 0; i < 40 && !done; i++) {
    await sleep(250);
    done = [...(await phoneAll()).values()].map((x) => x.rec).find((r) => r?.t === 'entries' && r.id === '2' && r.r.status === 'done');
  }
  assert.ok(done, 'the phone sees it done');
  await shot(page, '10-tasks-after');

  // ---- dark
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await page.waitForSelector('.rail');
  await page.click('button.nav:has-text("Hoje")');
  await sleep(300);
  await shot(page, '11-today-dark');
  assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], 'no errors on the page');

  // ---- a phone opening the page: get the app
  const phonePage = await (await browser.newContext({ viewport: { width: 400, height: 860 }, locale: 'pt-BR', userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36' })).newPage();
  await phonePage.goto(`${server.url}/web/link`);
  await phonePage.waitForSelector('text=Baixar o Novelo');
  await shot(phonePage, '12-phone');
  console.log(`ok: ${fs.readdirSync(out).length} telas em ${out}`);
} finally {
  await browser.close();
  await server.close();
  await upstream.close();
}
