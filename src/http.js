// The few things every handler needs: a body with a size limit, JSON out, who is calling.

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  body() {
    return { error: { code: this.code, message: this.message, ...this.extra } };
  }
}

/** The whole body, refused as soon as it passes [limit] bytes. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      req.resume();
      reject(new HttpError(413, 'too_large', 'Pedido grande demais.'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new HttpError(413, 'too_large', 'Pedido grande demais.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new HttpError(400, 'bad_request', 'Pedido interrompido.')));
    req.on('aborted', () => reject(new HttpError(400, 'bad_request', 'Pedido interrompido.')));
  });
}

export function parseJson(buf) {
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* falls through */ }
  throw new HttpError(422, 'bad_request', 'O pedido não é um JSON válido.');
}

export function sendJson(res, status, obj, headers = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(obj));
  if (res.headersSent) {
    res.end(body);
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

export function sendError(res, e) {
  if (e instanceof HttpError) {
    const headers = e.extra.retry_after ? { 'Retry-After': String(e.extra.retry_after) } : {};
    sendJson(res, e.status, e.body(), headers);
  } else {
    sendJson(res, 500, { error: { code: 'internal', message: 'Erro interno.' } });
  }
}

/**
 * The scheme the caller used, as the proxy in front says ('https', 'http'); '' when nothing says
 * (no proxy, or one that doesn't tell): then nothing is assumed.
 */
export function scheme(req, trust) {
  if (trust === 'none') return '';
  const fwd = req.headers['x-forwarded-proto'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim().toLowerCase();
  const visitor = req.headers['cf-visitor'];
  if (trust === 'cloudflare' && typeof visitor === 'string') {
    try {
      return String(JSON.parse(visitor).scheme ?? '').toLowerCase();
    } catch { /* nothing said */ }
  }
  return '';
}

/** Who is calling. Behind a proxy the socket is the proxy: [trust] says which header to believe. */
export function clientIp(req, trust) {
  if (trust === 'cloudflare') {
    const ip = req.headers['cf-connecting-ip'];
    if (typeof ip === 'string' && ip) return ip.trim();
  }
  if (trust === 'xff' || trust === 'cloudflare') {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}
