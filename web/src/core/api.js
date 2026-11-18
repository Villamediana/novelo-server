// The page talking to the Novelo's server (same address): the link (before there is a token), and
// then everything with the token. What goes and comes is the encrypted bytes; see docs/WEB.md.

import * as lock from './crypto.js';

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const te = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export class Api {
  /**
   * [token]: this computer's entry to the server; [proof]: the private key (ECDSA P-256, not
   * extractable) that signs each request — the token alone is worth nothing.
   */
  constructor({ base = '', token = null, proof = null, onUnlinked = () => {} } = {}) {
    this.base = base;
    this.token = token;
    this.proof = proof;
    this.onUnlinked = onUnlinked;
    this.skew = 0; // the server's clock minus this one (learned when the server says the clock is off)
  }

  /** X-Novelo-Sig for a request: "<ms>.<nonce>.<ECDSA over method, address, ms, nonce, SHA-256 of the body>". */
  async sign(method, path, body) {
    const at = String(Date.now() + this.skew);
    const nonce = lock.b64u.enc(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const digest = hex(await globalThis.crypto.subtle.digest('SHA-256', body ?? new Uint8Array(0)));
    const text = `novelo-web-v1\n${method}\n${path}\n${at}\n${nonce}\n${digest}`;
    const sig = await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.proof, te.encode(text));
    return `${at}.${nonce}.${lock.b64u.enc(new Uint8Array(sig))}`;
  }

  async call(method, path, opts = {}, again = true) {
    const { json, bytes, headers = {}, signal, raw = false } = opts;
    const body = json !== undefined ? te.encode(JSON.stringify(json)) : bytes;
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(this.token && this.proof ? { 'X-Novelo-Sig': await this.sign(method, path, body) } : {}),
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(bytes ? { 'Content-Type': 'application/octet-stream' } : {}),
          ...headers,
        },
        body,
        signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new ApiError(0, 'offline', 'sem conexão');
    }
    if (raw && res.ok) return new Uint8Array(await res.arrayBuffer());
    const text = await res.text();
    let out = null;
    try {
      out = text ? JSON.parse(text) : null;
    } catch { /* not JSON */ }
    if (!res.ok || out?.error) {
      const err = out?.error ?? {};
      if (res.status === 401 && err.code === 'unlinked') this.onUnlinked();
      // This computer's clock is off: the server said its time; signed again with it, once.
      if (res.status === 401 && err.code === 'bad_proof' && again && Number.isSafeInteger(err.now)) {
        this.skew = err.now - Date.now();
        return this.call(method, path, opts, false);
      }
      throw new ApiError(res.status, err.code ?? 'http', err.message, err);
    }
    return out;
  }

  // ------------------------------------------------------------------ linking

  startLink(key, name, proof) {
    return this.call('POST', '/v1/link', { json: { key, name, proof } });
  }

  pollLink(id, poll, wait = 25, signal) {
    // The poll secret in a header, not in the address (addresses end up in logs on the way).
    return this.call('GET', `/v1/link/${encodeURIComponent(id)}?wait=${wait}`, { signal, headers: { 'X-Novelo-Poll': poll } });
  }

  unlink() {
    return this.call('DELETE', '/v1/link');
  }

  me() {
    return this.call('GET', '/v1/web/me');
  }

  // ------------------------------------------------------------------ the space

  changes(since, wait = 0, signal) {
    return this.call('GET', `/v1/sync/changes?since=${since}&limit=500${wait ? `&wait=${wait}` : ''}`, { signal });
  }

  push(items) {
    return this.call('POST', '/v1/sync/push', { json: { items } });
  }

  putBlob(id, bytes) {
    return this.call('PUT', `/v1/sync/blob/${id}`, { bytes });
  }

  getBlob(id) {
    return this.call('GET', `/v1/sync/blob/${id}`, { raw: true });
  }

  // ------------------------------------------------------------------ the intelligence, in the phone's name

  /** {text, route} — the model's answer for [job] ("think", "see"). */
  async ask(job, body, { not = [] } = {}) {
    const request = globalThis.crypto.randomUUID();
    const out = await this.call('POST', `/v1/web/ask/${job}`, {
      json: body,
      headers: { 'X-Novelo-Request': request, ...(not.length ? { 'X-Novelo-Not': not.join(',') } : {}) },
    });
    const content = out?.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : '';
    if (!text.trim()) throw new ApiError(200, 'empty', 'resposta vazia');
    return { text, route: out?.novelo?.route ?? '' };
  }
}
