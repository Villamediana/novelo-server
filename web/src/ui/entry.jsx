// An item, open beside the list: everything of it, set by hand — title and text, status and category,
// steps, due day and reminder, hidden or not, its photos, files and sound; deleted with "Desfazer".
import { useEffect, useRef, useState } from 'react';
import * as R from '../core/repeat.js';
import { Steps, kindOf, statusOf, Categories } from '../core/words.js';
import { photosOf, filesOf, soundsOf } from '../core/attached.js';
import { FileKind } from '../core/brain.js';
import * as Summary from '../core/summary.js';
import { safeType } from '../core/sync.js';
import { Check, Icon, IconBtn, Photo, useApp, useData, when, toInput, fromInput, grow, useBlobUrl, useLeave } from './kit.jsx';

function FileRow({ c }) {
  const app = useApp();
  const media = c.media?.file;
  const [url, setUrl] = useState(null);
  async function open() {
    const u = url ?? await app.sync.url(media.id, safeType(c.fileMime));
    setUrl(u);
    const a = document.createElement('a');
    a.href = u;
    a.download = c.fileName ?? 'arquivo';
    a.rel = 'noopener';
    a.click();
  }
  return (
    <div className="card solo file-row" style={{ marginBottom: 6 }}>
      <div className="file-kind">{FileKind.label(c.fileName ?? '', c.fileMime) ?? '·'}</div>
      <div className="grow"><div className="title">{c.fileName}</div><div className="meta">{c.description ?? FileKind.size(c.fileSize ?? 0)}</div></div>
      <IconBtn icon="download" label={app.t('download')} onClick={open} />
    </div>
  );
}

/** "Em tópicos": a long note's points, above its text (app 1.80) — what it is about a little stronger. */
function Points({ summary, t }) {
  const points = Summary.read(summary);
  if (!points.length) return null;
  return (
    <section className="points" aria-label={t('inTopics')}>
      <div className="points-head">{t('inTopics')}</div>
      <ul>
        {points.map((p, i) => {
          const l = Summary.label(p);
          return <li key={`${i}-${p}`}>{l ? <><strong>{l[0]}:</strong> {l[1]}</> : p}</li>;
        })}
      </ul>
    </section>
  );
}

function Sound({ c }) {
  const url = useBlobUrl(c.media?.audio ? { ...c.media.audio, mime: 'audio/wav' } : null);
  return url ? <audio controls src={url} style={{ width: '100%', marginTop: 8 }} /> : null;
}

export function EntryPanel({ id, fresh, onClose }) {
  const app = useApp();
  const data = useData();
  const { t, zone, lang, library } = app;
  const e = data.entry(id);
  const titleRef = useRef(null);
  const bodyRef = useRef(null);
  const [newStep, setNewStep] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [newCat, setNewCat] = useState(false);
  const [leaving, leave] = useLeave(onClose);
  useEffect(() => { grow(titleRef.current); grow(bodyRef.current); });
  useEffect(() => {
    const key = (ev) => { if (ev.key === 'Escape') close(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  if (!e) return null;
  const kind = kindOf(e);
  const steps = Steps.read(e.steps);
  const captures = data.captures();
  const photos = photosOf(id, captures);
  const files = filesOf(id, captures);
  const sounds = soundsOf(id, captures);
  const rule = R.read(e.repeat);
  const save = () => library.edit(id, titleRef.current?.value ?? e.title, bodyRef.current?.value ?? e.body);
  function close() {
    save();
    library.dropIfEmpty(id);
    leave();
  }
  const created = new Intl.DateTimeFormat(lang === 'en' ? 'en' : lang === 'es' ? 'es' : 'pt-BR', { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: zone }).format(new Date(e.createdAt));
  const categories = Categories.inUse(data.entries());
  return (
    <>
      <div className={`scrim${leaving ? ' leaving' : ''}`} onClick={close} />
      <aside className={`panel${leaving ? ' leaving' : ''}`} aria-label={e.title}>
        <div className="panel-top">
          <IconBtn icon="close" label={t('close')} onClick={close} />
          <div className="grow" />
          <IconBtn icon="trash" label={t('delete')} onClick={() => { library.delete(id); app.toast(t('deleted'), () => { const back = library.undoDelete(id); if (back) app.open(back); }); leave(); }} />
        </div>
        <div className="kind-line">{t(`kind_${kind}`)} · {created}</div>
        <textarea ref={titleRef} className="title-edit" rows={1} autoFocus={fresh} defaultValue={e.title} placeholder={t('title')} onInput={(ev) => grow(ev.target)} onBlur={save} />
        <div className="pills">
          {(['task', 'note', 'diary']).filter((k) => k !== kind).length && kind !== 'diary' ? (
            <select className="pill" value={kind} onChange={(ev) => library.setKind(id, ev.target.value)} aria-label="tipo">
              {['task', 'note'].map((k) => <option key={k} value={k}>{t(`kind_${k}`)}</option>)}
            </select>
          ) : null}
          {kind === 'task' ? (
            <>
              {['todo', 'doing', 'waiting', 'done'].map((s) => <button key={s} type="button" className={`pill${statusOf(e) === s ? ' on' : ''}`} onClick={() => library.setStatus(id, s)}>{t(`st_${s}`)}</button>)}
              {newCat ? (
                <input className="pill" autoFocus placeholder={t('newCategory')} onBlur={(ev) => { if (ev.target.value.trim()) library.setCategory(id, ev.target.value); setNewCat(false); }} onKeyDown={(ev) => { if (ev.key === 'Enter') ev.target.blur(); }} />
              ) : (
                <select className="pill" value={e.category ?? ''} onChange={(ev) => (ev.target.value === '\u0000' ? setNewCat(true) : library.setCategory(id, ev.target.value || null))} aria-label={t('category')}>
                  <option value="">{t('chooseCategory')}</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  <option value={'\u0000'}>{t('newCategory')}</option>
                </select>
              )}
            </>
          ) : null}
        </div>
        {kind === 'note' && !(e.sensitive && !showHidden) ? <Points summary={e.summary} t={t} /> : null}
        {e.sensitive && !showHidden ? (
          <div className="hidden-body"><Icon name="lock" /> <button type="button" className="pill" onClick={() => setShowHidden(true)}>{t('show')}</button></div>
        ) : (
          <textarea ref={bodyRef} className={`body-edit${kind === 'diary' ? ' diary' : ''}`} defaultValue={e.body} placeholder={t('body')} onInput={(ev) => grow(ev.target)} onBlur={save} />
        )}
        {photos.length ? <div className="photos" style={{ marginTop: 14 }}>{photos.map((c) => <Photo key={c.id} capture={c} onClick={() => app.view(c.id, photos.map((p) => p.id))} />)}</div> : null}
        {sounds.map((c) => <Sound key={c.id} c={c} />)}
        {files.length ? <div style={{ marginTop: 14 }}>{files.map((c) => <FileRow key={c.id} c={c} />)}</div> : null}
        {kind === 'task' ? (
          <>
            <div className="steps-head">{t('steps')}{steps.length ? ` · ${steps.filter((s) => s.done).length}/${steps.length}` : ''}</div>
            {steps.length ? <div className="bar"><i style={{ width: `${(100 * steps.filter((s) => s.done).length) / steps.length}%` }} /></div> : null}
            {steps.map((s, i) => (
              <div className="step" key={`${i}-${s.text}`}>
                <Check on={s.done} label={s.text} onClick={() => library.toggleStep(id, i)} />
                <input className={s.done ? 'done' : ''} defaultValue={s.text} onBlur={(ev) => library.editStep(id, i, ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') ev.target.blur(); }} />
                <button type="button" className="quiet x" aria-label={t('delete')} onClick={() => library.removeStep(id, i)}><Icon name="close" size={16} /></button>
              </div>
            ))}
            <div className="step">
              <span style={{ width: 28, display: 'grid', placeItems: 'center', color: 'var(--faint)' }}><Icon name="plus" size={18} /></span>
              <input placeholder={t('newStep')} value={newStep} onChange={(ev) => setNewStep(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter' && newStep.trim()) { library.addStep(id, newStep); setNewStep(''); } }} />
            </div>
          </>
        ) : null}
        <div className="fields">
          {kind === 'task' ? (
            <label className="field"><Icon name="calendar" size={18} /> {t('due')}
              <input type="date" value={toInput(e.dueAt, zone).slice(0, 10)} onChange={(ev) => {
                if (!ev.target.value) return library.setDue(id, null, false);
                const hour = e.dueHasTime && e.dueAt != null ? toInput(e.dueAt, zone).slice(10) : '';
                library.setDue(id, fromInput(ev.target.value + hour, zone), !!hour);
              }} />
              {e.dueAt != null ? <input type="time" aria-label={t('due')} value={e.dueHasTime ? toInput(e.dueAt, zone).slice(11) : ''} onChange={(ev) => library.setDue(id, fromInput(`${toInput(e.dueAt, zone).slice(0, 10)}${ev.target.value ? `T${ev.target.value}` : ''}`, zone), !!ev.target.value)} /> : null}
            </label>
          ) : null}
          <label className="field"><Icon name="bell" size={18} /> {t('reminder')}
            <input type="datetime-local" value={toInput(e.remindAt, zone)} onChange={(ev) => library.setReminder(id, ev.target.value ? fromInput(ev.target.value, zone) : null, rule ? { every: rule.every, days: rule.days, times: rule.times } : null)} />
          </label>
          {e.remindAt != null ? (
            <label className="field">{t('repeat')}
              <select value={rule?.every ?? ''} onChange={(ev) => library.setReminder(id, e.remindAt, ev.target.value ? { every: ev.target.value } : null)}>
                <option value="">{t('once')}</option>
                <option value="day">{t('daily')}</option>
                <option value="week">{t('weekly')}</option>
                <option value="month">{t('monthly')}</option>
              </select>
            </label>
          ) : null}
        </div>
        {e.remindAt != null ? <label className="toggle"><input type="checkbox" checked={!!e.alarm} onChange={(ev) => library.setAlarm(id, ev.target.checked)} /> {t('alarm')}</label> : null}
        <label className="toggle"><input type="checkbox" checked={!!e.sensitive} onChange={(ev) => library.setSensitive(id, ev.target.checked)} /> {t('sensitive')}</label>
        {kind === 'task' && e.checkInAt != null && statusOf(e) !== 'done' ? <p className="note">{t('willAsk', { d: when(e.checkInAt, true, zone, lang, t) })}</p> : null}
      </aside>
    </>
  );
}
