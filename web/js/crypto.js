// The Novelo Web's locks, the same as the phone's (sync/SyncCrypto.kt): what is kept on the server
// is opened only here and on the phone. WebCrypto only, so it runs in the browser and in Node (the
// tests). See docs/WEB.md, "Cifra".
//
// - The space's key (32 random bytes, made on the phone) never goes anywhere in the clear. From it
//   (HKDF-SHA256, salt "novelo-sync-v1"): "enc" encrypts the records (AES-256-GCM), "key" names them
//   (HMAC-SHA256 of "<kind>:<id>": the server doesn't see what a record is), "blob" encrypts the files,
//   "check" says which key a space is in without being it.
// - Linking: the computer's key pair (ECDH P-256) is in its QR code; the phone answers with its own
//   one-time public key and the space's key encrypted with HKDF(ECDH, salt = the link's id, info
//   "novelo-link-v1") — only this computer can open it, and not the server that carries it.
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const b64u = {
  enc(bytes) {
    let s = '';
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(text) {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

export const b64 = {
  enc(bytes) {
    let s = '';
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(text) {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

const SALT = te.encode('novelo-sync-v1');
const LINK_INFO = te.encode('novelo-link-v1');
const IV = 12;

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function hkdfKey(raw) {
  return subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
}

function hkdf(salt, info) {
  return { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) };
}

/**
 * The keys of a space from its 32 bytes ([master], a Uint8Array): never extractable once made (a page
 * with a fault in it can use them while open, never take them away).
 */
export async function spaceKeys(master) {
  if (!(master instanceof Uint8Array) || master.length !== 32) throw new Error('space key: 32 bytes');
  const base = await hkdfKey(master);
  const aes = (info) => subtle.deriveKey(hkdf(SALT, info), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const [enc, blob, mac, checkBits] = await Promise.all([
    aes('enc'),
    aes('blob'),
    subtle.deriveKey(hkdf(SALT, 'key'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
    subtle.deriveBits(hkdf(SALT, 'check'), base, 128),
  ]);
  return { enc, blob, mac, check: b64u.enc(new Uint8Array(checkBits)) };
}

/** The name a record has on the server: HMAC("<kind>:<id>"), base64url (43 letters). */
export async function recordKey(keys, kind, id) {
  const sig = await subtle.sign('HMAC', keys.mac, te.encode(`${kind}:${id}`));
  return b64u.enc(new Uint8Array(sig));
}

/** A record's bytes, base64: IV (12) + AES-GCM of its JSON, bound to its name ([k]). */
export async function seal(keys, k, value) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(k) }, keys.enc, te.encode(JSON.stringify(value))));
  return b64.enc(concat(iv, ct));
}

/** A record back: its JSON. Throws when it isn't this space's (or was changed on the way). */
export async function open(keys, k, data) {
  const bytes = b64.dec(data);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, IV), additionalData: te.encode(k) }, keys.enc, bytes.subarray(IV));
  return JSON.parse(td.decode(pt));
}

/** A file's bytes encrypted (IV + AES-GCM, bound to its [id]). */
export async function sealBlob(keys, id, bytes) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(id) }, keys.blob, bytes));
  return concat(iv, ct);
}

export async function openBlob(keys, id, bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, IV), additionalData: te.encode(id) }, keys.blob, b.subarray(IV)));
}

/** A new name for something (a file, a link): 18 random bytes, base64url. */
export function newId(n = 18) {
  return b64u.enc(globalThis.crypto.getRandomValues(new Uint8Array(n)));
}

// ------------------------------------------------------------------ linking

/** The computer's key pair for its QR code: the public half raw (65 bytes, base64url), the private one kept. */
export async function linkKeys() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, pub: b64u.enc(pub) };
}

async function linkLock(privateKey, peerPubRaw, linkId) {
  const peer = await subtle.importKey('raw', peerPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
  const base = await hkdfKey(shared);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(linkId), info: LINK_INFO }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** The phone's answer opened: { space, key (Uint8Array 32), owner }. */
export async function unwrapLink(privateKey, linkId, wrapped) {
  const lock = await linkLock(privateKey, b64u.dec(wrapped.pub), linkId);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(wrapped.iv), additionalData: te.encode(linkId) }, lock, b64u.dec(wrapped.ct));
  const v = JSON.parse(td.decode(pt));
  return { space: v.space, key: b64u.dec(v.key), owner: v.owner ?? '' };
}

/** What the phone does with a QR code (here for the tests: the phone's own is in Kotlin). */
export async function wrapLink(webPub, linkId, { space, key, owner = '' }) {
  const mine = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const lock = await linkLock(mine.privateKey, b64u.dec(webPub), linkId);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(linkId) }, lock, te.encode(JSON.stringify({ space, key: b64u.enc(key), owner }))));
  return { pub: b64u.enc(new Uint8Array(await subtle.exportKey('raw', mine.publicKey))), iv: b64u.enc(iv), ct: b64u.enc(ct) };
}

/** What goes in the computer's QR code: the address that opens the Novelo on the phone, with the link and the key. */
export function linkUrl(origin, linkId, pub) {
  return `${origin}/web/link#${linkId}.${pub}`;
}
