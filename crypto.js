/* Team password crypto — PBKDF2-SHA256 + AES-GCM. Password never stored in repo/code. */
(function (global) {
  'use strict';

  const KDF_ITERATIONS = 300000;
  const IV_BYTES = 12;
  const SALT_BYTES = 16;
  const META_FILE = 'crypto-meta.json';

  function b64encode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }
  function b64decode(str) {
    const bin = atob(str);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  function randomBytes(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return a;
  }

  async function deriveKey(password, saltB64, iterations) {
    const salt = b64decode(saltB64);
    const base = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iterations || KDF_ITERATIONS, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable
      ['encrypt', 'decrypt']
    );
  }

  async function encryptBytes(key, plainBytes) {
    const iv = randomBytes(IV_BYTES);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);
    return { v: 1, iv: b64encode(iv), ct: b64encode(ct) };
  }

  async function decryptBytes(key, envelope) {
    if (!envelope || !envelope.iv || !envelope.ct) throw new Error('bad envelope');
    const iv = b64decode(envelope.iv);
    const ct = b64decode(envelope.ct);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new Uint8Array(plain);
  }

  async function encryptText(key, text) {
    return encryptBytes(key, new TextEncoder().encode(text));
  }

  async function decryptText(key, envelope) {
    const bytes = await decryptBytes(key, envelope);
    return new TextDecoder().decode(bytes);
  }

  function isEncryptedEnvelope(obj) {
    return obj && typeof obj === 'object' && obj.iv && obj.ct && (obj.v === 1 || obj.v == null);
  }

  function newMeta({ saltB64, passwordId, iterations } = {}) {
    return {
      version: 1,
      kdf: 'PBKDF2-SHA256',
      iterations: iterations || KDF_ITERATIONS,
      salt: saltB64 || b64encode(randomBytes(SALT_BYTES)),
      passwordId: passwordId || (crypto.randomUUID ? crypto.randomUUID() : ('pid-' + Date.now().toString(36))),
      algo: 'AES-GCM',
      updatedAt: new Date().toISOString()
    };
  }

  global.VCCrypto = {
    KDF_ITERATIONS, META_FILE, IV_BYTES,
    b64encode, b64decode, randomBytes,
    deriveKey, encryptBytes, decryptBytes, encryptText, decryptText,
    isEncryptedEnvelope, newMeta
  };
})(typeof window !== 'undefined' ? window : globalThis);
