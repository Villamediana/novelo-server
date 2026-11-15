// Who is asking. There is no login: each installation makes a key inside the phone's secure
// hardware, registers its public half once (with Android's proof of where the key lives and which
// app made it) and signs every request with it. A request without a valid signature costs nothing.
import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { verifyAttestation } from './attest.js';
import { event } from './db.js';

const CHALLENGE_TTL = 5 * 60_000;
/** A request's clock may be this far from ours. */
export const TIME_WINDOW = 5 * 60_000;
const SEEN_EVERY = 3600_000;
const CACHE_MAX = 200_000;

const b64 = (s) => Buffer.from(String(s ?? ''), 'base64');

export class Devices {
  constructor({ db, settings, secret, roots = [], revocations = null, now = Date.now }) {
    this.db = db;
    this.settings = settings;
    this.secret = secret;
    this.roots = roots;
    this.revocations = revocations;
    this.now = now;
    this.cache = new Map();
    this.registered = new Map(); // address (hashed) + day → how many today
    this.registeredDay = { day: '', n: 0 };
    this.q = {
      get: db.prepare('SELECT * FROM devices WHERE id = ?'),
      insert: db.prepare(`INSERT INTO devices(id,public_key,created,last_seen,app_version,package,attested,attest_level,attest_note,boot)
        VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, app_version=excluded.app_version, package=excluded.package,
          attested=excluded.attested, attest_level=excluded.attest_level, attest_note=excluded.attest_note, boot=excluded.boot`),
      seen: db.prepare('UPDATE devices SET last_seen = ?, app_version = ? WHERE id = ?'),
      status: db.prepare('UPDATE devices SET status = ?, note = ? WHERE id = ?'),
    };
  }

  mac(data) {
    return crypto.createHmac('sha256', this.secret).update(data).digest();
  }

  /** A challenge only this server could have made, good for a few minutes. Nothing is stored. */
  challenge() {
    const head = Buffer.alloc(24);
    head.writeBigUInt64BE(BigInt(this.now()), 0);
    crypto.randomFillSync(head, 8);
    const full = Buffer.concat([head, this.mac(head).subarray(0, 16)]);
    return { challenge: full.toString('base64url'), expires_in: CHALLENGE_TTL / 1000 };
  }

  checkChallenge(text) {
    const full = Buffer.from(String(text ?? ''), 'base64url');
    if (full.length !== 40) return null;
    const head = full.subarray(0, 24);
    if (!crypto.timingSafeEqual(full.subarray(24), this.mac(head).subarray(0, 16))) return null;
    const age = this.now() - Number(head.readBigUInt64BE(0));
    return age >= 0 && age <= CHALLENGE_TTL ? full : null;
  }

  static idOf(spki) {
    return crypto.createHash('sha256').update(spki).digest('base64url').slice(0, 24);
  }

  /** New phones are counted per address and in all, per day, in memory only (the address is not kept). */
  countRegistration(ip, day) {
    if (this.registeredDay.day !== day) {
      this.registeredDay = { day, n: 0 };
      this.registered.clear();
    }
    const perIp = this.settings.get('register_per_ip_day');
    const perDay = this.settings.get('register_per_day');
    const key = this.mac(`ip|${day}|${ip}`).subarray(0, 9).toString('base64');
    const mine = this.registered.get(key) ?? 0;
    if (perIp && mine >= perIp) throw new HttpError(429, 'rate_limited', 'Muitos aparelhos novos deste endereço hoje.', { retry_after: 3600 });
    if (perDay && this.registeredDay.n >= perDay) {
      if (this.registeredDay.n === perDay) event(this.db, 'registro', `Limite de ${perDay} aparelhos novos no dia atingido.`);
      this.registeredDay.n++;
      throw new HttpError(429, 'rate_limited', 'Muitos aparelhos novos hoje.', { retry_after: 3600 });
    }
    this.registered.set(key, mine + 1);
    this.registeredDay.n++;
  }

  /**
   * Registers a phone's key. [body]: { challenge, public_key (SPKI, base64), proof (signature of the
   * challenge with that key, base64), attestation ([certificates, base64, leaf first]), app: { version, package } }.
   */
  register(body, ip, day) {
    const challenge = this.checkChallenge(body.challenge);
    if (!challenge) throw new HttpError(422, 'bad_challenge', 'Desafio inválido ou vencido.');
    const spki = b64(body.public_key);
    let key;
    try {
      key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    } catch {
      throw new HttpError(422, 'bad_key', 'Chave pública inválida.');
    }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new HttpError(422, 'bad_key', 'A chave precisa ser EC P-256.');
    }
    const proofOk = (() => {
      try {
        return crypto.verify('sha256', Buffer.from(`novelo-device-v1\n${body.challenge}`), { key, dsaEncoding: 'der' }, b64(body.proof));
      } catch {
        return false;
      }
    })();
    if (!proofOk) throw new HttpError(422, 'bad_proof', 'A prova da chave não confere.');

    const mode = this.settings.get('attestation');
    let attest = { ok: false, reason: mode === 'off' ? 'não conferido' : 'sem atestado', level: '', boot: '' };
    if (mode !== 'off' && Array.isArray(body.attestation) && body.attestation.length) {
      attest = verifyAttestation({
        chain: body.attestation.slice(0, 10).map(b64),
        challenge,
        publicKey: spki,
        packages: this.settings.list('app_packages'),
        digests: this.settings.list('app_cert_sha256').map((d) => d.toLowerCase().replace(/[^0-9a-f]/g, '')),
        roots: this.roots,
        revoked: this.revocations?.set ?? new Set(),
        now: new Date(this.now()),
      });
    }
    if (mode === 'require' && !attest.ok) {
      throw new HttpError(403, 'attestation', 'Este aparelho não pôde ser verificado.', { reason: attest.reason });
    }

    const id = Devices.idOf(spki);
    const known = this.q.get.get(id);
    if (known?.status === 'blocked') throw new HttpError(403, 'blocked', 'Este aparelho está bloqueado.');
    if (!known) this.countRegistration(ip, day);
    const t = this.now();
    const app = body.app && typeof body.app === 'object' ? body.app : {};
    this.q.insert.run(
      id, spki, t, t,
      String(app.version ?? '').slice(0, 40),
      String(app.package ?? '').slice(0, 120),
      attest.ok ? 1 : 0,
      attest.level || '',
      (attest.reason || '').slice(0, 200),
      attest.boot || '',
    );
    this.cache.delete(id);
    return { device: id, verified: attest.ok };
  }

  load(id) {
    let d = this.cache.get(id);
    if (d) return d;
    const row = this.q.get.get(id);
    if (!row) return null;
    d = {
      id,
      key: crypto.createPublicKey({ key: Buffer.from(row.public_key), format: 'der', type: 'spki' }),
      status: row.status,
      attested: row.attested === 1,
      seen: row.last_seen,
    };
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(id, d);
    return d;
  }

  /**
   * The phone behind a request, from its headers and the body's hash. Throws 401/403.
   * Signed text: "v1\n<METHOD>\n<path>\n<time ms>\n<request id>\n<sha256 of the body, hex>".
   */
  authenticate(req, path, bodyHash) {
    const id = String(req.headers['x-novelo-device'] ?? '');
    const time = Number(req.headers['x-novelo-time']);
    const request = String(req.headers['x-novelo-request'] ?? '');
    const sig = String(req.headers['x-novelo-signature'] ?? '');
    if (!/^[A-Za-z0-9_-]{24}$/.test(id) || !/^[A-Za-z0-9_-]{16,64}$/.test(request) || !sig || !Number.isFinite(time)) {
      throw new HttpError(401, 'bad_signature', 'Pedido sem identificação.');
    }
    const now = this.now();
    if (Math.abs(now - time) > TIME_WINDOW) throw new HttpError(401, 'stale_time', 'O relógio do pedido não bate com o do servidor.', { now });
    const d = this.load(id);
    if (!d) throw new HttpError(401, 'unknown_device', 'Aparelho não registrado.');
    const text = `v1\n${req.method}\n${path}\n${time}\n${request}\n${bodyHash}`;
    let ok = false;
    try {
      ok = crypto.verify('sha256', Buffer.from(text), { key: d.key, dsaEncoding: 'der' }, b64(sig));
    } catch { /* not a signature */ }
    if (!ok) throw new HttpError(401, 'bad_signature', 'Assinatura inválida.');
    if (d.status === 'blocked') throw new HttpError(403, 'blocked', 'Este aparelho está bloqueado.');
    if (!d.attested && this.settings.get('attestation') === 'require') {
      throw new HttpError(401, 'unknown_device', 'Aparelho precisa se registrar de novo.');
    }
    if (now - d.seen > SEEN_EVERY) {
      d.seen = now;
      this.q.seen.run(now, String(req.headers['x-novelo-app'] ?? '').slice(0, 40), id);
    }
    return { id, request };
  }

  setStatus(id, status, note = '') {
    if (!['ok', 'blocked'].includes(status)) throw new Error('estado inválido');
    this.q.status.run(status, String(note).slice(0, 200), id);
    this.cache.delete(id);
  }
}
