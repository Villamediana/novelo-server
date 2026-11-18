// What she writes on the computer, organized here — mind/Mind.kt's path, the same: the context, the
// model (by the Novelo's server, in the phone's name), up to two look-ups, the plan written in. What
// is written stays only here while it is organized (held: the phone never organizes it too) and goes
// up when done. When the Novelo's intelligence can't be used here (the phone's plan, the network for a
// long while), it goes up as it is, and the phone organizes it.
import * as Brain from './brain.js';
import * as Keeper from './keeper.js';
import { Recall, PhotoRecall } from './recall.js';
import { Categories, kindOf, statusOf, isBlank, take } from './words.js';
import { bounds, title as dayTitle } from './diary.js';
import { newId } from './data.js';

export const MAX_LOOKUPS = 2;
export const MAX_SENT_SEEN = 9;
const FIRST_PHOTO_HITS = 4;
const MAX_PHOTO_HITS = 8;
const RECENT = 5;
const NOVELO_TRIES = 3;
const WHAT = { created: 'criado', updated: 'mudou', done: 'feito' };

export const PHOTO_ASK = 'Describe this photo in one or two sentences, in {lang}, with the words she would use to look for it later: '
  + 'the place, the people, animals and things, the colours, the moment, and any writing you can read. '
  + 'Only what can be seen, nothing made up. Plain text.';
export const PHOTOS_ASK = 'You get {n} photos, numbered in the order they come (1, 2, …). Describe each one on its own — they may be of '
  + 'unrelated things — in one or two sentences, in {lang}, with the words she would use to look for it later: '
  + 'the place, the people, animals and things, the colours, the moment, and any writing you can read. '
  + 'Only what can be seen, nothing made up. Answer only with a JSON object from each photo\'s number to its '
  + 'description: {"1": "…", "2": "…"}.';
export const FILE_ASK = 'Diga numa frase curta o que é este arquivo que ela guardou: que tipo de documento é e de quem ou de quê (por exemplo "currículo do Miguel, 2026", "contrato de aluguel do apartamento", "planilha de gastos de novembro"), com as palavras que ela usaria pra procurá-lo. Use o nome, o começo dele e o que ela disse; não invente nada. Escreva em {lang}. Só a frase.';
const LANG_LABEL = { pt: 'Português', en: 'English', es: 'Español' };
const SEE_PHOTO = { pt: 'Descreva esta foto.', en: 'Describe this photo.', es: 'Describe esta foto.' };
const SEE_PHOTOS = { pt: 'Descreva cada uma destas fotos.', en: 'Describe each of these photos.', es: 'Describe cada una de estas fotos.' };

/** A chat request as the Novelo's server takes it (mind/Engines.kt chatBody). */
export function chatBody(system, user, { images = [], json = false, effort = null } = {}) {
  const content = images.length
    ? [
      ...(user ? [{ type: 'text', text: user }] : []),
      ...images.flatMap((img, i) => [
        ...(images.length > 1 ? [{ type: 'text', text: `${i + 1}:` }] : []),
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}`, detail: 'low' } },
      ]),
    ]
    : user;
  return {
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

export function clean(text, max) {
  const t = String(text ?? '').trim().replace(/^["“”']+|["“”']+$/g, '').trim();
  return t ? t.slice(0, max) : null;
}

/** The descriptions of [n] photos from a numbered answer ({"1": …} or a list). */
export function numbered(answer, n) {
  const s = String(answer);
  const start = [...s].findIndex((c) => c === '{' || c === '[');
  if (start < 0) return [];
  const end = s.lastIndexOf(s[start] === '[' ? ']' : '}');
  if (end <= start) return [];
  let root;
  try {
    root = JSON.parse(s.slice(start, end + 1));
  } catch {
    return [];
  }
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  if (Array.isArray(root)) return Array.from({ length: n }, (_, i) => text(root[i]));
  if (root && typeof root === 'object') return Array.from({ length: n }, (_, i) => text(root[String(i + 1)] ?? root[`foto ${i + 1}`] ?? root[`photo ${i + 1}`]));
  return [];
}

/** A photo as the model reads it, from its capture (one with an image there or here). */
export function photoOf(c) {
  if (c.source !== 'photo') return null;
  const media = c.media ?? {};
  if (!media.image && !media.thumb) return null;
  return { id: c.id, takenAt: c.createdAt, description: isBlank(c.description) ? null : c.description, text: isBlank(c.transcript) ? null : c.transcript, turn: c.turn };
}

/** What went wrong, in a word: the network, the intelligence over for the phone, or something else. */
export class Problem extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'offline' | 'handoff' | 'failed'
  }
}

export class WebMind {
  /**
   * [ask](job, body, {not}) → {text, route}: the Novelo's server in the phone's name (throws {status, code}).
   * [describe](captureId) → the photo as a JPEG (base64), at most 1024 px; [peek](captureId) → a file's first words.
   */
  constructor({ data, ask, zone, lang = 'pt', describe = async () => null, peek = async () => '', onChange = () => {} }) {
    Object.assign(this, { data, askServer: ask, zone, lang, describe, peek, onChange });
    this.line = []; // [{id, where: 'going'|'in_line'|'later'|'failed'|'phone', text, message}]
    this.running = false;
    this.answers = [];
  }

  emit() {
    this.onChange({ line: [...this.line], answer: this.answers[this.answers.length - 1] ?? null });
  }

  /** What she wrote, and the photos and files she put with it ([{captureId}] already made, held). */
  write(text, parts = []) {
    const said = String(text).trim();
    if (!said && !parts.length) return null;
    const now = this.data.clock();
    const id = newId();
    this.data.batch(() => {
      this.data.write('captures', { id, createdAt: now, source: 'text', transcript: said || null, state: 'thinking' });
      this.data.hold('captures', String(id));
      for (const p of parts) {
        const c = this.data.capture(p);
        if (c) this.data.write('captures', { ...c, partOf: id, state: 'done' });
      }
    });
    this.line.push({ id, where: 'in_line', text: said });
    this.emit();
    this.run();
    return id;
  }

  /** What was being organized when the page closed: back in line. */
  resume() {
    for (const c of this.data.captures()) {
      if (!this.data.held.has(`captures|${c.id}`) || c.partOf != null || c.state === 'done') continue;
      if (!this.line.some((l) => l.id === c.id)) this.line.push({ id: c.id, where: 'in_line', text: c.transcript ?? '' });
    }
    this.emit();
    this.run();
  }

  retry(id) {
    const l = this.line.find((x) => x.id === id);
    if (l) l.where = 'in_line';
    this.emit();
    this.run();
  }

  /** Thrown away before it went (with what she sent with it). */
  discard(id) {
    this.line = this.line.filter((l) => l.id !== id);
    this.data.batch(() => {
      for (const c of this.data.captures()) if (c.partOf === id) {
        this.data.release('captures', String(c.id));
        this.data.remove('captures', String(c.id));
      }
      this.data.release('captures', String(id));
      this.data.remove('captures', String(id));
    });
    this.emit();
  }

  /** The network is back: what waited for it goes. */
  online() {
    let any = false;
    for (const l of this.line) if (l.where === 'later') { l.where = 'in_line'; any = true; }
    if (any) {
      this.emit();
      this.run();
    }
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const next = this.line.find((l) => l.where === 'in_line');
        if (!next) return;
        next.where = 'going';
        this.emit();
        try {
          const answer = await this.process(next.id);
          this.line = this.line.filter((l) => l.id !== next.id);
          if (answer) this.answers.push(answer);
        } catch (e) {
          if (e instanceof Problem && e.kind === 'handoff') {
            this.handOff(next.id);
            next.where = 'phone';
            next.message = e.message;
          } else if (e instanceof Problem && e.kind === 'offline') {
            next.where = 'later';
            next.message = e.message;
          } else {
            next.where = 'failed';
            next.message = e?.message ?? String(e);
          }
        }
        this.emit();
      }
    } finally {
      this.running = false;
    }
  }

  /** Goes up as it is: the phone organizes it (its own intelligence). */
  handOff(id) {
    const c = this.data.capture(id);
    if (!c) return;
    this.data.batch(() => {
      this.data.write('captures', { ...c, state: 'recorded', error: null, tries: 0 });
      for (const p of this.data.captures()) if (p.partOf === id) this.data.release('captures', String(p.id));
      this.data.release('captures', String(id));
    });
  }

  async ask(job, body, not = []) {
    try {
      return await this.askServer(job, body, { not });
    } catch (e) {
      if (e?.status === 0 || e?.name === 'TypeError') throw new Problem('offline', 'sem internet');
      if (e?.code === 'plan' || e?.code === 'not_configured' || e?.status === 403) throw new Problem('handoff', e?.message ?? 'o celular organiza');
      if (e?.code === 'busy' || e?.code === 'budget' || e?.code === 'quota' || e?.code === 'rate_limited' || e?.status === 429 || e?.status >= 500) throw new Problem('offline', e?.message ?? 'depois');
      throw e;
    }
  }

  async describePhotos(photos) {
    const todo = photos.filter((p) => isBlank(p.description));
    if (!todo.length) return;
    const images = [];
    for (const p of todo) images.push(await this.describe(p.id).catch(() => null));
    const ready = todo.map((p, i) => [p, images[i]]).filter(([, img]) => img);
    if (!ready.length) return;
    const lang = LANG_LABEL[this.lang] ?? 'Português';
    let said = [];
    if (ready.length > 1) {
      const a = await this.ask('see', chatBody(PHOTOS_ASK.replace('{n}', String(ready.length)).replace('{lang}', lang), SEE_PHOTOS[this.lang] ?? SEE_PHOTOS.pt, { images: ready.map((r) => r[1]), json: true })).catch(() => null);
      said = a ? numbered(a.text, ready.length) : [];
    }
    for (let i = 0; i < ready.length; i++) {
      let d = said[i] ? clean(said[i], 400) : null;
      if (!d) {
        const a = await this.ask('see', chatBody(PHOTO_ASK.replace('{lang}', lang), SEE_PHOTO[this.lang] ?? SEE_PHOTO.pt, { images: [ready[i][1]] })).catch(() => null);
        d = a ? clean(a.text, 400) : null;
      }
      if (d) {
        const c = this.data.capture(ready[i][0].id);
        if (c) this.data.write('captures', { ...c, description: d });
      }
    }
  }

  async describeFile(c, said) {
    if (!isBlank(c.description)) return c.description;
    const peek = await this.peek(c.id).catch(() => '');
    let user = `Nome: ${take(c.fileName, 120)}\n`;
    const label = Brain.FileKind.label(c.fileName ?? '', c.fileMime);
    if (label) user += `Tipo: ${label}\n`;
    if (peek?.trim()) user += `Começo: ${take(peek.trim(), Brain.PEEK).replaceAll('\n', ' ')}\n`;
    if (said?.trim()) user += `O que ela disse ao mandar: ${take(said.trim(), 300).replaceAll('\n', ' ')}\n`;
    const a = await this.ask('see', chatBody(FILE_ASK.replace('{lang}', LANG_LABEL[this.lang] ?? 'Português'), user)).catch(() => null);
    const d = a ? clean(String(a.text).split('\n')[0], 180) : null;
    if (d) this.data.write('captures', { ...c, description: d });
    return d;
  }

  /** The model's answer that is a plan (another model asked when one isn't). */
  async think(system, user) {
    const not = [];
    let last = '';
    for (let i = 0; i < NOVELO_TRIES; i++) {
      const a = await this.ask('think', chatBody(system, user, { json: true, effort: 'low' }), not);
      last = a.text;
      if (Brain.parse(last) !== null || !a.route) break;
      not.push(a.route);
    }
    return last;
  }

  before(c, live) {
    const last = this.data.lastDone(c.id);
    if (!last) return null;
    const byId = new Map(live.map((e) => [e.id, e]));
    let outs = [];
    try {
      outs = JSON.parse(last.outcomes ?? '[]');
    } catch { /* none */ }
    const items = outs.filter((o) => o.action !== 'deleted').map((o) => (byId.has(o.entryId) ? [byId.get(o.entryId), WHAT[o.action] || 'mudou'] : null)).filter(Boolean);
    return { at: last.createdAt, said: last.transcript ?? '', reply: last.reply ?? '', photo: last.source === 'photo', items, file: last.source === 'file' ? last.fileName : null };
  }

  diaryFor(at) {
    const day = bounds(at, this.zone);
    if (this.data.diariesBetween(day[0], day[1]).length) return;
    this.data.insertEntry({ kind: 'diary', title: dayTitle(at, this.zone, this.lang), createdAt: at, updatedAt: this.data.clock() });
  }

  async process(id) {
    const data = this.data;
    const c = data.capture(id);
    if (!c) return null;
    const said = c.transcript ?? '';
    const parts = data.captures().filter((p) => p.partOf === id).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
    const photos = parts.filter((p) => p.source === 'photo');
    const files = parts.filter((p) => p.source === 'file');
    await this.describePhotos(photos.slice(0, MAX_SENT_SEEN));
    const seen = [];
    for (const f of files) {
      const d = await this.describeFile(data.capture(f.id) ?? f, said);
      seen.push({ name: f.fileName ?? 'arquivo', mime: f.fileMime, size: f.fileSize, peek: '', about: d });
    }
    const sentPhotos = photos.slice(0, MAX_SENT_SEEN).map((p) => photoOf(data.capture(p.id) ?? p) ?? { id: p.id, takenAt: p.createdAt, description: null, text: null });
    const fileAlone = !said && files.length > 0 && !photos.length;
    const together = !said && photos.length > 0 && !files.length;

    const now = data.clock();
    const z = this.zone;
    const all = data.entries();
    const topics = data.topics();
    const ties = data.ties();
    const links = data.links();
    const live = all.filter((e) => !(kindOf(e) === 'task' && statusOf(e) === 'done'));
    const open = data.openTasks();
    const hits = new Recall(live, topics, ties, links).search(said, 12, now).map((h) => h.entry).slice(0, 12);
    const recent = live.slice(0, RECENT);
    const diary = Brain.todaysDiary(all, now, z);
    const sentIds = new Set(parts.map((p) => p.id));
    const pictures = new PhotoRecall(data.captures().filter((p) => p.id !== id && p.partOf !== id && !sentIds.has(p.id)).map(photoOf).filter(Boolean));
    const photoHits = fileAlone || !said ? [] : pictures.search(said, FIRST_PHOTO_HITS);
    const before = this.before(c, live);
    const categories = Categories.inUse(all);
    const meds = data.meds();
    const taken = meds.length ? data.taken() : [];
    const heard = said || (together ? '' : said);
    const ctx = (extra) => Brain.context({
      said: heard, now, zone: z, openTasks: open, related: hits, focus: null, recent, typed: true, diary, photos: photoHits, before,
      sent: sentPhotos, files: seen, fileAlone, categories, meds, taken, together, ...extra,
    });
    const answer = await this.think(Brain.SYSTEM, ctx({}));
    let plan = Brain.parse(answer);
    if (!plan) throw new Problem('failed', this.lang === 'en' ? 'The model answered in the wrong format. Try again.' : this.lang === 'es' ? 'El modelo respondió fuera del formato. Intenta de nuevo.' : 'O modelo respondeu fora do formato. Tente de novo.');
    const nothing = this.lang === 'en' ? "I didn't find anything about that." : this.lang === 'es' ? 'No encontré nada sobre eso.' : 'Não achei nada sobre isso.';
    let found = [];
    let foundPhotos = [];
    const looked = [];
    let lookups = 0;
    const recall = new Recall(all, topics, ties, links);
    while (Brain.isLookupOnly(plan) && lookups < MAX_LOOKUPS) {
      lookups++;
      const asked = plan.search.join(' ');
      const byWords = plan.search.length ? recall.search(asked, 15, now).map((h) => h.entry) : [];
      const days = Brain.range(plan.period, z);
      const byTime = days ? all.filter((e) => (e.createdAt >= days[0] && e.createdAt <= days[1]) || (e.doneAt != null && e.doneAt >= days[0] && e.doneAt <= days[1]) || (e.dueAt != null && e.dueAt >= days[0] && e.dueAt <= days[1])) : [];
      const seenIds = new Set();
      found = [...found, ...byWords, ...byTime].filter((e) => !seenIds.has(e.id) && seenIds.add(e.id));
      const ph = [...foundPhotos, ...(plan.search.length ? pictures.search(asked, MAX_PHOTO_HITS) : []), ...(days ? pictures.during(days, MAX_PHOTO_HITS) : [])];
      const phIds = new Set();
      foundPhotos = ph.filter((p) => !phIds.has(p.id) && phIds.add(p.id));
      looked.push(Brain.looked(plan));
      const next = Brain.parse(await this.think(Brain.SYSTEM, ctx({ related: found, looked: looked.join(' · '), photos: foundPhotos })));
      plan = next ?? { ...plan, search: [], period: null, reply: plan.reply || nothing };
    }
    if (Brain.isLookupOnly(plan)) plan = { ...plan, reply: plan.reply || nothing };
    plan = { ...plan, search: [], period: null };

    const result = Keeper.apply(data, plan, { captureId: id, sentPhotos: sentPhotos.map((p) => p.id), sentFiles: files.map((f) => f.id), saidAt: c.createdAt, zone: z, now: data.clock() });
    const days = new Set();
    for (const p of photos) {
      const d = bounds(p.createdAt, z)[0];
      if (!days.has(d)) { days.add(d); this.diaryFor(p.createdAt); }
    }
    for (const f of files) {
      if (result.outcomes.some((o) => o.action !== 'deleted' && (o.files || o.docs.includes(f.id)))) continue;
      const d = bounds(f.createdAt, z)[0];
      if (!days.has(d)) { days.add(d); this.diaryFor(f.createdAt); }
    }
    const shown = [...new Set(plan.show)].filter((e) => data.entry(e));
    const shownPhotos = [...new Set(plan.showPhotos)].filter((p) => p !== id && data.capture(p)?.source === 'photo');
    const shownMeds = [...new Set(plan.showMeds)].filter((m) => !result.meds.includes(m) && data.med(m));
    // The outcomes as the phone writes them (what is false or empty left out).
    const outcomes = result.outcomes.map((o) => ({ entryId: o.entryId, action: o.action, ...(o.photos ? { photos: true } : {}), ...(o.files ? { files: true } : {}), ...(o.pics.length ? { pics: o.pics } : {}), ...(o.docs.length ? { docs: o.docs } : {}) }));
    data.batch(() => {
      data.write('captures', {
        ...data.capture(id), state: 'done', tries: 0, error: null, reply: plan.reply, outcomes: JSON.stringify(outcomes), shown: JSON.stringify(shown), shownPhotos: JSON.stringify(shownPhotos),
      });
      for (const p of parts) data.release('captures', String(p.id));
      data.release('captures', String(id));
    });
    return { captureId: id, said, reply: plan.reply, outcomes: result.outcomes, shown, photos: shownPhotos, meds: result.meds, shownMeds };
  }
}
