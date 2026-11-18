// Writing: on the computer the Novelo is for writing. What she writes (and the photos and files she
// drops with it) goes to the line under it, is organized one by one, and the answer shows with what
// was kept or changed — the phone's Home, for writing.
import { useEffect, useRef, useState } from 'react';
import { newId } from '../core/data.js';
import { newId as blobId } from '../core/crypto.js';
import { FileKind } from '../core/brain.js';
import { Recorder, transcribe, MAX_S } from '../core/voice.js';
import { EntryCard } from './lists.jsx';
import { Icon, IconBtn, Photo, useApp, useData } from './kit.jsx';

const MAX_FILE = 38 * 1024 * 1024;

/** A photo made small (the longest side [side] px) as a JPEG; null when the browser can't read it. */
export async function smaller(blob, side) {
  try {
    const img = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const k = Math.min(1, side / Math.max(img.width, img.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close();
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })).arrayBuffer());
  } catch {
    return null;
  }
}

function lineWords(t, l) {
  return { going: t('line_going'), in_line: t('line_in_line'), later: t('line_later'), phone: t('line_phone'), failed: l.message || t('line_failed') }[l.where];
}

export function WritePage() {
  const app = useApp();
  const data = useData();
  const { t } = app;
  const [text, setText] = useState('');
  const draftIn = useRef(false);
  const [staged, setStaged] = useState([]); // [{key, file, kind, preview}]
  const [drop, setDrop] = useState(false);
  const [mind, setMind] = useState({ line: app.mind.line, answer: null });
  const area = useRef(null);
  const photoInput = useRef(null);
  const fileInput = useRef(null);
  useEffect(() => app.onMind(setMind), []);
  const speakRef = useRef(null);
  speakRef.current = speak;
  useEffect(() => {
    const key = (e) => { if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space') { e.preventDefault(); speakRef.current?.(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => { area.current?.focus(); }, []);
  // What she was writing, kept sealed in the browser (like everything else here) until it goes.
  useEffect(() => {
    let live = true;
    app.sync.loadDraft().then((d) => {
      if (!live) return;
      if (d) setText((x) => x || d);
      draftIn.current = true;
    });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!draftIn.current) return undefined;
    const timer = setTimeout(() => app.sync.saveDraft(text).catch(() => {}), 300);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => () => staged.forEach((s) => s.preview && URL.revokeObjectURL(s.preview)), []);

  // Speaking: the microphone while the button is on, then the words into the box (she reads, then sends).
  const [rec, setRec] = useState(null); // {secs, level}
  const [hearing, setHearing] = useState(null); // {i, n}
  const recorder = useRef(null);
  useEffect(() => () => { recorder.current?.stop(); }, []);
  useEffect(() => {
    if (!rec) return undefined;
    const timer = setInterval(() => {
      const r = recorder.current;
      if (!r) return;
      setRec((x) => (x ? { ...x, secs: r.seconds } : x));
      if (r.seconds >= MAX_S) speak();
    }, 250);
    return () => clearInterval(timer);
  }, [!!rec]);

  async function speak() {
    if (hearing) return;
    if (!recorder.current) {
      const r = new Recorder();
      try {
        await r.start((level) => setRec((x) => (x ? { ...x, level } : x)));
      } catch (e) {
        app.toast(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? t('micDenied') : t('micNone'));
        return;
      }
      recorder.current = r;
      setRec({ secs: 0, level: 0 });
      return;
    }
    const r = recorder.current;
    recorder.current = null;
    setRec(null);
    const samples = await r.stop();
    setHearing({ i: 0, n: 1 });
    try {
      const words = await transcribe(samples, (body) => app.api.ask('hear', body), (i, n) => setHearing({ i, n }));
      if (!words) {
        app.toast(t('micNothing'));
      } else {
        setText((x) => (x.trim() ? `${x.replace(/\s+$/, '')}${/[.!?…]$/.test(x.trim()) ? ' ' : '\n'}${words}` : words));
        requestAnimationFrame(() => {
          const el = area.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
          el.scrollTop = el.scrollHeight;
        });
      }
    } catch (e) {
      app.toast(e?.status === 0 ? t('micOffline') : e?.message ? `${t('micFailed')} ${e.message}` : t('micFailed'));
    } finally {
      setHearing(null);
    }
  }

  function cancelSpeak() {
    recorder.current?.stop();
    recorder.current = null;
    setRec(null);
  }

  function add(files) {
    const next = [];
    for (const f of files) {
      if (f.size > MAX_FILE) continue;
      const image = /^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(f.type);
      next.push({ key: `${f.name}-${f.size}-${f.lastModified}-${Math.random()}`, file: f, kind: image ? 'photo' : 'file', preview: image ? URL.createObjectURL(f) : null });
    }
    setStaged((s) => [...s, ...next].slice(0, 20));
  }

  async function send() {
    const said = text.trim();
    if (!said && !staged.length) return;
    const parts = [];
    for (const s of staged) {
      const bytes = new Uint8Array(await s.file.arrayBuffer());
      const id = newId();
      const at = s.file.lastModified && s.file.lastModified < Date.now() ? s.file.lastModified : Date.now();
      if (s.kind === 'photo') {
        const imageId = blobId();
        await app.sync.addFile(imageId, bytes);
        const media = { image: { id: imageId, size: bytes.length, mime: s.file.type || 'image/jpeg' } };
        const thumb = await smaller(s.file, 480);
        if (thumb) {
          const thumbId = blobId();
          await app.sync.addFile(thumbId, thumb);
          media.thumb = { id: thumbId, size: thumb.length, mime: 'image/jpeg' };
        }
        data.write('captures', { id, createdAt: at, source: 'photo', state: 'done', media });
      } else {
        const fileId = blobId();
        await app.sync.addFile(fileId, bytes);
        data.write('captures', { id, createdAt: Date.now(), source: 'file', state: 'done', fileName: s.file.name.slice(0, 120), fileMime: s.file.type || null, fileSize: s.file.size, media: { file: { id: fileId, size: bytes.length, mime: s.file.type || null } } });
      }
      data.hold('captures', String(id));
      app.localFiles.set(id, s.file);
      parts.push(id);
    }
    app.mind.write(said, parts);
    staged.forEach((s) => s.preview && URL.revokeObjectURL(s.preview));
    setStaged([]);
    setText('');
    requestAnimationFrame(() => { area.current?.focus(); });
  }

  const answer = mind.answer;
  return (
    <div className="write-wrap">
      <div
        className={`write${drop ? ' drop' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrop(true); }}
        onDragLeave={() => setDrop(false)}
        onDrop={(e) => { e.preventDefault(); setDrop(false); add([...e.dataTransfer.files]); }}
      >
        <textarea
          ref={area}
          value={text}
          placeholder={drop ? t('dropHere') : t('invite')}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => { const f = [...(e.clipboardData?.files ?? [])]; if (f.length) { e.preventDefault(); add(f); } }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
            if (e.key === 'Escape' && rec) { e.preventDefault(); cancelSpeak(); }
          }}
          aria-label={t('invite')}
        />
        {staged.length ? (
          <div className="staged">
            {staged.map((s) => (
              <div className="tile" key={s.key} title={s.file.name}>
                {s.preview ? <img src={s.preview} alt="" /> : (FileKind.label(s.file.name, s.file.type) ?? '·')}
                <button type="button" aria-label={t('remove')} onClick={() => setStaged((x) => x.filter((y) => y.key !== s.key))}><Icon name="close" /></button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="write-foot">
          <button type="button" className={`icon-btn mic${rec ? ' on' : ''}`} aria-label={rec ? t('micStop') : t('mic')} title={rec ? t('micStop') : `${t('mic')} · Ctrl+Shift+Space`} aria-pressed={!!rec} onClick={speak} disabled={!!hearing}>
            <Icon name={rec ? 'stop' : 'mic'} />
          </button>
          {rec ? (
            <div className="rec" role="status">
              <i className="rec-dot" />
              <span className="num">{`${Math.floor(rec.secs / 60)}:${String(Math.floor(rec.secs % 60)).padStart(2, '0')}`}</span>
              <span className="rec-level" style={{ '--level': rec.level }}><b /><b /><b /><b /><b /></span>
              <button type="button" className="quiet rec-x" onClick={cancelSpeak} aria-label={t('micCancel')} title={`${t('micCancel')} · Esc`}><Icon name="close" size={14} /></button>
            </div>
          ) : null}
          {hearing ? <div className="rec hearing" role="status"><span className="spin small" aria-hidden="true" />{t('micHearing')}{hearing.n > 1 ? ` ${hearing.i + 1}/${hearing.n}` : ''}</div> : null}
          {rec || hearing ? null : <IconBtn icon="photo" label={t('attachPhoto')} onClick={() => photoInput.current?.click()} />}
          {rec || hearing ? null : <IconBtn icon="file" label={t('attachFile')} onClick={() => fileInput.current?.click()} />}
          <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={(e) => { add([...e.target.files]); e.target.value = ''; }} />
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { add([...e.target.files]); e.target.value = ''; }} />
          <span className="hint">{t('sendHint')}</span>
          <IconBtn icon="send" label={t('send')} kind="solid" onClick={send} disabled={!text.trim() && !staged.length} />
        </div>
      </div>

      {mind.line.length ? (
        <div className="line group">
          {mind.line.map((l) => (
            <div className="card" key={l.id}>
              <div className="grow">
                <div className={`status${l.where === 'going' ? ' going' : ''}`}>{lineWords(t, l)}</div>
                {l.text ? <div className="said">“{l.text}”</div> : null}
              </div>
              {l.where === 'going' ? <span className="spin" aria-label={t('line_going')}><span /></span> : null}
              {l.where === 'failed' || l.where === 'later' ? <IconBtn icon="retry" label={t('retry')} kind="primary" onClick={() => app.mind.retry(l.id)} /> : null}
              {l.where !== 'going' && l.where !== 'phone' ? <IconBtn icon="trash" label={t('discard')} onClick={() => app.mind.discard(l.id)} /> : null}
            </div>
          ))}
        </div>
      ) : null}

      {answer ? (
        <div className="answer" key={answer.captureId}>
          {answer.reply ? <p className="reply">{answer.reply}</p> : null}
          <div className="group">
            {answer.outcomes.filter((o) => o.action !== 'deleted' && data.entry(o.entryId)).map((o) => <EntryCard key={`o${o.entryId}`} e={data.entry(o.entryId)} label={t(`outcome_${o.action}`)} />)}
            {answer.shown.filter((s) => data.entry(s) && !answer.outcomes.some((o) => o.entryId === s)).map((s) => <EntryCard key={`s${s}`} e={data.entry(s)} />)}
          </div>
          {answer.photos.length ? <div className="photos" style={{ marginTop: 10 }}>{answer.photos.map((p) => data.capture(p) ? <Photo key={p} capture={data.capture(p)} onClick={() => app.view(p, answer.photos)} /> : null)}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
