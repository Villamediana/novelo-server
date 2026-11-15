import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { verifyAttestation, parseKeyDescription, googleRoots, KEY_DESCRIPTION } from '../src/attest.js';
import { extension } from '../src/der.js';

// A real chain from a phone (Google's android-key-attestation test data, Apache 2.0).
const pems = JSON.parse(fs.readFileSync(new URL('./fixtures/google-tee-chain.json', import.meta.url), 'utf8'));
const chain = pems.map((p) => new crypto.X509Certificate(p).raw);
const leaf = new crypto.X509Certificate(chain[0]);
const described = parseKeyDescription(extension(chain[0], KEY_DESCRIPTION));
const base = {
  chain,
  challenge: Buffer.from('abc'),
  publicKey: leaf.publicKey.export({ type: 'spki', format: 'der' }),
  packages: ['com.android.settings'],
  digests: described.digests,
  roots: googleRoots(),
  now: new Date('2026-11-15T00:00:00Z'),
};

test('reads what the phone says of the key', () => {
  assert.equal(described.level, 'tee');
  assert.equal(described.challenge.toString(), 'abc');
  assert.ok(described.packages.includes('com.android.settings'));
  assert.equal(described.digests.length, 1);
  assert.equal(described.boot, 'unverified');
});

test('a real chain is accepted, with or without the root in it', () => {
  assert.deepEqual(verifyAttestation(base), { ok: true, reason: '', level: 'tee', boot: 'unverified', locked: false });
  assert.equal(verifyAttestation({ ...base, chain: chain.slice(0, 3) }).ok, true);
});

test('what does not match is refused', () => {
  const no = (over) => verifyAttestation({ ...base, ...over });
  assert.match(no({ challenge: Buffer.from('abd') }).reason, /desafio/);
  assert.match(no({ packages: ['com.villamediana.novelo'] }).reason, /pacote/);
  assert.match(no({ digests: ['00'.repeat(32)] }).reason, /assinatura/);
  assert.match(no({ publicKey: Buffer.from('outra') }).reason, /chave não é/);
  assert.match(no({ roots: [] }).reason, /raiz/);
  assert.match(no({ now: new Date('2031-01-01') }).reason, /validade/);
  assert.match(no({ chain: [chain[0], chain[2], chain[3]] }).reason, /quebrada/);
  assert.match(no({ chain: chain.slice(1) }).reason, /sem descrição/);
  assert.match(no({ chain: [Buffer.from('lixo'), chain[1]] }).reason, /ilegível/);
  assert.equal(no({ chain: [] }).ok, false);
});

test('a revoked certificate anywhere in the chain is refused (serial in hex or decimal)', () => {
  const serial = new crypto.X509Certificate(chain[1]).serialNumber.toLowerCase().replace(/^0+/, '');
  assert.match(verifyAttestation({ ...base, revoked: new Set([serial]) }).reason, /revogado/);
  assert.match(verifyAttestation({ ...base, revoked: new Set([BigInt('0x' + serial).toString(10)]) }).reason, /revogado/);
});

test('without the app certificate configured it passes, saying so', () => {
  const r = verifyAttestation({ ...base, digests: [] });
  assert.equal(r.ok, true);
  assert.match(r.reason, /falta configurar/);
});
