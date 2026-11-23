// Friends and what they share (app 1.84): a phone invites by a link, the other accepts, and either one
// can end it; then a note, a diary or a task can be shared with friends and edited by all at once,
// each one seeing where the others are writing. As everywhere in the Novelo, the server keeps what it
// cannot read: who is friends with whom (by opaque ids) and encrypted bytes. See docs/AMIGOS.md.
//
// - Invite: { code, the inviter's public key (ECDH P-256), their card } — the card (name, the key again)
//   is sealed with a secret that is only in the link (after the #), never here. Accepting leaves the
//   other's public key and card (sealed the same way): from then on the two phones share a key made of
//   ECDH + that secret, and the server can't stand in the middle (it would have to make a card).
// - Friendship: two installs, each one's public key and card. Ended by either: gone for both, and so
//   is what they shared through it.
// - Doc: something shared. Its key is made on the owner's phone and handed to each member wrapped
//   with the key the owner and that friend share. Its changes are a log of encrypted operations (each
//   phone merges them: the same text whatever the order); "here" is where each one is writing (memory
//   only, a few seconds).
// - The feed: a number per phone that moves whenever something of theirs changed (a friend, a doc, a
//   change in a doc); a long wait on it is how the app knows to look.
import crypto from 'node:crypto';
import { HttpError } from './http.js';

export const SOCIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS invites(
  code TEXT PRIMARY KEY,
  install TEXT NOT NULL,
  pub TEXT NOT NULL,
  card TEXT NOT NULL,
  created INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS invites_install ON invites(install);

CREATE TABLE IF NOT EXISTS friends(
  id TEXT PRIMARY KEY,
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  a_pub TEXT NOT NULL,
  b_pub TEXT NOT NULL,
  a_card TEXT NOT NULL,
  b_card TEXT NOT NULL,
  invite TEXT NOT NULL,
  created INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS friends_a ON friends(a);
CREATE INDEX IF NOT EXISTS friends_b ON friends(b);
CREATE UNIQUE INDEX IF NOT EXISTS friends_pair ON friends(min(a, b), max(a, b));

CREATE TABLE IF NOT EXISTS docs(
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  created INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  snap_seq INTEGER NOT NULL DEFAULT 0,
  snap BLOB
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS docs_owner ON docs(owner);

CREATE TABLE IF NOT EXISTS doc_members(
  doc TEXT NOT NULL,
  install TEXT NOT NULL,
  key TEXT NOT NULL,
  via TEXT,
  added INTEGER NOT NULL,
  PRIMARY KEY(doc, install)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS doc_members_install ON doc_members(install);
CREATE INDEX IF NOT EXISTS doc_members_via ON doc_members(via);

CREATE TABLE IF NOT EXISTS doc_ops(
  doc TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY(doc, seq)
) WITHOUT ROWID;
`;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const CODE = /^[A-Za-z0-9_-]{22}$/;
const ID = /^[A-Za-z0-9_-]{22,32}$/;
const PUB = /^[A-Za-z0-9_-]{87}$/; // 65 bytes, base64url
const B64URL = /^[A-Za-z0-9_-]+$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

const bad = (message) => new HttpError(422, 'bad_request', message);
const gone = (message = 'Não existe mais.') => new HttpError(404, 'gone', message);
const token = (n = 16) => crypto.randomBytes(n).toString('base64url');

function sealed(v, max, what) {
  if (typeof v !== 'string' || v.length < 40 || v.length > max || !B64URL.test(v)) throw bad(`${what} inválido.`);
  return v;
}

function pub(v) {
  if (typeof v !== 'string' || !PUB.test(v) || Buffer.from(v, 'base64url')[0] !== 4) throw bad('Chave pública inválida.');
  return v;
}

export class Social {
  constructor({ db, config, now = Date.now }) {
    this.db = db;
    this.now = now;
    db.exec(SOCIAL_SCHEMA);
    this.inviteTtl = config.int('FRIEND_INVITE_DAYS', 7) * DAY;
    this.maxInvites = 20;
    this.maxFriends = config.int('MAX_FRIENDS', 500);
    this.maxDocs = config.int('MAX_SHARED_DOCS', 2000);
    this.maxMembers = 20;
    this.maxOp = 64 * 1024;
    this.maxOps = 200;
    this.maxDocBytes = config.int('SHARED_DOC_MB', 16) * 1024 * 1024;
    this.hereTtl = 30_000;
    this.maxWaitsPerPhone = 8;
    this.maxWaits = config.int('SOCIAL_MAX_WAITS', 4000);
    this.waits = 0;
    this.open = new Map(); // install → waits open
    this.feed = new Map(); // install → number
    this.feedWaiters = new Map(); // install → Set<() => void>
    this.docWaiters = new Map(); // doc → Set<() => void>
    this.here = new Map(); // doc → { v, by: Map(tag → { d, at }) }
    this.calls = new Map();
    const q = (sql) => db.prepare(sql);
    this.q = {
      invite: q('SELECT * FROM invites WHERE code = ?'),
      invitesOf: q('SELECT code, created FROM invites WHERE install = ? ORDER BY created'),
      newInvite: q('INSERT INTO invites(code, install, pub, card, created) VALUES(?,?,?,?,?)'),
      dropInvite: q('DELETE FROM invites WHERE code = ?'),
      staleInvites: q('DELETE FROM invites WHERE created < ?'),
      friend: q('SELECT * FROM friends WHERE id = ?'),
      friendsOf: q('SELECT * FROM friends WHERE a = ? OR b = ? ORDER BY created'),
      pair: q('SELECT * FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)'),
      countFriends: q('SELECT COUNT(*) AS n FROM friends WHERE a = ? OR b = ?'),
      newFriend: q('INSERT INTO friends(id, a, b, a_pub, b_pub, a_card, b_card, invite, created) VALUES(?,?,?,?,?,?,?,?,?)'),
      cardA: q('UPDATE friends SET a_card = ? WHERE id = ? AND a = ?'),
      cardB: q('UPDATE friends SET b_card = ? WHERE id = ? AND b = ?'),
      dropFriend: q('DELETE FROM friends WHERE id = ?'),
      doc: q('SELECT id, owner, created, seq, bytes, snap_seq FROM docs WHERE id = ?'),
      snap: q('SELECT snap_seq, snap FROM docs WHERE id = ?'),
      newDoc: q('INSERT INTO docs(id, owner, created) VALUES(?,?,?)'),
      countDocs: q('SELECT COUNT(*) AS n FROM docs WHERE owner = ?'),
      dropDoc: q('DELETE FROM docs WHERE id = ?'),
      bumpDoc: q('UPDATE docs SET seq = ?, bytes = ? WHERE id = ?'),
      setSnap: q('UPDATE docs SET snap_seq = ?, snap = ?, bytes = ? WHERE id = ?'),
      member: q('SELECT * FROM doc_members WHERE doc = ? AND install = ?'),
      members: q('SELECT * FROM doc_members WHERE doc = ?'),
      docsOf: q('SELECT d.id, d.owner, d.seq, m.key, m.via FROM doc_members m JOIN docs d ON d.id = m.doc WHERE m.install = ? ORDER BY d.created'),
      addMember: q('INSERT INTO doc_members(doc, install, key, via, added) VALUES(?,?,?,?,?) ON CONFLICT(doc, install) DO UPDATE SET key = excluded.key, via = excluded.via'),
      dropMember: q('DELETE FROM doc_members WHERE doc = ? AND install = ?'),
      dropMembers: q('DELETE FROM doc_members WHERE doc = ?'),
      membersVia: q('SELECT doc, install FROM doc_members WHERE via = ?'),
      ops: q('SELECT seq, data FROM doc_ops WHERE doc = ? AND seq > ? ORDER BY seq LIMIT ?'),
      addOp: q('INSERT INTO doc_ops(doc, seq, data) VALUES(?,?,?)'),
      dropOps: q('DELETE FROM doc_ops WHERE doc = ?'),
      dropOpsUpTo: q('DELETE FROM doc_ops WHERE doc = ? AND seq <= ?'),
      opsBytes: q('SELECT COALESCE(SUM(length(data)), 0) AS n FROM doc_ops WHERE doc = ?'),
    };
  }

  /** So many calls a minute for one phone. */
  rate(install, max = 900) {
    const now = this.now();
    let c = this.calls.get(install);
    if (!c || now - c.start > MINUTE) this.calls.set(install, (c = { start: now, n: 0 }));
    if (++c.n > max) throw new HttpError(429, 'rate_limited', 'Muitos pedidos em pouco tempo.', { retry_after: 30 });
  }

  prune() {
    const now = this.now();
    this.q.staleInvites.run(now - this.inviteTtl);
    for (const [k, c] of this.calls) if (now - c.start > MINUTE) this.calls.delete(k);
    for (const [doc, h] of this.here) {
      for (const [tag, p] of h.by) if (now - p.at > this.hereTtl) h.by.delete(tag);
      if (!h.by.size) this.here.delete(doc);
    }
  }

  // ------------------------------------------------------------------ the feed

  /** The phone's number (it only moves forward while the server runs; after a restart, a different one). */
  seqOf(install) {
    let n = this.feed.get(install);
    if (n === undefined) this.feed.set(install, (n = this.now()));
    return n;
  }

  /** Something of [installs] changed: their number moves and their waits wake. */
  bump(...installs) {
    for (const i of new Set(installs)) {
      if (!i) continue;
      this.feed.set(i, this.seqOf(i) + 1);
      const set = this.feedWaiters.get(i);
      if (set) for (const w of [...set]) w();
    }
  }

  /** Waits (up to [ms]) for the phone's number to be other than [since]. */
  async waitFeed(install, since, ms, signal) {
    if (this.seqOf(install) !== since) return this.seqOf(install);
    await this.wait(this.feedWaiters, install, install, ms, signal);
    return this.seqOf(install);
  }

  enter(install) {
    const n = this.open.get(install) ?? 0;
    if (n >= this.maxWaitsPerPhone || this.waits >= this.maxWaits) throw new HttpError(429, 'rate_limited', 'Conexões demais abertas.', { retry_after: 10 });
    this.open.set(install, n + 1);
    this.waits++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.waits--;
      const m = (this.open.get(install) ?? 1) - 1;
      if (m > 0) this.open.set(install, m);
      else this.open.delete(install);
    };
  }

  wait(map, key, install, ms, signal) {
    const leave = this.enter(install);
    return new Promise((resolve) => {
      let set = map.get(key);
      if (!set) map.set(key, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (!set.size) map.delete(key);
        signal?.removeEventListener('abort', done);
        leave();
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  wakeDoc(doc) {
    const set = this.docWaiters.get(doc);
    if (set) for (const w of [...set]) w();
  }

  // ------------------------------------------------------------------ friends

  /** A new invite of [install]: its code (the secret stays in the link, after the #). */
  invite(install, body) {
    const p = pub(body?.pub);
    const card = sealed(body?.card, 6000, 'Cartão');
    if (this.q.invitesOf.all(install).length >= this.maxInvites) throw new HttpError(429, 'too_many_invites', 'Convites demais abertos.');
    const code = token(16);
    this.q.newInvite.run(code, install, p, card, this.now());
    return { code, expires_in: Math.floor(this.inviteTtl / 1000) };
  }

  /** What the one with the link sees before accepting: the inviter's key and card (sealed). */
  peek(install, code) {
    const inv = this.liveInvite(code);
    return { pub: inv.pub, card: inv.card, mine: inv.install === install };
  }

  liveInvite(code) {
    if (typeof code !== 'string' || !CODE.test(code)) throw gone('Convite não existe mais.');
    const inv = this.q.invite.get(code);
    if (!inv || this.now() - inv.created > this.inviteTtl) throw gone('Convite não existe mais.');
    return inv;
  }

  /** [install] accepts [code]: friends from now on (the invite goes). Returns the friendship as they see it. */
  accept(install, code, body) {
    const inv = this.liveInvite(code);
    if (inv.install === install) throw new HttpError(409, 'own_invite', 'É o seu próprio convite.');
    const p = pub(body?.pub);
    const card = sealed(body?.card, 6000, 'Cartão');
    const already = this.q.pair.get(inv.install, install, install, inv.install);
    if (already) {
      this.q.dropInvite.run(code);
      return { friend: this.view(already, install), already: true };
    }
    for (const who of [inv.install, install]) {
      if (this.q.countFriends.get(who, who).n >= this.maxFriends) throw new HttpError(409, 'too_many_friends', 'Amigos demais.');
    }
    const id = token(16);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.q.newFriend.run(id, inv.install, install, inv.pub, p, inv.card, card, code, this.now());
      this.q.dropInvite.run(code);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.bump(inv.install, install);
    return { friend: this.view(this.q.friend.get(id), install), already: false };
  }

  /** The inviter takes an invite back. */
  cancelInvite(install, code) {
    const inv = typeof code === 'string' && CODE.test(code) ? this.q.invite.get(code) : null;
    if (inv && inv.install === install) this.q.dropInvite.run(code);
    return { ok: true };
  }

  /** A friendship as [install] sees it: the other's key and card; [invite] for the inviter to find the secret. */
  view(f, install) {
    const mine = f.a === install;
    return { id: f.id, pub: mine ? f.b_pub : f.a_pub, card: mine ? f.b_card : f.a_card, invite: f.invite, inviter: mine, since: f.created };
  }

  friends(install) {
    return {
      friends: this.q.friendsOf.all(install, install).map((f) => this.view(f, install)),
      invites: this.q.invitesOf.all(install).filter((i) => this.now() - i.created <= this.inviteTtl).map((i) => ({ code: i.code, created: i.created })),
      seq: this.seqOf(install),
    };
  }

  /** [install]'s own card for friendship [id] (a new name, or sealed with the key the two share). */
  setCard(install, id, body) {
    const f = typeof id === 'string' && ID.test(id) ? this.q.friend.get(id) : null;
    if (!f || (f.a !== install && f.b !== install)) throw gone('Amizade não existe mais.');
    const card = sealed(body?.card, 6000, 'Cartão');
    if (f.a === install) this.q.cardA.run(card, id, install);
    else this.q.cardB.run(card, id, install);
    this.bump(f.a === install ? f.b : f.a);
    return { ok: true };
  }

  /**
   * Ends friendship [id] (either one may): gone for both, and with it what they shared through it —
   * the docs of one that the other was in (they leave them; the owner keeps the doc).
   */
  unfriend(install, id) {
    const f = typeof id === 'string' && ID.test(id) ? this.q.friend.get(id) : null;
    if (!f || (f.a !== install && f.b !== install)) return { ok: true };
    const touched = new Set();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const m of this.q.membersVia.all(id)) {
        this.q.dropMember.run(m.doc, m.install);
        touched.add(m.doc);
      }
      this.q.dropFriend.run(id);
      for (const doc of touched) this.dropIfAlone(doc);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    const others = [];
    for (const doc of touched) {
      for (const m of this.q.members.all(doc)) others.push(m.install);
      this.dropHere(doc);
      this.wakeDoc(doc);
    }
    this.bump(f.a, f.b, ...others);
    return { ok: true };
  }

  // ------------------------------------------------------------------ docs

  /** The friendship [friendId] of [install], with the other one's install; 404 when it isn't theirs. */
  friendOf(install, friendId) {
    const f = typeof friendId === 'string' && ID.test(friendId) ? this.q.friend.get(friendId) : null;
    if (!f || (f.a !== install && f.b !== install)) throw gone('Amizade não existe mais.');
    return { f, other: f.a === install ? f.b : f.a };
  }

  /** [install] shares a new doc [id] with friends: { id, members: [{ friend, key }] }. */
  share(install, body) {
    const id = body?.id;
    if (typeof id !== 'string' || !ID.test(id)) throw bad('id inválido.');
    if (this.q.doc.get(id)) throw new HttpError(409, 'exists', 'Já existe.');
    const members = Array.isArray(body?.members) ? body.members : [];
    if (!members.length || members.length > this.maxMembers) throw bad(`members: de 1 a ${this.maxMembers}.`);
    if (this.q.countDocs.get(install).n >= this.maxDocs) throw new HttpError(409, 'too_many_docs', 'Coisas compartilhadas demais.');
    const rows = members.map((m) => {
      const { other } = this.friendOf(install, m?.friend);
      return { install: other, key: sealed(m?.key, 512, 'Chave'), via: m.friend };
    });
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.q.newDoc.run(id, install, now);
      this.q.addMember.run(id, install, '', null, now);
      for (const r of rows) this.q.addMember.run(id, r.install, r.key, r.via, now);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.bump(...rows.map((r) => r.install));
    return { doc: id, me: this.tag(id, install) };
  }

  /** The owner adds friends ({ add: [{ friend, key }] }) and takes them out ({ remove: [friend] }). */
  members(install, id, body) {
    const doc = this.ownDoc(install, id);
    const add = (Array.isArray(body?.add) ? body.add : []).map((m) => {
      const { other } = this.friendOf(install, m?.friend);
      return { install: other, key: sealed(m?.key, 512, 'Chave'), via: m.friend };
    });
    const remove = (Array.isArray(body?.remove) ? body.remove : []).map((friend) => {
      const f = typeof friend === 'string' && ID.test(friend) ? this.q.friend.get(friend) : null;
      return f && (f.a === install || f.b === install) ? (f.a === install ? f.b : f.a) : null;
    }).filter(Boolean);
    const before = this.q.members.all(id).map((m) => m.install);
    if (new Set([...before, ...add.map((a) => a.install)]).size - remove.length > this.maxMembers + 1) throw bad('Gente demais.');
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of add) this.q.addMember.run(id, r.install, r.key, r.via, now);
      for (const i of remove) if (i !== doc.owner) this.q.dropMember.run(id, i);
      if (remove.length) this.dropIfAlone(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.dropHere(id);
    this.wakeDoc(id);
    this.bump(...before, ...add.map((a) => a.install));
    return { ok: true };
  }

  ownDoc(install, id) {
    const doc = typeof id === 'string' && ID.test(id) ? this.q.doc.get(id) : null;
    if (!doc || doc.owner !== install) throw gone();
    return doc;
  }

  /** A doc [install] is in; 404 otherwise (as if it didn't exist). */
  memberDoc(install, id) {
    const doc = typeof id === 'string' && ID.test(id) ? this.q.doc.get(id) : null;
    if (!doc || !this.q.member.get(id, install)) throw gone();
    return doc;
  }

  /** The owner ends it (for everyone); anyone else leaves it. */
  leave(install, id) {
    const doc = typeof id === 'string' && ID.test(id) ? this.q.doc.get(id) : null;
    if (!doc || !this.q.member.get(id, install)) return { ok: true };
    const all = this.q.members.all(id).map((m) => m.install);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (doc.owner === install) {
        this.q.dropOps.run(id);
        this.q.dropMembers.run(id);
        this.q.dropDoc.run(id);
      } else {
        this.q.dropMember.run(id, install);
        this.dropIfAlone(id);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.dropHere(id);
    this.wakeDoc(id);
    this.bump(...all);
    return { ok: true };
  }

  /**
   * The docs [install] is in: their key (wrapped for them), the friendship it came by (null: theirs),
   * who is in (the owner sees friendships; the others, how many) and the last change's number.
   */
  docs(install) {
    const out = this.q.docsOf.all(install).map((d) => {
      const mine = d.owner === install;
      const members = this.q.members.all(d.id);
      return {
        id: d.id,
        owner: mine,
        via: d.via,
        key: d.key || null,
        head: d.seq,
        me: this.tag(d.id, install),
        friends: mine ? members.filter((m) => m.via).map((m) => m.via) : undefined,
        count: members.length,
      };
    });
    return { docs: out, seq: this.seqOf(install) };
  }

  /** The doc's own name for a member (the same for everyone in it, nothing outside it). */
  tag(doc, install) {
    return crypto.createHash('sha256').update(`${doc}\n${install}`).digest('base64url').slice(0, 12);
  }

  /** Changes of [install] to doc [id]: each encrypted, kept in order. */
  push(install, id, body) {
    const doc = this.memberDoc(install, id);
    const ops = Array.isArray(body?.ops) ? body.ops : null;
    if (!ops || !ops.length || ops.length > this.maxOps) throw bad(`ops: de 1 a ${this.maxOps}.`);
    const data = ops.map((o) => {
      if (typeof o !== 'string' || !B64.test(o)) throw bad('op: base64.');
      const b = Buffer.from(o, 'base64');
      if (b.length < 28 || b.length > this.maxOp) throw bad('op de tamanho inválido.');
      return b;
    });
    const adding = data.reduce((n, b) => n + b.length, 0);
    if (doc.bytes + adding > this.maxDocBytes) throw new HttpError(507, 'doc_full', 'Grande demais: precisa de um retrato.');
    let seq = doc.seq;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const b of data) this.q.addOp.run(id, ++seq, b);
      this.q.bumpDoc.run(seq, doc.bytes + adding, id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.wakeDoc(id);
    this.bump(...this.q.members.all(id).map((m) => m.install).filter((i) => i !== install));
    return { seq };
  }

  /**
   * A picture of the whole doc up to [upTo] (encrypted, as one op): the changes up to it go, and who
   * comes later starts from it.
   */
  snapshot(install, id, body) {
    const doc = this.memberDoc(install, id);
    const upTo = body?.upTo;
    if (!Number.isSafeInteger(upTo) || upTo <= doc.snap_seq || upTo > doc.seq) throw bad('upTo inválido.');
    if (typeof body?.d !== 'string' || !B64.test(body.d)) throw bad('d: base64.');
    const snap = Buffer.from(body.d, 'base64');
    if (snap.length < 28 || snap.length > this.maxDocBytes / 2) throw bad('Retrato de tamanho inválido.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.q.dropOpsUpTo.run(id, upTo);
      const rest = this.q.opsBytes.get(id).n;
      this.q.setSnap.run(upTo, snap, rest + snap.length, id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { ok: true };
  }

  /**
   * What changed after [since]: { ops: [{ s, d }], head, more, snap?: { upTo, d }, here: [{ m, d }], hv, me }.
   * With [wait], waits until there is a change or someone moved (their "here" is newer than [hv]).
   */
  async changes(install, id, since, hv, wait, signal) {
    let doc = this.memberDoc(install, id);
    const from = Number.isSafeInteger(since) && since >= 0 ? since : 0;
    const me = this.tag(id, install);
    const hereV = () => this.here.get(id)?.v ?? 0;
    // [hv] < 0: only the changes matter (whoever moved doesn't wake it).
    if (wait && doc.seq <= from && (hv < 0 || hereV() === hv)) {
      await this.wait(this.docWaiters, id, install, wait, signal);
      doc = this.q.doc.get(id);
      if (!doc || !this.q.member.get(id, install)) throw gone();
    }
    const out = { head: doc.seq, me, hv: hereV(), here: this.hereOf(id, me) };
    let after = from;
    if (from < doc.snap_seq) {
      const s = this.q.snap.get(id);
      if (s?.snap) out.snap = { upTo: s.snap_seq, d: Buffer.from(s.snap).toString('base64') };
      after = doc.snap_seq;
    }
    const rows = this.q.ops.all(id, after, 1001);
    out.more = rows.length > 1000;
    out.ops = rows.slice(0, 1000).map((r) => ({ s: r.seq, d: Buffer.from(r.data).toString('base64') }));
    return out;
  }

  /** Where [install] is in doc [id] now (encrypted, a few seconds), told to the others at once. */
  setHere(install, id, body) {
    this.memberDoc(install, id);
    let d = body?.d;
    if (d !== null) {
      if (typeof d !== 'string' || !B64.test(d) || d.length > 4096) throw bad('d: base64, pequeno.');
    }
    let h = this.here.get(id);
    if (!h) this.here.set(id, (h = { v: 0, by: new Map() }));
    const tag = this.tag(id, install);
    if (d === null) h.by.delete(tag);
    else h.by.set(tag, { d, at: this.now() });
    h.v += 1;
    this.wakeDoc(id);
    return { hv: h.v };
  }

  hereOf(id, me) {
    const h = this.here.get(id);
    if (!h) return [];
    const now = this.now();
    const out = [];
    for (const [tag, p] of h.by) if (tag !== me && now - p.at <= this.hereTtl) out.push({ m: tag, d: p.d });
    return out;
  }

  /** A doc with nobody left but its owner isn't shared any more: gone (the owner keeps their entry). */
  dropIfAlone(id) {
    const left = this.q.members.all(id);
    if (left.length > 1) return [];
    this.q.dropOps.run(id);
    this.q.dropMembers.run(id);
    this.q.dropDoc.run(id);
    this.here.delete(id);
    return left.map((m) => m.install);
  }

  dropHere(id) {
    const h = this.here.get(id);
    if (h) {
      h.by.clear();
      h.v += 1;
    }
  }
}
