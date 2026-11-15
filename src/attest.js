// Android key attestation: the proof that a key was made inside a real phone's secure hardware,
// by this app (its package and the certificate it is signed with), for the challenge we gave.
// It needs no Google Play: the certificate chain ends in Google's hardware attestation roots.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { read, children, int, extension } from './der.js';
import { ROOT } from './config.js';

export const KEY_DESCRIPTION = '1.3.6.1.4.1.11129.2.1.17';
const TAG_ROOT_OF_TRUST = 704;
const TAG_APPLICATION_ID = 709;
const LEVELS = ['software', 'tee', 'strongbox'];
const BOOT = ['verified', 'self-signed', 'unverified', 'failed'];
const STATUS_URL = 'https://android.googleapis.com/attestation/status';

/** Google's roots (RSA and the ECDSA one of 2025), as shipped in certs/android-roots.json. */
export function googleRoots(file = path.join(ROOT, 'certs', 'android-roots.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).map((pem) => new crypto.X509Certificate(pem).publicKey);
}

function serials(cert) {
  const hex = cert.serialNumber.toLowerCase().replace(/^0+(?=.)/, '');
  return [hex, BigInt('0x' + hex).toString(10)];
}

function tagged(list, tag) {
  const el = children(list).find((c) => c.cls === 2 && c.tag === tag);
  return el ? children(el)[0] : null;
}

/** The key description of the leaf: security level, challenge, the app it was made by, the boot state. */
export function parseKeyDescription(ext) {
  const f = children(read(ext));
  if (f.length < 8) throw new Error('descrição da chave incompleta');
  const out = {
    version: int(f[0]),
    level: LEVELS[int(f[1])] ?? 'unknown',
    keymintLevel: LEVELS[int(f[3])] ?? 'unknown',
    challenge: Buffer.from(f[4].value),
    packages: [],
    digests: [],
    boot: '',
    locked: null,
  };
  // The app's identity may only be believed from the software list (the system writes it there).
  const appId = tagged(f[6], TAG_APPLICATION_ID);
  if (appId) {
    const [infos, digests] = children(read(appId.value));
    for (const info of children(infos)) out.packages.push(children(info)[0].value.toString('utf8'));
    for (const d of children(digests)) out.digests.push(d.value.toString('hex'));
  }
  // The boot state only from the hardware list.
  const rot = tagged(f[7], TAG_ROOT_OF_TRUST);
  if (rot) {
    const r = children(rot);
    out.locked = r[1] ? r[1].value[0] !== 0 : null;
    out.boot = BOOT[r[2] ? int(r[2]) : -1] ?? '';
  }
  return out;
}

/**
 * Checks a chain (leaf first, DER buffers). Returns { ok, reason, level, boot, locked }.
 * [roots]: the public keys trusted at the top; [revoked]: serials (hex or decimal) not to be trusted.
 */
export function verifyAttestation({ chain, challenge, publicKey, packages, digests, roots, revoked = new Set(), now = new Date() }) {
  const fail = (reason, more = {}) => ({ ok: false, reason, level: '', boot: '', locked: null, ...more });
  try {
    if (!Array.isArray(chain) || chain.length < 2 || chain.length > 10) return fail('cadeia de certificados ausente');
    const certs = chain.map((der) => new crypto.X509Certificate(der));

    for (let i = 0; i < certs.length - 1; i++) {
      if (!certs[i].verify(certs[i + 1].publicKey)) return fail('cadeia quebrada');
    }
    const top = certs[certs.length - 1];
    if (!roots.some((key) => top.verify(key))) return fail('a cadeia não chega na raiz do Google');

    // The top one is trusted by its key, not by its dates (Google reissues the root with the same key).
    for (const c of certs.slice(0, -1)) {
      if (new Date(c.validFrom) > now || new Date(c.validTo) < now) return fail('certificado fora da validade');
    }
    for (const c of certs) {
      if (serials(c).some((s) => revoked.has(s))) return fail('certificado revogado');
    }

    // Only the leaf may carry the description: a real phone's key can sign a made-up certificate
    // under itself, so a description anywhere above the leaf means the leaf is not the attested key.
    for (const c of certs.slice(1)) {
      if (extension(c.raw, KEY_DESCRIPTION)) return fail('cadeia estendida');
    }
    const ext = extension(certs[0].raw, KEY_DESCRIPTION);
    if (!ext) return fail('sem descrição da chave');
    const d = parseKeyDescription(ext);
    const seen = { level: d.level, boot: d.boot, locked: d.locked };

    if (d.level === 'software' || d.level === 'unknown' || d.keymintLevel === 'software') return fail('chave fora do hardware seguro', seen);
    if (d.challenge.length !== challenge.length || !crypto.timingSafeEqual(d.challenge, challenge)) return fail('desafio não confere', seen);
    const spki = certs[0].publicKey.export({ type: 'spki', format: 'der' });
    if (!spki.equals(publicKey)) return fail('a chave não é a do certificado', seen);
    if (!d.packages.some((p) => packages.includes(p))) return fail(`pacote não reconhecido (${d.packages.slice(0, 3).join(', ') || 'nenhum'})`, seen);
    if (digests.length && !d.digests.some((x) => digests.includes(x))) return fail('assinatura do app não reconhecida', seen);
    return { ok: true, reason: digests.length ? '' : 'assinatura do app não conferida (falta configurar)', ...seen };
  } catch (e) {
    return fail(`atestado ilegível: ${e.message}`.slice(0, 200));
  }
}

/** Google's list of revoked attestation certificates, refreshed once a day and kept on disk. */
export class Revocations {
  constructor(dataDir, { url = STATUS_URL, fetcher = fetch } = {}) {
    this.file = dataDir && dataDir !== ':memory:' ? path.join(dataDir, 'attestation-status.json') : null;
    this.url = url;
    this.fetcher = fetcher;
    this.set = new Set();
    this.at = 0;
    if (this.file && fs.existsSync(this.file)) {
      try {
        this.take(JSON.parse(fs.readFileSync(this.file, 'utf8')));
        this.at = fs.statSync(this.file).mtimeMs;
      } catch { /* a broken copy is fetched again */ }
    }
  }

  take(json) {
    this.set = new Set(Object.keys(json.entries ?? {}).map((s) => s.toLowerCase()));
  }

  /** Never throws: without the list, the last one known keeps being used. */
  async refresh() {
    try {
      const r = await this.fetcher(this.url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return false;
      const text = await r.text();
      this.take(JSON.parse(text));
      this.at = Date.now();
      if (this.file) fs.writeFileSync(this.file, text);
      return true;
    } catch {
      return false;
    }
  }

  start() {
    const tick = () => {
      if (Date.now() - this.at > 24 * 3600_000) this.refresh();
    };
    tick();
    this.timer = setInterval(tick, 3600_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}
