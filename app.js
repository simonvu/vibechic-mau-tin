/* VibeChic — products with multiple message variants + GitHub sync */
(() => {
  'use strict';
  const { uid, sanitizeHtml, htmlToPlain, htmlToClipboardHtml, migrateProduct,
    packProductsTextOnly, exportFileName, parseImportList, sampleProduct, imagePublicUrl } = window.VC;
  const CFG = window.VC_CONFIG || {};
  const CryptoUtil = window.VCCrypto;

  const DB_NAME = 'vibechic-templates';
  const DB_VER = 2;
  const STORE = 'products';
  const META = 'meta';
  const MAX_IMAGES = 5;
  const MAX_IMG_EDGE = 1200;
  const JPEG_QUALITY = 0.82;

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  let db, products = [], activeCategory = 'Tất cả', searchQuery = '';
  let currentId = null, selectedVariantId = null;
  let editImages = [], editVariants = [];
  let unicodePrefer = localStorage.getItem('vc-unicode') === '1';
  let pendingImportFile = null;
  let teamKey = null; // CryptoKey non-extractable
  let teamPasswordId = null;
  let unlockResolved = false;
  let localPins = {}; // { [productId]: pinOrderNumber } personal pins

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2200);
  }
  function showOverlay(id) {
    const el = $(id); el.hidden = false; el.classList.add('show'); el.removeAttribute('hidden');
  }
  function hideOverlay(id) {
    const el = $(id); el.classList.remove('show'); el.hidden = true;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          const s = d.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('category', 'category', { unique: false });
        }
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'key' });
        // Migrate old 'templates' store → products
        if (d.objectStoreNames.contains('templates') && e.oldVersion < 2) {
          const tx = req.transaction;
          try {
            const old = tx.objectStore('templates');
            const dest = tx.objectStore(STORE);
            old.openCursor().onsuccess = (ev) => {
              const cur = ev.target.result;
              if (!cur) return;
              const m = migrateProduct(cur.value);
              if (m) dest.put(m);
              cur.continue();
            };
          } catch (_) {}
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function txDone(tx) {
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('aborted'));
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
  async function putProduct(p) {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(migrateProduct(p));
    await txDone(tx);
  }
  async function deleteProduct(id) {
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
      try {
        const tx = db.transaction(META, 'readonly');
        const req = tx.objectStore(META).get(key);
        req.onsuccess = () => resolve(req.result ? req.result.value : null);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  async function setMeta(key, value) {
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).put({ key, value });
    await txDone(tx);
  }

  // Also try reading leftover templates store once
  async function migrateLegacyStore() {
    if (!db.objectStoreNames.contains('templates')) return;
    const legacy = await new Promise((resolve) => {
      try {
        const tx = db.transaction('templates', 'readonly');
        const req = tx.objectStore('templates').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
    if (!legacy.length) return;
    for (const row of legacy) {
      const m = migrateProduct(row);
      if (!m) continue;
      const existing = products.find((p) => p.id === m.id);
      if (existing) {
        m.images = existing.images.length ? existing.images : m.images;
        // merge variants by id
        const map = new Map(existing.variants.map((v) => [v.id, v]));
        for (const v of m.variants) {
          if (!map.has(v.id)) map.set(v.id, v);
          else map.set(v.id, { ...map.get(v.id), ...v, html: v.html });
        }
        m.variants = [...map.values()];
      }
      await putProduct(m);
    }
    products = await getAll();
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  function dataURLToBlob(dataURL) {
    const [head, b64] = dataURL.split(',');
    const mime = (head.match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  function blobToPngBlob(blob) {
    return new Promise(async (resolve, reject) => {
      try {
        if (blob.type === 'image/png') { resolve(blob); return; }
        const bmp = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width; canvas.height = bmp.height;
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close && bmp.close();
        canvas.toBlob((b) => b ? resolve(b) : reject(new Error('png')), 'image/png');
      } catch (e) { reject(e); }
    });
  }
  function copyImageToClipboard(dataURL) {
    const blob = dataURLToBlob(dataURL);
    if (!navigator.clipboard || !window.ClipboardItem) return Promise.reject(new Error('no clipboard'));
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': blobToPngBlob(blob) })]);
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

  async function copyText(html, useUnicode) {
    const plain = htmlToPlain(html, { unicode: useUnicode });
    const rich = htmlToClipboardHtml(html);
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([rich], { type: 'text/html' })
        })]);
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(plain);
      } else {
        const ta = document.createElement('textarea');
        ta.value = plain; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      toast('Đã copy chữ ✓');
    } catch {
      try { await navigator.clipboard.writeText(plain); toast('Đã copy chữ ✓'); }
      catch { toast('Không copy được'); }
    }
  }


  async function loadLocalPins() {
    const v = await getMeta('localPins');
    localPins = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  }
  async function saveLocalPins() {
    await setMeta('localPins', localPins);
  }
  function isHot(p) {
    return !!(p && (p.pinned || localPins[p.id] != null));
  }
  function hotRank(p) {
    // Admin pins first (by pinOrder), then personal-only pins
    if (p.pinned) return (p.pinOrder != null ? Number(p.pinOrder) : 0);
    if (localPins[p.id] != null) return 10000 + Number(localPins[p.id]);
    return 99999;
  }
  async function toggleLocalPin(id) {
    if (localPins[id] != null) {
      delete localPins[id];
      await saveLocalPins();
      toast('Đã bỏ ghim cá nhân');
    } else {
      const vals = Object.values(localPins).map(Number);
      const next = vals.length ? Math.max(...vals) + 1 : 0;
      localPins[id] = next;
      await saveLocalPins();
      toast('Đã ghim cá nhân 📌');
    }
    refresh();
    if (currentId === id) openDetail(id);
  }

    function categories() {
    const set = new Set(products.map((p) => p.category || 'Khác'));
    return ['Tất cả', ...[...set].sort((a, b) => a.localeCompare(b, 'vi'))];
  }
  function sortedProducts() {
    return [...products].sort((a, b) => {
      const ah = isHot(a) ? 0 : 1;
      const bh = isHot(b) ? 0 : 1;
      if (ah !== bh) return ah - bh;
      if (isHot(a) && isHot(b)) {
        const ra = hotRank(a), rb = hotRank(b);
        if (ra !== rb) return ra - rb;
      }
      const sa = a.sortOrder != null ? a.sortOrder : 9999;
      const sb = b.sortOrder != null ? b.sortOrder : 9999;
      if (sa !== sb) return sa - sb;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }
  function filtered() {
    const q = searchQuery.trim().toLowerCase();
    return sortedProducts().filter((p) => {
      if (activeCategory !== 'Tất cả' && (p.category || 'Khác') !== activeCategory) return false;
      if (!q) return true;
      const blob = [p.title, p.category, ...(p.variants || []).map((v) => v.label + ' ' + htmlToPlain(v.html))]
        .join(' ').toLowerCase();
      return blob.includes(q);
    });
  }

  function renderChips() {
    $('#categoryChips').innerHTML = categories().map((c) =>
      `<button type="button" class="chip${c === activeCategory ? ' active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`
    ).join('');
  }
  function cardThumbHtml(p) {
    const imgs = p.images || [];
    const synced = imgs.find((im) => im.source === 'synced' || im.path);
    const local = imgs.find((im) => im.source === 'local' && (im.dataURL || im.url));
    const any = imgs.find((im) => im.dataURL || imagePublicUrl(im));
    const im = synced || local || any;
    if (im) {
      const src = im.dataURL || imagePublicUrl(im);
      if (src) {
        return `<img class="card-thumb" src="${src}" alt="" loading="lazy" decoding="async" width="64" height="64" />`;
      }
    }
    const initial = ((p.title || '?').trim().charAt(0) || '?').toUpperCase();
    return `<div class="card-thumb placeholder" aria-hidden="true"><img src="icons/logo-128.png" alt="" loading="lazy" width="28" height="28" /><span>${escapeHtml(initial)}</span></div>`;
  }

  function renderList() {
    const list = filtered();
    const box = $('#productList');
    if (!list.length) {
      box.innerHTML = `<div class="empty"><div class="emoji">💌</div>Chưa có sản phẩm.<br>Bấm ＋ hoặc đồng bộ từ GitHub.</div>`;
      return;
    }
    const hot = list.filter(isHot);
    const rest = list.filter((p) => !isHot(p));
    const card = (p) => {
      const n = (p.variants || []).length;
      const preview = (p.variants && p.variants[0]) ? p.variants[0].html : '';
      const pinBits = [];
      if (p.pinned) pinBits.push('đội');
      if (localPins[p.id] != null) pinBits.push('máy');
      const pinLabel = pinBits.length ? ` · 📌 ${pinBits.join('+')}` : '';
      return `<button type="button" class="card${isHot(p) ? ' card-hot' : ''}" data-id="${p.id}">
        <div class="card-row">
          <div class="card-thumb-wrap">${cardThumbHtml(p)}</div>
          <div class="card-body">
            <div class="title">${isHot(p) ? '<span class="pin-badge" aria-hidden="true">📌</span> ' : ''}${escapeHtml(p.title)}</div>
            <div class="meta">${escapeHtml(p.category || 'Khác')} · ${(p.images||[]).length} ảnh${pinLabel}</div>
            <div class="badge">${n} mẫu câu</div>
            <div class="preview">${preview}</div>
          </div>
        </div>
      </button>`;
    };
    let html = '';
    if (hot.length) {
      html += `<div class="list-section hot-section"><span>📌 Đang hot</span><span class="hot-count">${hot.length}</span></div>`;
      html += hot.map(card).join('');
    }
    if (rest.length) {
      if (hot.length) html += `<div class="list-section">Tất cả sản phẩm</div>`;
      html += rest.map(card).join('');
    }
    box.innerHTML = html;
  }
  function refresh() {
    renderChips();
    renderList();
    $('#categoryList').innerHTML = categories().filter((c) => c !== 'Tất cả')
      .map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
  }

  function openDetail(id) {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    currentId = id;
    selectedVariantId = (p.variants[0] && p.variants[0].id) || null;
    $('#detailTitle').textContent = p.title;
    const pinBits = [];
    if (p.pinned) pinBits.push('ghim đội');
    if (localPins[p.id] != null) pinBits.push('ghim máy');
    $('#detailMeta').textContent = `${p.category || 'Khác'} · ${(p.images||[]).length} ảnh · ${p.variants.length} mẫu${pinBits.length ? ' · 📌 ' + pinBits.join(', ') : ''}`;
    const pinBtn = $('#btnLocalPin');
    if (pinBtn) {
      const on = localPins[p.id] != null;
      pinBtn.textContent = on ? '📌 Bỏ ghim máy này' : '📌 Ghim trên máy này';
      pinBtn.classList.toggle('pin-on', on);
    }
    const teamPin = $('#teamPinHint');
    if (teamPin) teamPin.hidden = !p.pinned;
    $('#unicodeToggle').checked = unicodePrefer;

    const vbox = $('#variantList');
    vbox.innerHTML = (p.variants || []).map((v) => `
      <div class="variant-card" data-vid="${v.id}">
        <div class="v-label">${escapeHtml(v.label)}</div>
        <div class="v-preview">${v.html || ''}</div>
        <button type="button" class="btn btn-primary" style="width:100%" data-copy-var="${v.id}">📋 Copy chữ</button>
      </div>`).join('') || '<p style="color:var(--muted)">Chưa có mẫu câu</p>';

    const imgs = p.images || [];
    const synced = imgs.filter((im) => im.source !== 'local');
    const locals = imgs.filter((im) => im.source === 'local');
    const renderImgRow = (im, i, label) => `
      <div class="image-copy-item">
        <img src="${im.dataURL || imagePublicUrl(im)}" alt="Ảnh ${i+1}" />
        <button type="button" class="btn btn-secondary" data-copy-img="${i}">🖼️ ${label}${im.source==='local'?' <span class="tag-local">local</span>':''}</button>
      </div>`;
    $('#imageCopyActions').innerHTML =
      (synced.length ? `<div class="section-label">Ảnh đồng bộ</div>` : '') +
      synced.map((im) => renderImgRow(im, imgs.indexOf(im), 'Copy ảnh')).join('') +
      (locals.length ? `<div class="section-label" style="margin-top:8px">Ảnh chỉ trên máy này</div>` : '') +
      locals.map((im) => renderImgRow(im, imgs.indexOf(im), 'Copy ảnh')).join('');
    $('#saveImagesFallback').innerHTML = imgs.map((im, i) =>
      `<button type="button" class="btn btn-ghost" data-save-img="${i}">💾 Lưu ảnh ${i+1}</button>`).join('');
    showOverlay('#detailOverlay');
  }

  function renderEditVariants() {
    const box = $('#editVariants');
    if (!editVariants.length) {
      box.innerHTML = '<p style="color:var(--muted);font-size:0.9rem">Chưa có mẫu — bấm “Thêm mẫu”.</p>';
      return;
    }
    box.innerHTML = editVariants.map((v, i) => `
      <div class="edit-variant" data-idx="${i}">
        <div class="v-head">
          <span style="color:var(--muted);cursor:grab" title="Thứ tự">⋮⋮ ${i+1}</span>
          <input type="text" class="v-label-input" value="${escapeHtml(v.label)}" placeholder="Nhãn mẫu (VD: Báo giá)" maxlength="80" />
          <button type="button" class="btn btn-ghost" data-up="${i}" ${i===0?'disabled':''}>↑</button>
          <button type="button" class="btn btn-ghost" data-down="${i}" ${i===editVariants.length-1?'disabled':''}>↓</button>
          <button type="button" class="btn btn-danger" data-rm-var="${i}">✕</button>
        </div>
        <div class="v-tools">
          <button type="button" data-cmd="bold" data-vi="${i}"><b>B</b></button>
          <button type="button" data-cmd="italic" data-vi="${i}"><i>I</i></button>
          <button type="button" data-cmd="insertUnorderedList" data-vi="${i}">• List</button>
          <button type="button" data-cmd="insertLineBreak" data-vi="${i}">↵</button>
          <button type="button" data-cmd="removeFormat" data-vi="${i}">Tx</button>
        </div>
        <div class="v-body" contenteditable="true" data-vi="${i}" data-placeholder="Nội dung mẫu câu…">${v.html || ''}</div>
      </div>`).join('');
  }
  function renderEditImages() {
    const box = $('#editImages');
    const parts = editImages.map((im, i) => `
      <div class="img-thumb">
        <img src="${im.url || im.dataURL}" alt="" />
        <button type="button" class="rm" data-rm="${i}" aria-label="Xóa">×</button>
      </div>`);
    if (editImages.length < MAX_IMAGES) {
      parts.push(`<button type="button" class="add-img" id="btnAddImg" aria-label="Thêm ảnh">＋</button>`);
    }
    box.innerHTML = parts.join('');
  }
  function syncEditVariantsFromDom() {
    $$('#editVariants .edit-variant').forEach((el, i) => {
      if (!editVariants[i]) return;
      const lab = el.querySelector('.v-label-input');
      const body = el.querySelector('.v-body');
      if (lab) editVariants[i].label = lab.value;
      if (body) editVariants[i].html = sanitizeHtml(body.innerHTML);
    });
  }
  function openEditor(p) {
    editImages = [];
    $('#editId').value = p ? p.id : '';
    $('#editTitle').textContent = p ? 'Sửa sản phẩm' : 'Thêm sản phẩm';
    $('#editTitleInput').value = p ? p.title : '';
    $('#editCategory').value = p ? (p.category || '') : 'Tư vấn sản phẩm';
    if (p && p.images) {
      editImages = p.images.map((im) => ({
        id: im.id || uid(),
        dataURL: im.dataURL,
        url: im.dataURL || imagePublicUrl(im),
        source: im.source || 'local',
        path: im.path || null,
        hash: im.hash || null
      }));
    }
    editVariants = p && p.variants && p.variants.length
      ? p.variants.map((v, i) => ({ id: v.id || uid(), label: v.label, html: v.html || '', sortOrder: i }))
      : [{ id: uid(), label: 'Tin đầy đủ', html: '', sortOrder: 0 }];
    renderEditImages();
    renderEditVariants();
    showOverlay('#editOverlay');
  }


  async function saveTeamKey(key, passwordId) {
    const tx = db.transaction(META, 'readwrite');
    const store = tx.objectStore(META);
    store.put({ key: 'teamKey', value: key });
    store.put({ key: 'passwordId', value: passwordId });
    await txDone(tx);
    teamKey = key;
    teamPasswordId = passwordId;
  }
  async function loadTeamKeyFromDB() {
    teamKey = await getMeta('teamKey');
    teamPasswordId = await getMeta('passwordId');
    return !!(teamKey && teamPasswordId);
  }
  async function clearTeamKey() {
    const tx = db.transaction(META, 'readwrite');
    const store = tx.objectStore(META);
    store.delete('teamKey');
    store.delete('passwordId');
    await txDone(tx);
    teamKey = null;
    teamPasswordId = null;
  }

  async function fetchJsonUrls(urls) {
    let lastErr = null;
    for (const url of urls) {
      if (!url) continue;
      try {
        const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('fetch failed');
  }

  async function fetchCryptoMeta() {
    try {
      return await fetchJsonUrls([CFG.cryptoMetaUrl, CFG.cryptoMetaRawUrl]);
    } catch (_) {
      try {
        const cache = await caches.open('vibechic-data-v1');
        const hit = await cache.match('crypto-meta.json');
        if (hit) return await hit.json();
      } catch (_) {}
      return null;
    }
  }

  function showLock(msg) {
    const ov = $('#lockOverlay');
    ov.hidden = false; ov.classList.add('show');
    $('#unlockError').textContent = msg || '';
    $('#unlockPassword').value = '';
    setTimeout(() => $('#unlockPassword').focus(), 200);
  }
  function hideLock() {
    const ov = $('#lockOverlay');
    ov.classList.remove('show'); ov.hidden = true;
  }

  async function tryUnlock(password) {
    const meta = await fetchCryptoMeta();
    if (!meta || !meta.salt) throw new Error('Chưa có crypto-meta trên GitHub — admin cần Đăng lên trước');
    const key = await CryptoUtil.deriveKey(password, meta.salt, meta.iterations || CryptoUtil.KDF_ITERATIONS);
    // Verify by decrypting templates
    const enc = await fetchJsonUrls([CFG.templatesUrl, CFG.templatesRawUrl]);
    if (!CryptoUtil.isEncryptedEnvelope(enc)) {
      // allow plaintext legacy during transition only if decrypt not needed
      throw new Error('templates.json chưa mã hóa — admin hãy Đăng lên lại');
    }
    try {
      const text = await CryptoUtil.decryptText(key, enc);
      JSON.parse(text);
    } catch (_) {
      throw new Error('Sai mật khẩu');
    }
    await saveTeamKey(key, meta.passwordId);
    try {
      const cache = await caches.open('vibechic-data-v1');
      await cache.put('crypto-meta.json', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    } catch (_) {}
    return true;
  }

  async function ensureUnlockedForSync() {
    const meta = await fetchCryptoMeta();
    if (!meta) return false; // no remote yet
    await loadLocalPins();
    await loadTeamKeyFromDB();
    if (teamKey && teamPasswordId && teamPasswordId === meta.passwordId) return true;
    // password changed or missing
    await clearTeamKey();
    return new Promise((resolve) => {
      showLock(teamPasswordId && teamPasswordId !== meta.passwordId
        ? 'Admin đã đổi mật khẩu đội — nhập mật khẩu mới'
        : '');
      const onUnlock = async () => {
        const pw = $('#unlockPassword').value;
        $('#unlockError').textContent = '';
        try {
          await tryUnlock(pw);
          hideLock();
          $('#btnUnlock').removeEventListener('click', onUnlock);
          resolve(true);
        } catch (e) {
          $('#unlockError').textContent = e.message || 'Sai mật khẩu';
        }
      };
      const onSkip = () => {
        hideLock();
        $('#btnUnlock').removeEventListener('click', onUnlock);
        resolve(false);
      };
      $('#btnUnlock').onclick = onUnlock;
      $('#btnSkipUnlock').onclick = onSkip;
      $('#unlockPassword').onkeydown = (e) => { if (e.key === 'Enter') onUnlock(); };
    });
  }

  async function decryptRemoteTemplates(enc) {
    if (!teamKey) throw new Error('no key');
    if (CryptoUtil.isEncryptedEnvelope(enc)) {
      const text = await CryptoUtil.decryptText(teamKey, enc);
      return JSON.parse(text);
    }
    // legacy plaintext
    return enc;
  }

  async function ensureImageCached(im) {
    if (im.dataURL) return im;
    if (!im.path || !teamKey) return im;
    const base = (CFG.pagesAppUrl || '').replace(/\/?$/, '/');
    const urls = [base + im.path.replace(/^\//, '')];
    if (CFG.templatesRawUrl) {
      urls.push(CFG.templatesRawUrl.replace(/templates\\.json.*/, '') + im.path.replace(/^\//, ''));
    }
    for (const url of urls) {
      try {
        const res = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) continue;
        const env = await res.json();
        const bytes = await CryptoUtil.decryptBytes(teamKey, env);
        // to dataURL jpeg
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        im.dataURL = 'data:image/jpeg;base64,' + btoa(binary);
        im.source = 'synced';
        return im;
      } catch (e) { console.warn('img', url, e); }
    }
    return im;
  }

  async function mergeProducts(incoming, { replace = false } = {}) {
    if (replace) {
      // Preserve nothing except we clear — but keep local-only images? Spec: replace clears.
      await clearAll();
      for (let i = 0; i < incoming.length; i++) {
        const m = migrateProduct({ ...incoming[i], sortOrder: i });
        // incoming synced images may lack dataURL — fetch
        const imgs = [];
        for (const im of (m.images || [])) {
          if (im.source === 'local' && im.dataURL) { imgs.push(im); continue; }
          const cached = await ensureImageCached({ ...im, source: 'synced' });
          imgs.push(cached);
        }
        m.images = imgs;
        await putProduct(m);
      }
    } else {
      const byId = new Map(products.map((p) => [p.id, p]));
      for (let i = 0; i < incoming.length; i++) {
        const inc = migrateProduct(incoming[i]);
        if (!inc) continue;
        const prev = byId.get(inc.id);
        const localOnly = prev ? (prev.images || []).filter((im) => im.source === 'local') : [];
        const syncedIn = [];
        for (const im of (inc.images || [])) {
          const prevImg = prev && (prev.images || []).find((x) => x.id === im.id || (x.hash && x.hash === im.hash));
          if (prevImg && prevImg.dataURL && prevImg.hash === im.hash) {
            syncedIn.push({ ...im, dataURL: prevImg.dataURL, source: 'synced' });
          } else {
            syncedIn.push(await ensureImageCached({ ...im, source: 'synced' }));
          }
        }
        const variants = (() => {
          if (!prev) return inc.variants;
          const vMap = new Map(prev.variants.map((v) => [v.id, v]));
          for (const v of inc.variants) {
            const old = vMap.get(v.id);
            vMap.set(v.id, { ...(old || {}), ...v, id: v.id });
          }
          return [...vMap.values()].sort((a, b) => (a.sortOrder||0) - (b.sortOrder||0));
        })();
        await putProduct({
          ...(prev || {}),
          id: inc.id,
          title: inc.title,
          category: inc.category,
          sortOrder: inc.sortOrder != null ? inc.sortOrder : (prev ? prev.sortOrder : products.length + i),
          variants,
          images: [...syncedIn, ...localOnly],
          createdAt: prev ? prev.createdAt : (inc.createdAt || Date.now()),
          updatedAt: Date.now()
        });
      }
    }
    products = await getAll();
    refresh();
  }

  async function syncFromGithub() {
    $('#syncStatus').textContent = 'Đang đồng bộ…';
    const unlocked = await ensureUnlockedForSync();
    if (!unlocked && !teamKey) {
      $('#syncStatus').textContent = 'Chưa mở khóa';
      return false;
    }
    let enc = null;
    try {
      enc = await fetchJsonUrls([CFG.templatesUrl, CFG.templatesRawUrl]);
      try {
        const cache = await caches.open('vibechic-data-v1');
        await cache.put('templates.json', new Response(JSON.stringify(enc), { headers: { 'Content-Type': 'application/json' } }));
      } catch (_) {}
    } catch (_) {
      try {
        const cache = await caches.open('vibechic-data-v1');
        const hit = await cache.match('templates.json');
        if (hit) enc = await hit.json();
      } catch (_) {}
    }
    if (!enc) {
      $('#syncStatus').textContent = 'Offline';
      return false;
    }
    let data;
    try {
      data = await decryptRemoteTemplates(enc);
    } catch (e) {
      console.warn(e);
      await clearTeamKey();
      $('#syncStatus').textContent = 'Cần mật khẩu';
      showLock('Không giải mã được — nhập lại mật khẩu đội');
      return false;
    }
    const list = parseImportList(data);
    if (list.length) {
      await mergeProducts(list, { replace: false });
      await setMeta('lastSync', Date.now());
      $('#syncStatus').textContent = 'Đã đồng bộ';
      return true;
    }
    $('#syncStatus').textContent = 'Chưa có data';
    return false;
  }

  async function ensureSeed() {
    if (products.length) return;
    const seeded = await getMeta('seeded-v3');
    if (seeded) return;
    await putProduct(sampleProduct());
    await setMeta('seeded-v3', true);
    products = await getAll();
  }

  function bind() {
    $('#searchInput').addEventListener('input', (e) => { searchQuery = e.target.value; renderList(); });
    $('#categoryChips').addEventListener('click', (e) => {
      const btn = e.target.closest('.chip'); if (!btn) return;
      activeCategory = btn.dataset.cat; refresh();
    });
    $('#productList').addEventListener('click', (e) => {
      const card = e.target.closest('.card'); if (card) openDetail(card.dataset.id);
    });
    $('#btnAdd').onclick = () => openEditor(null);
    $('#btnSettings').onclick = () => {
      $('#defaultUnicode').checked = unicodePrefer;
      showOverlay('#settingsOverlay');
    };
    $('#btnCloseSettings').onclick = () => hideOverlay('#settingsOverlay');
    $('#btnCloseDetail').onclick = () => hideOverlay('#detailOverlay');
    $('#btnCancelEdit').onclick = () => hideOverlay('#editOverlay');
    $$('.overlay').forEach((ov) => ov.addEventListener('click', (e) => {
      if (e.target === ov) { ov.classList.remove('show'); ov.hidden = true; }
    }));

    $('#btnLocalPin').onclick = async () => {
      if (!currentId) return;
      await toggleLocalPin(currentId);
    };
    $('#btnEdit').onclick = () => {
      const p = products.find((x) => x.id === currentId);
      hideOverlay('#detailOverlay');
      if (p) openEditor(p);
    };
    $('#btnDelete').onclick = async () => {
      if (!currentId || !confirm('Xóa sản phẩm này và mọi mẫu câu?')) return;
      await deleteProduct(currentId);
      products = await getAll();
      hideOverlay('#detailOverlay');
      refresh();
      toast('Đã xóa');
    };

    $('#variantList').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-copy-var]');
      if (!btn) return;
      const p = products.find((x) => x.id === currentId);
      const v = p && p.variants.find((x) => x.id === btn.dataset.copyVar);
      if (!v) return;
      selectedVariantId = v.id;
      await copyText(v.html, $('#unicodeToggle').checked);
    });

    $('#imageCopyActions').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy-img]');
      if (!btn) return;
      const p = products.find((x) => x.id === currentId);
      const im = p && p.images[Number(btn.dataset.copyImg)];
      if (!im || !im.dataURL) { toast('Ảnh chưa tải — thử Đồng bộ'); return; }
      copyImageToClipboard(im.dataURL)
        .then(() => toast('Đã copy ảnh ✓'))
        .catch(() => {
          const a = document.createElement('a');
          a.href = im.dataURL; a.download = `anh-${btn.dataset.copyImg}.jpg`; a.click();
          toast('Đã tải ảnh xuống');
        });
    });
    $('#saveImagesFallback').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-save-img]');
      if (!btn) return;
      const p = products.find((x) => x.id === currentId);
      const im = p && p.images[Number(btn.dataset.saveImg)];
      if (!im) return;
      const a = document.createElement('a');
      a.href = im.dataURL; a.download = `${(p.title||'sp').slice(0,30)}-${btn.dataset.saveImg}.jpg`; a.click();
    });
    $('#btnShare').onclick = async () => {
      const p = products.find((x) => x.id === currentId);
      if (!p) return;
      const v = p.variants.find((x) => x.id === selectedVariantId) || p.variants[0];
      if (!v) return;
      const plain = htmlToPlain(v.html, { unicode: $('#unicodeToggle').checked });
      const files = [];
      for (let i = 0; i < (p.images||[]).length; i++) {
        const blob = dataURLToBlob(p.images[i].dataURL);
        files.push(new File([blob], `vibechic-${i+1}.jpg`, { type: 'image/jpeg' }));
      }
      try {
        const data = { text: plain };
        if (files.length && navigator.canShare && navigator.canShare({ files })) data.files = files;
        if (navigator.share) await navigator.share(data);
        else await copyText(v.html, $('#unicodeToggle').checked);
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        await copyText(v.html, $('#unicodeToggle').checked);
      }
    };

    $('#unicodeToggle').onchange = (e) => {
      unicodePrefer = e.target.checked;
      localStorage.setItem('vc-unicode', unicodePrefer ? '1' : '0');
      $('#defaultUnicode').checked = unicodePrefer;
    };
    $('#defaultUnicode').onchange = (e) => {
      unicodePrefer = e.target.checked;
      localStorage.setItem('vc-unicode', unicodePrefer ? '1' : '0');
    };

    $('#btnAddVariant').onclick = () => {
      syncEditVariantsFromDom();
      editVariants.push({ id: uid(), label: 'Mẫu mới', html: '', sortOrder: editVariants.length });
      renderEditVariants();
    };
    $('#editVariants').addEventListener('click', (e) => {
      const up = e.target.closest('[data-up]');
      const down = e.target.closest('[data-down]');
      const rm = e.target.closest('[data-rm-var]');
      const cmdBtn = e.target.closest('[data-cmd]');
      if (cmdBtn) {
        e.preventDefault();
        const vi = Number(cmdBtn.dataset.vi);
        const body = $(`.edit-variant[data-idx="${vi}"] .v-body`);
        if (body) {
          body.focus();
          const cmd = cmdBtn.dataset.cmd;
          if (cmd === 'insertLineBreak') document.execCommand('insertHTML', false, '<br>');
          else document.execCommand(cmd, false, null);
        }
        return;
      }
      if (up || down || rm) syncEditVariantsFromDom();
      if (up) {
        const i = Number(up.dataset.up);
        if (i > 0) { const t = editVariants[i-1]; editVariants[i-1] = editVariants[i]; editVariants[i] = t; renderEditVariants(); }
      }
      if (down) {
        const i = Number(down.dataset.down);
        if (i < editVariants.length - 1) { const t = editVariants[i+1]; editVariants[i+1] = editVariants[i]; editVariants[i] = t; renderEditVariants(); }
      }
      if (rm) {
        const i = Number(rm.dataset.rmVar);
        if (editVariants.length <= 1) { toast('Cần ít nhất 1 mẫu'); return; }
        editVariants.splice(i, 1);
        renderEditVariants();
      }
    });

    $('#editImages').addEventListener('click', (e) => {
      if (e.target.closest('#btnAddImg')) { $('#imagePicker').click(); return; }
      const rm = e.target.closest('[data-rm]');
      if (rm) { editImages.splice(Number(rm.dataset.rm), 1); renderEditImages(); }
    });
    $('#btnAddImagesDetail').onclick = () => {
      // reuse picker then attach to current product
      const picker = $('#imagePicker');
      const handler = async (e) => {
        picker.removeEventListener('change', handler);
        const p = products.find((x) => x.id === currentId);
        if (!p) return;
        const files = [...(e.target.files || [])];
        picker.value = '';
        for (const file of files) {
          if ((p.images||[]).length >= MAX_IMAGES) break;
          if (!file.type.startsWith('image/')) continue;
          try {
            const blob = await resizeImageFile(file);
            const dataURL = await blobToDataURL(blob);
            p.images = p.images || [];
            p.images.push({ id: uid(), dataURL, source: 'local' });
          } catch (_) {}
        }
        p.updatedAt = Date.now();
        await putProduct(p);
        products = await getAll();
        openDetail(p.id);
        toast('Đã thêm ảnh');
      };
      picker.addEventListener('change', handler);
      picker.click();
    };
    $('#imagePicker').addEventListener('change', async (e) => {
      // only for edit form (detail uses one-shot handler)
      if ($('#editOverlay').hidden) return;
      const files = [...(e.target.files || [])];
      e.target.value = '';
      for (const file of files) {
        if (editImages.length >= MAX_IMAGES) break;
        if (!file.type.startsWith('image/')) continue;
        try {
          const blob = await resizeImageFile(file);
          const dataURL = await blobToDataURL(blob);
          editImages.push({ id: uid(), blob, url: dataURL, dataURL, source: 'local' });
        } catch (_) { toast('Lỗi ảnh'); }
      }
      renderEditImages();
    });

    $('#editForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      syncEditVariantsFromDom();
      const title = $('#editTitleInput').value.trim();
      if (!title) { toast('Nhập tên sản phẩm'); return; }
      const variants = editVariants
        .map((v, i) => ({ id: v.id || uid(), label: (v.label || '').trim() || `Mẫu ${i+1}`, html: sanitizeHtml(v.html || ''), sortOrder: i }))
        .filter((v) => htmlToPlain(v.html).trim());
      if (!variants.length) { toast('Cần ít nhất 1 mẫu có nội dung'); return; }
      const id = $('#editId').value || uid();
      const prev = products.find((x) => x.id === id);
      const images = [];
      for (const im of editImages) images.push({
        id: im.id,
        dataURL: im.dataURL || await blobToDataURL(im.blob),
        source: im.source || 'local',
        path: im.path || null,
        hash: im.hash || null
      });
      await putProduct({
        id, title,
        category: $('#editCategory').value.trim() || 'Khác',
        variants, images,
        pinned: prev ? !!prev.pinned : false,
        pinOrder: prev && prev.pinned ? prev.pinOrder : null,
        sortOrder: prev ? prev.sortOrder : products.length,
        createdAt: prev ? prev.createdAt : Date.now(),
        updatedAt: Date.now()
      });
      products = await getAll();
      hideOverlay('#editOverlay');
      refresh();
      toast('Đã lưu sản phẩm');
    });

    $('#btnExport').onclick = () => {
      const payload = {
        app: 'vibechic-templates', version: 3, kind: 'text-pack',
        exportedAt: new Date().toISOString(),
        products: packProductsTextOnly(products)
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = exportFileName(); a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('Đã xuất JSON');
    };
    $('#btnImport').onclick = () => $('#importFile').click();
    $('#importFile').onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      pendingImportFile = f;
      $('#importFileName').textContent = f.name;
      showOverlay('#importOverlay');
    };
    $('#btnImportMerge').onclick = async () => {
      const f = pendingImportFile; pendingImportFile = null; hideOverlay('#importOverlay');
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const list = parseImportList(data);
        await mergeProducts(list, { replace: false });
        toast(`Đã gộp ${list.length} sản phẩm`);
      } catch { toast('File không hợp lệ'); }
    };
    $('#btnImportReplace').onclick = async () => {
      const f = pendingImportFile; pendingImportFile = null; hideOverlay('#importOverlay');
      if (!f) return;
      if (!confirm('Thay thế toàn bộ? Ảnh của sản phẩm bị xóa sẽ mất.')) return;
      try {
        const data = JSON.parse(await f.text());
        const list = parseImportList(data);
        await mergeProducts(list, { replace: true });
        toast(`Đã thay thế — ${list.length} sản phẩm`);
      } catch { toast('File không hợp lệ'); }
    };
    $('#btnImportCancel').onclick = () => { pendingImportFile = null; hideOverlay('#importOverlay'); };
    $('#btnSyncNow').onclick = async () => {
      const ok = await syncFromGithub();
      toast(ok ? 'Đã đồng bộ' : 'Không kéo được (repo chưa có / offline / chưa mở khóa)');
    };
    $('#btnLogout').onclick = async () => {
      if (!confirm('Xóa khóa mật khẩu đội trên máy này?')) return;
      await clearTeamKey();
      toast('Đã đăng xuất');
      hideOverlay('#settingsOverlay');
      showLock('Nhập lại mật khẩu để đồng bộ');
    };
  }

  async function init() {
    $('#defaultUnicode').checked = unicodePrefer;
    db = await openDB();
    products = await getAll();
    await migrateLegacyStore();
    await ensureSeed();
    products = await getAll();
    // If sample exists with old single-html shape, remigrate seed once
    const sample = products.find((p) => p.id === 'sample-linen-xanh-pastel');
    if (sample && sample.variants.length === 1 && sample.variants[0].label === 'Mẫu chính') {
      const fresh = sampleProduct();
      fresh.images = sample.images || [];
      await putProduct(fresh);
      products = await getAll();
    }
    bind();
    refresh();
    await loadLocalPins();
    await loadTeamKeyFromDB();
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js');
        reg.update && reg.update();
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!sessionStorage.getItem('vc-sw-reload')) {
            sessionStorage.setItem('vc-sw-reload', '1');
            location.reload();
          }
        });
      } catch (_) {}
    }
    // Check remote passwordId; prompt if needed then sync
    try {
      const meta = await fetchCryptoMeta();
      if (meta && meta.passwordId) {
        if (!teamKey || teamPasswordId !== meta.passwordId) {
          await clearTeamKey();
          const ok = await ensureUnlockedForSync();
          if (ok) await syncFromGithub();
          else $('#syncStatus').textContent = 'Local';
        } else {
          await syncFromGithub();
        }
      } else {
        $('#syncStatus').textContent = 'Chưa có repo';
      }
    } catch (_) {
      $('#syncStatus').textContent = 'Local';
    }
  }
  init().catch((err) => { console.error(err); toast('Lỗi khởi tạo'); });
})();
