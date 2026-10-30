/* Team products — encrypted per-product store on Worker /team/products + images/thumbs */
(function (global) {
  'use strict';

  const C = () => global.VCCrypto;
  const CFG = () => global.VC_CONFIG || {};

  function teamBase() {
    if (CFG().teamBaseUrl) return String(CFG().teamBaseUrl).replace(/\/$/, '');
    const root = (CFG().pagesAdminUrl || CFG().deviceBaseUrl || CFG().syncBaseUrl || '').replace(/\/device\/?$/, '').replace(/\/$/, '');
    return root + '/team';
  }

  function dataURLToBytes(dataURL) {
    const m = String(dataURL || '').match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('bad dataURL');
    return C().b64decode(m[2]);
  }
  function bytesToJpegDataURL(bytes) {
    return 'data:image/jpeg;base64,' + C().b64encode(bytes);
  }

  async function teamFetch(path, { method, deviceId, teamToken, body, meta, ifUpdatedAt } = {}) {
    const writing = method === 'PUT' || method === 'DELETE' || method === 'POST';
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (teamToken) headers['X-VC-Team-Token'] = teamToken;
    if (deviceId) headers['Authorization'] = 'Bearer ' + deviceId;
    if (ifUpdatedAt) headers['X-VC-If-Updated-At'] = ifUpdatedAt;
    if (meta) {
      const json = JSON.stringify(meta);
      headers['X-VC-Item-Meta'] = btoa(unescape(encodeURIComponent(json)));
      headers['X-VC-Item-Meta-Enc'] = 'b64';
    }
    if (writing && !teamToken) throw new Error('Cần mật khẩu đội');
    const res = await fetch(teamBase() + path, {
      method: method || 'GET',
      headers,
      body: body != null ? body : undefined,
      cache: 'no-store'
    });
    return res;
  }

  async function listTeamProducts(teamToken, since) {
    const q = since ? ('?since=' + encodeURIComponent(since)) : '';
    const res = await teamFetch('/products' + q, { method: 'GET', teamToken });
    if (!res.ok) throw new Error('list products HTTP ' + res.status);
    const j = await res.json();
    return j.items || [];
  }

  async function fetchAndDecryptProduct(productId, teamKey, teamToken) {
    const res = await teamFetch('/products/' + encodeURIComponent(productId), { method: 'GET', teamToken });
    if (!res.ok) throw new Error('product HTTP ' + res.status);
    const enc = await res.json();
    if (!C().isEncryptedEnvelope(enc)) throw new Error('bad envelope');
    const text = await C().decryptText(teamKey, enc);
    return JSON.parse(text);
  }

  async function putEncryptedBlob(path, bytes, teamKey, deviceId, teamToken) {
    const env = await C().encryptBytes(teamKey, bytes);
    const put = await teamFetch(path, {
      method: 'PUT', deviceId, teamToken, body: JSON.stringify(env)
    });
    if (!put.ok) {
      const err = await put.json().catch(() => ({}));
      throw new Error(err.error || ('upload HTTP ' + put.status));
    }
    return put.json().catch(() => ({}));
  }

  async function fetchDecryptImage(path, teamKey, teamToken) {
    const r = await teamFetch(path, { method: 'GET', teamToken });
    if (!r.ok) return null;
    const env = await r.json();
    const bytes = await C().decryptBytes(teamKey, env);
    return bytesToJpegDataURL(bytes);
  }

  /** Pack product for team store: no full dataURLs — only refs + optional thumbDataURL kept client-side */
  function packProductForTeam(product, { deviceId, authorName, basedOnAdmin }) {
    const packedImages = [];
    const imageIds = [];
    const thumbIds = [];
    for (let j = 0; j < (product.images || []).length; j++) {
      const im = product.images[j];
      const iid = im.id || ('timg-' + String(product.id).slice(0, 8) + '-' + j);
      const entry = {
        id: iid,
        sortOrder: j,
        source: im.path ? 'synced' : 'team',
        teamImage: !im.path,
        hasFull: !!(im.dataURL || im.hasFull || im.path),
        hasThumb: !!(im.thumbDataURL || im.hasThumb || im.thumbId)
      };
      if (im.path) {
        entry.path = im.path;
        entry.hash = im.hash || null;
        entry.source = 'synced';
      } else {
        imageIds.push(iid);
        thumbIds.push(iid);
        entry.teamImage = true;
        entry.source = 'team';
      }
      if (im.authorDeviceId) entry.authorDeviceId = im.authorDeviceId;
      if (im.authorName) entry.authorName = im.authorName;
      packedImages.push(entry);
    }
    const now = Date.now();
    return {
      payload: {
        v: 2,
        kind: 'team-product',
        authorDeviceId: product.authorDeviceId || deviceId,
        authorName: (authorName || product.authorName || '').trim().slice(0, 40),
        lastEditorDeviceId: deviceId,
        lastEditorName: (authorName || '').trim().slice(0, 40),
        updatedAt: new Date().toISOString(),
        product: {
          id: product.id,
          title: product.title,
          category: product.category,
          variants: product.variants || [],
          images: packedImages,
          personal: false,
          teamShared: true,
          teamProduct: true,
          basedOnAdmin: !!(basedOnAdmin || product.basedOnAdmin),
          source: 'team',
          authorDeviceId: product.authorDeviceId || deviceId,
          authorName: (authorName || product.authorName || '').trim().slice(0, 40),
          sortOrder: product.sortOrder || 0,
          pinned: !!product.pinned,
          pinOrder: product.pinned ? product.pinOrder : null,
          createdAt: product.createdAt || now,
          updatedAt: now
        }
      },
      imageIds,
      thumbIds
    };
  }

  /**
   * Push whole product to team (LWW). Uploads full + thumb for local/team images that have dataURL.
   * Admin path images are referenced only (no re-upload).
   */
  async function pushTeamProduct({
    product, teamKey, teamToken, deviceId, authorName, ifUpdatedAt, basedOnAdmin
  }) {
    if (!teamKey) throw new Error('Chưa mở khóa mật khẩu đội');
    if (!teamToken) throw new Error('Thiếu team write token');
    if (!deviceId) throw new Error('Thiếu device id');
    const id = product.id;

    for (let j = 0; j < (product.images || []).length; j++) {
      const im = product.images[j];
      if (im.path) continue; // admin public
      const iid = im.id || ('timg-' + String(id).slice(0, 8) + '-' + j);
      im.id = iid;
      const alreadyOnTeam = !!(im.teamImage || im.teamExtra || im.source === 'team');
      if (alreadyOnTeam) {
        im.hasFull = !!(im.hasFull || im.dataURL);
        im.hasThumb = !!(im.hasThumb || im.thumbDataURL);
        continue;
      }
      if (im.dataURL) {
        const bytes = dataURLToBytes(im.dataURL);
        await putEncryptedBlob('/images/' + encodeURIComponent(iid), bytes, teamKey, deviceId, teamToken);
        im.hasFull = true;
      }
      if (im.thumbDataURL) {
        const tbytes = dataURLToBytes(im.thumbDataURL);
        await putEncryptedBlob('/thumbs/' + encodeURIComponent(iid), tbytes, teamKey, deviceId, teamToken);
        im.hasThumb = true;
      } else if (im.dataURL) {
        // fallback: use full as thumb if no separate thumb (caller should make one)
        const bytes = dataURLToBytes(im.dataURL);
        await putEncryptedBlob('/thumbs/' + encodeURIComponent(iid), bytes, teamKey, deviceId, teamToken);
        im.hasThumb = true;
      }
    }

    const { payload, imageIds, thumbIds } = packProductForTeam(product, { deviceId, authorName, basedOnAdmin });
    const enc = await C().encryptText(teamKey, JSON.stringify(payload));
    const res = await teamFetch('/products/' + encodeURIComponent(id), {
      method: 'PUT',
      deviceId,
      teamToken,
      body: JSON.stringify(enc),
      ifUpdatedAt,
      meta: {
        authorName: payload.authorName,
        lastEditorName: payload.lastEditorName,
        imageIds,
        thumbIds,
        titleHint: String(product.title || '').slice(0, 80),
        basedOnAdmin: !!(basedOnAdmin || product.basedOnAdmin)
      }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 409) {
        const e = new Error('conflict');
        e.conflict = true;
        e.currentUpdatedAt = err.currentUpdatedAt;
        throw e;
      }
      throw new Error(err.error || ('push HTTP ' + res.status));
    }
    const j = await res.json();
    return { ok: true, product: payload.product, meta: j.meta, remoteUpdatedAt: j.meta && j.meta.updatedAt };
  }

  async function deleteTeamProduct({ productId, deviceId, teamToken }) {
    const res = await teamFetch('/products/' + encodeURIComponent(productId), {
      method: 'DELETE', deviceId, teamToken
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || ('delete HTTP ' + res.status));
    }
    return res.json();
  }

  /** Hydrate thumb into image (from cache or network). Does not fetch full. */
  async function hydrateThumb(im, teamKey, teamToken) {
    if (!im || im.path) return im; // admin — use public URL / ensureImageCached separately
    if (im.thumbDataURL) return im;
    const Cache = global.VCMediaCache;
    if (Cache) {
      const cached = await Cache.getThumb(im.id);
      if (cached) {
        im.thumbDataURL = cached;
        return im;
      }
    }
    if (!teamKey || !teamToken || !im.id) return im;
    try {
      const dataURL = await fetchDecryptImage('/thumbs/' + encodeURIComponent(im.id), teamKey, teamToken);
      if (dataURL) {
        im.thumbDataURL = dataURL;
        im.hasThumb = true;
        if (Cache) await Cache.putThumb(im.id, dataURL);
      }
    } catch (e) {
      console.warn('thumb', im.id, e);
    }
    return im;
  }

  /** Hydrate full image for detail/lightbox/share. */
  async function hydrateFull(im, teamKey, teamToken) {
    if (!im) return im;
    if (im.dataURL) return im;
    if (im.path) return im; // caller uses ensureImageCached for public
    const Cache = global.VCMediaCache;
    if (Cache) {
      const cached = await Cache.getFull(im.id);
      if (cached) {
        im.dataURL = cached;
        return im;
      }
    }
    if (!teamKey || !teamToken || !im.id) return im;
    try {
      const dataURL = await fetchDecryptImage('/images/' + encodeURIComponent(im.id), teamKey, teamToken);
      if (dataURL) {
        im.dataURL = dataURL;
        im.hasFull = true;
        if (Cache) await Cache.putFull(im.id, dataURL);
      }
    } catch (e) {
      console.warn('full img', im.id, e);
    }
    return im;
  }

  /**
   * Incremental pull: only products with meta.updatedAt > since.
   * Returns { products, newestUpdatedAt } without full image bytes (thumbs optional lazy).
   */
  async function mapPool(items, limit, fn) {
    const out = new Array(items.length);
    let cursor = 0;
    const n = Math.min(limit, items.length);
    async function worker() {
      while (cursor < items.length) {
        const idx = cursor;
        cursor += 1;
        out[idx] = await fn(items[idx], idx);
      }
    }
    if (n > 0) await Promise.all(Array.from({ length: n }, () => worker()));
    return out;
  }

  async function pullTeamProductsIncremental({ teamKey, teamToken, since }) {
    const metas = await listTeamProducts(teamToken, since || '');
    const out = [];
    let newest = since || '';
    const bodies = await mapPool(metas, 6, async (m) => {
      try {
        return await fetchAndDecryptProduct(m.id, teamKey, teamToken);
      } catch (e) {
        console.warn('team product', m.id, e);
        return null;
      }
    });
    for (let i = 0; i < metas.length; i++) {
      const m = metas[i];
      const raw = bodies[i];
      if (!raw) continue;
      try {
        if (m.updatedAt && m.updatedAt > newest) newest = m.updatedAt;
        let product = raw.product || raw;
        product = {
          ...product,
          personal: false,
          teamShared: true,
          teamProduct: true,
          basedOnAdmin: !!(product.basedOnAdmin || m.basedOnAdmin),
          source: 'team',
          authorDeviceId: raw.authorDeviceId || product.authorDeviceId || m.createdByDeviceId || m.authorDeviceId,
          authorName: raw.authorName || product.authorName || m.lastEditorName || m.authorName || '',
          remoteUpdatedAt: m.updatedAt || raw.updatedAt || null,
          // strip any accidental dataURLs from payload
          images: (product.images || []).map((im) => {
            const { dataURL, thumbDataURL, ...rest } = im || {};
            return {
              ...rest,
              id: im.id,
              source: im.path ? 'synced' : 'team',
              teamImage: !im.path,
              hasFull: im.hasFull !== false && !im.path,
              hasThumb: im.hasThumb !== false && !im.path
            };
          })
        };
        out.push(product);
      } catch (e) {
        console.warn('team product', m.id, e);
      }
    }
    return { products: out, newestUpdatedAt: newest, metas };
  }

  // ---- Legacy adapters (items + extras) kept for migration / old clients ----

  async function listTeamItems(teamToken) {
    const res = await teamFetch('/items', { method: 'GET', teamToken });
    if (!res.ok) throw new Error('list team HTTP ' + res.status);
    const j = await res.json();
    return j.items || [];
  }

  async function pushTeamItem(opts) {
    // Compat: route to pushTeamProduct
    return pushTeamProduct(opts);
  }

  async function deleteTeamItem({ itemId, deviceId, teamToken }) {
    // Try products first, then legacy items
    try {
      return await deleteTeamProduct({ productId: itemId, deviceId, teamToken });
    } catch (_) {
      const res = await teamFetch('/items/' + encodeURIComponent(itemId), {
        method: 'DELETE', deviceId, teamToken
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || ('delete HTTP ' + res.status));
      }
      return res.json();
    }
  }

  async function pullAllTeamProducts({ teamKey, teamToken }) {
    const r = await pullTeamProductsIncremental({ teamKey, teamToken, since: '' });
    return r.products;
  }

  async function listProductExtras(teamToken) {
    const res = await teamFetch('/extras', { method: 'GET', teamToken });
    if (!res.ok) throw new Error('list extras HTTP ' + res.status);
    const j = await res.json();
    return j.items || [];
  }

  async function pullAllProductExtras({ teamKey, teamToken }) {
    const metas = await listProductExtras(teamToken);
    const byProduct = {};
    for (const m of metas) {
      const pid = m.productId;
      if (!pid) continue;
      const imgs = [];
      for (const entry of (m.images || [])) {
        if (!entry || !entry.id) continue;
        try {
          const dataURL = await fetchDecryptImage('/images/' + encodeURIComponent(entry.id), teamKey, teamToken);
          if (!dataURL) continue;
          imgs.push({
            id: entry.id,
            dataURL,
            source: 'team',
            teamImage: true,
            teamExtra: true,
            hasFull: true,
            authorDeviceId: entry.authorDeviceId || null,
            authorName: entry.authorName || ''
          });
        } catch (e) {
          console.warn('extra img', entry.id, e);
        }
      }
      byProduct[pid] = imgs;
    }
    return byProduct;
  }

  /** One-shot: migrate extras into team products if product not yet in /team/products */
  async function migrateExtrasIntoProducts({ teamKey, teamToken, deviceId, authorName, baseProductsById }) {
    const extras = await listProductExtras(teamToken);
    const existing = await listTeamProducts(teamToken, '');
    const have = new Set(existing.map((m) => m.id));
    const migrated = [];
    for (const m of extras) {
      const pid = m.productId;
      if (!pid || have.has(pid)) continue;
      const base = (baseProductsById && baseProductsById[pid]) || null;
      const extraImgs = [];
      for (const entry of (m.images || [])) {
        if (!entry || !entry.id) continue;
        try {
          const dataURL = await fetchDecryptImage('/images/' + encodeURIComponent(entry.id), teamKey, teamToken);
          if (!dataURL) continue;
          // also ensure thumb exists (reuse full if needed)
          try {
            await putEncryptedBlob('/thumbs/' + encodeURIComponent(entry.id), dataURLToBytes(dataURL), teamKey, deviceId, teamToken);
          } catch (_) {}
          extraImgs.push({
            id: entry.id,
            dataURL,
            thumbDataURL: dataURL,
            source: 'team',
            teamImage: true,
            hasFull: true,
            hasThumb: true,
            authorDeviceId: entry.authorDeviceId,
            authorName: entry.authorName || ''
          });
        } catch (_) {}
      }
      if (!extraImgs.length && !base) continue;
      const product = {
        id: pid,
        title: (base && base.title) || m.titleHint || pid,
        category: (base && base.category) || 'Khác',
        variants: (base && base.variants) || [{ id: 'v1', label: 'Mẫu chính', html: '<p></p>', sortOrder: 0 }],
        images: [
          ...((base && base.images) || []).map((im) => ({
            id: im.id,
            path: im.path || null,
            hash: im.hash || null,
            source: im.path ? 'synced' : (im.source || 'team'),
            dataURL: im.dataURL || null,
            thumbDataURL: im.thumbDataURL || null
          })),
          ...extraImgs
        ],
        personal: false,
        teamShared: true,
        teamProduct: true,
        basedOnAdmin: !!base,
        source: 'team',
        authorDeviceId: (extraImgs[0] && extraImgs[0].authorDeviceId) || deviceId,
        authorName: (extraImgs[0] && extraImgs[0].authorName) || authorName || '',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await pushTeamProduct({
        product, teamKey, teamToken, deviceId,
        authorName: product.authorName || authorName || 'team',
        basedOnAdmin: !!base
      });
      migrated.push(pid);
      have.add(pid);
    }
    return migrated;
  }

  // Deprecated per-image extras API wrappers (kept so old app bits don't crash)
  async function pushProductExtraImage() {
    throw new Error('Đã đổi sang đẩy cả sản phẩm — dùng Sửa / Đẩy lên team');
  }
  async function deleteProductExtraImage() {
    throw new Error('Xóa ảnh trong Sửa sản phẩm');
  }

  global.VCTeamShare = {
    teamBase,
    listTeamProducts,
    fetchAndDecryptProduct,
    pushTeamProduct,
    deleteTeamProduct,
    pullTeamProductsIncremental,
    hydrateThumb,
    hydrateFull,
    // legacy
    listTeamItems,
    pushTeamItem,
    deleteTeamItem,
    pullAllTeamProducts,
    listProductExtras,
    pullAllProductExtras,
    migrateExtrasIntoProducts,
    pushProductExtraImage,
    deleteProductExtraImage
  };
})(typeof window !== 'undefined' ? window : globalThis);
