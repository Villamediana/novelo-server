// The tabs: Hoje (by the hour, with the medicines), Tarefas (by category), Notas, Diário (by day),
// Galeria, and the search — the app's own groups (core/sections.js), the app's cards.
import { useMemo, useState } from 'react';
import * as T from '../core/time.js';
import * as R from '../core/repeat.js';
import * as D from '../core/doses.js';
import { sectionsFor } from '../core/sections.js';
import { Steps, kindOf, statusOf, Words, Categories } from '../core/words.js';
import { Recall, PhotoRecall, around } from '../core/recall.js';
import { photosOf, keptInside, hasImage } from '../core/attached.js';
import { photoOf } from '../core/mind.js';
import { Check, Icon, Photo, useApp, useData, when, hm } from './kit.jsx';
import { MedCard } from './meds.jsx';

export function EntryCard({ e, label, terms, solo = false }) {
  const app = useApp();
  const { t, zone, lang } = app;
  const kind = kindOf(e);
  const done = statusOf(e) === 'done';
  const steps = Steps.read(e.steps);
  const meta = [];
  if (e.dueAt != null) meta.push(when(e.dueAt, !!e.dueHasTime, zone, lang, t));
  else if (e.remindAt != null && !done) meta.push(when(e.remindAt, true, zone, lang, t));
  const body = !e.sensitive && e.body?.trim() ? (terms?.length ? around(e.body, terms) : e.body) : null;
  return (
    <div className={`card click${solo ? ' solo' : ''}`} role="button" tabIndex={0} onClick={() => app.open(e.id)} onKeyDown={(ev) => { if (ev.key === 'Enter') app.open(e.id); }}>
      {kind === 'task' ? <Check on={done} label={t('st_done')} onClick={() => (e._time != null ? app.library.toggleTime(e.id, e._time) : app.library.toggleDone(e.id))} /> : null}
      <div className="grow">
        {label ? <div className="label">{label}</div> : null}
        <div className={`title${done ? ' struck' : ''}`}>{e.title || <span className="faint">{t(`kind_${kind}`)}</span>} {e.sensitive ? <span className="faint"><Icon name="lock" size={14} /></span> : null}</div>
        {kind !== 'task' && body ? <div className="snippet">{body}</div> : null}
        {meta.length || steps.length || (kind === 'task' && e.category) ? (
          <div className="meta">
            {meta.map((m) => <span key={m}>{m}</span>)}
            {steps.length ? (
              <span className="dots">{steps.slice(0, 8).map((s, i) => <i key={i} className={s.done ? 'on' : ''} />)} <span>{steps.filter((s) => s.done).length}/{steps.length}</span></span>
            ) : null}
            {R.read(e.repeat) ? <Icon name="retry" size={13} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Pra hoje: one card per time, its tasks and its medicines; the one due now or next in the accent. */
function TimedCard({ at, items, slot, solo, next }) {
  const app = useApp();
  const { zone, t } = app;
  const past = at < Date.now() - 15 * 60_000;
  return (
    <div className={`card${solo ? ' solo' : ''}`} style={{ alignItems: 'flex-start' }}>
      <div className={`time${past && !next ? ' past' : ''}`}>{hm(at, zone)}{next ? <small>{t(next)}</small> : null}</div>
      <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((e) => (
          <div key={`${e.id}-${e._time ?? ''}`} style={{ display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }} onClick={() => app.open(e.id)}>
            <Check on={statusOf(e) === 'done'} label={t('st_done')} onClick={() => (e._time != null ? app.library.toggleTime(e.id, e._time) : app.library.toggleDone(e.id))} />
            <div className={`title${statusOf(e) === 'done' ? ' struck' : ''}`} style={{ fontWeight: 600 }}>{e.title}</div>
          </div>
        ))}
        {slot?.meds.map((m) => {
          const taken = app.data.takenBetween(at, at).some((x) => x.medId === m.id);
          return (
            <div key={`m${m.id}`} style={{ display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }} onClick={() => app.openMed(m.id)}>
              <Check on={taken} label={t('med_taken')} onClick={() => app.library.toggleTaken(m.id, at)} />
              <div className="grow"><div className={`title${taken ? ' struck' : ''}`} style={{ fontWeight: 600 }}>{m.name}</div><div className="meta">{[m.dose, m.person ? t('med_person', { p: m.person }) : null].filter(Boolean).join(' · ')}</div></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Group({ items, terms }) {
  return <div className="group">{items.map((e) => <EntryCard key={`${e.id}-${e._time ?? ''}`} e={e} terms={terms} />)}</div>;
}

export function TodayTab() {
  const app = useApp();
  const data = useData();
  const { t, zone } = app;
  const now = Date.now();
  const all = data.entries();
  const sections = sectionsFor('today', all, zone, now);
  const today = T.dateOf(now, zone);
  const meds = data.meds().filter((m) => !D.ended(m, now));
  const slots = D.day(meds, today, zone);
  const [showDone, setShowDone] = useState(false);
  // Pra hoje: the tasks with a time and the medicines' times, together by the hour.
  const timed = sections.find((s) => s[0] === 'for_today')[1];
  const byTime = new Map();
  for (const e of timed) {
    const at = e._time ?? (e.remindAt != null && T.sameDate(T.dateOf(e.remindAt, zone), today) ? e.remindAt : e.dueAt);
    if (!byTime.has(at)) byTime.set(at, { items: [], slot: null });
    byTime.get(at).items.push(e);
  }
  for (const s of slots) {
    if (!byTime.has(s.at)) byTime.set(s.at, { items: [], slot: null });
    byTime.get(s.at).slot = s;
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);
  const nextAt = times.find((at) => at >= now - 15 * 60_000);
  const rest = sections.filter((s) => s[0] !== 'for_today' && s[1].length);
  if (!times.length && !rest.length) return <div className="empty">{t('emptyToday')}</div>;
  return (
    <>
      {sections.filter((s) => s[0] === 'late' && s[1].length).map(([k, items]) => (<div key={k}><div className="section">{t(k)}</div><Group items={items} /></div>))}
      {times.length ? (
        <>
          <div className="section">{t('for_today')}</div>
          <div className="group">
            {times.map((at) => <TimedCard key={at} at={at} items={byTime.get(at).items} slot={byTime.get(at).slot} solo={false} next={at === nextAt ? (at <= now ? 'now' : 'next') : null} />)}
          </div>
        </>
      ) : null}
      {rest.filter((s) => s[0] !== 'late' && s[0] !== 'done_today').map(([k, items]) => (<div key={k}><div className="section">{t(k)}</div><Group items={items} /></div>))}
      {rest.filter((s) => s[0] === 'done_today').map(([k, items]) => (
        <div key={k}>
          <button type="button" className="section quiet" style={{ display: 'block' }} onClick={() => setShowDone(!showDone)}>{t(k)} · {items.length}</button>
          {showDone ? <Group items={items} /> : null}
        </div>
      ))}
    </>
  );
}

export function TasksTab() {
  const app = useApp();
  const data = useData();
  const { t, zone } = app;
  const [cat, setCat] = useState(undefined);
  const [showDone, setShowDone] = useState(false);
  const all = data.entries();
  const sections = sectionsFor('tasks', all, zone);
  const categories = Categories.inUse(all.filter((e) => kindOf(e) === 'task' && statusOf(e) !== 'done'));
  const open = sections.filter((s) => s[0] !== 'done' && (cat === undefined || s[0].category === cat));
  const done = sections.find((s) => s[0] === 'done')[1].filter((e) => cat === undefined || e.category === cat);
  return (
    <>
      <div className="top" style={{ marginBottom: 0 }}>
        <div className="pills">
          <button type="button" className={`pill${cat === undefined ? ' on' : ''}`} onClick={() => setCat(undefined)}>{t('all')}</button>
          {categories.map((c) => <button key={c} type="button" className={`pill${cat === c ? ' on' : ''}`} onClick={() => setCat(c)}><i className="dot" style={{ background: hue(c) }} /> {c}</button>)}
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" className="pill" onClick={() => app.open(app.library.create('task'), true)}><Icon name="plus" size={16} /> {t('newTask')}</button>
      </div>
      {!open.length && !done.length ? <div className="empty">{t('emptyTasks')}</div> : null}
      {open.map(([label, items]) => (
        <div key={label.category ?? '-'}>
          <div className="section">{label.category ?? t('noCategory')}</div>
          <Group items={items} />
        </div>
      ))}
      {done.length ? (
        <div>
          <button type="button" className="section quiet" style={{ display: 'block' }} onClick={() => setShowDone(!showDone)}>{t('done')} · {done.length}</button>
          {showDone ? <Group items={done.slice(0, 200)} /> : null}
        </div>
      ) : null}
    </>
  );
}

/** A category's own color (the same name, the same color). */
export function hue(name) {
  let h = 0;
  for (const c of Words.fold(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 32% 58%)`;
}

export function NotesTab() {
  const app = useApp();
  const data = useData();
  const { t, zone } = app;
  const [[, items]] = sectionsFor('notes', data.entries(), zone);
  return (
    <>
      <div className="top" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
        <button type="button" className="pill" onClick={() => app.open(app.library.create('note'), true)}><Icon name="plus" size={16} /> {t('newNote')}</button>
      </div>
      {items.length ? <Group items={items} /> : <div className="empty">{t('emptyNotes')}</div>}
    </>
  );
}

function DiaryCard({ e, photos }) {
  const app = useApp();
  const { zone, lang } = app;
  const p = T.parts(e.createdAt, zone);
  const month = new Intl.DateTimeFormat(lang === 'en' ? 'en' : lang === 'es' ? 'es' : 'pt-BR', { month: 'short', timeZone: zone }).format(new Date(e.createdAt)).replace('.', '');
  return (
    <div className="card click solo" role="button" tabIndex={0} style={{ alignItems: 'flex-start', marginBottom: 10 }} onClick={() => app.open(e.id)}>
      <div className="diary-day"><b>{p.d}</b><span>{month}</span></div>
      <div className="grow">
        <div className="title serif" style={{ fontFamily: 'var(--serif)', fontWeight: 400, fontSize: 19 }}>{e.title}</div>
        {!e.sensitive && e.body?.trim() ? <div className="snippet" style={{ WebkitLineClamp: 4 }}>{e.body}</div> : null}
        {photos.length ? <div className="strip">{photos.slice(0, 4).map((c) => <Photo key={c.id} capture={c} className="photo" onClick={(ev) => { ev.stopPropagation(); app.view(c.id, photos.map((x) => x.id)); }} />)}</div> : null}
      </div>
    </div>
  );
}

export function DiaryTab() {
  const app = useApp();
  const data = useData();
  const { t, zone } = app;
  const all = data.entries();
  const groups = sectionsFor('diary', all, zone);
  const captures = data.captures();
  const inside = keptInside(captures, all);
  const photosOfDay = (e) => {
    const [from] = [T.startOfDay(e.createdAt, zone)];
    const to = T.startOfDay(e.createdAt, zone, 1);
    // The day's photos (not inside a note), and the ones that are the diary's own.
    return captures.filter((c) => hasImage(c) && !inside.has(c.id) && c.createdAt >= from && c.createdAt < to).sort((a, b) => a.createdAt - b.createdAt);
  };
  if (!groups.length) return <div className="empty">{t('emptyDiary')}</div>;
  return (
    <>
      <div className="top" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
        <button type="button" className="pill" onClick={() => app.open(app.library.create('diary'), true)}><Icon name="plus" size={16} /> {t('newDiary')}</button>
      </div>
      {groups.map(([label, items], i) => (
        <div key={i}>
          {label ? <div className="section">{T.sameDate(label.day, T.dateOf(Date.now(), zone)) ? t('dayToday') : t('dayYesterday')}</div> : <div style={{ height: 10 }} />}
          {items.map((e) => <DiaryCard key={e.id} e={e} photos={photosOfDay(e)} />)}
        </div>
      ))}
    </>
  );
}

export function GalleryTab() {
  const app = useApp();
  const data = useData();
  const { t } = app;
  const captures = data.captures();
  const inside = keptInside(captures, data.entries());
  const photos = captures.filter((c) => hasImage(c) && !inside.has(c.id)).sort((a, b) => b.createdAt - a.createdAt);
  if (!photos.length) return <div className="empty">{t('emptyGallery')}</div>;
  const ids = photos.map((p) => p.id);
  return <div className="photos">{photos.map((c) => <Photo key={c.id} capture={c} onClick={() => app.view(c.id, ids)} />)}</div>;
}

export function SearchTab({ query }) {
  const app = useApp();
  const data = useData();
  const { t } = app;
  const result = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    const all = data.entries();
    const recall = new Recall(all, data.topics(), data.ties(), data.links());
    const hits = recall.search(q, 40);
    const captures = data.captures();
    const inside = keptInside(captures, all);
    const photos = new PhotoRecall(captures.filter((c) => !inside.has(c.id)).map(photoOf).filter(Boolean)).search(q, 12);
    const meds = data.meds().filter((m) => Words.of(`${m.name} ${m.person ?? ''} ${m.notes}`).some((w) => recall.terms(q).some((x) => w.startsWith(x))));
    return { hits, photos, meds, terms: recall.terms(q) };
  }, [query, data.version]);
  if (!result) return <div className="empty">{t('searchHint')}</div>;
  if (!result.hits.length && !result.photos.length && !result.meds.length) return <div className="empty">{t('emptySearch')}</div>;
  return (
    <>
      {result.photos.length ? (<><div className="section">{t('photos')}</div><div className="photos">{result.photos.map((p) => <Photo key={p.id} capture={data.capture(p.id)} onClick={() => app.view(p.id, result.photos.map((x) => x.id))} />)}</div></>) : null}
      {result.meds.length ? (<><div className="section">{t('meds')}</div><div className="group">{result.meds.map((m) => <MedCard key={m.id} m={m} />)}</div></>) : null}
      {result.hits.length ? (<><div className="section" /><Group items={result.hits.map((h) => h.entry)} terms={result.terms} /></>) : null}
    </>
  );
}
