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
  let hiddenIds = {}; // { [productId]: true } personal hide of team/admin items
  let myDeviceId = null;
  let staffDisplayName = '';
  let multiSelectMode = false;
  let selectedImageIdx = new Set(); // indices into product.images
  let preparedShareFiles = new Map(); // idx -> File (ready for sync share)


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

  function slugFilePart(s) {
    return String(s || 'vibechic')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'vibechic';
  }

  async function resolveImageDataURL(im) {
    if (im && im.dataURL) return im;
    let next = await ensureImageCached({ ...(im || {}) });
    if (next.dataURL) return next;
    // Last resort: fetch public URL (may be encrypted JSON — ensureImageCached handles that)
    const url = imagePublicUrl(im);
    if (url && !im.dataURL) {
      try {
        const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
        if (res.ok) {
          const ct = res.headers.get('Content-Type') || '';
          if (ct.includes('application/json')) {
            const env = await res.json();
            if (teamKey && CryptoUtil.isEncryptedEnvelope(env)) {
              const bytes = await CryptoUtil.decryptBytes(teamKey, env);
              let binary = '';
              const chunk = 0x8000;
              for (let i = 0; i < bytes.length; i += chunk) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
              }
              next = { ...im, dataURL: 'data:image/jpeg;base64,' + btoa(binary) };
              return next;
            }
          } else if (ct.startsWith('image/') || ct.includes('octet-stream')) {
            const blob = await res.blob();
            const dataURL = await blobToDataURL(blob);
            next = { ...im, dataURL };
            return next;
          }
        }
      } catch (e) { console.warn('resolveImage', e); }
    }
    return next || im;
  }

  function fileFromDataURL(dataURL, fileName) {
    const blob = dataURLToBlob(dataURL);
    const mime = blob.type || 'image/jpeg';
    const ext = /png/i.test(mime) ? 'png' : (/webp/i.test(mime) ? 'webp' : 'jpg');
    const base = String(fileName || 'vibechic').replace(/\.(jpe?g|png|webp)$/i, '');
    return new File([blob], base + '.' + ext, { type: mime.includes('png') ? 'image/png' : (mime.includes('webp') ? 'image/webp' : 'image/jpeg') });
  }

  async function prepareShareFileForIndex(p, idx) {
    const im = p && p.images && p.images[idx];
    if (!im) throw new Error('missing image');
    const resolved = await resolveImageDataURL(im);
    if (!resolved.dataURL) throw new Error('Ảnh chưa tải');
    // Persist dataURL onto product image for later copy
    if (p.images[idx] && !p.images[idx].dataURL) p.images[idx].dataURL = resolved.dataURL;
    const name = slugFilePart(p.title) + '-' + (idx + 1);
    const file = fileFromDataURL(resolved.dataURL, name);
    preparedShareFiles.set(idx, file);
    return file;
  }

  function canShareFiles(files) {
    if (!navigator.share) return false;
    if (!files || !files.length) return false;
    try {
      if (navigator.canShare && !navigator.canShare({ files })) return false;
    } catch (_) { return false; }
    return true;
  }

  function variantTabLabel(v, i) {
    const lab = String((v && v.label) || '').trim();
    if (!lab) return 'Câu ' + (i + 1);
    const generic = /^(mẫu(\s|$)|tin\s|mẫu chính|mẫu mới)/i.test(lab);
    if (generic) return 'Câu ' + (i + 1);
    return lab.length > 18 ? lab.slice(0, 16) + '…' : lab;
  }

  function selectedVariant(p) {
    if (!p) return null;
    return (p.variants || []).find((x) => x.id === selectedVariantId) || (p.variants || [])[0] || null;
  }

  function selectedVariantLabel(p) {
    const vars = (p && p.variants) || [];
    const v = selectedVariant(p);
    if (!v) return '—';
    const i = Math.max(0, vars.findIndex((x) => x.id === v.id));
    return variantTabLabel(v, i);
  }

  function updateSendFlowUI(p) {
    const bar = $('#multiShareBar');
    const idle = $('#sendFlowIdle');
    const shareBtn = $('#btnShareSelectedImages');
    const saveBtn = $('#btnSaveImagesShare');
    const countEl = $('#multiShareCount');
    const will = $('#sendWillCopy');
    const startBtn = $('#btnStartSend');
    if (!bar) return;
    const inSend = !!multiSelectMode;
    bar.hidden = !inSend;
    if (idle) idle.hidden = inSend || !(p && (p.images || []).length);
    if (startBtn) startBtn.hidden = !(p && (p.images || []).length);
    if (will) will.textContent = 'Sẽ copy: ' + selectedVariantLabel(p);
    const n = selectedImageIdx.size;
    let ready = 0;
    for (const i of selectedImageIdx) if (preparedShareFiles.has(i)) ready++;
    if (countEl) {
      countEl.textContent = n
        ? (ready < n ? (ready + '/' + n + ' sẵn sàng') : (n + ' ảnh đã chọn'))
        : '0 ảnh';
    }
    const ok = n > 0 && ready >= n;
    if (shareBtn) {
      shareBtn.disabled = !ok;
      shareBtn.textContent = ok ? ('Chia sẻ · ' + n + ' ảnh') : 'Chia sẻ';
    }
    if (saveBtn) {
      saveBtn.disabled = !ok;
    }
  }

  function renderVariantTabs(p) {
    const tabs = $('#variantTabs');
    const preview = $('#variantPreview');
    const vars = p.variants || [];
    if (!tabs || !preview) return;
    if (!vars.length) {
      tabs.innerHTML = '';
      preview.innerHTML = '<span style="color:var(--muted)">Chưa có câu</span>';
      return;
    }
    if (!selectedVariantId || !vars.some((v) => v.id === selectedVariantId)) {
      selectedVariantId = vars[0].id;
    }
    tabs.innerHTML = vars.map((v, i) => {
      const active = v.id === selectedVariantId;
      return `<button type="button" class="variant-tab${active ? ' active' : ''}" role="tab" aria-selected="${active ? 'true' : 'false'}" data-vid="${escapeHtml(v.id)}">${escapeHtml(variantTabLabel(v, i))}</button>`;
    }).join('');
    const v = selectedVariant(p);
    preview.innerHTML = (v && v.html) ? v.html : '<span style="color:var(--muted)">Trống</span>';
  }

  function renderDetailImages(p) {
    const box = $('#imageCopyActions');
    if (!box) return;
    const imgs = p.images || [];
    if (!imgs.length) {
      box.innerHTML = '<p style="color:var(--muted);font-size:0.9rem;grid-column:1/-1">Chưa có ảnh</p>';
      updateSendFlowUI(p);
      return;
    }
    box.innerHTML = imgs.map((im, i) => {
      const selected = selectedImageIdx.has(i);
      const personal = im.source === 'local';
      const isTeamExtra = !!(im.teamExtra || (im.source === 'team' && im.teamImage));
      const isTeamish = isTeamExtra || im.source === 'team' || im.teamImage;
      const selClass = multiSelectMode ? ('select-mode' + (selected ? ' selected' : '')) : '';
      const check = multiSelectMode
        ? `<span class="img-check" aria-hidden="true">${selected ? '✓' : ''}</span>`
        : '';
      const badge = personal
        ? '<span class="src-icon src-me" title="Ảnh riêng của tôi" aria-label="Riêng mình">🔒</span>'
        : (isTeamish
          ? '<span class="src-icon src-team" title="Ảnh của team" aria-label="Team">👥</span>'
          : '<span class="src-icon src-team" title="Ảnh của team" aria-label="Team">👥</span>');
      const canRemoveExtra = !multiSelectMode && im.teamExtra && myDeviceId && im.authorDeviceId === myDeviceId;
      const pushBtn = (!multiSelectMode && personal)
        ? `<button type="button" class="btn-tile-action btn-push-team" data-push-img="${i}" title="Đẩy lên team" aria-label="Đẩy lên team">👥</button>`
        : '';
      const rmBtn = canRemoveExtra
        ? `<button type="button" class="btn-tile-action btn-rm-extra" data-rm-extra="${i}" title="Xóa khỏi team" aria-label="Xóa khỏi team">✕</button>`
        : '';
      const src = im.dataURL || imagePublicUrl(im) || '';
      return `<div class="img-tile ${selClass}" data-img-idx="${i}" role="${multiSelectMode ? 'checkbox' : 'group'}" aria-checked="${selected ? 'true' : 'false'}">
        ${badge}${check}${pushBtn}${rmBtn}
        <img src="${src}" alt="Ảnh ${i + 1}" />
        <button type="button" class="btn-copy-mini" data-copy-img="${i}">Copy</button>
      </div>`;
    }).join('');
    updateSendFlowUI(p);
  }

  function openLightbox(src) {
    let lb = document.getElementById('imgLightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'imgLightbox';
      lb.innerHTML = '<img alt="Ảnh lớn" /><button type="button" class="lb-close" aria-label="Đóng">✕</button>';
      lb.addEventListener('click', () => lb.classList.remove('show'));
      document.body.appendChild(lb);
    }
    lb.querySelector('img').src = src;
    lb.classList.add('show');
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
      toast('Đã copy câu ✓');
    } catch {
      try { await navigator.clipboard.writeText(plain); toast('Đã copy câu ✓'); }
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
  async function loadHiddenIds() {
    const v = await getMeta('hiddenIds');
    hiddenIds = (v && typeof v === 'object') ? v : {};
  }
  async function saveHiddenIds() {
    await setMeta('hiddenIds', hiddenIds);
  }
  async function loadStaffDisplayName() {
    staffDisplayName = (await getMeta('staffDisplayName')) || '';
  }
  async function saveStaffDisplayName(name) {
    staffDisplayName = String(name || '').trim().slice(0, 40);
    await setMeta('staffDisplayName', staffDisplayName);
  }
  async function ensureMyDeviceId() {
    if (!window.VCDeviceCloud) return null;
    const dev = await VCDeviceCloud.ensureDeviceKey(getMeta, setMeta);
    myDeviceId = dev.id;
    return myDeviceId;
  }
  function isHidden(id) { return !!(id && hiddenIds[id]); }
  function sourceLabel(p) {
    if (!p) return '';
    if (p.personal) return 'của tôi';
    if (p.teamShared || p.source === 'team') {
      const by = (p.authorName || '').trim();
      return by ? ('team · by ' + by) : 'team';
    }
    return 'team';
  }
  function canEditProduct(p) {
    if (!p) return false;
    if (p.personal) return true;
    if (p.teamShared || p.source === 'team') {
      return !!(myDeviceId && p.authorDeviceId && p.authorDeviceId === myDeviceId);
    }
    return false; // admin pack — staff shouldn't edit on phone
  }

  function isHot(p) {
    return !!(p && (p.pinned || localPins[p.id] != null));
  }
  function hotRank(p) {
    // Admin pins first (by pinOrder), then personal-only pins
    if (p.pinned) return (p.pinOrder != null ? Number(p.pinOrder) : 0);
    if (localPins[p.id] != null) return 1e15 - Number(localPins[p.id]); // newest personal pin first
    return 99999;
  }
  async function toggleLocalPin(id) {
    if (localPins[id] != null) {
      delete localPins[id];
      await saveLocalPins();
      toast('Đã bỏ ghim');
    } else {
      const vals = Object.values(localPins).map(Number);
      localPins[id] = Math.max(Date.now(), (vals.length ? Math.max(...vals) : 0) + 1);
      const MAX_PINS = 10;
      const ids = Object.keys(localPins).sort((x, y) => Number(localPins[x]) - Number(localPins[y]));
      let dropped = 0;
      while (ids.length > MAX_PINS) { delete localPins[ids.shift()]; dropped++; }
      await saveLocalPins();
      toast(dropped ? 'Đã ghim 📌 (bỏ ghim mục cũ nhất)' : 'Đã ghim 📌');
    }
    refresh();
    if (currentId === id) openDetail(id);
    queueDeviceCloudSave();
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
      if (isHidden(p.id) && !(p.personal && !p.teamShared)) return false; // hide team/admin for self; personal never "hidden" this way
      if (isHidden(p.id)) return false;
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
        return `<img class="card-thumb" src="${src}" alt="" loading="lazy" decoding="async" width="96" height="96" />`;
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
          <div class="card-thumb-wrap">${cardThumbHtml(p)}<span class="thumb-count">${n} câu</span></div>
          <div class="card-body">
            <div class="title">${isHot(p) ? '<span class="pin-badge" aria-hidden="true">📌</span> ' : ''}${escapeHtml(p.title)}</div>
            <div class="meta">${escapeHtml(p.category || 'Khác')} · ${(p.images||[]).length} ảnh · ${escapeHtml(sourceLabel(p))}${pinLabel}</div>
            <div class="preview">${preview}</div>
          </div>
        </div>
      </button>`;
    };
    const html = hot.map(card).join('') + rest.map(card).join('');
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
    $('#detailMeta').textContent = `${p.category || 'Khác'} · ${(p.images||[]).length} ảnh · ${p.variants.length} mẫu · ${sourceLabel(p)}${pinBits.length ? ' · 📌 ' + pinBits.join(', ') : ''}`;
    const pinBtn = $('#btnLocalPin');
    if (pinBtn) {
      const on = localPins[p.id] != null;
      pinBtn.textContent = on ? '📌 Bỏ ghim' : '📌 Ghim';
      pinBtn.classList.toggle('pin-on', on);
    }
    const teamPin = $('#teamPinHint');
    if (teamPin) teamPin.hidden = !p.pinned;
    const by = $('#authorByline');
    if (by) {
      if ((p.teamShared || p.source === 'team') && (p.authorName || p.authorDeviceId)) {
        by.hidden = false;
        by.textContent = p.authorName ? ('Người gửi: ' + p.authorName) : ('Người gửi: máy ' + String(p.authorDeviceId || '').slice(0, 8));
      } else {
        by.hidden = true;
        by.textContent = '';
      }
    }
    const editable = canEditProduct(p);
    const isTeamOrAdmin = !p.personal || p.teamShared || p.source === 'team' || p.source === 'admin' || (!p.personal && !p.teamShared);
    // Hide button: for non-personal (team/admin) items
    const hideBtn = $('#btnHideItem');
    if (hideBtn) {
      const showHide = !p.personal || !!p.teamShared;
      hideBtn.hidden = !showHide;
      hideBtn.textContent = '🙈 Ẩn';
    }
    const moveBtn = $('#btnMovePersonal');
    if (moveBtn) {
      moveBtn.hidden = !(editable && (p.teamShared || p.source === 'team'));
    }
    const editBtn = $('#btnEdit');
    const delBtn = $('#btnDelete');
    if (editBtn) editBtn.style.display = editable ? '' : 'none';
    if (delBtn) delBtn.style.display = editable ? '' : 'none';

    // Reset send flow when opening a product
    multiSelectMode = false;
    selectedImageIdx = new Set();
    preparedShareFiles = new Map();
    renderVariantTabs(p);
    renderDetailImages(p);
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
    const scopeTeam = !!(p && (p.teamShared || p.source === 'team'));
    const rPers = $('#scopePersonal');
    const rTeam = $('#scopeTeam');
    if (rPers && rTeam) {
      rPers.checked = !scopeTeam;
      rTeam.checked = scopeTeam;
      // Admin-owned items shouldn't be re-scoped here (not editable anyway)
      const field = $('#editShareScopeField');
      if (field) field.hidden = !!(p && !p.personal && !p.teamShared && p.source === 'admin');
    }
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
    store.delete('teamWriteToken');
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
    if (!meta || !meta.salt) throw new Error('Chưa có crypto-meta — admin cần Đăng lên trước');
    const key = await CryptoUtil.deriveKey(password, meta.salt, meta.iterations || CryptoUtil.KDF_ITERATIONS);
    try {
      if (meta.verifier && CryptoUtil.isEncryptedEnvelope(meta.verifier) && CryptoUtil.checkVerifier) {
        await CryptoUtil.checkVerifier(key, meta);
      } else {
        const enc = await fetchJsonUrls([CFG.templatesUrl, CFG.templatesRawUrl]);
        if (!CryptoUtil.isEncryptedEnvelope(enc)) {
          throw new Error('templates.json chưa mã hóa — admin hãy Đăng lên lại');
        }
        const text = await CryptoUtil.decryptText(key, enc);
        JSON.parse(text);
      }
    } catch (e) {
      if (e && /chưa mã hóa|crypto-meta/.test(String(e.message || e))) throw e;
      throw new Error('Sai mật khẩu');
    }
    await saveTeamKey(key, meta.passwordId);
    try {
      if (window.VCDeviceCloud && CryptoUtil.deriveTeamWriteToken) {
        const tok = await CryptoUtil.deriveTeamWriteToken(password);
        await VCDeviceCloud.saveTeamWriteToken(setMeta, tok);
      }
    } catch (_) {}
    try {
      const cache = await caches.open('vibechic-data-v1');
      await cache.put('crypto-meta.json', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    } catch (_) {}
    return true;
  }

  async function ensureTeamWriteToken() {
    let tok = await VCDeviceCloud.getTeamWriteToken(getMeta);
    if (tok) return tok;
    // Unlocked on an old version that didn't save the write token: ask for the team password once more.
    await clearTeamKey();
    const ok = await ensureUnlockedForSync();
    if (!ok) return '';
    tok = await VCDeviceCloud.getTeamWriteToken(getMeta);
    return tok || '';
  }

  async function ensureUnlockedForSync() {
    const meta = await fetchCryptoMeta();
    if (!meta) return false; // no remote yet
    await loadLocalPins();
    await loadHiddenIds();
    await loadStaffDisplayName();
    await loadTeamKeyFromDB();
    try { await ensureMyDeviceId(); } catch (_) {}
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
        // Shared team sync must not clobber personal products
        const prev = byId.get(inc.id);
        if (prev && prev.personal && !inc.personal) continue;
        if (prev && prev.teamShared && !(inc.teamShared || inc.source === 'team')) continue;
        const localOnly = prev ? (prev.images || []).filter((im) => im.source === 'local') : [];
        const keepExtras = prev ? (prev.images || []).filter((im) => im.teamExtra) : [];
        const syncedIn = [];
        for (const im of (inc.images || [])) {
          const prevImg = prev && (prev.images || []).find((x) => x.id === im.id || (x.hash && x.hash === im.hash));
          if (prevImg && prevImg.dataURL && prevImg.hash === im.hash) {
            syncedIn.push({ ...im, dataURL: prevImg.dataURL, source: im.source === 'team' ? 'team' : 'synced', teamImage: !!im.teamImage });
          } else if (im.source === 'team' || im.teamImage) {
            // already hydrated by team-share
            syncedIn.push({ ...im, source: 'team', teamImage: true });
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
          images: [...syncedIn, ...keepExtras, ...localOnly],
          personal: !!(inc.personal || (prev && prev.personal)),
          teamShared: !!(inc.teamShared || inc.source === 'team' || (prev && prev.teamShared)),
          source: inc.source || (prev && prev.source) || 'admin',
          authorDeviceId: inc.authorDeviceId || (prev && prev.authorDeviceId) || null,
          authorName: inc.authorName || (prev && prev.authorName) || '',
          pinned: !!inc.pinned,
          pinOrder: inc.pinned ? (inc.pinOrder != null ? Number(inc.pinOrder) : 0) : null,
          createdAt: prev ? prev.createdAt : (inc.createdAt || Date.now()),
          updatedAt: Date.now()
        });
      }
    }
    products = await getAll();
    refresh();
  }


  function anyOverlayOpen() {
    // Only .show — avoid false positives from attribute quirks
    return !!document.querySelector('.overlay.show');
  }

  function showSwUpdateToast() {
    const btn = $('#swUpdateToast');
    if (!btn) return;
    btn.hidden = false;
  }
  function hideSwUpdateToast() {
    const btn = $('#swUpdateToast');
    if (!btn) return;
    btn.hidden = true;
  }

  async function activateWaitingWorker(reg) {
    const waiting = reg && reg.waiting;
    if (!waiting) return false;
    waiting.postMessage({ type: 'SKIP_WAITING' });
    return true;
  }

  let swReloadArmed = false;
  function armControllerReload() {
    if (swReloadArmed) return;
    swReloadArmed = true;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      location.reload();
    });
  }

  async function checkServiceWorkerUpdate({ activateIfWaiting } = {}) {
    if (!('serviceWorker' in navigator)) return { updated: false };
    try {
      const reg = await navigator.serviceWorker.getRegistration() ||
        await navigator.serviceWorker.register('./sw.js');
      await reg.update();
      // installing → wait a tick for waiting
      if (reg.installing) {
        await new Promise((resolve) => {
          const w = reg.installing;
          if (!w) return resolve();
          w.addEventListener('statechange', () => {
            if (w.state === 'installed' || w.state === 'activated') resolve();
          });
          setTimeout(resolve, 4000);
        });
      }
      if (reg.waiting) {
        if (activateIfWaiting) {
          armControllerReload();
          await activateWaitingWorker(reg);
          return { updated: true, activating: true };
        }
        showSwUpdateToast();
        return { updated: true, waiting: true };
      }
      return { updated: false };
    } catch (e) {
      console.warn('sw update', e);
      return { updated: false, error: String(e && e.message || e) };
    }
  }

  async function pullAndMergePersonalCloud() {
    if (!window.VCDeviceCloud) return;
    try {
      await VCDeviceCloud.pullAndMerge({
        getMeta, setMeta,
        mergePersonal: mergePersonalFromCloud,
        onStatus: setDeviceCloudStatus
      });
    } catch (e) {
      console.warn('personal pull', e);
    }
  }

  /** Full refresh used by pull-to-refresh: admin templates + team + personal cloud + SW */
  async function fullPullRefresh() {
    $('#syncStatus').textContent = 'Đang tải lại…';
    let ok = false;
    try {
      ok = await syncFromGithub();
    } catch (e) {
      console.warn(e);
    }
    await pullAndMergePersonalCloud();
    products = await getAll();
    refresh();
    const sw = await checkServiceWorkerUpdate({ activateIfWaiting: true });
    if (sw.activating) {
      toast('Đang cập nhật bản mới…');
      // reload via controllerchange
      return { ok, sw };
    }
    $('#syncStatus').textContent = ok ? 'Đã đồng bộ' : ($('#syncStatus').textContent || 'Local');
    toast(ok ? 'Đã tải lại ✓' : 'Đã thử tải lại');
    return { ok, sw };
  }


  async function mergeTeamExtras(extrasByProduct) {
    if (!extrasByProduct || typeof extrasByProduct !== 'object') return;
    let changed = false;
    const ids = Object.keys(extrasByProduct);
    for (const pid of ids) {
      const extras = extrasByProduct[pid] || [];
      const prev = products.find((x) => x.id === pid);
      if (!prev) continue;
      const nonExtra = (prev.images || []).filter((im) => !im.teamExtra);
      // Keep local dataURL cache when same id already present
      const prevById = new Map((prev.images || []).map((im) => [im.id, im]));
      const mergedExtras = extras.map((im) => {
        const old = prevById.get(im.id);
        if (old && old.dataURL && !im.dataURL) return { ...im, dataURL: old.dataURL };
        if (old && old.dataURL && im.dataURL) return { ...im, dataURL: im.dataURL };
        return im;
      });
      // Drop locals that were pushed (same id now in extras)
      const extraIds = new Set(mergedExtras.map((im) => im.id));
      const kept = nonExtra.filter((im) => !(im.source === 'local' && extraIds.has(im.id)));
      const nextImages = [...kept, ...mergedExtras];
      const same =
        nextImages.length === (prev.images || []).length &&
        nextImages.every((im, i) => prev.images[i] && prev.images[i].id === im.id && prev.images[i].source === im.source);
      if (same) continue;
      await putProduct({ ...prev, images: nextImages, updatedAt: Date.now() });
      changed = true;
    }
    // Also strip teamExtra images for products that no longer have any extras on server
    // (only for products we know about that previously had extras — optional; skip for simplicity)
    if (changed) {
      products = await getAll();
      if (currentId) {
        const cur = products.find((x) => x.id === currentId);
        if (cur) renderDetailImages(cur);
      }
      refresh();
    }
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
    // Tag admin source
    for (const p of list) {
      if (p && !p.personal && !p.teamShared) p.source = p.source || 'admin';
    }
    if (list.length) {
      await mergeProducts(list, { replace: false });
    }
    // Merge team-contributed items + per-product extra images
    try {
      if (teamKey && window.VCTeamShare) {
        const tok = await VCDeviceCloud.getTeamWriteToken(getMeta);
        if (tok) {
          const teamList = await VCTeamShare.pullAllTeamProducts({ teamKey, teamToken: tok });
          if (teamList.length) {
            // Remove local copies of team ids that vanished? keep simple: merge upsert
            await mergeProducts(teamList.map((p) => ({ ...p, teamShared: true, source: 'team', personal: false })), { replace: false });
          }
          try {
            const extrasByProduct = await VCTeamShare.pullAllProductExtras({ teamKey, teamToken: tok });
            await mergeTeamExtras(extrasByProduct);
          } catch (ee) {
            console.warn('team extras pull', ee);
          }
        }
      }
    } catch (e) {
      console.warn('team pull', e);
    }
    await setMeta('lastSync', Date.now());
    $('#syncStatus').textContent = 'Đã đồng bộ';
    return true;
  }

  async function ensureSeed() {
    if (products.length) return;
    const seeded = await getMeta('seeded-v3');
    if (seeded) return;
    await putProduct(sampleProduct());
    await setMeta('seeded-v3', true);
    products = await getAll();
  }


  function setDeviceCloudStatus(msg) {
    const el = $('#deviceCloudStatus');
    if (el) el.textContent = msg || '';
    if (msg && /Đã lưu lên cloud/.test(msg)) {
      $('#syncStatus').textContent = msg.replace('Đã lưu lên cloud lúc', 'Cloud');
    }
  }

  function queueDeviceCloudSave() {
    if (!window.VCDeviceCloud) return;
    VCDeviceCloud.scheduleUpload({
      getMeta, setMeta, products, localPins, hiddenIds,
      onStatus: setDeviceCloudStatus
    });
  }

  async function mergePersonalFromCloud(incomingProducts, incomingPins, overlays, incomingHidden) {
    for (const raw of (incomingProducts || [])) {
      const inc = migrateProduct({ ...raw, personal: true });
      if (!inc) continue;
      const prev = products.find((x) => x.id === inc.id);
      const cloudIds = new Set((inc.images || []).map((im) => im.id));
      const extraLocal = prev
        ? (prev.images || []).filter((im) => im.source === 'local' && im.dataURL && !cloudIds.has(im.id))
        : [];
      await putProduct({
        ...(prev || {}),
        ...inc,
        personal: true,
        images: [...(inc.images || []), ...extraLocal],
        updatedAt: Date.now()
      });
    }
    if (overlays && typeof overlays === 'object') {
      for (const pid of Object.keys(overlays)) {
        const prev = products.find((x) => x.id === pid);
        if (!prev) continue;
        const add = overlays[pid] || [];
        const have = new Set((prev.images || []).map((im) => im.id));
        const merged = [...(prev.images || [])];
        for (const im of add) {
          if (!im || have.has(im.id)) continue;
          merged.push(im);
          have.add(im.id);
        }
        await putProduct({ ...prev, images: merged, updatedAt: Date.now() });
      }
    }
    if (incomingPins && typeof incomingPins === 'object') {
      localPins = { ...localPins, ...incomingPins };
      await saveLocalPins();
    }
    if (Array.isArray(incomingHidden)) {
      const next = { ...hiddenIds };
      for (const id of incomingHidden) if (id) next[id] = true;
      hiddenIds = next;
      await saveHiddenIds();
    }
    products = await getAll();
    refresh();
  }

  async function refreshRecoveryUI() {
    if (!window.VCDeviceCloud) return;
    try {
      const dev = await VCDeviceCloud.ensureDeviceKey(getMeta, setMeta);
      const codeEl = $('#recoveryCodeDisplay');
      if (codeEl) codeEl.textContent = dev.code;
      const at = await getMeta('deviceCloudSavedAt');
      if (at) setDeviceCloudStatus('Đã lưu lên cloud lúc ' + new Date(Number(at)).toLocaleString('vi-VN'));
      else setDeviceCloudStatus('Chưa lưu cloud cá nhân (sẽ tự lưu sau khi sửa)');
    } catch (e) {
      setDeviceCloudStatus('Lỗi mã máy: ' + (e.message || e));
    }
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
    function renderHiddenList() {
      const box = $('#hiddenItemsList');
      if (!box) return;
      const ids = Object.keys(hiddenIds).filter((id) => hiddenIds[id]);
      if (!ids.length) {
        box.innerHTML = '<p style="color:var(--muted);margin:0">Không có mẫu ẩn.</p>';
        return;
      }
      box.innerHTML = ids.map((id) => {
        const p = products.find((x) => x.id === id);
        const title = p ? p.title : id;
        return `<div style="display:flex;gap:8px;align-items:center;margin:6px 0">
          <span style="flex:1">${escapeHtml(title)}</span>
          <button type="button" class="btn btn-ghost" data-unhide="${escapeHtml(id)}">Hiện lại</button>
        </div>`;
      }).join('');
      box.querySelectorAll('[data-unhide]').forEach((btn) => {
        btn.onclick = async () => {
          const id = btn.getAttribute('data-unhide');
          delete hiddenIds[id];
          await saveHiddenIds();
          renderHiddenList();
          refresh();
          toast('Đã hiện lại');
          queueDeviceCloudSave();
        };
      });
    }
    $('#btnSettings').onclick = () => {
      $('#defaultUnicode').checked = unicodePrefer;
      const nameEl = $('#staffDisplayName');
      if (nameEl) nameEl.value = staffDisplayName || '';
      renderHiddenList();
      refreshRecoveryUI();
      showOverlay('#settingsOverlay');
    };
    const btnSaveName = $('#btnSaveDisplayName');
    if (btnSaveName) btnSaveName.onclick = async () => {
      await saveStaffDisplayName(($('#staffDisplayName').value || '').trim());
      toast(staffDisplayName ? ('Đã lưu tên: ' + staffDisplayName) : 'Đã xóa tên');
    };
    const btnCopyRec = $('#btnCopyRecovery');
    if (btnCopyRec) btnCopyRec.onclick = async () => {
      const txt = ($('#recoveryCodeDisplay').textContent || '').trim();
      if (!txt || txt === '—') return;
      try {
        await navigator.clipboard.writeText(txt);
        toast('Đã copy mã khôi phục');
      } catch (_) {
        toast('Không copy được — hãy giữ chọn thủ công');
      }
    };
    const btnRestore = $('#btnRestoreRecovery');
    if (btnRestore) btnRestore.onclick = async () => {
      const code = ($('#recoveryCodeInput').value || '').trim();
      if (!code) { toast('Nhập mã khôi phục'); return; }
      if (!confirm('Khôi phục sẽ dùng mã này làm khóa máy. Tiếp tục?')) return;
      try {
        await VCDeviceCloud.restoreFromRecoveryCode(code, getMeta, setMeta);
        await refreshRecoveryUI();
        const r = await VCDeviceCloud.pullAndMerge({
          getMeta, setMeta,
          mergePersonal: mergePersonalFromCloud,
          onStatus: setDeviceCloudStatus
        });
        toast(r.ok ? (r.empty ? 'Mã OK — chưa có dữ liệu cloud' : 'Đã khôi phục từ mã') : 'Khôi phục lỗi');
      } catch (e) {
        toast(e.message || 'Mã không hợp lệ');
      }
    };
    const btnUp = $('#btnUploadDeviceCloud');
    if (btnUp) btnUp.onclick = async () => {
      const r = await VCDeviceCloud.uploadPersonalCloud({
        getMeta, setMeta, products, localPins, hiddenIds,
        onStatus: setDeviceCloudStatus
      });
      toast(r.ok ? 'Đã lưu cloud cá nhân' : (r.needTeam ? 'Cần mật khẩu đội trước' : 'Lưu cloud thất bại'));
    };
    $('#btnCloseSettings').onclick = () => hideOverlay('#settingsOverlay');
    $('#btnCloseDetail').onclick = () => hideOverlay('#detailOverlay');

    // Swipe left/right on detail sheet to close (like Đóng)
    (function bindDetailSwipeClose() {
      const overlay = $('#detailOverlay');
      const sheet = overlay && overlay.querySelector('.sheet');
      if (!sheet) return;
      const THRESH = 80;
      let startX = 0, startY = 0, dx = 0, dy = 0, tracking = false, decided = false, horizontal = false;

      function resetTransform() {
        sheet.style.transition = 'transform 0.22s ease, opacity 0.22s ease';
        sheet.style.transform = '';
        sheet.style.opacity = '';
        const clear = () => {
          sheet.style.transition = '';
          sheet.removeEventListener('transitionend', clear);
        };
        sheet.addEventListener('transitionend', clear);
      }

      function closeWithSwipe(dir) {
        sheet.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
        sheet.style.transform = `translateX(${dir > 0 ? 110 : -110}%)`;
        sheet.style.opacity = '0';
        setTimeout(() => {
          hideOverlay('#detailOverlay');
          sheet.style.transition = '';
          sheet.style.transform = '';
          sheet.style.opacity = '';
        }, 200);
      }

      sheet.addEventListener('touchstart', (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        const lb = document.getElementById('imgLightbox');
        if (lb && lb.classList.contains('show')) return;
        const t = e.touches[0];
        const target = e.target;
        if (target && target.closest && target.closest('#variantTabs')) return;
        startX = t.clientX; startY = t.clientY;
        dx = 0; dy = 0;
        tracking = true; decided = false; horizontal = false;
        sheet.style.transition = 'none';
      }, { passive: true });

      sheet.addEventListener('touchmove', (e) => {
        if (!tracking || !e.touches || e.touches.length !== 1) return;
        const t = e.touches[0];
        dx = t.clientX - startX;
        dy = t.clientY - startY;
        if (!decided) {
          if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
          decided = true;
          horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
          if (!horizontal) { tracking = false; return; }
        }
        if (!horizontal) return;
        if (e.cancelable) e.preventDefault();
        const w = sheet.offsetWidth || 1;
        const opacity = Math.max(0.35, 1 - Math.abs(dx) / w);
        sheet.style.transform = `translateX(${dx}px)`;
        sheet.style.opacity = String(opacity);
      }, { passive: false });

      sheet.addEventListener('touchend', () => {
        if (!tracking) return;
        const wasHoriz = horizontal;
        const finalDx = dx;
        tracking = false; decided = false; horizontal = false;
        if (!wasHoriz) { resetTransform(); return; }
        if (Math.abs(finalDx) >= THRESH && Math.abs(finalDx) > Math.abs(dy)) {
          closeWithSwipe(finalDx > 0 ? 1 : -1);
        } else {
          resetTransform();
        }
      }, { passive: true });

      sheet.addEventListener('touchcancel', () => {
        tracking = false; decided = false; horizontal = false;
        resetTransform();
      }, { passive: true });
    })();

    $('#btnCancelEdit').onclick = () => hideOverlay('#editOverlay');
    $$('.overlay').forEach((ov) => ov.addEventListener('click', (e) => {
      if (e.target === ov) { ov.classList.remove('show'); ov.hidden = true; }
    }));

    $('#btnLocalPin').onclick = async () => {
      if (!currentId) return;
      await toggleLocalPin(currentId);
    };
    const btnHide = $('#btnHideItem');
    if (btnHide) btnHide.onclick = async () => {
      if (!currentId) return;
      hiddenIds[currentId] = true;
      await saveHiddenIds();
      hideOverlay('#detailOverlay');
      refresh();
      toast('Đã ẩn (chỉ mình bạn)');
      queueDeviceCloudSave();
    };
    const btnMove = $('#btnMovePersonal');
    if (btnMove) btnMove.onclick = async () => {
      if (!currentId) return;
      const p = products.find((x) => x.id === currentId);
      if (!p || !canEditProduct(p)) { toast('Không có quyền'); return; }
      if (!confirm('Gỡ khỏi team và giữ bản riêng trên máy bạn?')) return;
      try {
        await ensureMyDeviceId();
        const tok = await VCDeviceCloud.getTeamWriteToken(getMeta);
        await VCTeamShare.deleteTeamItem({ itemId: p.id, deviceId: myDeviceId, teamToken: tok });
      } catch (e) {
        toast(e.message || 'Không gỡ team được');
        return;
      }
      await putProduct({
        ...p,
        personal: true,
        teamShared: false,
        source: 'personal',
        updatedAt: Date.now()
      });
      products = await getAll();
      hideOverlay('#detailOverlay');
      refresh();
      toast('Đã chuyển về chỉ mình tôi');
      queueDeviceCloudSave();
    };
    $('#btnEdit').onclick = () => {
      const p = products.find((x) => x.id === currentId);
      hideOverlay('#detailOverlay');
      if (p) openEditor(p);
    };
    $('#btnDelete').onclick = async () => {
      if (!currentId || !confirm('Xóa sản phẩm này và mọi mẫu câu?')) return;
      const doomed = products.find((x) => x.id === currentId);
      if (doomed && (doomed.teamShared || doomed.source === 'team')) {
        try {
          await ensureMyDeviceId();
          const tok = await VCDeviceCloud.getTeamWriteToken(getMeta);
          await VCTeamShare.deleteTeamItem({ itemId: currentId, deviceId: myDeviceId, teamToken: tok });
        } catch (e) {
          toast(e.message || 'Không xóa được trên team');
          return;
        }
      }
      await deleteProduct(currentId);
      products = await getAll();
      hideOverlay('#detailOverlay');
      refresh();
      toast('Đã xóa');
      queueDeviceCloudSave();
    };

    // Variant tabs
    const variantTabs = $('#variantTabs');
    if (variantTabs) variantTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-vid]');
      if (!tab) return;
      const p = products.find((x) => x.id === currentId);
      if (!p) return;
      selectedVariantId = tab.getAttribute('data-vid');
      renderVariantTabs(p);
      updateSendFlowUI(p);
    });

    const btnCopyThis = $('#btnCopyThisVariant');
    if (btnCopyThis) btnCopyThis.onclick = async () => {
      const p = products.find((x) => x.id === currentId);
      const v = selectedVariant(p);
      if (!v) { toast('Chưa có câu'); return; }
      await copyText(v.html, unicodePrefer);
    };

    $('#imageCopyActions').addEventListener('click', async (e) => {
      const p = products.find((x) => x.id === currentId);
      if (!p) return;

      const pushBtn = e.target.closest('[data-push-img]');
      if (pushBtn) {
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(pushBtn.dataset.pushImg);
        const im = p.images[idx];
        if (!im || im.source !== 'local' || !im.dataURL) { toast('Ảnh không hợp lệ'); return; }
        try {
          await ensureMyDeviceId();
          if (!myDeviceId) { toast('Không tạo được mã máy'); return; }
          if (!staffDisplayName) {
            const n = prompt('Tên của bạn (hiện với ảnh team):', staffDisplayName || '');
            if (n == null) return;
            await saveStaffDisplayName(n);
            if (!staffDisplayName) { toast('Cần tên để đẩy team'); return; }
          }
          if (!teamKey) {
            const ok = await ensureUnlockedForSync();
            if (!ok || !teamKey) { toast('Cần mật khẩu đội để đẩy team'); return; }
          }
          const tok = await ensureTeamWriteToken();
          if (!tok) { toast('Cần mật khẩu đội để đẩy team'); return; }
          toast('Đang đẩy ảnh lên team…');
          const r = await VCTeamShare.pushProductExtraImage({
            productId: p.id,
            image: im,
            teamKey,
            teamToken: tok,
            deviceId: myDeviceId,
            authorName: staffDisplayName
          });
          p.images[idx] = { ...r.image };
          p.updatedAt = Date.now();
          await putProduct(p);
          products = await getAll();
          openDetail(p.id);
          toast('Đã đẩy ảnh lên team ✓');
          queueDeviceCloudSave();
        } catch (err) {
          toast(err.message || 'Đẩy ảnh thất bại');
        }
        return;
      }

      const rmExtra = e.target.closest('[data-rm-extra]');
      if (rmExtra) {
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(rmExtra.dataset.rmExtra);
        const im = p.images[idx];
        if (!im || !im.teamExtra) return;
        if (!confirm('Xóa ảnh này khỏi team?')) return;
        try {
          await ensureMyDeviceId();
          if (!teamKey) {
            const ok = await ensureUnlockedForSync();
            if (!ok || !teamKey) { toast('Cần mật khẩu đội'); return; }
          }
          const tok = await VCDeviceCloud.getTeamWriteToken(getMeta);
          await VCTeamShare.deleteProductExtraImage({
            productId: p.id,
            imageId: im.id,
            deviceId: myDeviceId,
            teamToken: tok
          });
          p.images.splice(idx, 1);
          p.updatedAt = Date.now();
          await putProduct(p);
          products = await getAll();
          openDetail(p.id);
          toast('Đã xóa ảnh khỏi team');
          queueDeviceCloudSave();
        } catch (err) {
          toast(err.message || 'Xóa thất bại');
        }
        return;
      }

      if (multiSelectMode) {
        const tile = e.target.closest('[data-img-idx]');
        if (!tile) return;
        if (e.target.closest('[data-copy-img]')) {
          /* rare: copy still visible */
        } else {
          const idx = Number(tile.getAttribute('data-img-idx'));
          if (Number.isNaN(idx)) return;
          if (selectedImageIdx.has(idx)) {
            selectedImageIdx.delete(idx);
            preparedShareFiles.delete(idx);
          } else {
            selectedImageIdx.add(idx);
            try { await prepareShareFileForIndex(p, idx); }
            catch (err) {
              selectedImageIdx.delete(idx);
              toast(err.message || 'Không lấy được ảnh');
            }
          }
          renderDetailImages(p);
          return;
        }
      }

      const btn = e.target.closest('[data-copy-img]');
      if (!btn) {
        const imgEl = e.target.closest('.img-tile img');
        if (imgEl && imgEl.src) openLightbox(imgEl.src);
        return;
      }
      const im = p.images[Number(btn.dataset.copyImg)];
      if (!im) return;
      try {
        const resolved = await resolveImageDataURL(im);
        if (!resolved.dataURL) { toast('Ảnh chưa tải — bấm Đồng bộ'); return; }
        if (!im.dataURL) im.dataURL = resolved.dataURL;
        await copyImageToClipboard(resolved.dataURL);
        toast('Đã copy ảnh ✓');
      } catch (_) {
        const a = document.createElement('a');
        const url = im.dataURL || imagePublicUrl(im);
        if (!url) { toast('Không copy được'); return; }
        a.href = url; a.download = `anh-${btn.dataset.copyImg}.jpg`; a.click();
        toast('Đã tải ảnh xuống');
      }
    });

    async function enterSendFlow() {
      const p = products.find((x) => x.id === currentId);
      if (!p || !(p.images || []).length) { toast('Chưa có ảnh'); return; }
      multiSelectMode = true;
      selectedImageIdx = new Set();
      preparedShareFiles = new Map();
      toast('Đang chuẩn bị ảnh…');
      for (let i = 0; i < p.images.length; i++) {
        selectedImageIdx.add(i);
        try { await prepareShareFileForIndex(p, i); }
        catch (err) {
          selectedImageIdx.delete(i);
          console.warn(err);
        }
      }
      renderDetailImages(p);
      if (!selectedImageIdx.size) toast('Không chuẩn bị được ảnh');
    }

    const btnStartSend = $('#btnStartSend');
    if (btnStartSend) btnStartSend.onclick = () => enterSendFlow();

    const btnCancelSend = $('#btnCancelSend');
    if (btnCancelSend) btnCancelSend.onclick = () => {
      const p = products.find((x) => x.id === currentId);
      multiSelectMode = false;
      selectedImageIdx = new Set();
      preparedShareFiles = new Map();
      if (p) renderDetailImages(p);
    };

    const btnSelectAll = $('#btnSelectAllImages');
    if (btnSelectAll) btnSelectAll.onclick = async () => {
      const p = products.find((x) => x.id === currentId);
      if (!p || !multiSelectMode) return;
      toast('Đang chuẩn bị ảnh…');
      for (let i = 0; i < (p.images || []).length; i++) {
        selectedImageIdx.add(i);
        try { await prepareShareFileForIndex(p, i); }
        catch (err) {
          selectedImageIdx.delete(i);
          console.warn(err);
        }
      }
      renderDetailImages(p);
    };

    async function sharePreparedFiles({ copyTextFirst }) {
      const p = products.find((x) => x.id === currentId);
      if (!p || !selectedImageIdx.size) return;
      const idxs = [...selectedImageIdx].sort((a, b) => a - b);
      for (const i of idxs) {
        if (!preparedShareFiles.has(i)) {
          toast('Ảnh chưa sẵn sàng — chờ / chọn lại');
          return;
        }
      }
      const files = idxs.map((i) => preparedShareFiles.get(i));
      if (!files.length) { toast('Chưa có ảnh'); return; }

      if (copyTextFirst) {
        const v = selectedVariant(p);
        if (v) {
          try {
            const plain = htmlToPlain(v.html, { unicode: unicodePrefer });
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(plain);
            } else {
              const ta = document.createElement('textarea');
              ta.value = plain; document.body.appendChild(ta); ta.select();
              document.execCommand('copy'); ta.remove();
            }
            toast('Đã copy câu, dán vào sau khi gửi ảnh');
          } catch (_) {
            toast('Không copy được câu — vẫn gửi ảnh');
          }
        }
      }

      if (!canShareFiles(files)) {
        toast('Máy này chưa gửi được nhiều ảnh — bấm Lưu ảnh về máy hoặc Copy từng ảnh');
        return;
      }
      try {
        await navigator.share({ files });
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        console.warn(err);
        toast('Không gửi được — thử Lưu ảnh về máy');
      }
    }

    const btnShareSel = $('#btnShareSelectedImages');
    if (btnShareSel) btnShareSel.onclick = () => sharePreparedFiles({ copyTextFirst: true });

    const btnSaveShare = $('#btnSaveImagesShare');
    if (btnSaveShare) btnSaveShare.onclick = () => sharePreparedFiles({ copyTextFirst: false });

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
        queueDeviceCloudSave();
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
      const wantTeam = !!( $('#scopeTeam') && $('#scopeTeam').checked );
      let personalFlag = !wantTeam;
      let teamShared = wantTeam;
      let authorDeviceId = prev && prev.authorDeviceId;
      let authorName = prev && prev.authorName;
      if (wantTeam) {
        await ensureMyDeviceId();
        if (!myDeviceId) { toast('Không tạo được mã máy'); return; }
        if (!staffDisplayName) {
          const n = prompt('Tên của bạn (hiện by … trên mẫu team):', staffDisplayName || '');
          if (n == null) return;
          await saveStaffDisplayName(n);
          if (!staffDisplayName) { toast('Cần tên để đẩy team'); return; }
        }
        if (!teamKey) {
          const ok = await ensureUnlockedForSync();
          if (!ok || !teamKey) { toast('Cần mật khẩu đội để đẩy team'); return; }
        }
        authorDeviceId = (prev && prev.authorDeviceId) || myDeviceId;
        if (prev && prev.authorDeviceId && prev.authorDeviceId !== myDeviceId) {
          toast('Không phải chủ mẫu — không sửa được'); return;
        }
        authorName = staffDisplayName;
      }

      const product = {
        id, title,
        category: $('#editCategory').value.trim() || 'Khác',
        variants, images,
        pinned: prev ? !!prev.pinned : false,
        pinOrder: prev && prev.pinned ? prev.pinOrder : null,
        personal: personalFlag,
        teamShared: teamShared,
        source: wantTeam ? 'team' : 'personal',
        authorDeviceId: authorDeviceId || null,
        authorName: authorName || '',
        sortOrder: prev ? prev.sortOrder : products.length,
        createdAt: prev ? prev.createdAt : Date.now(),
        updatedAt: Date.now()
      };

      if (wantTeam) {
        try {
          const tok = await ensureTeamWriteToken();
          const r = await VCTeamShare.pushTeamItem({
            product, teamKey, teamToken: tok, deviceId: myDeviceId, authorName: staffDisplayName
          });
          Object.assign(product, r.product || {}, { personal: false, teamShared: true, source: 'team' });
          toast('Đã đẩy cho team ✓');
        } catch (e) {
          toast(e.message || 'Đẩy team thất bại');
          return;
        }
      }

      await putProduct(product);
      products = await getAll();
      hideOverlay('#editOverlay');
      refresh();
      if (!wantTeam) {
        toast('Đã lưu (chỉ mình tôi)');
        queueDeviceCloudSave();
      } else {
        // Remove from personal-only cloud footprint: already marked not personal
        queueDeviceCloudSave();
      }
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
        await navigator.serviceWorker.register('./sw.js');
        // Soft check on open — toast if waiting (do not auto-activate)
        setTimeout(() => { checkServiceWorkerUpdate({ activateIfWaiting: false }); }, 800);
      } catch (_) {}
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        checkServiceWorkerUpdate({ activateIfWaiting: false });
      }
    });
    window.addEventListener('focus', () => {
      checkServiceWorkerUpdate({ activateIfWaiting: false });
    });
    const swBtn = $('#swUpdateToast');
    if (swBtn) {
      swBtn.onclick = async () => {
        hideSwUpdateToast();
        toast('Đang cập nhật…');
        armControllerReload();
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg && reg.waiting) await activateWaitingWorker(reg);
          else await checkServiceWorkerUpdate({ activateIfWaiting: true });
        } catch (_) {}
      };
    }
    // Pull-to-refresh (iOS standalone)
    if (window.VCPullRefresh) {
      VCPullRefresh.createPullRefresh({
        indicator: $('#pullRefresh'),
        labelEl: $('#pullRefreshLabel'),
        isBlocked: () => anyOverlayOpen(),
        onRefresh: () => fullPullRefresh()
      });
    }
    // Ensure device key exists (recovery code)
    try { await VCDeviceCloud.ensureDeviceKey(getMeta, setMeta); } catch (_) {}

    // Check remote passwordId; prompt if needed then sync team pack + personal cloud
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
    try {
      await VCDeviceCloud.pullAndMerge({
        getMeta, setMeta,
        mergePersonal: mergePersonalFromCloud,
        onStatus: setDeviceCloudStatus
      });
    } catch (_) {}
  }
  init().catch((err) => { console.error(err); toast('Lỗi khởi tạo'); });
})();
