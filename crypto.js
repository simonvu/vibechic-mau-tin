/* Team password crypto — PBKDF2-SHA256 + AES-GCM. Password never stored in repo/code. */
(function (global) {
  'use strict';

  const KDF_ITERATIONS = 300000;
  const IV_BYTES = 12;
  const SALT_BYTES = 16;
  const META_FILE = 'crypto-meta.json';
  const VERIFIER_PLAINTEXT = 'vibechic-ok';

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
      false,
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

  async function makeVerifier(key) {
    return encryptText(key, VERIFIER_PLAINTEXT);
  }

  async function checkVerifier(key, meta) {
    if (!meta || !meta.verifier || !isEncryptedEnvelope(meta.verifier)) {
      throw new Error('no verifier');
    }
    const text = await decryptText(key, meta.verifier);
    if (text !== VERIFIER_PLAINTEXT) throw new Error('bad verifier');
    return true;
  }

  /* ---- Per-device private cloud key (recovery code) ---- */
  // Crockford Base32 (no I,L,O,U)
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const DEVICE_HKDF_INFO = 'vibechic-device-aes-v1';
  const TEAM_WRITE_PREFIX = 'vibechic-device-write-v1:';

  function bytesToCrockford(bytes) {
    let bits = 0, value = 0, out = '';
    for (let i = 0; i < bytes.length; i++) {
      value = (value << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) {
        out += CROCKFORD[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
    return out;
  }
  function crockfordToBytes(str) {
    const cleaned = String(str || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
      .replace(/O/g, '0').replace(/[IL]/g, '1');
    let bits = 0, value = 0;
    const out = [];
    for (let i = 0; i < cleaned.length; i++) {
      const idx = CROCKFORD.indexOf(cleaned[i]);
      if (idx < 0) throw new Error('bad recovery char');
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return new Uint8Array(out);
  }
  function formatRecoveryCode(crockford) {
    const s = String(crockford || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    const parts = [];
    for (let i = 0; i < s.length; i += 4) parts.push(s.slice(i, i + 4));
    return parts.join('-');
  }
  function parseRecoveryCode(input) {
    const bytes = crockfordToBytes(input);
    if (bytes.length < 16) throw new Error('mã quá ngắn');
    return bytes.slice(0, 16); // use first 16 bytes (>=128-bit)
  }

  function generateDeviceKeyBytes() {
    return randomBytes(16); // 128-bit
  }

  async function deviceIdFromKeyBytes(keyBytes) {
    const dig = await crypto.subtle.digest('SHA-256', keyBytes);
    const u8 = new Uint8Array(dig);
    let hex = '';
    for (let i = 0; i < u8.length; i++) hex += u8[i].toString(16).padStart(2, '0');
    return hex;
  }

  async function deriveDeviceAesKey(keyBytes) {
    const base = await crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('vibechic-device-salt-v1'),
        info: new TextEncoder().encode(DEVICE_HKDF_INFO)
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function deriveTeamWriteToken(teamPassword) {
    const dig = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(TEAM_WRITE_PREFIX + teamPassword)
    );
    const u8 = new Uint8Array(dig);
    let hex = '';
    for (let i = 0; i < u8.length; i++) hex += u8[i].toString(16).padStart(2, '0');
    return hex;
  }

  global.VCCrypto = {
    KDF_ITERATIONS, META_FILE, IV_BYTES, VERIFIER_PLAINTEXT,
    TEAM_WRITE_PREFIX,
    b64encode, b64decode, randomBytes,
    deriveKey, encryptBytes, decryptBytes, encryptText, decryptText,
    isEncryptedEnvelope, newMeta, makeVerifier, checkVerifier,
    generateDeviceKeyBytes, formatRecoveryCode, parseRecoveryCode,
    deviceIdFromKeyBytes, deriveDeviceAesKey, deriveTeamWriteToken,
    bytesToCrockford, crockfordToBytes
  };
})(typeof window !== 'undefined' ? window : globalThis);
