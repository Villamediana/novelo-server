// The Novelo on the computer: its pages (web/), from the same address as the API. Nothing here is
// made per person: the pages are the same for everyone and do everything in the browser (the
// records come encrypted and are opened there). Also what Android checks to open the linking code in
// the app (/.well-known/assetlinks.json).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

// Only what the page itself is made of: no script from anywhere else, no inline script, no frames.
// Photos and files are opened in the page itself (blob:); the fonts and styles are its own.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  // No text ever becomes HTML or script (Trusted Types: the browser refuses it).
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

const HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000',
};

export class WebPages {
  constructor({ config, dir } = {}) {
    this.dir = dir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');
    // The app (and its signing certificate) Android opens novelo…/web/link/ in.
    this.pkg = config?.get('APP_PACKAGE', 'com.villamediana.novelo') ?? 'com.villamediana.novelo';
    this.cert = config?.get('APP_CERT_SHA256', '428becffc007c5063d8e3ea5122a2d7e712a965c445ae70b1384024def1d4858') ?? '';
    this.cache = new Map(); // file → { bytes, etag, mtime }
  }

  serves(p) {
    return p === '/' || p === '/web' || p.startsWith('/web/') || p === '/.well-known/assetlinks.json' || p === '/favicon.ico';
  }

  serve(req, res, p) {
    if (p === '/') {
      res.writeHead(302, { Location: '/web/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (p === '/web') {
      res.writeHead(301, { Location: '/web/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (p === '/.well-known/assetlinks.json') {
      const fp = this.cert.replace(/[^0-9a-f]/gi, '').toUpperCase().match(/../g)?.join(':') ?? '';
      const body = Buffer.from(JSON.stringify([{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: this.pkg, sha256_cert_fingerprints: [fp] },
      }]));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const rel = p === '/favicon.ico' ? 'icon.svg' : decodeURIComponent(p.slice('/web/'.length));
    // A page of the app (no file of that name, no extension): the app itself, which reads the address.
    let file = this.file(rel);
    if (!file && !path.extname(rel)) file = this.file('index.html');
    if (!file) {
      const body = Buffer.from('Não existe.');
      res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
      return res.end(body);
    }
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, { ...HEADERS, ETag: file.etag, 'Cache-Control': 'no-cache, no-transform' });
      return res.end();
    }
    res.writeHead(200, {
      ...HEADERS,
      'Content-Type': TYPES[path.extname(file.path)] ?? 'application/octet-stream',
      'Content-Length': file.bytes.length,
      ETag: file.etag,
      // Always asked again (a 304 when it didn't change): a new version reaches everyone at once.
      // no-transform: nothing on the way changes the page (no script put in by a proxy or CDN).
      'Cache-Control': 'no-cache, no-transform',
    });
    return res.end(req.method === 'HEAD' ? undefined : file.bytes);
  }

  /** A file of web/, only from inside it; null when there is none. */
  file(rel) {
    if (!rel || rel.includes('\0')) return null;
    const full = path.resolve(this.dir, rel);
    if (full !== this.dir && !full.startsWith(this.dir + path.sep)) return null;
    if (path.basename(full).startsWith('.')) return null;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const hit = this.cache.get(full);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit;
    const bytes = fs.readFileSync(full);
    const f = { path: full, bytes, etag: `"${crypto.createHash('sha256').update(bytes).digest('base64url').slice(0, 22)}"`, mtime: st.mtimeMs, size: st.size };
    this.cache.set(full, f);
    return f;
  }
}
