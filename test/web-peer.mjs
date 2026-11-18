// A computer linked to a phone, from the command line: what the phone's tests (Novelo, NoveloWebTest)
// use to check the phone against the real server and the page's own locks (web/js/crypto.js).
// Each call is one step; what it knows between steps is kept in [state] (a JSON file).
//
//   node test/web-peer.mjs <state> link <server> <name>     → {code}            (the QR code's address)
//   node test/web-peer.mjs <state> wait                     → {space, owner}    (after the phone read it)
//   node test/web-peer.mjs <state> pull                     → {records: [{t, id, r}], deleted: n}
//   node test/web-peer.mjs <state> put '<{t,id,r}>'         → {ok, s}
//   node test/web-peer.mjs <state> delete <t> <id>          → {ok, s}
//   node test/web-peer.mjs <state> blob-put <base64>        → {id}
//   node test/web-peer.mjs <state> blob-get <id>            → {data: base64} | {missing: true}
//   node test/web-peer.mjs <state> me                       → {status}
import fs from 'node:fs';
import * as lock from '../web/src/core/crypto.js';
import { Api } from '../web/src/core/api.js';

const [stateFile, cmd, ...args] = process.argv.slice(2);
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const subtle = globalThis.crypto.subtle;

async function api(method, path, body, raw, headers = {}) {
  const bytes = raw ?? (body ? new TextEncoder().encode(JSON.stringify(body)) : undefined);
  // Signed as the page signs (the key that signs is kept here as JWK: a test's, not a browser's).
  let sig = null;
  if (state.token && state.proofJwk) {
    const proof = await subtle.importKey('jwk', state.proofJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    sig = await new Api({ token: state.token, proof }).sign(method, path, bytes);
  }
  const res = await fetch(state.server + path, {
    method,
    headers: { ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(sig ? { 'X-Novelo-Sig': sig } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: bytes,
  });
  const data = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(data.toString());
  } catch { /* bytes */ }
  return { status: res.status, json, data };
}

async function keys() {
  return lock.spaceKeys(lock.b64u.dec(state.master));
}

/** Everything of the space, opened: name → {s, value}. */
async function all() {
  const k = await keys();
  const out2 = {};
  let since = 0;
  for (;;) {
    const r = await api('GET', `/v1/sync/changes?since=${since}&limit=500`);
    if (r.status !== 200) throw new Error(`changes ${r.status} ${r.data}`);
    for (const c of r.json.changes) out2[c.k] = { s: c.s, value: c.d ? await lock.open(k, c.k, c.d) : null };
    since = r.json.seq;
    if (!r.json.more) break;
  }
  return out2;
}

switch (cmd) {
  case 'link': {
    state.server = args[0];
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pub = lock.b64u.enc(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
    state.jwk = await subtle.exportKey('jwk', pair.privateKey);
    const signer = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    state.proofJwk = await subtle.exportKey('jwk', signer.privateKey);
    const proofPub = lock.b64u.enc(new Uint8Array(await subtle.exportKey('raw', signer.publicKey)));
    state.secret = lock.b64u.enc(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const r = await api('POST', '/v1/link', { key: pub, name: args[1] ?? 'Teste', proof: proofPub });
    if (r.status !== 200) throw new Error(`link ${r.status} ${r.data}`);
    state.link = r.json.id;
    state.poll = r.json.poll;
    save();
    out({ code: lock.linkUrl(state.server, r.json.id, pub, state.secret) });
    break;
  }
  case 'wait': {
    const r = await api('GET', `/v1/link/${state.link}?wait=20`, null, undefined, { 'X-Novelo-Poll': state.poll });
    if (r.json?.status !== 'linked') throw new Error(`wait ${r.status} ${r.data}`);
    const priv = await subtle.importKey('jwk', state.jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const opened = await lock.unwrapLink(priv, state.link, state.secret, r.json.wrapped);
    state.token = r.json.token;
    state.master = lock.b64u.enc(opened.key);
    state.space = opened.space;
    save();
    out({ space: opened.space, owner: opened.owner });
    break;
  }
  case 'pull': {
    const recs = Object.values(await all());
    out({ records: recs.filter((x) => x.value).map((x) => x.value), deleted: recs.filter((x) => !x.value).length });
    break;
  }
  case 'put': {
    const rec = JSON.parse(args[0]);
    const k = await keys();
    const key = await lock.recordKey(k, rec.t, rec.id);
    const known = (await all())[key];
    const r = await api('POST', '/v1/sync/push', { items: [{ k: key, base: known?.s ?? 0, d: await lock.seal(k, key, rec) }] });
    out(r.json.results[0]);
    break;
  }
  case 'delete': {
    const k = await keys();
    const key = await lock.recordKey(k, args[0], args[1]);
    const known = (await all())[key];
    const r = await api('POST', '/v1/sync/push', { items: [{ k: key, base: known?.s ?? 0, d: null }] });
    out(r.json.results[0]);
    break;
  }
  case 'blob-put': {
    const id = lock.newId();
    const sealed = await lock.sealBlob(await keys(), id, lock.b64.dec(args[0]));
    const r = await api('PUT', `/v1/sync/blob/${id}`, null, sealed);
    if (r.status !== 200) throw new Error(`blob ${r.status} ${r.data}`);
    out({ id });
    break;
  }
  case 'blob-get': {
    const r = await api('GET', `/v1/sync/blob/${args[0]}`);
    if (r.status === 404) out({ missing: true });
    else out({ data: lock.b64.enc(await lock.openBlob(await keys(), args[0], new Uint8Array(r.data))) });
    break;
  }
  case 'me': {
    out({ status: (await api('GET', '/v1/web/me')).status });
    break;
  }
  default:
    throw new Error(`comando? ${cmd}`);
}
