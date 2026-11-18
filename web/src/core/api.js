// The page talking to the Novelo's server (same address): the link (before there is a token), and
// then everything with the token. What goes and comes is the encrypted bytes; see docs/WEB.md.

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export class Api {
  constructor({ base = '', token = null, onUnlinked = () => {} } = {}) {
    this.base = base;
    this.token = token;
    this.onUnlinked = onUnlinked;
  }

  async call(method, path, { json, bytes, headers = {}, signal, raw = false } = {}) {
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(bytes ? { 'Content-Type': 'application/octet-stream' } : {}),
          ...headers,
        },
        body: json !== undefined ? JSON.stringify(json) : bytes,
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
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch { /* not JSON */ }
    if (!res.ok || body?.error) {
      const err = body?.error ?? {};
      if (res.status === 401 && err.code === 'unlinked') this.onUnlinked();
      throw new ApiError(res.status, err.code ?? 'http', err.message, err);
    }
    return body;
  }

  // ------------------------------------------------------------------ linking

  startLink(key, name) {
    return this.call('POST', '/v1/link', { json: { key, name } });
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
