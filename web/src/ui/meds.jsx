// Remédios: each medicine with its times and today's doses (ticked here, they are ticked on the phone),
// and its page to set it by hand.
import { useState } from 'react';
import * as T from '../core/time.js';
import * as D from '../core/doses.js';
import { Check, Icon, IconBtn, useApp, useData, hm, toInput } from './kit.jsx';

export function MedCard({ m }) {
  const app = useApp();
  const { t, zone } = app;
  const now = Date.now();
  const times = D.times(m);
  const taken = new Set(app.data.taken().filter((x) => x.medId === m.id).map((x) => x.at));
  const today = D.ended(m, now) ? [] : D.day([m], T.dateOf(now, zone), zone);
  const left = D.daysLeft(m, now, zone);
  const line = [m.dose, m.amount, m.person ? t('med_person', { p: m.person }) : null, times.length ? times.map(T.hhmm).join(', ') : t('med_when'), left != null ? t('med_daysLeft', { n: left }) : null].filter(Boolean);
  return (
    <div className="card click" role="button" tabIndex={0} style={{ alignItems: 'flex-start' }} onClick={() => app.openMed(m.id)}>
      <div className="grow">
        <div className={`title${D.ended(m, now) ? ' struck' : ''}`}>{m.name || t('newMed')}</div>
        <div className="meta">{line.join(' · ')}</div>
        {today.length ? (
          <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
            {today.map((s) => (
              <span key={s.at} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                <Check on={taken.has(s.at)} label={hm(s.at, zone)} onClick={() => app.library.toggleTaken(m.id, s.at)} />
                <span className={taken.has(s.at) ? 'muted' : ''}>{hm(s.at, zone)}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function MedsTab() {
  const app = useApp();
  const data = useData();
  const { t } = app;
  const now = Date.now();
  const meds = data.meds();
  const live = meds.filter((m) => !D.ended(m, now));
  const ended = meds.filter((m) => D.ended(m, now));
  const people = [...new Set(live.map((m) => m.person ?? ''))];
  return (
    <>
      <div className="top" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
        <button type="button" className="pill" onClick={() => app.openMed(app.library.newMed(), true)}><Icon name="plus" size={16} /> {t('newMed')}</button>
      </div>
      {!meds.length ? <div className="empty">{t('emptyMeds')}</div> : null}
      {people.map((p) => (
        <div key={p}>
          <div className="section">{p || t('meds')}</div>
          <div className="group">{live.filter((m) => (m.person ?? '') === p).map((m) => <MedCard key={m.id} m={m} />)}</div>
        </div>
      ))}
      {ended.length ? (<><div className="section">{t('done')}</div><div className="group">{ended.map((m) => <MedCard key={m.id} m={m} />)}</div></>) : null}
    </>
  );
}

/** A medicine set by hand. */
export function MedPanel({ id, fresh, onClose }) {
  const app = useApp();
  const data = useData();
  const { t, zone } = app;
  const m = data.med(id);
  const [times, setTimes] = useState(() => (m ? D.times(m).map(T.hhmm).join(', ') : ''));
  if (!m) return null;
  const save = (patch) => app.library.saveMed({ ...m, ...patch });
  const close = () => {
    app.library.dropMedIfEmpty(id);
    onClose();
  };
  return (
    <>
      <div className="scrim" onClick={close} />
      <aside className="panel" aria-label={m.name}>
        <div className="panel-top">
          <IconBtn icon="close" label={t('close')} onClick={close} />
          <div className="grow" />
          <IconBtn icon="trash" label={t('delete')} onClick={() => { app.library.deleteMed(id); onClose(); }} />
        </div>
        <textarea className="title-edit" rows={1} autoFocus={fresh} defaultValue={m.name} placeholder={t('medName')} onBlur={(e) => save({ name: e.target.value.trim() })} />
        <div className="fields" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <label className="field">{t('medDose')} <input defaultValue={m.dose ?? ''} onBlur={(e) => save({ dose: e.target.value.trim() || null, amount: D.amount(m.strength, e.target.value.trim() || null) })} /></label>
          <label className="field">{t('medStrength')} <input defaultValue={m.strength ?? ''} onBlur={(e) => save({ strength: e.target.value.trim() || null, amount: D.amount(e.target.value.trim() || null, m.dose) })} /></label>
          <label className="field">{t('medTimes')} <input value={times} onChange={(e) => setTimes(e.target.value)} onBlur={() => save({ times: D.writeTimes(times.split(/[,\s]+/).map(D.time).filter(Boolean)) })} /></label>
          <label className="field">{t('medEnd')} <input type="date" defaultValue={m.endsAt != null ? toInput(m.endsAt, zone).slice(0, 10) : ''} onChange={(e) => save({ endsAt: e.target.value ? D.endOf(T.parseLocal(e.target.value).date, zone) : null })} /></label>
          <label className="field">{t('medNotes')} <input defaultValue={m.notes} onBlur={(e) => save({ notes: e.target.value.trim() })} /></label>
        </div>
        <label className="toggle"><input type="checkbox" checked={!!m.alarm} onChange={(e) => save({ alarm: e.target.checked ? 1 : 0 })} /> {t('alarm')}</label>
      </aside>
    </>
  );
}
