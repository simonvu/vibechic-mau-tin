#!/usr/bin/env node
/**
 * E2E v21 — push/pull/delete per-product team extra images
 * Never prints passwords or tokens.
 */
const { webcrypto } = require('crypto');
const path = require('path');
globalThis.crypto = webcrypto;
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
require(path.join(__dirname, '..', 'crypto.js'));
const C = globalThis.VCCrypto;

const BASE = process.env.VIBECHIC_WORKER_BASE || 'https://vibechic-admin.tusinh-information.workers.dev';
const teamPw = process.env.VIBECHIC_TEAM_PASSWORD;
if (!teamPw) { console.error('missing VIBECHIC_TEAM_PASSWORD'); process.exit(2); }

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function log(o) { console.log(JSON.stringify(o)); }
function metaHeaders(obj) {
  const json = JSON.stringify(obj);
  return {
    'X-VC-Item-Meta': Buffer.from(json, 'utf8').toString('base64'),
    'X-VC-Item-Meta-Enc': 'b64'
  };
}

async function main() {
  const teamToken = await C.deriveTeamWriteToken(teamPw);
  assert(teamToken.length === 64, 'token');

  const metaRes = await fetch(BASE + '/public/crypto-meta.json?_=' + Date.now(), { cache: 'no-store' });
  assert(metaRes.ok, 'crypto-meta ' + metaRes.status);
  const meta = await metaRes.json();
  const teamKey = await C.deriveKey(teamPw, meta.salt, meta.iterations || C.KDF_ITERATIONS);
  assert(await C.checkVerifier(teamKey, meta), 'verifier');

  const keyA = C.generateDeviceKeyBytes();
  const keyB = C.generateDeviceKeyBytes();
  const idA = await C.deviceIdFromKeyBytes(keyA);
  const idB = await C.deviceIdFromKeyBytes(keyB);
  log({ step: 'devices', a: idA.slice(0, 8), b: idB.slice(0, 8) });

  const productId = 'extra-e2e-' + Date.now().toString(36);
  const imageId = 'tex-' + Date.now().toString(36);
  // tiny jpeg-ish bytes
  const plain = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4, 5, 6, 7, 8]);
  const env = await C.encryptBytes(teamKey, plain);

  // PUT without token → 403
  {
    const r = await fetch(BASE + '/team/extras/' + productId + '/images/' + imageId, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + idA,
        'Content-Type': 'application/json',
        ...metaHeaders({ authorName: 'E2E-A' })
      },
      body: JSON.stringify(env)
    });
    log({ step: 'put_no_token', status: r.status });
    assert(r.status === 403, 'expect 403');
  }

  // A pushes extra
  {
    const r = await fetch(BASE + '/team/extras/' + productId + '/images/' + imageId, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + idA,
        'Content-Type': 'application/json',
        'X-VC-Team-Token': teamToken,
        ...metaHeaders({ authorName: 'E2E-A' })
      },
      body: JSON.stringify(env)
    });
    const j = await r.json().catch(() => ({}));
    log({ step: 'put_A', status: r.status, ok: j.ok, bytes: j.bytes });
    assert(r.status === 200 && j.ok, 'put A');
    assert(j.entry && j.entry.authorDeviceId === idA, 'author');
  }

  // B lists extras
  {
    const r = await fetch(BASE + '/team/extras', {
      headers: { 'X-VC-Team-Token': teamToken }
    });
    const j = await r.json();
    log({ step: 'list', status: r.status, count: (j.items || []).length });
    assert(r.status === 200, 'list');
    const found = (j.items || []).find((x) => x.productId === productId);
    assert(found, 'product in list');
    assert((found.images || []).some((im) => im.id === imageId), 'image in meta');
  }

  // B gets product extras + decrypts image
  {
    const r = await fetch(BASE + '/team/extras/' + productId, {
      headers: { 'X-VC-Team-Token': teamToken }
    });
    const j = await r.json();
    log({ step: 'get_product', status: r.status, n: (j.images || []).length });
    assert(r.status === 200 && (j.images || []).length >= 1, 'get product');

    const ir = await fetch(BASE + '/team/images/' + imageId, {
      headers: { 'X-VC-Team-Token': teamToken }
    });
    assert(ir.ok, 'image get ' + ir.status);
    const enc = await ir.json();
    const bytes = await C.decryptBytes(teamKey, enc);
    assert(bytes.length === plain.length && bytes[0] === plain[0] && bytes[bytes.length - 1] === plain[plain.length - 1], 'roundtrip');
    log({ step: 'decrypt_ok', len: bytes.length });
  }

  // B cannot delete A's extra
  {
    const r = await fetch(BASE + '/team/extras/' + productId + '/images/' + imageId, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer ' + idB,
        'X-VC-Team-Token': teamToken
      }
    });
    const j = await r.json().catch(() => ({}));
    log({ step: 'delete_B', status: r.status, err: j.error });
    assert(r.status === 403, 'B forbidden');
  }

  // A deletes
  {
    const r = await fetch(BASE + '/team/extras/' + productId + '/images/' + imageId, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer ' + idA,
        'X-VC-Team-Token': teamToken
      }
    });
    const j = await r.json().catch(() => ({}));
    log({ step: 'delete_A', status: r.status, ok: j.ok });
    assert(r.status === 200 && j.ok, 'delete A');
  }

  // Gone
  {
    const r = await fetch(BASE + '/team/extras/' + productId, {
      headers: { 'X-VC-Team-Token': teamToken }
    });
    const j = await r.json();
    log({ step: 'after_delete', status: r.status, n: (j.images || []).length });
    assert((j.images || []).length === 0, 'cleaned');
  }

  // Ensure public/ not writable via team extras path (sanity: GET public still works)
  {
    const r = await fetch(BASE + '/public/crypto-meta.json');
    log({ step: 'public_ok', status: r.status });
    assert(r.ok, 'public');
  }

  log({ step: 'ALL_PASS' });
}

main().catch((e) => {
  console.error(JSON.stringify({ step: 'FAIL', error: String(e && e.message || e) }));
  process.exit(1);
});
