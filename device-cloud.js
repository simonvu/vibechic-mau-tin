/* Per-iPhone private cloud — encrypted snapshot + images on Worker /device/* */
(function (global) {
  'use strict';

  const C = () => global.VCCrypto;
  const CFG = () => global.VC_CONFIG || {};
  const META_DEVICE_KEY = 'deviceKeyB64';
  const META_TEAM_WRITE = 'teamWriteToken';
  const META_CLOUD_AT = 'deviceCloudSavedAt';
  const DEBOUNCE_MS = 2500;

  let uploadTimer = null;
  let lastStatus = '';
  let busy = false;

  function deviceBase() {
    return (CFG().deviceBaseUrl || CFG().pagesAdminUrl || '').replace(/\/$/, '') + '/device';
  }

  function b64encode(buf) {
    return C().b64encode(buf);
  }
  function b64decode(str) {
    return C().b64decode(str);
  }

  async function ensureDeviceKey(getMeta, setMeta) {
    let b64 = await getMeta(META_DEVICE_KEY);
    let bytes;
    if (b64) {
      bytes = b64decode(b64);
      if (bytes.length < 16) bytes = null;
    }
    if (!bytes) {
      bytes = C().generateDeviceKeyBytes();
      b64 = b64encode(bytes);
      await setMeta(META_DEVICE_KEY, b64);
    }
    const id = await C().deviceIdFromKeyBytes(bytes);
    const aes = await C().deriveDeviceAesKey(bytes);
    const code = C().formatRecoveryCode(C().bytesToCrockford(bytes));
    return { bytes, b64, id, aes, code };
  }

  async function restoreFromRecoveryCode(code, getMeta, setMeta) {
    const bytes = C().parseRecoveryCode(code);
    if (bytes.length < 16) throw new Error('Mã khôi phục không hợp lệ');
    const use = bytes.slice(0, 16);
    const b64 = b64encode(use);
    await setMeta(META_DEVICE_KEY, b64);
    const id = await C().deviceIdFromKeyBytes(use);
    const aes = await C().deriveDeviceAesKey(use);
    const formatted = C().formatRecoveryCode(C().bytesToCrockford(use));
    return { bytes: use, b64, id, aes, code: formatted };
  }

  async function getTeamWriteToken(getMeta) {
    return (await getMeta(META_TEAM_WRITE)) || '';
  }

  async function saveTeamWriteToken(setMeta, token) {
    await setMeta(META_TEAM_WRITE, token || '');
  }

  function authHeaders(deviceId, teamToken, writing) {
    const h = {
      Authorization: 'Bearer ' + deviceId,
      'Content-Type': 'application/json; charset=utf-8'
    };
    if (writing) {
      if (!teamToken) throw new Error('Cần mật khẩu đội (token ghi cloud)');
      h['X-VC-Team-Token'] = teamToken;
    }
    return h;
  }

  async function fetchDevice(path, { method, deviceId, teamToken, body } = {}) {
    const writing = method === 'PUT' || method === 'POST' || method === 'DELETE';
    const url = deviceBase() + path;
    const res = await fetch(url, {
      method: method || 'GET',
      headers: authHeaders(deviceId, teamToken, writing),
      body: body != null ? body : undefined,
      cache: 'no-store'
    });
    return res;
  }

  function dataURLToBytes(dataURL) {
    const m = String(dataURL || '').match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('bad dataURL');
    return b64decode(m[2]);
  }

  function bytesToJpegDataURL(bytes) {
    return 'data:image/jpeg;base64,' + b64encode(bytes);
  }

  async function buildPersonalSnapshot(products, localPins) {
    const imagePayloads = []; // { id, bytes }
    function packImage(im, j) {
      const id = im.id || ('img-' + j);
      if (im.dataURL && (im.source === 'local' || im.personalCloud)) {
        try { imagePayloads.push({ id, bytes: dataURLToBytes(im.dataURL) }); } catch (_) {}
        return { id, source: 'personal', personalCloud: true, sortOrder: im.sortOrder != null ? im.sortOrder : j };
      }
      return {
        id,
        source: im.source || 'synced',
        path: im.path || null,
        hash: im.hash || null,
        sortOrder: im.sortOrder != null ? im.sortOrder : j
      };
    }
    const personal = (products || []).filter((p) => p && p.personal);
    const packed = personal.map((p) => ({
      id: p.id,
      title: p.title,
      category: p.category,
      variants: p.variants || [],
      images: (p.images || []).map(packImage),
      personal: true,
      sortOrder: p.sortOrder || 0,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt || Date.now()
    }));
    // Local-only images attached to shared team products
    const localImageOverlays = {};
    for (const p of (products || [])) {
      if (!p || p.personal) continue;
      const locals = (p.images || []).filter((im) => im && im.dataURL && (im.source === 'local' || im.personalCloud));
      if (!locals.length) continue;
      localImageOverlays[p.id] = locals.map(packImage);
    }
    return {
      snapshot: {
        v: 1,
        kind: 'device-personal',
        updatedAt: new Date().toISOString(),
        localPins: localPins || {},
        products: packed,
        localImageOverlays,
        imageIds: imagePayloads.map((x) => x.id)
      },
      imagePayloads
    };
  }

  async function uploadPersonalCloud({ getMeta, setMeta, products, localPins, onStatus }) {
    if (busy) return { ok: false, skipped: true };
    busy = true;
    try {
      const tok = await getTeamWriteToken(getMeta);
      if (!tok) {
        onStatus && onStatus('Cloud cá nhân: cần mở khóa mật khẩu đội để lưu');
        return { ok: false, needTeam: true };
      }
      const dev = await ensureDeviceKey(getMeta, setMeta);
      const { snapshot, imagePayloads } = await buildPersonalSnapshot(products, localPins);
      onStatus && onStatus('Đang mã hóa / lưu cloud cá nhân…');

      for (const img of imagePayloads) {
        const env = await C().encryptBytes(dev.aes, img.bytes);
        const body = JSON.stringify(env);
        const res = await fetchDevice('/image/' + encodeURIComponent(img.id), {
          method: 'PUT',
          deviceId: dev.id,
          teamToken: tok,
          body
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || ('ảnh HTTP ' + res.status));
        }
      }

      const encSnap = await C().encryptText(dev.aes, JSON.stringify(snapshot));
      const res = await fetchDevice('/snapshot', {
        method: 'PUT',
        deviceId: dev.id,
        teamToken: tok,
        body: JSON.stringify(encSnap)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || ('snapshot HTTP ' + res.status));
      }
      const at = Date.now();
      await setMeta(META_CLOUD_AT, at);
      const label = 'Đã lưu lên cloud lúc ' + new Date(at).toLocaleString('vi-VN');
      lastStatus = label;
      onStatus && onStatus(label);
      return { ok: true, at };
    } catch (e) {
      const msg = 'Cloud cá nhân lỗi: ' + (e.message || e);
      lastStatus = msg;
      onStatus && onStatus(msg);
      return { ok: false, error: e };
    } finally {
      busy = false;
    }
  }

  function scheduleUpload(ctx) {
    if (uploadTimer) clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => {
      uploadPersonalCloud(ctx);
    }, DEBOUNCE_MS);
  }

  async function pullAndMerge({ getMeta, setMeta, mergePersonal, onStatus }) {
    try {
      const dev = await ensureDeviceKey(getMeta, setMeta);
      onStatus && onStatus('Đang kéo cloud cá nhân…');
      const res = await fetchDevice('/snapshot', { method: 'GET', deviceId: dev.id });
      if (res.status === 404) {
        onStatus && onStatus('Chưa có bản cloud cá nhân');
        return { ok: true, empty: true };
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const enc = await res.json();
      if (!C().isEncryptedEnvelope(enc)) throw new Error('snapshot không phải bản mã hóa');
      let text;
      try {
        text = await C().decryptText(dev.aes, enc);
      } catch (_) {
        throw new Error('Không giải mã được snapshot — sai mã khôi phục?');
      }
      const snap = JSON.parse(text);
      const products = snap.products || [];
      // hydrate personal images
      for (const p of products) {
        const imgs = [];
        for (const im of (p.images || [])) {
          if (im.personalCloud || im.source === 'personal') {
            try {
              const ir = await fetchDevice('/image/' + encodeURIComponent(im.id), {
                method: 'GET',
                deviceId: dev.id
              });
              if (ir.ok) {
                const env = await ir.json();
                const bytes = await C().decryptBytes(dev.aes, env);
                imgs.push({
                  ...im,
                  dataURL: bytesToJpegDataURL(bytes),
                  source: 'local',
                  personalCloud: true
                });
                continue;
              }
            } catch (e) {
              console.warn('personal img', im.id, e);
            }
          }
          imgs.push(im);
        }
        p.images = imgs;
        p.personal = true;
      }
      // Hydrate overlay images for shared products
      const overlays = snap.localImageOverlays || {};
      for (const pid of Object.keys(overlays)) {
        const list = overlays[pid] || [];
        for (let i = 0; i < list.length; i++) {
          const im = list[i];
          if (!(im.personalCloud || im.source === 'personal')) continue;
          try {
            const ir = await fetchDevice('/image/' + encodeURIComponent(im.id), { method: 'GET', deviceId: dev.id });
            if (!ir.ok) continue;
            const env = await ir.json();
            const bytes = await C().decryptBytes(dev.aes, env);
            list[i] = { ...im, dataURL: bytesToJpegDataURL(bytes), source: 'local', personalCloud: true };
          } catch (_) {}
        }
        overlays[pid] = list;
      }
      await mergePersonal(products, snap.localPins || {}, overlays);
      const savedAt = snap.updatedAt ? Date.parse(snap.updatedAt) : Date.now();
      await setMeta(META_CLOUD_AT, savedAt);
      const label = 'Đã khôi phục cloud · cập nhật ' + new Date(savedAt).toLocaleString('vi-VN');
      lastStatus = label;
      onStatus && onStatus(label);
      return { ok: true, products: products.length };
    } catch (e) {
      const msg = 'Kéo cloud lỗi: ' + (e.message || e);
      lastStatus = msg;
      onStatus && onStatus(msg);
      return { ok: false, error: e };
    }
  }

  function getLastStatus() { return lastStatus; }

  global.VCDeviceCloud = {
    META_DEVICE_KEY, META_TEAM_WRITE, META_CLOUD_AT,
    ensureDeviceKey, restoreFromRecoveryCode,
    getTeamWriteToken, saveTeamWriteToken,
    uploadPersonalCloud, scheduleUpload, pullAndMerge, getLastStatus,
    deviceBase
  };
})(typeof window !== 'undefined' ? window : globalThis);
