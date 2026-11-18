// The Novelo on the computer, end to end, in a real browser (Chromium, by playwright-core): the real
// server, a phone (its key, its signature, the same locks as the app) and the page. The computer
// shows its code, the phone links it, what the phone has shows on the page, what is written on the
// page is organized there (a made-up model) and reaches the phone, what the phone changes reaches the
// page. Pictures of each screen in [out]. Not part of npm test (it needs a browser):
//   CHROME=/path/to/chrome node test/web-e2e.mjs /tmp/shots
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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

/** A small PNG (a colored square), to drop on the page as a photo. */
function png(w = 64, h = 48) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) row.set([200, 90 + y, 60 + x], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

let asked = [];
const heardWith = []; // what the transcription was asked with (the system message)
const upstream = await fakeUpstream((json) => {
  const user = JSON.stringify(json.messages.at(-1).content);
  asked.push(user);
  if (user.includes('image_url')) return { text: 'Um recibo de mercado; total R$ 32,00.' };
  if (user.includes('input_audio')) {
    heardWith.push(json.messages[0].content);
    return { text: 'comprar leite e ovos' };
  }
  // What she wrote (the end of the context), not what else the context has.
  const content = json.messages.at(-1).content;
  const text = typeof content === 'string' ? content : content.map((p) => p.text ?? '').join('');
  const said = /O QUE ELA ESCREVEU:\n"([^"]*)"/.exec(text)?.[1] ?? '';
  if (said.includes('recibo do mercado')) return { text: JSON.stringify({ reply: 'Guardei o recibo.', create: [{ kind: 'note', title: 'Recibo do mercado', body: 'Total R$ 32,00', photos: true }] }) };
  if (said.includes('comprar pão')) return { text: JSON.stringify({ reply: 'Anotei o pão.', create: [{ kind: 'task', title: 'Comprar pão', due: tomorrow }] }) };
  return { text: JSON.stringify({ reply: 'Anotei: ligar pro Pedro amanhã às 9.', create: [{ kind: 'task', title: 'Ligar pro Pedro sobre o contrato', due: `${tomorrow}T09:00`, remind_at: `${tomorrow}T09:00`, steps: ['achar o número dele'], category: 'Trabalho', entities: [{ name: 'Pedro', type: 'person' }] }] }) };
});
const server = await startServer({ upstream });
server.route('think', 'modelo-de-teste');
server.route('see', 'modelo-de-teste');
server.route('hear', 'modelo-de-teste');
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

// A microphone of its own (a tone), and no asking for it.
const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const shot = async (page, name) => {
  await sleep(450); // the screen's own movement settles first
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};
try {
  // ---- the computer shows its code; the phone reads it
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, timezoneId: zone, locale: 'pt-BR', permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const linkRes = page.waitForResponse((r) => r.url().endsWith('/v1/link') && r.request().method() === 'POST');
  await page.goto(`${server.url}/web/`);
  const link = await (await linkRes).json();
  await page.waitForSelector('.qr svg');
  await shot(page, '01-link');
  // What the phone's camera reads: the address in the QR code (the secret is only there).
  const code = await page.locator('.qr').getAttribute('data-code');
  const [, id, pub, secret] = /#([^.]+)\.([^.]+)\.([^.]+)$/.exec(code);
  assert.equal(id, link.id);
  const wrapped = await lock.wrapLink(pub, link.id, secret, { space, key: master, owner: 'Pixel da Ana' });
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

  const latest = async () => [...(await phoneAll()).values()].map((x) => x.rec).filter(Boolean);
  const until = async (what, find) => {
    for (let i = 0; i < 80; i++) {
      const got = find(await latest());
      if (got) return got;
      await sleep(250);
    }
    assert.fail(`o celular não recebeu: ${what}`);
  };

  // ---- a dose ticked on the page: taken on the phone
  await page.click('button.nav:has-text("Remédios")');
  await page.locator('.card:has-text("Amoxicilina") [aria-label="08:00"]').first().click();
  await until('a dose das 8', (rs) => rs.find((r) => r.t === 'med_taken' && r.r.medId === 1 && r.r.at === at(8)));

  // ---- a photo with words: up encrypted, described, kept with the note
  await page.click('button.nav:has-text("Escrever")');
  await page.setInputFiles('input[type=file][accept="image/*"]', { name: 'recibo.png', mimeType: 'image/png', buffer: png() });
  await page.fill('textarea', 'recibo do mercado de hoje');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.answer >> text=Guardei o recibo.', { timeout: 20_000 });
  await shot(page, '10b-photo');
  const note = await until('a nota do recibo', (rs) => rs.find((r) => r.t === 'entries' && r.r.title === 'Recibo do mercado'));
  const photo = await until('a foto', (rs) => rs.find((r) => r.t === 'captures' && r.r.source === 'photo' && r.r.media?.image && r.r.state === 'done'));
  assert.ok(photo.r.description?.includes('recibo'), 'described');
  const sealed = (await signed(phone, 'GET', `/v1/sync/blob/${photo.r.media.image.id}`)).data;
  const bytes = await lock.openBlob(keys, photo.r.media.image.id, sealed);
  assert.ok(bytes.length > 100, 'the photo opens with the key');
  assert.ok((await latest()).some((r) => r.t === 'captures' && r.r.transcript?.includes('recibo do mercado') && JSON.parse(r.r.outcomes).some((o) => o.entryId === Number(note.id))));

  // ---- speaking: the microphone, then the words in the box (she reads them, then sends)
  await page.fill('textarea', '');
  await page.click('button.mic');
  await page.waitForSelector('.rec .rec-dot');
  await sleep(1600);
  await shot(page, '10g-speaking');
  await page.click('button.mic');
  await page.waitForFunction(() => document.querySelector('.write textarea')?.value === 'comprar leite e ovos', null, { timeout: 20_000 });
  assert.ok(asked.some((u) => u.includes('input_audio') && u.includes('"format":"wav"')), 'a WAV went to the server');
  assert.ok(heardWith.some((sys) => String(sys).startsWith('Transcribe exactly what is said')), 'asked as the phone asks');
  // The box takes the height there is.
  const box = await page.locator('.write').boundingBox();
  assert.ok(box.height > 400, `the box is ${box.height}px tall`);
  await page.fill('textarea', '');

  // ---- no internet: it waits in the line, and goes by itself when it's back
  await ctx.setOffline(true);
  await page.fill('textarea', 'comprar pão amanhã');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('text=Sem internet · vai sozinho quando voltar', { timeout: 20_000 });
  await shot(page, '10c-offline');
  await ctx.setOffline(false);
  try {
    await page.waitForSelector('.answer >> text=Anotei o pão.', { timeout: 40_000 });
  } catch (e) {
    await page.screenshot({ path: path.join(out, '99-debug.png') });
    console.log('DEBUG line:', await page.locator('.line').allInnerTexts(), 'answer:', await page.locator('.answer').allInnerTexts(), 'errors:', errors, 'online:', await page.evaluate(() => navigator.onLine));
    console.log('asked:', JSON.stringify(asked.map((a) => a.slice(-120))));
    console.log('phone:', JSON.stringify((await latest()).filter((r) => r.t === 'captures' || /pão/.test(r.r.title ?? '')).map((r) => [r.t, r.id, r.r.state, r.r.transcript ?? r.r.title, r.r.reply])));
    throw e;
  }
  await until('o pão', (rs) => rs.find((r) => r.t === 'entries' && r.r.title === 'Comprar pão'));
  assert.equal(await page.locator('text=Sem internet · vai sozinho quando voltar').count(), 0);

  // ---- deleted, then "Desfazer": it stays (here and on the phone)
  await page.click('button.nav:has-text("Notas")');
  await page.click('text=Aniversário da Ana: piquenique');
  await page.waitForSelector('.panel .title-edit');
  await page.click('.panel button[aria-label="Apagar"]');
  await page.click('.toast button:has-text("Desfazer")');
  await page.waitForSelector('.panel .title-edit');
  await page.keyboard.press('Escape');
  await until('a nota de volta', (rs) => rs.find((r) => r.t === 'entries' && r.r.title === 'Aniversário da Ana: piquenique'));

  // ---- a dose unticked and ticked again (the same row, made again after it went): taken on the phone
  await page.click('button.nav:has-text("Remédios")');
  const dose8 = page.locator('.card:has-text("Amoxicilina") [aria-label="08:00"]').first();
  await dose8.click();
  await until('a dose desmarcada', (rs) => !rs.some((r) => r.t === 'med_taken' && r.r.at === at(8)));
  await dose8.click();
  await until('a dose marcada de novo', (rs) => rs.find((r) => r.t === 'med_taken' && r.r.at === at(8)));
  await sleep(1500);
  assert.ok((await latest()).some((r) => r.t === 'med_taken' && r.r.at === at(8)), 'it stays taken');
  assert.equal(await dose8.getAttribute('aria-pressed'), 'true');
  // ...and what the phone wrote meanwhile is still there: nothing written on the page was lost.
  assert.ok((await latest()).some((r) => r.t === 'entries' && r.id === '2' && r.r.status === 'done'));

  // ---- the search finds what was written (and the photo's note)
  await page.click('button.nav:has-text("Hoje")');
  await page.fill('input[type=search]', 'recibo');
  await page.waitForSelector('.card:has-text("Recibo do mercado")');
  await shot(page, '10f-search');
  await page.fill('input[type=search]', '');

  // ---- a note made by hand: written, it reaches the phone; one left empty is dropped
  await page.click('button.nav:has-text("Notas")');
  await page.click('button:has-text("Nova nota")');
  await page.waitForSelector('.panel .title-edit');
  await page.keyboard.press('Escape');
  await page.click('button:has-text("Nova nota")');
  await page.fill('.panel .title-edit', 'Lista de compras');
  await page.fill('.panel .body-edit', 'pão, leite, café');
  await page.keyboard.press('Escape');
  const list = await until('a nota nova', (rs) => rs.find((r) => r.t === 'entries' && r.r.title === 'Lista de compras'));
  assert.equal(list.r.body, 'pão, leite, café');
  assert.equal(list.r.kind, 'note');
  await sleep(800);
  assert.ok(!(await latest()).some((r) => r.t === 'entries' && r.r.kind === 'note' && r.r.title === '' && r.r.body === ''), 'the empty one was dropped');

  // ---- a task's due day set by hand
  await page.click('button.nav:has-text("Tarefas")');
  await page.click('text=Fechar contrato da torre de Campinas');
  await page.waitForSelector('.panel .title-edit');
  const due = new Date(now + 5 * day).toLocaleDateString('sv-SE', { timeZone: zone });
  await page.fill('.panel input[type=date]', due);
  await page.keyboard.press('Escape');
  await until('o prazo novo', (rs) => rs.find((r) => r.t === 'entries' && r.id === '1' && new Date(r.r.dueAt).toLocaleDateString('sv-SE', { timeZone: zone }) === due && r.r.dueHasTime === 0));

  // ---- a medicine made by hand
  await page.click('button.nav:has-text("Remédios")');
  await page.click('button:has-text("Novo remédio")');
  await page.fill('.panel .title-edit', 'Vitamina D');
  await page.locator('.panel label:has-text("Horários") input').fill('9h, 21:00');
  // Esc closes it, and what was being typed is kept.
  await page.keyboard.press('Escape');
  const vit = await until('o remédio novo', (rs) => rs.find((r) => r.t === 'meds' && r.r.name === 'Vitamina D' && r.r.times === '["09:00","21:00"]'));
  assert.ok(Number(vit.id) >= 2 ** 45);
  await page.waitForSelector('.card:has-text("Vitamina D")');

  // ---- a second tab: only one works at a time ("Usar aqui" takes it over)
  const tab2 = await ctx.newPage();
  await tab2.goto(`${server.url}/web/`);
  await tab2.waitForSelector('text=O Novelo está aberto em outra aba');
  await shot(tab2, '10d-other-tab');
  await tab2.click('button:has-text("Usar aqui")');
  await tab2.waitForSelector('.rail', { timeout: 20_000 });
  await page.waitForSelector('text=O Novelo está aberto em outra aba', { timeout: 20_000 });
  await page.click('button:has-text("Usar aqui")');
  await page.waitForSelector('.rail', { timeout: 20_000 });
  await tab2.waitForSelector('text=O Novelo está aberto em outra aba', { timeout: 20_000 });
  await tab2.close();

  // ---- someone else's computer: nothing kept in it, and closing the tab unlinks it
  const pub2 = await browser.newContext({ viewport: { width: 1360, height: 860 }, timezoneId: zone, locale: 'pt-BR' });
  const lib = await pub2.newPage();
  await lib.goto(`${server.url}/web/`);
  await lib.waitForSelector('.qr svg');
  await lib.uncheck('.keep input');
  const code2 = await lib.locator('.qr').getAttribute('data-code');
  const [, id2, pubKey2, secret2] = /#([^.]+)\.([^.]+)\.([^.]+)$/.exec(code2);
  const wrapped2 = await lock.wrapLink(pubKey2, id2, secret2, { space, key: master, owner: 'Pixel da Ana' });
  assert.equal((await signed(phone, 'POST', `/v1/link/${id2}/approve`, { wrapped: wrapped2, owner: 'Pixel da Ana' })).status, 200);
  await lib.waitForSelector('.rail', { timeout: 20_000 });
  await lib.waitForSelector('.shared-note');
  await lib.click('button.nav:has-text("Notas")');
  await lib.waitForSelector('text=Aniversário da Ana: piquenique', { timeout: 20_000 });
  await shot(lib, '10e-shared');
  const keptThere = await lib.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open('novelo-web');
    r.onsuccess = () => {
      const db = r.result;
      const names = [...db.objectStoreNames];
      if (!names.length) return resolve(0);
      const tx = db.transaction(names, 'readonly');
      let n = 0;
      names.forEach((name) => { const q = tx.objectStore(name).count(); q.onsuccess = () => { n += q.result; }; });
      tx.oncomplete = () => resolve(n);
      return undefined;
    };
  }));
  assert.equal(keptThere, 0, 'nothing kept in that browser');
  assert.equal((await signed(phone, 'GET', '/v1/links')).json.links.length, 2);
  await lib.close({ runBeforeUnload: true });
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    await sleep(250);
    gone = (await signed(phone, 'GET', '/v1/links')).json.links.length === 1;
  }
  assert.ok(gone, 'closing the tab unlinked that computer');
  await pub2.close();

  // ---- dark
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await page.waitForSelector('.rail');
  await page.click('button.nav:has-text("Hoje")');
  await sleep(300);
  await shot(page, '11-today-dark');
  assert.deepEqual(errors.filter((e) => !/favicon|ERR_INTERNET_DISCONNECTED/.test(e)), [], 'no errors on the page (but the ones while offline)');

  // ---- a phone opening the page: get the app
  const phonePage = await (await browser.newContext({ viewport: { width: 400, height: 860 }, locale: 'pt-BR', userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36' })).newPage();
  await phonePage.goto(`${server.url}/web/link`);
  await phonePage.waitForSelector('text=Baixar o Novelo');
  await shot(phonePage, '12-phone');

  // ---- the same in other window sizes (wide, laptop, narrow with the icon rail, small with the bottom bar)
  await page.emulateMedia({ colorScheme: 'light' });
  for (const [w, h] of [[1440, 900], [1024, 760], [820, 720], [520, 860]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => { location.hash = '#/tasks'; });
    await page.waitForSelector('.card:has-text("Fechar contrato da torre de Campinas")');
    await shot(page, `20-${w}-tasks`);
    await page.click('.card:has-text("Fechar contrato da torre de Campinas") .title');
    await page.waitForSelector('.panel .title-edit');
    await shot(page, `21-${w}-entry`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.panel', { state: 'detached' });
    await page.evaluate(() => { location.hash = '#/write'; });
    await page.waitForSelector('.write textarea');
    await shot(page, `22-${w}-write`);
  }
  await page.setViewportSize({ width: 1360, height: 860 });

  // ---- unlinked from Ajustes: nothing of it stays in the browser, the server forgets it
  await page.emulateMedia({ colorScheme: 'light' });
  await page.click('button.nav:has-text("Ajustes")');
  await page.click('button:has-text("Desligar este computador")');
  await page.click('button:has-text("Clique de novo pra desligar")');
  await page.waitForSelector('text=Este computador foi desligado do celular.');
  // The page's database is gone whole (records, files, keys, token, draft); only the look stays.
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  assert.ok(!dbs.includes('novelo-web'), `the browser kept nothing: ${JSON.stringify(dbs)}`);
  const kept = await page.evaluate(() => Object.keys(localStorage));
  assert.deepEqual(kept.filter((k) => k !== 'novelo-prefs'), []);
  assert.deepEqual((await signed(phone, 'GET', '/v1/links')).json.links, []);
  await shot(page, '13-unlinked');
  console.log(`ok: ${fs.readdirSync(out).length} telas em ${out}`);
} finally {
  await browser.close();
  await server.close();
  await upstream.close();
}
