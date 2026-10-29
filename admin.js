/* Desktop authoring + GitHub Pages publish (templates.json + images, single commit) */
(() => {
  'use strict';
  const {
    uid, sanitizeHtml, htmlToPlain, migrateProduct, packProductsTextOnly,
    packProductsForSync, exportFileName, parseImportList, sampleProduct,
    imagePublicUrl, sha256Hex, dataURLToBytes, bytesToBase64
  } = window.VC;
  const CryptoUtil = window.VCCrypto;
  const CFG = window.VC_CONFIG || {};
  const TOKEN_KEY = 'vc-gh-token';
  const MAX_IMAGES = 8;
  const MAX_IMG_EDGE = 1200;
  const JPEG_QUALITY = 0.8;

  const DB_NAME = 'vibechic-templates';
  const DB_VER = 2;
  const STORE = 'products';
  const META = 'meta';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  let db, products = [], selectedId = null, editVariants = [], editImages = [], dirty = false;

  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2200);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function txDone(tx) {
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function getAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result || []).map(migrateProduct).filter(Boolean));
      req.onerror = () => reject(req.error);
    });
  }
  async function put(p) {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(migrateProduct(p));
    await txDone(tx);
  }
  async function del(id) {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await txDone(tx);
  }
  async function clearAll() {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await txDone(tx);
  }
  async function getMeta(key) {
    return new Promise((resolve) => {
      const tx = db.transaction(META, 'readonly');
      const req = tx.objectStore(META).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => resolve(null);
    });
  }
  async function setMeta(key, value) {
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).put({ key, value });
    await txDone(tx);
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  async function resizeImageFile(file) {
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;
    const scale = Math.min(1, MAX_IMG_EDGE / Math.max(width, height));
    width = Math.round(width * scale); height = Math.round(height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close && bitmap.close();
    return new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
  }

  function sorted() {
    return [...products].sort((a, b) => {
      const ap = a.pinned ? 0 : 1;
      const bp = b.pinned ? 0 : 1;
      if (ap !== bp) return ap - bp;
      if (a.pinned && b.pinned) {
        const pa = a.pinOrder != null ? a.pinOrder : 0;
        const pb = b.pinOrder != null ? b.pinOrder : 0;
        if (pa !== pb) return pa - pb;
      }
      const sa = a.sortOrder != null ? a.sortOrder : 9999;
      const sb = b.sortOrder != null ? b.sortOrder : 9999;
      if (sa !== sb) return sa - sb;
      return (a.title || '').localeCompare(b.title || '', 'vi');
    });
  }

  function nextPinOrder() {
    const pinned = products.filter((p) => p.pinned);
    if (!pinned.length) return 0;
    return Math.max(...pinned.map((p) => p.pinOrder != null ? p.pinOrder : 0)) + 1;
  }

  async function setPinned(id, pinned) {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    p.pinned = !!pinned;
    p.pinOrder = p.pinned ? (p.pinOrder != null ? p.pinOrder : nextPinOrder()) : null;
    p.updatedAt = Date.now();
    await put(p);
    products = await getAll();
    renderList();
    if (selectedId === id) {
      $('#editPinned').checked = !!p.pinned;
    }
    toast(p.pinned ? 'Đã ghim 📌' : 'Đã bỏ ghim');
  }

  async function movePin(id, dir) {
    const pinned = sorted().filter((p) => p.pinned);
    const idx = pinned.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= pinned.length) return;
    const a = pinned[idx], b = pinned[j];
    const oa = a.pinOrder != null ? a.pinOrder : idx;
    const ob = b.pinOrder != null ? b.pinOrder : j;
    a.pinOrder = ob; b.pinOrder = oa;
    a.updatedAt = Date.now(); b.updatedAt = Date.now();
    await put(a); await put(b);
    products = await getAll();
    renderList();
  }

  function renderList() {
    const list = sorted();
    const pinned = list.filter((p) => p.pinned);
    const rest = list.filter((p) => !p.pinned);
    $('#countLabel').textContent = `${list.length} SP · ${pinned.length} ghim`;
    const row = (p) => `
      <div class="list-item${p.id === selectedId ? ' active' : ''}${p.pinned ? ' pinned' : ''}" draggable="true" data-id="${p.id}">
        <div class="handle">⋮⋮</div>
        <button type="button" class="pin-btn${p.pinned ? ' on' : ''}" data-pin="${p.id}" title="Ghim/bỏ ghim">📌</button>
        ${p.pinned ? `<div class="pin-ord">
          <button type="button" data-pin-up="${p.id}">↑</button>
          <button type="button" data-pin-down="${p.id}">↓</button>
        </div>` : ''}
        <div style="flex:1;min-width:0">
          <div class="title">${p.pinned ? '📌 ' : ''}${escapeHtml(p.title)}</div>
          <div class="meta">${escapeHtml(p.category || 'Khác')} · ${(p.variants||[]).length} mẫu · ${(p.images||[]).length} ảnh${p.pinned ? ' · hot #' + ((p.pinOrder!=null?p.pinOrder:0)+1) : ''}</div>
        </div>
        <button type="button" class="del" data-del="${p.id}">✕</button>
      </div>`;
    let html = '';
    if (pinned.length) html += `<div class="list-section">Đang hot (ghim)</div>` + pinned.map(row).join('');
    if (rest.length) html += `<div class="list-section">Sản phẩm</div>` + rest.map(row).join('');
    $('#productList').innerHTML = html || '<div class="empty">Chưa có sản phẩm</div>';
    const cats = [...new Set(products.map((p) => p.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'vi'));
    $('#catList').innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
  }

  function renderVariants() {
    $('#editVariants').innerHTML = editVariants.map((v, i) => `
      <div class="edit-variant" data-idx="${i}">
        <div class="v-head">
          <span style="color:var(--muted)">${i+1}</span>
          <input type="text" class="v-label-input" value="${escapeHtml(v.label)}" placeholder="Nhãn (VD: Báo giá)" />
          <button type="button" data-up="${i}">↑</button>
          <button type="button" data-down="${i}">↓</button>
          <button type="button" class="del" data-rm="${i}">✕</button>
        </div>
        <div class="v-tools">
          <button type="button" data-cmd="bold" data-vi="${i}"><b>B</b></button>
          <button type="button" data-cmd="italic" data-vi="${i}"><i>I</i></button>
          <button type="button" data-cmd="insertUnorderedList" data-vi="${i}">•</button>
          <button type="button" data-cmd="insertLineBreak" data-vi="${i}">↵</button>
        </div>
        <div class="v-body" contenteditable="true" data-placeholder="Nội dung…" data-vi="${i}">${v.html || ''}</div>
      </div>`).join('');
    updatePreview();
  }

  function renderImages() {
    const box = $('#editImages');
    if (!box) return;
    box.innerHTML = editImages.map((im, i) => `
      <div class="img-thumb" data-i="${i}">
        <img src="${im.dataURL || imagePublicUrl(im)}" alt="" />
        <button type="button" class="rm" data-rm-img="${i}">×</button>
        <div class="ord">
          <button type="button" data-img-up="${i}" ${i===0?'disabled':''}>↑</button>
          <button type="button" data-img-down="${i}" ${i===editImages.length-1?'disabled':''}>↓</button>
        </div>
      </div>`).join('');
  }

  function syncFromDom() {
    $$('#editVariants .edit-variant').forEach((el, i) => {
      if (!editVariants[i]) return;
      editVariants[i].label = el.querySelector('.v-label-input').value;
      editVariants[i].html = sanitizeHtml(el.querySelector('.v-body').innerHTML);
    });
  }

  function updatePreview() {
    syncFromDom();
    const imgs = editImages.map((im) =>
      `<img src="${im.dataURL || imagePublicUrl(im)}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;margin:2px" />`
    ).join('');
    $('#previewBox').innerHTML =
      (imgs ? `<div style="margin-bottom:10px">${imgs}</div>` : '') +
      (editVariants.map((v) =>
        `<div class="pv"><b>${escapeHtml(v.label || 'Mẫu')}</b>${v.html || '<i style="color:var(--muted)">trống</i>'}</div>`
      ).join('') || '<span style="color:var(--muted)">Chưa có mẫu</span>');
  }

  function loadProduct(p) {
    selectedId = p ? p.id : null;
    $('#editId').value = p ? p.id : '';
    $('#editTitle').value = p ? p.title : '';
    $('#editCategory').value = p ? (p.category || '') : 'Tư vấn sản phẩm';
    $('#editPinned').checked = !!(p && p.pinned);
    editVariants = p && p.variants && p.variants.length
      ? p.variants.map((v, i) => ({ id: v.id || uid(), label: v.label, html: v.html || '', sortOrder: i }))
      : [{ id: uid(), label: 'Tin đầy đủ', html: '', sortOrder: 0 }];
    editImages = p && p.images
      ? p.images.map((im, i) => ({
          id: im.id || uid(),
          source: im.source || (im.path ? 'synced' : 'local'),
          path: im.path || null,
          hash: im.hash || null,
          dataURL: im.dataURL || null,
          sortOrder: i
        }))
      : [];
    dirty = false;
    renderList();
    renderVariants();
    renderImages();
  }

  async function saveCurrent() {
    syncFromDom();
    const title = $('#editTitle').value.trim();
    if (!title) { toast('Nhập tên sản phẩm'); return; }
    const variants = editVariants
      .map((v, i) => ({ id: v.id || uid(), label: (v.label || '').trim() || `Mẫu ${i+1}`, html: sanitizeHtml(v.html || ''), sortOrder: i }))
      .filter((v) => htmlToPlain(v.html).trim());
    if (!variants.length) { toast('Cần ≥1 mẫu có chữ'); return; }
    const id = $('#editId').value || uid();
    const prev = products.find((x) => x.id === id);
    const images = editImages.map((im, i) => ({
      id: im.id || uid(),
      source: 'synced', // admin-authored → will be published
      path: im.path || null,
      hash: im.hash || null,
      dataURL: im.dataURL || null,
      sortOrder: i
    }));
    const wantPin = $('#editPinned').checked;
    let pinOrder = null;
    if (wantPin) {
      pinOrder = (prev && prev.pinned && prev.pinOrder != null) ? prev.pinOrder : nextPinOrder();
    }
    const p = {
      id, title,
      category: $('#editCategory').value.trim() || 'Khác',
      variants, images,
      pinned: wantPin,
      pinOrder,
      sortOrder: prev ? prev.sortOrder : products.length,
      createdAt: prev ? prev.createdAt : Date.now(),
      updatedAt: Date.now()
    };
    await put(p);
    products = await getAll();
    loadProduct(p);
    toast('Đã lưu');
  }

  function exportPack() {
    // Export with embedded dataURLs for backup transfer
    const payload = {
      app: 'vibechic-templates', version: 3, kind: 'full-pack',
      exportedAt: new Date().toISOString(),
      products: packProductsForSync(products, { includeLocalImagesAsData: true }).map((p, i) => {
        const src = products.find((x) => x.id === p.id) || {};
        const images = (src.images || []).map((im, j) => ({
          id: im.id, sortOrder: j, source: im.source || 'local',
          path: im.path || null, hash: im.hash || null,
          dataURL: im.dataURL || null
        })).filter((im) => im.dataURL || im.path);
        return { ...p, images };
      })
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = exportFileName(); a.click();
    toast('Đã xuất ' + exportFileName());
  }

  async function importPack(file, replace) {
    const data = JSON.parse(await file.text());
    const list = parseImportList(data);
    if (!list.length) { toast('File trống'); return; }
    if (replace) {
      if (!confirm('Thay thế toàn bộ?')) return;
      await clearAll();
      for (let i = 0; i < list.length; i++) {
        await put({ ...list[i], sortOrder: i });
      }
    } else {
      const byId = new Map(products.map((p) => [p.id, p]));
      for (const inc of list) {
        const prev = byId.get(inc.id);
        if (!prev) { await put(inc); continue; }
        const vMap = new Map(prev.variants.map((v) => [v.id, v]));
        for (const v of inc.variants) vMap.set(v.id, { ...(vMap.get(v.id) || {}), ...v });
        // Prefer incoming images if they have data/path
        const images = (inc.images && inc.images.length) ? inc.images : (prev.images || []);
        await put({
          ...prev,
          title: inc.title, category: inc.category,
          sortOrder: inc.sortOrder != null ? inc.sortOrder : prev.sortOrder,
          variants: [...vMap.values()],
          images,
          updatedAt: Date.now()
        });
      }
    }
    products = await getAll();
    renderList();
    const first = sorted()[0];
    if (first) loadProduct(first);
    toast(`Đã nhập ${list.length} SP`);
  }

  /* ---------- GitHub Trees API publish (single commit) ---------- */
  function ghHeaders(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
  }
  async function gh(token, path, opts = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      ...opts,
      headers: { ...ghHeaders(token), ...(opts.headers || {}) }
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!res.ok) {
      const msg = (json && (json.message || json.error)) || res.statusText;
      const err = new Error(msg + ' (' + res.status + ')');
      err.status = res.status; err.body = json;
      throw err;
    }
    return json;
  }


  async function collectImageBlobs(productsList) {
    const out = [];
    for (const p of productsList) {
      for (const im of (p.images || [])) {
        if (!im.dataURL) {
          if (im.path && im.hash) out.push({ path: im.path, hash: im.hash, bytes: null, productId: p.id, imageId: im.id, reuse: true });
          continue;
        }
        const bytes = dataURLToBytes(im.dataURL);
        const full = await sha256Hex(bytes);
        const hash = full.slice(0, 16);
        // encrypted file extension
        const path = `images/${p.id}/${hash}.enc`;
        out.push({ path, hash, bytes, productId: p.id, imageId: im.id, reuse: false });
        im.path = path; im.hash = hash; im.source = 'synced';
      }
    }
    return out;
  }

  async function resolvePublishKey(token, owner, repo, branch) {
    const pw = ($('#teamPassword').value || '').trim();
    const pw2 = ($('#teamPassword2').value || '').trim();
    const changing = $('#changePassword').checked;
    if (!pw) throw new Error('Nhập mật khẩu đội trước khi đăng');

    let meta = null;
    try {
      const file = await gh(token, `/repos/${owner}/${repo}/contents/crypto-meta.json?ref=${branch}`);
      if (file && file.content) {
        const raw = decodeURIComponent(escape(atob(file.content.replace(/\n/g, ''))));
        meta = JSON.parse(raw);
      }
    } catch (e) {
      if (e.status !== 404) console.warn('meta fetch', e);
    }

    const firstTime = !meta || !meta.salt;
    if (firstTime || changing) {
      if (pw.length < 8) throw new Error('Mật khẩu đội cần ≥ 8 ký tự');
      if (pw !== pw2) throw new Error('Hai ô mật khẩu không khớp');
      meta = CryptoUtil.newMeta();
      $('#pwStatus').textContent = firstTime ? 'Tạo mới crypto-meta.json' : 'Đổi mật khẩu — passwordId mới';
    } else {
      $('#pwStatus').textContent = 'Dùng salt hiện có · passwordId ' + (meta.passwordId || '').slice(0, 8);
    }
    const key = await CryptoUtil.deriveKey(pw, meta.salt, meta.iterations || CryptoUtil.KDF_ITERATIONS);
    return { key, meta, firstTime, changing };
  }

  async function publishToGithub() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { toast('Chưa có token — dán và Lưu token trước'); return; }
    const owner = CFG.githubOwner;
    const repo = CFG.githubRepo;
    const branch = CFG.branch || 'main';
    const status = $('#publishStatus');
    status.textContent = 'Chuẩn bị…';

    try {
      const working = products.map((p) => migrateProduct(JSON.parse(JSON.stringify(p))));
      if (selectedId) {
        syncFromDom();
        const cur = working.find((p) => p.id === selectedId);
        if (cur) {
          cur.title = $('#editTitle').value.trim() || cur.title;
          cur.category = $('#editCategory').value.trim() || cur.category;
          cur.variants = editVariants.map((v, i) => ({
            id: v.id, label: v.label, html: sanitizeHtml(v.html || ''), sortOrder: i
          }));
          cur.images = editImages.map((im, i) => ({ ...im, sortOrder: i, source: 'synced' }));
          cur.pinned = $('#editPinned').checked;
          if (cur.pinned && cur.pinOrder == null) cur.pinOrder = nextPinOrder();
          if (!cur.pinned) cur.pinOrder = null;
        }
      }

      status.textContent = 'Khóa mã hóa…';
      const { key, meta } = await resolvePublishKey(token, owner, repo, branch);

      const imageEntries = await collectImageBlobs(working);
      for (const p of working) await put(p);
      products = await getAll();

      const desiredPaths = new Set(imageEntries.map((e) => e.path));
      desiredPaths.add('templates.json');
      desiredPaths.add('crypto-meta.json');

      const pack = {
        app: 'vibechic-templates', version: 3, kind: 'text-pack',
        exportedAt: new Date().toISOString(),
        products: packProductsForSync(working, { includeLocalImagesAsData: false }).map((p) => {
          const src = working.find((x) => x.id === p.id);
          return {
            ...p,
            images: (src.images || []).filter((im) => im.path).map((im, j) => ({
              id: im.id, path: im.path, hash: im.hash, sortOrder: j, source: 'synced'
            }))
          };
        })
      };

      status.textContent = 'Mã hóa templates + ảnh…';
      const encTemplates = await CryptoUtil.encryptText(key, JSON.stringify(pack));
      const encImages = [];
      for (const ent of imageEntries) {
        if (ent.reuse) {
          encImages.push({ path: ent.path, reuse: true });
          continue;
        }
        const env = await CryptoUtil.encryptBytes(key, ent.bytes);
        encImages.push({ path: ent.path, reuse: false, envelope: env });
      }

      status.textContent = 'Đọc nhánh GitHub…';
      const ref = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
      const headSha = ref.object.sha;
      const headCommit = await gh(token, `/repos/${owner}/${repo}/git/commits/${headSha}`);
      const baseTreeSha = headCommit.tree.sha;

      let oldPaths = [];
      try {
        const prevMeta = await getMeta('lastPublishedPaths');
        if (Array.isArray(prevMeta)) oldPaths = prevMeta;
      } catch (_) {}
      // Prefer paths from last encrypted pack if we can decrypt — skip; use meta store + listing heuristic
      try {
        // list images/ tree recursively via git trees (truncated)
        const tree = await gh(token, `/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`);
        const imgPaths = (tree.tree || []).filter((t) => t.type === 'blob' && String(t.path).startsWith('images/')).map((t) => t.path);
        if (imgPaths.length) oldPaths = imgPaths;
      } catch (_) {}

      const toDelete = oldPaths.filter((p) => p && !desiredPaths.has(p) && p !== 'templates.json' && p !== 'crypto-meta.json');

      status.textContent = 'Tạo blob (1 commit)…';
      const tree = [];

      const metaStr = JSON.stringify(meta, null, 2);
      const metaBlob = await gh(token, `/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: btoa(unescape(encodeURIComponent(metaStr))), encoding: 'base64' })
      });
      tree.push({ path: 'crypto-meta.json', mode: '100644', type: 'blob', sha: metaBlob.sha });

      const tplStr = JSON.stringify(encTemplates);
      const tplBlob = await gh(token, `/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: btoa(unescape(encodeURIComponent(tplStr))), encoding: 'base64' })
      });
      tree.push({ path: 'templates.json', mode: '100644', type: 'blob', sha: tplBlob.sha });

      for (const ent of encImages) {
        if (ent.reuse) continue;
        const body = JSON.stringify(ent.envelope);
        const blob = await gh(token, `/repos/${owner}/${repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: btoa(unescape(encodeURIComponent(body))), encoding: 'base64' })
        });
        tree.push({ path: ent.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      for (const path of toDelete) {
        tree.push({ path, mode: '100644', type: 'blob', sha: null });
      }

      const newTree = await gh(token, `/repos/${owner}/${repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseTreeSha, tree })
      });
      const nImg = encImages.filter((e) => !e.reuse).length;
      const msg = `Encrypted templates + images (${working.length} SP, +${nImg} ảnh, -${toDelete.length})`;
      const commit = await gh(token, `/repos/${owner}/${repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message: msg, tree: newTree.sha, parents: [headSha] })
      });
      await gh(token, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: false })
      });

      await setMeta('lastPublishedPaths', [...desiredPaths].filter((p) => p.startsWith('images/')));
      await setMeta('lastPublishAt', Date.now());
      await setMeta('lastPasswordId', meta.passwordId);

      // Keep password in session only for convenience (not localStorage)
      try { sessionStorage.setItem('vc-team-pw-set', '1'); } catch (_) {}

      products = await getAll();
      const sel = products.find((p) => p.id === selectedId);
      if (sel) loadProduct(sel);
      else renderList();

      status.textContent = 'Đã đăng (đã mã hóa) ' + new Date().toLocaleString('vi-VN') + ' · ' + commit.sha.slice(0, 7);
      $('#pwStatus').textContent = 'passwordId: ' + meta.passwordId;
      toast('Đã đăng bản mã hóa lên GitHub ✓');
      $('#changePassword').checked = false;
      $('#teamPassword2').value = '';
    } catch (e) {
      console.warn(e);
      status.textContent = 'Lỗi: ' + (e.message || e);
      toast('Đăng thất bại');
    }
  }

  function bind() {
    $('#repoName').textContent = `${CFG.githubOwner}/${CFG.githubRepo}`;
    $('#ghToken').value = localStorage.getItem(TOKEN_KEY) || '';
    $('#btnSaveToken').onclick = () => {
      const t = $('#ghToken').value.trim();
      if (!t) { toast('Token trống'); return; }
      localStorage.setItem(TOKEN_KEY, t);
      toast('Đã lưu token trên máy này');
    };
    $('#btnClearToken').onclick = () => {
      localStorage.removeItem(TOKEN_KEY);
      $('#ghToken').value = '';
      toast('Đã xóa token');
    };
    $('#btnPublish').onclick = () => publishToGithub();
    $('#btnNew').onclick = () => {
      if (dirty && !confirm('Bỏ thay đổi?')) return;
      const id = uid();
      loadProduct({ id, title: '', category: 'Tư vấn sản phẩm', variants: [{ id: uid(), label: 'Tin đầy đủ', html: '' }], images: [] });
      $('#editId').value = id;
      dirty = true;
      $('#editTitle').focus();
    };
    $('#btnSave').onclick = saveCurrent;
    $('#btnAddVariant').onclick = () => {
      syncFromDom();
      editVariants.push({ id: uid(), label: 'Mẫu mới', html: '', sortOrder: editVariants.length });
      renderVariants();
      dirty = true;
    };
    $('#btnExport').onclick = exportPack;
    $('#btnImport').onclick = () => $('#importFile').click();
    $('#importFile').onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const merge = confirm('OK = Gộp\nCancel = hỏi thay thế');
      if (merge) await importPack(f, false);
      else if (confirm('Thay thế toàn bộ?')) await importPack(f, true);
    };

    $('#btnPickImages').onclick = () => $('#adminImagePicker').click();
    $('#adminImagePicker').onchange = async (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      for (const file of files) {
        if (editImages.length >= MAX_IMAGES) { toast('Tối đa ' + MAX_IMAGES + ' ảnh'); break; }
        try {
          const blob = await resizeImageFile(file);
          const dataURL = await blobToDataURL(blob);
          editImages.push({ id: uid(), source: 'synced', dataURL, path: null, hash: null });
        } catch (err) { console.warn(err); }
      }
      dirty = true;
      renderImages();
      updatePreview();
    };
    $('#editImages').addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm-img]');
      const up = e.target.closest('[data-img-up]');
      const down = e.target.closest('[data-img-down]');
      if (rm) {
        editImages.splice(Number(rm.dataset.rmImg), 1);
        dirty = true; renderImages(); updatePreview();
      }
      if (up) {
        const i = Number(up.dataset.imgUp);
        if (i > 0) {
          [editImages[i-1], editImages[i]] = [editImages[i], editImages[i-1]];
          dirty = true; renderImages(); updatePreview();
        }
      }
      if (down) {
        const i = Number(down.dataset.imgDown);
        if (i < editImages.length - 1) {
          [editImages[i+1], editImages[i]] = [editImages[i], editImages[i+1]];
          dirty = true; renderImages(); updatePreview();
        }
      }
    });

    $('#editVariants').addEventListener('click', (e) => {
      const cmd = e.target.closest('[data-cmd]');
      if (cmd) {
        e.preventDefault();
        const body = $(`.edit-variant[data-idx="${cmd.dataset.vi}"] .v-body`);
        if (!body) return;
        body.focus();
        if (cmd.dataset.cmd === 'insertLineBreak') document.execCommand('insertHTML', false, '<br>');
        else document.execCommand(cmd.dataset.cmd, false, null);
        dirty = true; updatePreview();
        return;
      }
      const up = e.target.closest('[data-up]');
      const down = e.target.closest('[data-down]');
      const rm = e.target.closest('[data-rm]');
      if (up || down || rm) syncFromDom();
      if (up) {
        const i = Number(up.dataset.up);
        if (i > 0) { [editVariants[i-1], editVariants[i]] = [editVariants[i], editVariants[i-1]]; renderVariants(); }
      }
      if (down) {
        const i = Number(down.dataset.down);
        if (i < editVariants.length-1) { [editVariants[i+1], editVariants[i]] = [editVariants[i], editVariants[i+1]]; renderVariants(); }
      }
      if (rm) {
        if (editVariants.length <= 1) { toast('Cần ≥1 mẫu'); return; }
        editVariants.splice(Number(rm.dataset.rm), 1);
        renderVariants();
      }
    });
    $('#editVariants').addEventListener('input', () => { dirty = true; updatePreview(); });
    $('#editTitle').addEventListener('input', () => { dirty = true; });
    $('#editCategory').addEventListener('input', () => { dirty = true; });
    $('#editPinned').addEventListener('change', () => { dirty = true; });

    $('#productList').addEventListener('click', async (e) => {
      const pinBtn = e.target.closest('[data-pin]');
      if (pinBtn) {
        e.stopPropagation();
        const id = pinBtn.dataset.pin;
        const p = products.find((x) => x.id === id);
        await setPinned(id, !(p && p.pinned));
        return;
      }
      const pinUp = e.target.closest('[data-pin-up]');
      if (pinUp) { e.stopPropagation(); await movePin(pinUp.dataset.pinUp, -1); return; }
      const pinDown = e.target.closest('[data-pin-down]');
      if (pinDown) { e.stopPropagation(); await movePin(pinDown.dataset.pinDown, 1); return; }
      const d = e.target.closest('[data-del]');
      if (d) {
        if (!confirm('Xóa sản phẩm?')) return;
        await del(d.dataset.del);
        products = await getAll();
        const first = sorted()[0];
        if (first) loadProduct(first); else { selectedId = null; renderList(); loadProduct(null); }
        toast('Đã xóa');
        return;
      }
      const item = e.target.closest('.list-item');
      if (!item) return;
      if (dirty && item.dataset.id !== selectedId && !confirm('Bỏ thay đổi?')) return;
      const p = products.find((x) => x.id === item.dataset.id);
      if (p) loadProduct(p);
    });

    let dragId = null;
    $('#productList').addEventListener('dragstart', (e) => {
      const item = e.target.closest('.list-item'); if (!item) return;
      dragId = item.dataset.id; item.style.opacity = '0.5';
    });
    $('#productList').addEventListener('dragend', (e) => {
      const item = e.target.closest('.list-item'); if (item) item.style.opacity = '';
      dragId = null;
    });
    $('#productList').addEventListener('dragover', (e) => { e.preventDefault(); });
    $('#productList').addEventListener('drop', async (e) => {
      e.preventDefault();
      const item = e.target.closest('.list-item');
      if (!item || !dragId || dragId === item.dataset.id) return;
      const order = sorted().map((p) => p.id);
      const from = order.indexOf(dragId), to = order.indexOf(item.dataset.id);
      order.splice(to, 0, order.splice(from, 1)[0]);
      for (let i = 0; i < order.length; i++) {
        const p = products.find((x) => x.id === order[i]);
        if (p) { p.sortOrder = i; await put(p); }
      }
      products = await getAll();
      renderList();
      toast('Đã đổi thứ tự');
    });

    const hint = $('#dropHint');
    ['dragenter','dragover'].forEach((ev) => hint.addEventListener(ev, (e) => { e.preventDefault(); hint.classList.add('over'); }));
    ['dragleave','drop'].forEach((ev) => hint.addEventListener(ev, (e) => { e.preventDefault(); hint.classList.remove('over'); }));
    hint.addEventListener('drop', async (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) await importPack(f, false);
    });
  }

  async function init() {
    db = await openDB();
    products = await getAll();
    if (!products.length) {
      const seeded = await getMeta('seeded-v3');
      if (!seeded) {
        await put(sampleProduct());
        await setMeta('seeded-v3', true);
        products = await getAll();
      }
    }
    const sample = products.find((p) => p.id === 'sample-linen-xanh-pastel');
    if (sample && sample.variants.length === 1) {
      const fresh = sampleProduct();
      fresh.images = sample.images || [];
      await put(fresh);
      products = await getAll();
    }
    bind();
    const first = sorted()[0];
    if (first) loadProduct(first);
    else renderList();
  }
  init().catch((e) => { console.error(e); toast('Lỗi khởi tạo'); });
})();
