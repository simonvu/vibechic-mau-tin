/* Team-contributed items — encrypted with team key, stored under Worker /team/* */
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

  async function teamFetch(path, { method, deviceId, teamToken, body, meta } = {}) {
    const writing = method === 'PUT' || method === 'DELETE' || method === 'POST';
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (teamToken) headers['X-VC-Team-Token'] = teamToken;
    if (deviceId) headers['Authorization'] = 'Bearer ' + deviceId;
    if (meta) {
      // Header must be ByteString — base64(utf8 JSON) avoids non-ASCII (vi titles)
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

  async function listTeamItems(teamToken) {
    const res = await teamFetch('/items', { method: 'GET', teamToken });
    if (!res.ok) throw new Error('list team HTTP ' + res.status);
    const j = await res.json();
    return j.items || [];
  }

  async function fetchAndDecryptItem(itemId, teamKey, teamToken) {
    const res = await teamFetch('/items/' + encodeURIComponent(itemId), { method: 'GET', teamToken });
    if (!res.ok) throw new Error('item HTTP ' + res.status);
    const enc = await res.json();
    if (!C().isEncryptedEnvelope(enc)) throw new Error('bad envelope');
    const text = await C().decryptText(teamKey, enc);
    return JSON.parse(text);
  }

  async function hydrateTeamImages(product, teamKey, teamToken) {
    const imgs = [];
    for (const im of (product.images || [])) {
      if (im.teamPath || im.source === 'team' || (im.id && !im.dataURL && !im.path)) {
        const imageId = im.id;
        try {
          const r = await teamFetch('/images/' + encodeURIComponent(imageId), { method: 'GET', teamToken });
          if (r.ok) {
            const env = await r.json();
            const bytes = await C().decryptBytes(teamKey, env);
            imgs.push({
              ...im,
              id: imageId,
              dataURL: bytesToJpegDataURL(bytes),
              source: 'team',
              teamImage: true
            });
            continue;
          }
        } catch (e) { console.warn('team img', imageId, e); }
      }
      if (im.path && !im.dataURL) {
        imgs.push(im); // admin public path — caller may hydrate via ensureImageCached
      } else {
        imgs.push(im);
      }
    }
    product.images = imgs;
    return product;
  }

  async function pushTeamItem({
    product, teamKey, teamToken, deviceId, authorName
  }) {
    if (!teamKey) throw new Error('Chưa mở khóa mật khẩu đội');
    if (!teamToken) throw new Error('Thiếu team write token');
    if (!deviceId) throw new Error('Thiếu device id');
    const id = product.id;
    const imageIds = [];
    const packedImages = [];
    for (let j = 0; j < (product.images || []).length; j++) {
      const im = product.images[j];
      const iid = im.id || ('timg-' + id.slice(0, 8) + '-' + j);
      if (im.dataURL) {
        const bytes = dataURLToBytes(im.dataURL);
        const env = await C().encryptBytes(teamKey, bytes);
        const put = await teamFetch('/images/' + encodeURIComponent(iid), {
          method: 'PUT', deviceId, teamToken, body: JSON.stringify(env)
        });
        if (!put.ok) {
          const err = await put.json().catch(() => ({}));
          throw new Error(err.error || ('ảnh team HTTP ' + put.status));
        }
        imageIds.push(iid);
        packedImages.push({ id: iid, source: 'team', teamImage: true, sortOrder: j });
      } else if (im.path) {
        packedImages.push({
          id: im.id || iid, source: 'synced', path: im.path, hash: im.hash || null, sortOrder: j
        });
      }
    }
    const payload = {
      v: 1,
      kind: 'team-item',
      authorDeviceId: deviceId,
      authorName: (authorName || '').trim().slice(0, 40),
      updatedAt: new Date().toISOString(),
      product: {
        id,
        title: product.title,
        category: product.category,
        variants: product.variants || [],
        images: packedImages,
        personal: false,
        teamShared: true,
        source: 'team',
        authorDeviceId: deviceId,
        authorName: (authorName || '').trim().slice(0, 40),
        sortOrder: product.sortOrder || 0,
        pinned: false,
        pinOrder: null,
        createdAt: product.createdAt || Date.now(),
        updatedAt: Date.now()
      }
    };
    const enc = await C().encryptText(teamKey, JSON.stringify(payload));
    const res = await teamFetch('/items/' + encodeURIComponent(id), {
      method: 'PUT',
      deviceId,
      teamToken,
      body: JSON.stringify(enc),
      meta: {
        authorName: payload.authorName,
        imageIds,
        titleHint: String(product.title || '').slice(0, 80)
      }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || ('push HTTP ' + res.status));
    }
    return { ok: true, product: payload.product, meta: (await res.json()).meta };
  }

  async function deleteTeamItem({ itemId, deviceId, teamToken }) {
    const res = await teamFetch('/items/' + encodeURIComponent(itemId), {
      method: 'DELETE', deviceId, teamToken
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || ('delete HTTP ' + res.status));
    }
    return res.json();
  }

  async function pullAllTeamProducts({ teamKey, teamToken }) {
    const metas = await listTeamItems(teamToken);
    const out = [];
    for (const m of metas) {
      try {
        const raw = await fetchAndDecryptItem(m.id, teamKey, teamToken);
        let product = raw.product || raw;
        product = {
          ...product,
          personal: false,
          teamShared: true,
          source: 'team',
          authorDeviceId: raw.authorDeviceId || product.authorDeviceId || m.authorDeviceId,
          authorName: raw.authorName || product.authorName || m.authorName || ''
        };
        await hydrateTeamImages(product, teamKey, teamToken);
        out.push(product);
      } catch (e) {
        console.warn('team item', m.id, e);
      }
    }
    return out;
  }


  async function pushProductExtraImage({
    productId, image, teamKey, teamToken, deviceId, authorName
  }) {
    if (!teamKey) throw new Error('Chưa mở khóa mật khẩu đội');
    if (!teamToken) throw new Error('Thiếu team write token');
    if (!deviceId) throw new Error('Thiếu device id');
    if (!productId) throw new Error('Thiếu product id');
    if (!image || !image.dataURL) throw new Error('Thiếu ảnh');
    const imageId = image.id || ('tex-' + String(productId).slice(0, 8) + '-' + Date.now().toString(36));
    const bytes = dataURLToBytes(image.dataURL);
    const env = await C().encryptBytes(teamKey, bytes);
    const put = await teamFetch(
      '/extras/' + encodeURIComponent(productId) + '/images/' + encodeURIComponent(imageId),
      {
        method: 'PUT',
        deviceId,
        teamToken,
        body: JSON.stringify(env),
        meta: { authorName: (authorName || '').trim().slice(0, 40) }
      }
    );
    if (!put.ok) {
      const err = await put.json().catch(() => ({}));
      throw new Error(err.error || ('đẩy ảnh team HTTP ' + put.status));
    }
    const j = await put.json().catch(() => ({}));
    return {
      ok: true,
      image: {
        id: imageId,
        dataURL: image.dataURL,
        source: 'team',
        teamImage: true,
        teamExtra: true,
        authorDeviceId: deviceId,
        authorName: (authorName || '').trim().slice(0, 40)
      },
      meta: j.meta || null,
      entry: j.entry || null
    };
  }

  async function deleteProductExtraImage({ productId, imageId, deviceId, teamToken }) {
    if (!teamToken) throw new Error('Thiếu team write token');
    if (!deviceId) throw new Error('Thiếu device id');
    const res = await teamFetch(
      '/extras/' + encodeURIComponent(productId) + '/images/' + encodeURIComponent(imageId),
      { method: 'DELETE', deviceId, teamToken }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || ('xóa ảnh team HTTP ' + res.status));
    }
    return res.json();
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
          const r = await teamFetch('/images/' + encodeURIComponent(entry.id), { method: 'GET', teamToken });
          if (!r.ok) continue;
          const env = await r.json();
          const bytes = await C().decryptBytes(teamKey, env);
          imgs.push({
            id: entry.id,
            dataURL: bytesToJpegDataURL(bytes),
            source: 'team',
            teamImage: true,
            teamExtra: true,
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

  global.VCTeamShare = {
    teamBase, listTeamItems, fetchAndDecryptItem, hydrateTeamImages,
    pushTeamItem, deleteTeamItem, pullAllTeamProducts,
    pushProductExtraImage, deleteProductExtraImage,
    listProductExtras, pullAllProductExtras
  };
})(typeof window !== 'undefined' ? window : globalThis);
