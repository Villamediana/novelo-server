// Friends and what they share, on a real server: invite by link, accept, end it; share a doc, write at
// once, see where the others are, leave. The server only ever sees opaque ids and bytes it can't open.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, Phone, signed, sleep } from './helpers.js';

let server, ana, bia, caio;

const pubKey = () => {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
};
// Sealed bytes as the phones make them (here just random: the server never opens them).
const sealed = (n = 64) => crypto.randomBytes(n).toString('base64url');
const op = (n = 40) => crypto.randomBytes(n).toString('base64');

before(async () => {
  server = await startServer();
  ana = new Phone(server.url);
  bia = new Phone(server.url);
  caio = new Phone(server.url);
  for (const p of [ana, bia, caio]) assert.equal((await p.register()).status, 200);
});

after(async () => {
  await server.close();
});

async function befriend(a, b) {
  const inv = await signed(a, 'POST', '/v1/friends/invite', { pub: pubKey(), card: sealed() });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const ok = await signed(b, 'POST', `/v1/friends/invite/${inv.json.code}/accept`, { pub: pubKey(), card: sealed() });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const theirs = (await signed(a, 'GET', '/v1/friends')).json.friends.find((f) => f.invite === inv.json.code);
  return { code: inv.json.code, a: theirs.id, b: ok.json.friend.id };
}

test('um convite por link: quem tem o link vê o cartão, aceita uma vez, e os dois são amigos', async () => {
  const pa = pubKey();
  const card = sealed(200);
  const inv = await signed(ana, 'POST', '/v1/friends/invite', { pub: pa, card });
  assert.equal(inv.status, 200);
  assert.match(inv.json.code, /^[A-Za-z0-9_-]{22}$/);
  // The secret is never sent: the server only has the code, the key and a card it can't open.
  const row = server.app.db.prepare('SELECT * FROM invites WHERE code = ?').get(inv.json.code);
  assert.deepEqual(Object.keys(row).sort(), ['card', 'code', 'created', 'install', 'pub']);

  const seen = await signed(bia, 'GET', `/v1/friends/invite/${inv.json.code}`);
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.json, { pub: pa, card, mine: false });
  // Ana's own link, opened by her: hers.
  assert.equal((await signed(ana, 'GET', `/v1/friends/invite/${inv.json.code}`)).json.mine, true);
  assert.equal((await signed(ana, 'POST', `/v1/friends/invite/${inv.json.code}/accept`, { pub: pubKey(), card: sealed() })).status, 409);

  // Ana waits on her feed; Bia accepts: it wakes.
  const before = (await signed(ana, 'GET', '/v1/social')).json.seq;
  const waiting = signed(ana, 'GET', `/v1/social?since=${before}&wait=10`);
  await sleep(50);
  const pb = pubKey();
  const bcard = sealed(120);
  const ok = await signed(bia, 'POST', `/v1/friends/invite/${inv.json.code}/accept`, { pub: pb, card: bcard });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.already, false);
  assert.equal(ok.json.friend.pub, pa);
  assert.equal(ok.json.friend.card, card);
  assert.equal(ok.json.friend.inviter, false);
  const woke = await waiting;
  assert.notEqual(woke.json.seq, before);

  const mine = (await signed(ana, 'GET', '/v1/friends')).json;
  assert.equal(mine.friends.length, 1);
  assert.equal(mine.friends[0].pub, pb);
  assert.equal(mine.friends[0].card, bcard);
  assert.equal(mine.friends[0].inviter, true);
  assert.equal(mine.friends[0].invite, inv.json.code);
  assert.equal(mine.invites.length, 0);

  // Used: gone for anyone else.
  assert.equal((await signed(caio, 'GET', `/v1/friends/invite/${inv.json.code}`)).status, 404);
  assert.equal((await signed(caio, 'POST', `/v1/friends/invite/${inv.json.code}/accept`, { pub: pubKey(), card: sealed() })).status, 404);

  // A new card (another name): the other one gets it.
  const fid = mine.friends[0].id;
  const newCard = sealed(90);
  assert.equal((await signed(ana, 'PUT', `/v1/friends/${fid}/card`, { card: newCard })).status, 200);
  assert.equal((await signed(bia, 'GET', '/v1/friends')).json.friends[0].card, newCard);

  // Friends already: a second link between them is the same friendship.
  const again = await signed(bia, 'POST', '/v1/friends/invite', { pub: pubKey(), card: sealed() });
  const twice = await signed(ana, 'POST', `/v1/friends/invite/${again.json.code}/accept`, { pub: pubKey(), card: sealed() });
  assert.equal(twice.json.already, true);
  assert.equal(twice.json.friend.id, fid);
  assert.equal((await signed(ana, 'GET', '/v1/friends')).json.friends.length, 1);

  // Either one ends it: gone for both.
  assert.equal((await signed(bia, 'DELETE', `/v1/friends/${fid}`)).status, 200);
  assert.equal((await signed(ana, 'GET', '/v1/friends')).json.friends.length, 0);
  assert.equal((await signed(bia, 'GET', '/v1/friends')).json.friends.length, 0);
});

test('convites: expiram, o dono desfaz, um número máximo aberto, e nada inválido entra', async () => {
  const inv = await signed(caio, 'POST', '/v1/friends/invite', { pub: pubKey(), card: sealed() });
  assert.equal((await signed(caio, 'GET', '/v1/friends')).json.invites.length, 1);
  assert.equal((await signed(caio, 'DELETE', `/v1/friends/invite/${inv.json.code}`)).status, 200);
  assert.equal((await signed(bia, 'GET', `/v1/friends/invite/${inv.json.code}`)).status, 404);

  const old = await signed(caio, 'POST', '/v1/friends/invite', { pub: pubKey(), card: sealed() });
  server.app.db.prepare('UPDATE invites SET created = ? WHERE code = ?').run(Date.now() - 8 * 24 * 3600_000, old.json.code);
  assert.equal((await signed(bia, 'GET', `/v1/friends/invite/${old.json.code}`)).status, 404);
  server.app.social.prune();
  assert.equal(server.app.db.prepare('SELECT COUNT(*) n FROM invites WHERE code = ?').get(old.json.code).n, 0);

  assert.equal((await signed(caio, 'POST', '/v1/friends/invite', { pub: 'abc', card: sealed() })).status, 422);
  assert.equal((await signed(caio, 'POST', '/v1/friends/invite', { pub: pubKey(), card: 'x' })).status, 422);
  for (let i = 0; i < 20; i++) await signed(caio, 'POST', '/v1/friends/invite', { pub: pubKey(), card: sealed() });
  assert.equal((await signed(caio, 'POST', '/v1/friends/invite', { pub: pubKey(), card: sealed() })).status, 429);
  server.app.db.prepare('DELETE FROM invites').run();

  // Not a phone of the Novelo: nothing.
  const res = await fetch(`${server.url}/v1/friends`);
  assert.equal(res.status, 401);
});

test('compartilhar: só com amigos; quem está vê, escreve e espera junto; quem não está não vê nada', async () => {
  const ab = await befriend(ana, bia);
  const ac = await befriend(ana, caio);
  const id = crypto.randomBytes(18).toString('base64url');
  // Only with friends.
  assert.equal((await signed(bia, 'POST', '/v1/docs', { id, members: [{ friend: ac.a, key: sealed(60) }] })).status, 404);
  const made = await signed(ana, 'POST', '/v1/docs', { id, members: [{ friend: ab.a, key: sealed(60) }] });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal(made.json.doc, id);

  const biaDocs = (await signed(bia, 'GET', '/v1/docs')).json.docs;
  assert.equal(biaDocs.length, 1);
  assert.equal(biaDocs[0].owner, false);
  assert.equal(biaDocs[0].via, ab.b);
  assert.ok(biaDocs[0].key);
  assert.equal(biaDocs[0].count, 2);
  const anaDocs = (await signed(ana, 'GET', '/v1/docs')).json.docs;
  assert.equal(anaDocs[0].owner, true);
  assert.deepEqual(anaDocs[0].friends, [ab.a]);
  // Caio isn't in it: as if it didn't exist.
  assert.equal((await signed(caio, 'GET', '/v1/docs')).json.docs.length, 0);
  assert.equal((await signed(caio, 'GET', `/v1/docs/${id}/ops`)).status, 404);
  assert.equal((await signed(caio, 'POST', `/v1/docs/${id}/ops`, { ops: [op()] })).status, 404);

  // Bia waits; Ana writes: it wakes with the change.
  const waiting = signed(bia, 'GET', `/v1/docs/${id}/ops?since=0&wait=10`);
  await sleep(50);
  const first = op(100);
  assert.equal((await signed(ana, 'POST', `/v1/docs/${id}/ops`, { ops: [first] })).json.seq, 1);
  const got = await waiting;
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.ops, [{ s: 1, d: first }]);
  assert.equal(got.json.head, 1);

  // Both at once: every change in one order for everyone.
  const [x, y] = await Promise.all([
    signed(ana, 'POST', `/v1/docs/${id}/ops`, { ops: [op(), op()] }),
    signed(bia, 'POST', `/v1/docs/${id}/ops`, { ops: [op()] }),
  ]);
  assert.equal(x.status + y.status, 400);
  const all = (await signed(ana, 'GET', `/v1/docs/${id}/ops?since=0`)).json;
  assert.deepEqual(all.ops.map((o) => o.s), [1, 2, 3, 4]);

  // Too big, not base64: refused.
  assert.equal((await signed(ana, 'POST', `/v1/docs/${id}/ops`, { ops: [crypto.randomBytes(70 * 1024).toString('base64')] })).status, 422);
  assert.equal((await signed(ana, 'POST', `/v1/docs/${id}/ops`, { ops: ['não é base64!'] })).status, 422);

  // Caio comes in later (Ana adds him): he sees it all.
  assert.equal((await signed(ana, 'PUT', `/v1/docs/${id}/members`, { add: [{ friend: ac.a, key: sealed(60) }] })).status, 200);
  assert.equal((await signed(caio, 'GET', `/v1/docs/${id}/ops?since=0`)).json.ops.length, 4);
  assert.equal((await signed(caio, 'GET', '/v1/docs')).json.docs[0].count, 3);
  // Ana takes him out again.
  assert.equal((await signed(ana, 'PUT', `/v1/docs/${id}/members`, { remove: [ac.a] })).status, 200);
  assert.equal((await signed(caio, 'GET', `/v1/docs/${id}/ops`)).status, 404);
  // And Bia too: nobody left but Ana, it isn't shared any more.
  assert.equal((await signed(ana, 'PUT', `/v1/docs/${id}/members`, { remove: [ab.a] })).status, 200);
  assert.equal((await signed(ana, 'GET', '/v1/docs')).json.docs.some((d) => d.id === id), false);
  assert.equal(server.app.db.prepare('SELECT COUNT(*) n FROM doc_ops WHERE doc = ?').get(id).n, 0);
});

test('onde cada um escreve: os outros veem na hora, o próprio não volta, e some sozinho', async () => {
  const ab = (await signed(ana, 'GET', '/v1/friends')).json.friends.find((f) => !f.inviter || f.inviter);
  const id = crypto.randomBytes(18).toString('base64url');
  const friend = (await signed(ana, 'GET', '/v1/friends')).json.friends;
  const toBia = friend.find((f) => f.id && f.invite) ?? ab;
  // The friendship with Bia: the one in Bia's list too.
  const biaIds = new Set((await signed(bia, 'GET', '/v1/friends')).json.friends.map((f) => f.id));
  const withBia = friend.find((f) => biaIds.has(f.id)) ?? toBia;
  assert.equal((await signed(ana, 'POST', '/v1/docs', { id, members: [{ friend: withBia.id, key: sealed(60) }] })).status, 200);

  const start = (await signed(bia, 'GET', `/v1/docs/${id}/ops?since=0`)).json;
  assert.deepEqual(start.here, []);
  const waiting = signed(bia, 'GET', `/v1/docs/${id}/ops?since=0&hv=${start.hv}&wait=10`);
  await sleep(50);
  const where = op(30);
  const put = await signed(ana, 'PUT', `/v1/docs/${id}/here`, { d: where });
  assert.equal(put.status, 200);
  const woke = (await waiting).json;
  assert.equal(woke.here.length, 1);
  assert.equal(woke.here[0].d, where);
  assert.notEqual(woke.here[0].m, woke.me);
  // Ana doesn't get her own back.
  assert.deepEqual((await signed(ana, 'GET', `/v1/docs/${id}/ops?since=0`)).json.here, []);
  // Left the page: gone at once; or by itself after a while.
  await signed(ana, 'PUT', `/v1/docs/${id}/here`, { d: null });
  assert.deepEqual((await signed(bia, 'GET', `/v1/docs/${id}/ops?since=0`)).json.here, []);
  await signed(ana, 'PUT', `/v1/docs/${id}/here`, { d: where });
  const h = server.app.social.here.get(id);
  for (const p of h.by.values()) p.at -= 60_000;
  assert.deepEqual((await signed(bia, 'GET', `/v1/docs/${id}/ops?since=0`)).json.here, []);
});

test('um retrato encurta o caminho de quem chega; sair e terminar', async () => {
  const biaIds = new Set((await signed(bia, 'GET', '/v1/friends')).json.friends.map((f) => f.id));
  const withBia = (await signed(ana, 'GET', '/v1/friends')).json.friends.find((f) => biaIds.has(f.id));
  const id = crypto.randomBytes(18).toString('base64url');
  await signed(ana, 'POST', '/v1/docs', { id, members: [{ friend: withBia.id, key: sealed(60) }] });
  for (let i = 0; i < 5; i++) await signed(ana, 'POST', `/v1/docs/${id}/ops`, { ops: [op()] });
  const snap = op(200);
  assert.equal((await signed(bia, 'POST', `/v1/docs/${id}/snapshot`, { upTo: 4, d: snap })).status, 200);
  assert.equal((await signed(bia, 'POST', `/v1/docs/${id}/snapshot`, { upTo: 9, d: snap })).status, 422);
  const late = (await signed(bia, 'GET', `/v1/docs/${id}/ops?since=0`)).json;
  assert.deepEqual(late.snap, { upTo: 4, d: snap });
  assert.deepEqual(late.ops.map((o) => o.s), [5]);
  // Who was already past it doesn't get it again.
  assert.equal((await signed(bia, 'GET', `/v1/docs/${id}/ops?since=4`)).json.snap, undefined);

  // Ana ends it: gone for everyone.
  assert.equal((await signed(ana, 'DELETE', `/v1/docs/${id}`)).status, 200);
  assert.equal((await signed(bia, 'GET', `/v1/docs/${id}/ops`)).status, 404);
  assert.equal(server.app.db.prepare('SELECT COUNT(*) n FROM doc_ops WHERE doc = ?').get(id).n, 0);
  assert.equal((await signed(ana, 'GET', `/v1/docs/${id}/ops`)).status, 404);
});

test('desfazer a amizade tira cada um do que o outro compartilhou', async () => {
  const biaIds = new Set((await signed(bia, 'GET', '/v1/friends')).json.friends.map((f) => f.id));
  const withBia = (await signed(ana, 'GET', '/v1/friends')).json.friends.find((f) => biaIds.has(f.id));
  const id = crypto.randomBytes(18).toString('base64url');
  await signed(ana, 'POST', '/v1/docs', { id, members: [{ friend: withBia.id, key: sealed(60) }] });
  assert.equal((await signed(bia, 'GET', '/v1/docs')).json.docs.some((d) => d.id === id), true);
  assert.equal((await signed(bia, 'DELETE', `/v1/friends/${withBia.id}`)).status, 200);
  assert.equal((await signed(bia, 'GET', '/v1/docs')).json.docs.some((d) => d.id === id), false);
  // Nobody left in it but Ana: not shared any more (she keeps her entry).
  assert.equal((await signed(ana, 'GET', '/v1/docs')).json.docs.some((d) => d.id === id), false);
  assert.equal((await signed(ana, 'POST', '/v1/docs', { id: crypto.randomBytes(18).toString('base64url'), members: [{ friend: withBia.id, key: sealed(60) }] })).status, 404);
});
