// The model's side of Novelo — mind/Brain.kt, the same here: the context it sees, reading what it
// answers, and the dates it writes. The instructions are the app's own (prompt.js, generated).
// Rows are as the phone keeps them (booleans 0/1). Pure.
import * as T from './time.js';
import * as R from './repeat.js';
import * as D from './doses.js';
import { Steps, kindOf, kindKey, statusOf, isOpenTask, take, isBlank } from './words.js';
import * as Summary from './summary.js';
export { SYSTEM } from './prompt.js';

const MAX_TASKS = 30;
const MAX_MEDS = 40;
const MAX_RELATED = 8;
const MAX_RECENT = 5;
const MAX_FOUND = 40;
const MAX_PHOTOS = 12;
const TOGETHER_TEXT = 1500;
const BEFORE_SAID = 400;
const BEFORE_REPLY = 300;
const MAX_BEFORE_ITEMS = 6;
const MAX_BEFORE_SHOWN = 12;
/** The app's language when none is given (the app's own default). */
export const DEFAULT_LANG = 'Português';
/** Where "Mudar o tipo" sends an item, as the model reads it. */
const REDO_KINDS = {
  task: 'tarefa (em "create", "kind": "task")',
  note: 'nota (em "create", "kind": "note")',
  diary: 'diário (em "create", "kind": "diary")',
  med: 'remédio (em "meds")',
};
const FOCUS_BODY = 800;
const SUMMARY_LINE = 400;
export const PEEK = 800;
const SEEN = 400;

const nl = (s) => String(s).replaceAll('\n', ' ');
const two = (n) => String(n).padStart(2, '0');

// ------------------------------------------------------------------ files

export const FileKind = {
  ext(name) {
    const i = String(name).lastIndexOf('.');
    if (i < 0) return null;
    const e = name.slice(i + 1).toLowerCase();
    return e && e.length <= 5 && /^[\p{L}\p{N}]+$/u.test(e) ? e : null;
  },
  label(name, mime) {
    const e = FileKind.ext(name);
    if (e) return e.toUpperCase();
    if (!mime || !mime.includes('/')) return null;
    let sub = mime.slice(mime.indexOf('/') + 1);
    sub = sub.slice(sub.lastIndexOf('.') + 1);
    return sub && sub.length <= 8 ? sub.toUpperCase() : null;
  },
  size(bytes, locale = 'pt-BR') {
    const f = (v) => v.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.floor((bytes + 512) / 1024)} KB`;
    if (bytes < 1024 ** 3) return `${f(bytes / (1024 * 1024))} MB`;
    return `${f(bytes / 1024 ** 3)} GB`;
  },
};

export function fileLine(f) {
  let s = `"${take(f.name, 120)}"`;
  const label = FileKind.label(f.name, f.mime);
  if (label) s += ` · ${label}`;
  if (f.size > 0) s += ` · ${FileKind.size(f.size)}`;
  const about = f.about?.trim();
  if (about) s += ` · o que é: ${take(about, SEEN)}`;
  else if (f.peek?.trim()) s += `\n   começo da primeira página: "${nl(take(f.peek.trim(), PEEK))}"`;
  return s;
}

/** A photo as the model sees it: {id, takenAt, description, text}. */
export function photoLine(p, zone) {
  let s = `foto#${p.id} ${T.stamp(p.takenAt, zone)}`;
  if (p.description) s += ` — ${nl(take(p.description, 200))}`;
  if (p.text) s += ` · texto: ${nl(take(p.text, 120))}`;
  return s;
}

export function medLine(m, taken, zone, now) {
  let s = `remédio#${m.id} "${take(m.name, 60)}"`;
  for (const v of [m.strength, m.dose, m.amount]) if (v != null && !isBlank(v)) s += ` · ${take(v, 40)}`;
  if (m.person != null) s += ` · pra ${m.person}`;
  const ts = D.times(m);
  if (!ts.length) s += ' · quando precisar';
  else {
    s += ` · ${ts.map(T.hhmm).join(', ')}`;
    if (m.everyHours != null) s += ` · de ${m.everyHours} em ${m.everyHours} h`;
    const days = [...D.days(m)];
    if (days.length) s += ` · dias [${days.sort((a, b) => a - b).join(',')}]`;
  }
  if (m.startsAt > now) s += ` · começa ${T.stamp(m.startsAt, zone)}`;
  else s += ` · desde ${T.day(m.startsAt, zone)}`;
  if (m.endsAt != null) {
    s += (m.endsAt < now ? ' · terminou ' : ' · até ') + T.day(m.endsAt, zone);
    const all = D.slots(m, m.startsAt, m.endsAt, zone);
    if (all.length) {
      const ats = new Set(taken.filter((t) => t.medId === m.id).map((t) => t.at));
      s += ` · doses: ${all.filter((a) => ats.has(a)).length} de ${all.length} dadas`;
    }
  }
  if (!isBlank(m.notes)) s += ` · ${nl(take(m.notes, 80))}`;
  if (!D.ended(m, now)) {
    const today = D.day([m], T.dateOf(now, zone), zone);
    if (today.length) {
      s += ` · hoje: ${today.map((slot) => T.hhmm(T.timeOf(slot.at, zone)) + (taken.some((t) => t.medId === m.id && t.at === slot.at) ? ' tomado' : '')).join(', ')}`;
    }
  }
  return s;
}

/** One entry in a line the model can read and point to (#id). */
export function line(e, zone, now, long = false, bodyMax = 220) {
  const kind = kindOf(e);
  let s = `#${e.id} ${kind === 'task' ? `tarefa[${statusOf(e) ?? 'todo'}]` : kind === 'note' ? 'nota' : 'diário'}`;
  s += ` ${T.day(e.createdAt, zone)} "${take(e.title, 90)}"`;
  if (e.category != null && kind === 'task') s += ` · categoria ${e.category}`;
  if (e.dueAt != null) s += ` · prazo ${e.dueHasTime ? T.stamp(e.dueAt, zone) : T.day(e.dueAt, zone)}`;
  if (e.doneAt != null) s += ` · feito em ${T.day(e.doneAt, zone)}`;
  const rule = R.read(e.repeat);
  if (statusOf(e) !== 'done' && e.remindAt != null) {
    if (e.remindAt > now) s += ` · lembrete ${T.stamp(e.remindAt, zone)}`;
    else if (isOpenTask(e) && rule === null) s += ` · lembrete já tocou ${T.stamp(e.remindAt, zone)}`;
  }
  if (rule) s += ` · repete ${rule.every}${rule.every === 'week' ? `[${rule.days.join(',')}]` : ''} ${R.allTimes(rule).map((t) => `${two(t.h)}:${two(t.mi)}`).join(',')}`;
  if (isOpenTask(e)) {
    const left = R.timesOf(e, now + 1, zone).filter((t) => !t[1]).slice(-3);
    if (left.length) s += ` · não feito ${left.map((t) => T.stamp(t[0], zone)).join(',')}`;
  }
  const steps = Steps.read(e.steps);
  if (steps.length) s += ` · etapas: ${steps.map((st) => (st.done ? '[x] ' : '[ ] ') + take(st.text, 40)).join(' ')}`;
  // A note's points ("Em tópicos"): the whole of it in short, even when its text is cut below.
  if (long && kind === 'note' && !e.sensitive) {
    const points = Summary.read(e.summary);
    if (points.length) s += ` · em tópicos: ${take(points.join(' | '), SUMMARY_LINE)}`;
  }
  if (long && !isBlank(e.body)) {
    const body = e.sensitive ? take(e.body, 160) : take(e.body, bodyMax);
    s += ` — ${nl(body)}`;
  }
  return s;
}

/** Today's diary (the newest of the day in [zone]); null before the first. */
export function todaysDiary(entries, now, zone) {
  const today = T.dateOf(now, zone);
  let best = null;
  for (const e of entries) {
    if (kindOf(e) !== 'diary' || !T.sameDate(T.dateOf(e.createdAt, zone), today)) continue;
    if (!best || e.createdAt > best.createdAt) best = e;
  }
  return best;
}

/**
 * What the model sees — Brain.context, field by field. [o]: {said, now, zone, openTasks, related,
 * focus, recent, looked, photo, typed, diary, photos, takenAt, before, sent, files, fileAlone, seen,
 * categories, meds, taken, together}.
 */
export function context(o) {
  const { said, now, zone } = o;
  const openTasks = o.openTasks ?? [];
  const related = o.related ?? [];
  const focus = o.focus ?? null;
  const recent = o.recent ?? [];
  const looked = o.looked ?? null;
  const photos = o.photos ?? [];
  const sent = o.sent ?? [];
  const files = o.files ?? [];
  const categories = o.categories ?? [];
  const meds = o.meds ?? [];
  const taken = o.taken ?? [];
  let s = '';
  const today = o.diary && o.diary.id !== focus?.id ? o.diary : null;
  const shown = new Set([focus?.id, today?.id].filter((x) => x != null));
  const tasks = openTasks.filter((e) => !shown.has(e.id)).slice(0, MAX_TASKS);
  s += `IDIOMA DO APP: ${o.lang ?? DEFAULT_LANG}\n\n`;
  if (categories.length) s += `CATEGORIAS DAS TAREFAS: ${categories.join(', ')}\n\n`;
  const named = meds.filter((m) => !isBlank(m.name)).map((m) => ({ m, ended: D.ended(m, now) }))
    .sort((a, b) => {
      if (a.ended !== b.ended) return a.ended ? 1 : -1;
      const ka = a.ended ? a.m.endsAt : -a.m.createdAt;
      const kb = b.ended ? b.m.endsAt : -b.m.createdAt;
      return kb - ka;
    }).map((x) => x.m);
  if (named.length) {
    s += 'REMÉDIOS:\n';
    for (const m of named.slice(0, MAX_MEDS)) s += `${medLine(m, taken, zone, now)}\n`;
    s += '\n';
  }
  if (tasks.length) {
    s += 'TAREFAS ABERTAS:\n';
    for (const e of tasks) s += `${line(e, zone, now)}\n`;
  }
  if (today) {
    s += '\nDIÁRIO DE HOJE:\n';
    s += `${line(today, zone, now, true, FOCUS_BODY)}\n`;
  }
  const last = recent.filter((e) => !shown.has(e.id)).slice(0, MAX_RECENT);
  if (last.length) {
    s += '\nÚLTIMAS COISAS GUARDADAS (a mais nova primeiro):\n';
    for (const e of last) {
      const whole = line(e, zone, now, true);
      s += (tasks.some((t) => t.id === e.id) && whole === line(e, zone, now) ? `#${e.id} (acima)` : whole) + '\n';
    }
  }
  const listed = new Set([...shown, ...tasks.map((e) => e.id), ...last.map((e) => e.id)]);
  if (looked === null) {
    const rel = related.filter((r) => !listed.has(r.id)).slice(0, MAX_RELATED);
    if (rel.length) {
      s += '\nLEMBRANÇAS QUE PODEM TER A VER:\n';
      for (const e of rel) s += `${line(e, zone, now, true)}\n`;
    }
    for (const e of rel) listed.add(e.id);
  } else {
    const found = related.slice(0, MAX_FOUND);
    for (const e of found) listed.add(e.id);
    if (found.length) {
      s += `\nRESULTADOS DA BUSCA (${looked}):\n`;
      for (const e of found) s += `${line(e, zone, now, true)}\n`;
    } else {
      s += `\nA BUSCA (${looked}) NÃO ACHOU NADA. Responda com o que há.\n`;
    }
  }
  if (photos.length) {
    s += looked === null ? '\nFOTOS QUE PODEM TER A VER:\n' : '\nFOTOS ACHADAS:\n';
    for (const p of photos.slice(0, MAX_PHOTOS)) s += `${photoLine(p, zone)}\n`;
  }
  if (focus) {
    s += '\nELA ESTÁ RESPONDENDO SOBRE ESTE ITEM (o Novelo perguntou como está):\n';
    s += `${line(focus, zone, now, true, FOCUS_BODY)}\n`;
  }
  const before = o.before;
  if (before) {
    s += `\nANTES DISSO (a última conversa, ${T.stamp(before.at, zone)}):\n`;
    s += 'ela: ' + (before.file != null ? `(mandou o arquivo "${take(before.file, 80)}")` : before.photo ? '(mandou uma foto)' : `"${nl(take(String(before.said).trim(), BEFORE_SAID))}"`) + '\n';
    if (!isBlank(before.reply)) s += `você: "${nl(take(before.reply.trim(), BEFORE_REPLY))}"\n`;
    for (const [e, what] of (before.items ?? []).slice(0, MAX_BEFORE_ITEMS)) s += `${what}: ${listed.has(e.id) ? `#${e.id} (acima)` : line(e, zone, now)}\n`;
    // What it showed her (the list she may now ask to put in Hoje): pointed to when already above.
    for (const e of (before.shown ?? []).filter((x) => !(before.items ?? []).some(([i]) => i.id === x.id)).slice(0, MAX_BEFORE_SHOWN)) {
      s += `mostrado: ${listed.has(e.id) ? `#${e.id} (acima)` : line(e, zone, now)}\n`;
    }
  }
  const at = T.parts(now, zone);
  s += `\nAGORA: ${T.PT_WEEKDAYS[at.dow - 1]}, ${T.stamp(now, zone)} (${zone})\n`;
  const takenOn = o.takenAt != null && !T.sameDate(T.dateOf(o.takenAt, zone), T.dateOf(now, zone)) ? o.takenAt : null;
  if (sent.length) {
    s += `\nAS FOTOS QUE ELA MANDOU JUNTO (${sent.length}):\n`;
    sent.forEach((p, i) => {
      s += `${i + 1}. ${T.stamp(p.takenAt, zone)}`;
      if (p.description) s += ` · o que se vê: ${nl(take(p.description, SEEN))}`;
      if (p.text) s += ` · texto: ${nl(take(p.text, o.together ? TOGETHER_TEXT : 160))}`;
      s += '\n';
    });
  }
  const seen = o.seen?.trim();
  if (seen) s += `\nO QUE SE VÊ (o celular olhou):\n${take(seen, SEEN)}\n`;
  if (o.fileAlone) {
    s += '\nO ARQUIVO QUE ELA MANDOU (sem dizer nada; é o arquivo 1):\n';
    for (const f of files) s += `${fileLine(f)}\n`;
    return s;
  }
  if (files.length) {
    s += `\nOS ARQUIVOS QUE ELA MANDOU JUNTO (${files.length}):\n`;
    files.forEach((f, i) => { s += `${i + 1}. ${fileLine(f)}\n`; });
  }
  if (o.together) {
    s += '\nELA SÓ MANDOU AS FOTOS, SEM DIZER NADA.\n';
    return s;
  }
  if (o.redo) {
    // "Mudar o tipo" (app 1.82): she chose where it goes; the model organizes that one item again, there.
    const target = REDO_KINDS[o.redo.kind] ?? o.redo.kind;
    const was = { task: 'tarefa', note: 'nota', diary: 'diário' }[kindOf(o.redo.was)];
    s += `\nELA ESCOLHEU ONDE ISTO VAI: ${target}.\n`;
    s += `O Novelo tinha guardado como ${was} e errou; esse item sai pra dar lugar ao novo. `;
    s += `Organize de novo só isto, como ${target}, com o que está escrito nele (a data, o lembrete e as etapas que tiver). `;
    s += 'Nada mais: não crie outras coisas nem mude outros itens.\n';
    const then = o.redo.said?.trim();
    if (then) s += `O QUE ELA DISSE NA HORA (só pra entender): "${nl(take(then, BEFORE_SAID))}"\n`;
    s += '\nO ITEM, COMO ESTÁ ESCRITO:\n';
    s += `"${String(said).trim()}"\n`;
    return s;
  }
  if (o.photo && takenOn != null) {
    const p = T.parts(takenOn, zone);
    s += `\nO QUE ESTÁ NA FOTO (TIRADA EM ${T.PT_WEEKDAYS[p.dow - 1]}, ${T.stamp(takenOn, zone)}):\n`;
  } else if (o.photo) s += '\nO QUE ESTÁ NA FOTO QUE ELA TIROU:\n';
  else if (o.typed) s += '\nO QUE ELA ESCREVEU:\n';
  else s += '\nO QUE ELA DISSE:\n';
  s += `"${String(said).trim()}"\n`;
  return s;
}

// ------------------------------------------------------------------ the answer

const firstNumber = (v) => {
  if (v === null || v === undefined || typeof v === 'object') return null;
  const m = /\d+/.exec(String(v));
  return m ? Number(m[0]) : null;
};
const oneOrMany = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : v === null || v === undefined ? [] : [v]);
const strings = (v) => oneOrMany(v).filter((x) => typeof x !== 'object').map(String);
const longs = (v) => oneOrMany(v).map((x) => (typeof x === 'number' ? x : typeof x === 'string' && /^-?\d+$/.test(x.trim()) ? Number(x) : null)).filter((x) => x !== null && Number.isFinite(x)).map(Math.trunc);
const WEEK_NAMES = [['seg', 'mon', 'lun'], ['ter', 'tue', 'mar'], ['qua', 'wed', 'mie', 'mié'], ['qui', 'thu', 'jue'], ['sex', 'fri', 'vie'], ['sab', 'sáb', 'sat'], ['dom', 'sun']];
function weekDays(v) {
  if (v === null || v === undefined) return null;
  return (Array.isArray(v) ? v : [v]).map((e) => {
    if (e === null || typeof e === 'object') return null;
    const text = String(e).trim().toLowerCase();
    let n = /^-?\d+$/.test(text) ? Number(text) : null;
    if (n === null) {
      const i = WEEK_NAMES.findIndex((g) => g.some((w) => text.startsWith(w)));
      n = i >= 0 ? i + 1 : null;
    }
    return n !== null && n >= 1 && n <= 7 ? n : null;
  }).filter((x) => x !== null);
}
/** Photos or files of an item: numbers; true is all of them (0). */
function picks(v) {
  const one = (e) => {
    if (e === true) return 0;
    if (e === false || e === null || e === undefined || typeof e === 'object') return null;
    const n = /^-?\d+$/.test(String(e).trim()) ? Number(String(e).trim()) : null;
    return n !== null && n >= 1 ? n : null;
  };
  const items = (Array.isArray(v) ? v : [v]).map(one).filter((x) => x !== null);
  return [...new Set(items)];
}
export const ALL = 0;
const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined || typeof v === 'object' ? null : String(v));
const bool = (v, d = false) => (typeof v === 'boolean' ? v : d);
const optBool = (v) => (typeof v === 'boolean' ? v : null);

function topicsOf(v) {
  return (Array.isArray(v) ? v : []).filter((t) => t && typeof t === 'object' && typeof t.name === 'string').map((t) => ({ name: t.name, type: typeof t.type === 'string' ? t.type : 'topic' }));
}

function repeatAsk(v) {
  if (!v || typeof v !== 'object') return null;
  return { every: str(v.every) ?? '', days: (Array.isArray(v.days) ? v.days : []).filter(Number.isInteger), times: strings(v.times) };
}

/** The model's answer → a plan (code fences and text around the object ignored); null when there is no JSON. */
export function parse(answer) {
  const text = String(answer).split('</think>').pop();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const period = raw.period && typeof raw.period === 'object' ? { from: str(raw.period.from), to: str(raw.period.to) } : null;
  const plan = {
    reply: str(raw.reply) ?? '',
    create: (Array.isArray(raw.create) ? raw.create : []).filter((c) => c && typeof c === 'object' && typeof c.kind === 'string' && typeof c.title === 'string').map((c) => ({
      kind: c.kind, title: c.title, body: str(c.body) ?? '', summary: Summary.points(c.summary), tags: strings(c.tags), entities: topicsOf(c.entities), category: str(c.category),
      due: str(c.due), remindAt: str(c.remind_at), checkInAt: str(c.check_in_at), repeat: repeatAsk(c.repeat), steps: strings(c.steps),
      status: str(c.status), sensitive: bool(c.sensitive), related: longs(c.related), photos: picks(c.photos), files: picks(c.files), alarm: optBool(c.alarm),
    })).filter((c) => !isBlank(c.title) && kindKey(c.kind) !== null),
    update: (Array.isArray(raw.update) ? raw.update : []).filter((c) => c && typeof c === 'object' && longs(c.id).length).map((c) => ({
      id: longs(c.id)[0], status: str(c.status), stepsDone: strings(c.steps_done), addSteps: strings(c.add_steps), title: str(c.title), append: str(c.append), body: str(c.body), summary: Summary.points(c.summary),
      category: str(c.category), due: str(c.due), remindAt: str(c.remind_at), checkInAt: str(c.check_in_at), repeat: repeatAsk(c.repeat), entities: topicsOf(c.entities),
      delete: bool(c.delete), photos: picks(c.photos), files: picks(c.files), alarm: optBool(c.alarm),
    })),
    search: strings(raw.search),
    period,
    show: longs(raw.show),
    showPhotos: longs(raw.show_photos),
    showMeds: oneOrMany(raw.show_meds).map(firstNumber).filter((x) => x !== null),
    keepAudio: bool(raw.keep_audio),
    categories: (Array.isArray(raw.categories) ? raw.categories : []).filter((c) => c && typeof c === 'object').map((c) => ({ name: str(c.name) ?? '', to: str(c.to) })),
    meds: (Array.isArray(raw.meds) ? raw.meds : []).filter((c) => c && typeof c === 'object').map((c) => ({
      id: firstNumber(c.id), name: str(c.name), strength: str(c.strength), dose: str(c.dose), amount: str(c.amount), person: str(c.person),
      times: strings(c.times), everyHours: firstNumber(c.every_hours), days: weekDays(c.days), start: str(c.start), end: str(c.end), notes: str(c.notes),
      photos: picks(c.photos), taken: optBool(c.taken), alarm: optBool(c.alarm), untakenAt: strings(c.untaken_at), takenAt: strings(c.taken_at),
      takenCount: firstNumber(c.taken_count), delete: bool(c.delete),
    })),
  };
  return plan;
}

export function wantsLookup(p) {
  return p.search.length > 0 || p.period?.from != null || p.period?.to != null;
}

export function isLookupOnly(p) {
  return wantsLookup(p) && !p.create.length && !p.update.length && !p.show.length && !p.showPhotos.length && !p.meds.length && !p.showMeds.length;
}

// ------------------------------------------------------------------ dates

const RELATIVE = /^([+-])\s*(?:(\d{1,6})\s*d)?\s*(?:(\d{1,6})\s*h)?\s*(?:(\d{1,6})\s*m(?:in)?)?\s*(?:(\d{1,7})\s*s)?$/;

/** "+1h30m" → 5 400 000; anything else, null. */
export function relative(text) {
  if (text === null || text === undefined) return null;
  const m = RELATIVE.exec(String(text).trim().toLowerCase());
  if (!m) return null;
  const [, sign, d, h, mi, s] = m;
  if (!d && !h && !mi && !s) return null;
  const seconds = (+d || 0) * 86_400 + (+h || 0) * 3_600 + (+mi || 0) * 60 + (+s || 0);
  return seconds * 1000 * (sign === '-' ? -1 : 1);
}

/** "2026-11-12", "2026-11-12T15:00", "+10m" → [ms, hasTime]; null when it isn't one. */
export function time(text, zone, base = Date.now()) {
  const s = text === null || text === undefined ? '' : String(text).trim();
  if (!s || s.toLowerCase() === 'null') return null;
  const r = relative(s);
  if (r !== null) return [base + r, true];
  let norm = s.replaceAll(' ', 'T');
  if (norm.endsWith('Z')) norm = norm.slice(0, -1);
  const head = norm.slice(0, 19);
  const full = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(head.length === 16 ? `${head}:00` : head);
  if (full) {
    const p = T.parseLocal(full[0].replace('T', ' '));
    if (p?.time) return [T.toMs(p.date.y, p.date.m, p.date.d, p.time.h, p.time.mi, p.time.s, zone), true];
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(norm.slice(0, 10));
  if (dateOnly) {
    const p = T.parseLocal(dateOnly[0]);
    if (p) return [T.atStartOfDay(p.date, zone), false];
  }
  return null;
}

/** The days a period covers, whole days on both ends: [start, end] (an open end goes on); null when it names none. */
export function range(period, zone) {
  const from = time(period?.from, zone);
  const to = time(period?.to, zone);
  if (!from && !to) return null;
  const start = from ? T.startOfDay(from[0], zone) : -Infinity;
  const end = to ? T.startOfDay(to[0], zone, 1) - 1 : Infinity;
  return end < start ? null : [start, end];
}

export function looked(plan) {
  const parts = [];
  const words = plan.search.join(', ');
  if (!isBlank(words)) parts.push(words);
  const p = plan.period;
  if (p && (p.from != null || p.to != null)) {
    if (p.from != null && p.to != null && p.from !== p.to) parts.push(`de ${p.from} a ${p.to}`);
    else if (p.from != null && p.to != null) parts.push(`dia ${p.from}`);
    else if (p.from != null) parts.push(`desde ${p.from}`);
    else parts.push(`até ${p.to}`);
  }
  return parts.join(' · ');
}

/** A reminder needs a time: a bare day reminds at 9:00. */
export function remindTime(text, zone, base = Date.now()) {
  const t = time(text, zone, base);
  if (!t) return null;
  if (t[1]) return t[0];
  return T.atTime(T.dateOf(t[0], zone), { h: 9, mi: 0 }, zone);
}
