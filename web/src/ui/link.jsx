// Linking the computer (its QR code, read by the phone), and the page on a phone (install the app).
import { useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import * as lock from '../core/crypto.js';
import { ApiError } from '../core/api.js';
import { Yarn, Icon } from './kit.jsx';

/** "Chrome no Windows": what the phone shows in its list of computers. */
export function browserName(t) {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} ${t('linkOn')} ${os}` : b;
}

function Qr({ text }) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return (
    <svg viewBox={`-2 -2 ${n + 4} ${n + 4}`} shapeRendering="crispEdges" role="img" aria-label="QR">
      <path d={d} fill="#3A2A1F" />
    </svg>
  );
}

export function LinkPage({ api, t, onLinked }) {
  const [code, setCode] = useState(null); // {url, id, poll, privateKey}
  const [state, setState] = useState('waiting'); // waiting | expired | linking | failed
  // Kept linked (the computer is hers) or only while this tab is open (someone else's).
  const [keep, setKeep] = useState(true);
  const keepRef = useRef(true);
  keepRef.current = keep;
  const round = useRef(0);

  async function start() {
    const mine = ++round.current;
    setState('waiting');
    setCode(null);
    try {
      const keys = await lock.linkKeys();
      const proof = await lock.proofKeys();
      const s = await api.startLink(keys.pub, browserName(t), proof.pub);
      if (mine !== round.current) return;
      const c = { url: lock.linkUrl(location.origin, s.id, keys.pub, keys.secret), id: s.id, poll: s.poll, privateKey: keys.privateKey, secret: keys.secret };
      setCode(c);
      // Waiting for the phone: one long wait after another, until it reads the code (or it expires).
      for (;;) {
        if (mine !== round.current) return;
        let res;
        try {
          res = await api.pollLink(c.id, c.poll, 25);
        } catch (e) {
          if (e instanceof ApiError && (e.status === 410 || e.status === 404)) {
            setState('expired');
            return;
          }
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        if (res.status !== 'linked') continue;
        setState('linking');
        const opened = await lock.unwrapLink(c.privateKey, c.id, c.secret, res.wrapped);
        // What the phone said (only it could say it) and what the server says have to be the same space.
        if (opened.space !== res.space) throw new Error('espaço diferente');
        await onLinked({ token: res.token, proof: proof.privateKey, space: opened.space, key: opened.key, owner: opened.owner, shared: !keepRef.current });
        return;
      }
    } catch {
      if (mine === round.current) setState('failed');
    }
  }

  useEffect(() => {
    start();
    return () => { round.current++; };
  }, []);

  return (
    <div className="center">
      <div className="link">
        <div>
          <Yarn size={58} />
          <h1>{t('linkTitle')}</h1>
          <p className="lead">{t('linkLead')}</p>
          <ol>
            <li>{t('link1')}</li>
            <li>{t('link2')}</li>
            <li>{t('link3')}</li>
          </ol>
          <p className="safe">{t('linkSafe')}</p>
          <label className="keep">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            <span><b>{t('keepLinked')}</b><br />{t('keepLinkedHint')}</span>
          </label>
        </div>
        <div>
          <div className="qr" data-code={code?.url}>
            {code ? <Qr text={code.url} /> : null}
            {state !== 'waiting' || !code ? (
              <div className="over">
                {state === 'expired' || state === 'failed' ? (
                  <>
                    <p>{state === 'expired' ? t('linkExpired') : t('linkFailed')}</p>
                    <button type="button" className="pill on" onClick={start}><Icon name="retry" size={16} /> {t('linkNew')}</button>
                  </>
                ) : (
                  <p>{state === 'linking' ? t('linking') : '…'}</p>
                )}
              </div>
            ) : null}
          </div>
          <p className="qr-note">{state === 'waiting' && code ? t('linkWaiting') : ''}</p>
        </div>
      </div>
    </div>
  );
}

/** On a phone: the Novelo there is the app. */
export function PhonePage({ t }) {
  return (
    <div className="center">
      <div className="phone">
        <Yarn size={72} />
        <h1>{t('mobileTitle')}</h1>
        <p className="lead">{t('mobileLead')}</p>
        <a className="big-btn" href="https://github.com/Villamediana/Novelo/releases/latest" rel="noopener noreferrer">{t('mobileGet')}</a>
        <p className="faint">{t('mobileLink')}</p>
      </div>
    </div>
  );
}

/** A phone or a tablet (the page is for the computer). */
export function isPhone() {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini/i.test(ua)) return true;
  // An iPad says it is a Mac: a touch screen with no mouse.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}
