#!/usr/bin/env node
/** Verify R2 public pack using the same crypto.js as the phone app. Reads VIBECHIC_TEAM_PASSWORD from env; never prints it. */
const { webcrypto } = require('crypto');
const path = require('path');
globalThis.crypto = webcrypto;
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
require(path.join(__dirname, '..', 'crypto.js'));
const C = globalThis.VCCrypto;

const base = process.env.VIBECHIC_PUBLIC_BASE || 'https://vibechic-admin.tusinh-information.workers.dev/public';
const pw = process.env.VIBECHIC_TEAM_PASSWORD;
if (!pw) { console.error('set VIBECHIC_TEAM_PASSWORD'); process.exit(2); }

(async () => {
  const meta = await (await fetch(base + '/crypto-meta.json?_=' + Date.now(), { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
  const enc = await (await fetch(base + '/templates.json?_=' + Date.now(), { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
  const key = await C.deriveKey(pw, meta.salt, meta.iterations);
  await C.checkVerifier(key, meta);
  const pack = JSON.parse(await C.decryptText(key, enc));
  console.log(JSON.stringify({
    ok: true,
    products: (pack.products || []).length,
    hasVerifier: !!(meta.verifier && meta.verifier.iv),
    passwordIdPrefix: String(meta.passwordId || '').slice(0, 8),
    iterations: meta.iterations
  }));
})().catch((e) => { console.error('FAIL', e && e.message || e); process.exit(1); });
