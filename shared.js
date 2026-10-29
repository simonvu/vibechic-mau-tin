/* Shared helpers for VibeChic product + variant model */
(function (global) {
  'use strict';

  const BOLD_MAP = (() => {
    const m = {};
    for (let i = 0; i < 26; i++) {
      m[String.fromCharCode(65 + i)] = String.fromCodePoint(0x1d400 + i);
      m[String.fromCharCode(97 + i)] = String.fromCodePoint(0x1d41a + i);
    }
    for (let i = 0; i < 10; i++) m[String(i)] = String.fromCodePoint(0x1d7ce + i);
    return m;
  })();
  const ITALIC_MAP = (() => {
    const m = {};
    for (let i = 0; i < 26; i++) m[String.fromCharCode(65 + i)] = String.fromCodePoint(0x1d434 + i);
    for (let i = 0; i < 26; i++) {
      if (i === 7) m['h'] = '\u210e';
      else m[String.fromCharCode(97 + i)] = String.fromCodePoint(0x1d44e + (i > 7 ? i - 1 : i));
    }
    return m;
  })();
  const BOLD_ITALIC_MAP = (() => {
    const m = {};
    for (let i = 0; i < 26; i++) {
      m[String.fromCharCode(65 + i)] = String.fromCodePoint(0x1d468 + i);
      m[String.fromCharCode(97 + i)] = String.fromCodePoint(0x1d482 + i);
    }
    return m;
  })();

  function uid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      ('id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  }

  function mapStyled(str, map) {
    let out = '';
    for (const ch of str) out += map[ch] || ch;
    return out;
  }

  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
    const walk = (node, out) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) {
          out.appendChild(document.createTextNode(child.textContent));
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName.toLowerCase();
          let el = null;
          if (tag === 'br') { out.appendChild(document.createElement('br')); continue; }
          if (tag === 'strong' || tag === 'b') el = document.createElement('strong');
          else if (tag === 'em' || tag === 'i') el = document.createElement('em');
          else if (tag === 'ul' || tag === 'ol') el = document.createElement('ul');
          else if (tag === 'li') el = document.createElement('li');
          else if (tag === 'p' || tag === 'div') {
            if (out.childNodes.length) out.appendChild(document.createElement('br'));
            walk(child, out);
            out.appendChild(document.createElement('br'));
            continue;
          } else { walk(child, out); continue; }
          walk(child, el);
          out.appendChild(el);
        }
      }
    };
    const wrap = document.createElement('div');
    walk(doc.body.firstChild || doc.body, wrap);
    while (wrap.lastChild && wrap.lastChild.nodeName === 'BR') wrap.removeChild(wrap.lastChild);
    return wrap.innerHTML;
  }

  function htmlToPlain(html, { unicode = false } = {}) {
    const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
    const root = doc.body.firstChild || doc.body;
    const blocks = [];
    let line = '';
    function styleOf(el) {
      let bold = false, italic = false;
      let n = el;
      while (n && n !== root.parentNode) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          const t = n.tagName.toLowerCase();
          if (t === 'strong' || t === 'b') bold = true;
          if (t === 'em' || t === 'i') italic = true;
        }
        n = n.parentNode;
      }
      return { bold, italic };
    }
    function emitText(text, bold, italic) {
      text = text.replace(/\u00a0/g, ' ');
      if (!text) return;
      if (!unicode || (!bold && !italic)) { line += text; return; }
      const map = bold && italic ? BOLD_ITALIC_MAP : bold ? BOLD_MAP : ITALIC_MAP;
      line += mapStyled(text, map);
    }
    function flushLine() {
      blocks.push(line.replace(/[ \t]+$/g, ''));
      line = '';
    }
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const { bold, italic } = styleOf(node.parentElement || root);
        emitText(node.textContent.replace(/\r/g, '').replace(/\n+/g, ' '), bold, italic);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (tag === 'br') { flushLine(); return; }
      if (tag === 'li') {
        if (line.trim()) flushLine();
        line = '• ';
        for (const c of node.childNodes) walk(c);
        flushLine();
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        if (line.trim()) flushLine();
        if (blocks.length && blocks[blocks.length - 1] !== '') blocks.push('');
        for (const c of node.childNodes) walk(c);
        return;
      }
      if (tag === 'p' || tag === 'div') {
        if (line.trim()) flushLine();
        for (const c of node.childNodes) walk(c);
        if (line.length || (node.textContent || '').trim()) flushLine();
        if (blocks.length && blocks[blocks.length - 1] !== '') blocks.push('');
        return;
      }
      for (const c of node.childNodes) walk(c);
    }
    walk(root);
    if (line.length) flushLine();
    return blocks.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
  }

  function htmlToClipboardHtml(html) {
    return `<meta charset="utf-8"><div>${sanitizeHtml(html)}</div>`;
  }

  /** Normalize any record (old template or new product) into product+variants */
  function migrateProduct(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = raw.id || uid();
    let variants = [];
    if (Array.isArray(raw.variants) && raw.variants.length) {
      variants = raw.variants.map((v, i) => ({
        id: v.id || uid(),
        label: (v.label || v.title || `Mẫu ${i + 1}`).trim() || `Mẫu ${i + 1}`,
        html: sanitizeHtml(v.html || v.body || v.text || ''),
        sortOrder: v.sortOrder != null ? v.sortOrder : i
      }));
    } else if (raw.html || raw.body || raw.text) {
      variants = [{
        id: raw.variantId || (id + '-main'),
        label: raw.variantLabel || 'Mẫu chính',
        html: sanitizeHtml(raw.html || raw.body || raw.text || ''),
        sortOrder: 0
      }];
    }
    variants.sort((a, b) => (a.sortOrder - b.sortOrder));
    return {
      id,
      title: (raw.title || '').trim() || 'Không tiêu đề',
      category: (raw.category || 'Khác').trim() || 'Khác',
      images: Array.isArray(raw.images) ? raw.images.filter((im) => im && (im.dataURL || im.dataUrl || im.path || im.url)).map((im, i) => ({
        id: im.id || uid(),
        source: im.source || (im.path || (im.url && !String(im.url).startsWith('data:')) ? 'synced' : 'local'),
        path: im.path || null,
        hash: im.hash || null,
        url: im.url || null,
        dataURL: im.dataURL || im.dataUrl || null,
        sortOrder: im.sortOrder != null ? im.sortOrder : i
      })) : [],
      variants,
      sortOrder: raw.sortOrder != null ? raw.sortOrder : 0,
      pinned: !!raw.pinned,
      pinOrder: raw.pinned ? (raw.pinOrder != null ? Number(raw.pinOrder) : 0) : null,
      personal: !!raw.personal,
      createdAt: raw.createdAt || Date.now(),
      updatedAt: raw.updatedAt || Date.now()
    };
  }

  function packProductsTextOnly(list) {
    return packProductsForSync(list, { includeLocalImagesAsData: false });
  }

  /** Sync/export pack: synced images as path+hash; optionally embed local dataURLs */
  function packProductsForSync(list, { includeLocalImagesAsData = false } = {}) {
    return (list || []).map((p, i) => {
      const m = migrateProduct(p);
      const images = (m.images || []).map((im, j) => {
        const base = {
          id: im.id || uid(),
          sortOrder: im.sortOrder != null ? im.sortOrder : j,
          source: im.source || (im.path ? 'synced' : 'local')
        };
        if (im.path || im.hash) {
          return { ...base, source: 'synced', path: im.path, hash: im.hash };
        }
        if (includeLocalImagesAsData && im.dataURL) {
          return { ...base, source: 'local', dataURL: im.dataURL };
        }
        // Skip pure local blobs when publishing to GitHub
        if (base.source === 'local' && !includeLocalImagesAsData) return null;
        if (im.dataURL) return { ...base, dataURL: im.dataURL };
        return null;
      }).filter(Boolean);
      return {
        id: m.id,
        title: m.title,
        category: m.category,
        sortOrder: m.sortOrder != null ? m.sortOrder : i,
        pinned: !!m.pinned,
        pinOrder: m.pinned ? (m.pinOrder != null ? Number(m.pinOrder) : 0) : null,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        variants: (m.variants || []).map((v, j) => ({
          id: v.id,
          label: v.label,
          html: v.html,
          sortOrder: v.sortOrder != null ? v.sortOrder : j
        })),
        images
      };
    });
  }

  function pagesBase() {
    const CFG = (typeof window !== 'undefined' && window.VC_CONFIG) || {};
    const media = CFG.mediaBaseUrl || CFG.syncBaseUrl || '';
    if (media) return String(media).replace(/\/?$/, '/');
    return (CFG.pagesAppUrl || '').replace(/\/?$/, '/');
  }

  function imagePublicUrl(im) {
    if (!im) return '';
    if (im.dataURL) return im.dataURL;
    if (im.url && String(im.url).startsWith('data:')) return im.url;
    if (im.path) return pagesBase() + String(im.path).replace(/^\//, '');
    if (im.url) return im.url;
    return '';
  }

  async function sha256Hex(bytes) {
    const buf = bytes instanceof ArrayBuffer ? bytes : (bytes.buffer || bytes);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function dataURLToBytes(dataURL) {
    const b64 = String(dataURL).split(',')[1] || '';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function bytesToBase64(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function exportFileName() {
    const d = new Date();
    return `mau-tin-nhan-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}.json`;
  }

  /** Parse import payload — supports v3 products[], v2 templates[], or bare array */
  function parseImportList(data) {
    if (!data) return [];
    if (Array.isArray(data.products)) return data.products.map(migrateProduct).filter(Boolean);
    if (Array.isArray(data.templates)) return data.templates.map(migrateProduct).filter(Boolean);
    if (Array.isArray(data)) return data.map(migrateProduct).filter(Boolean);
    return [];
  }

  const SAMPLE_FULL = `Dạ chào Nàng, set đồ tone xanh pastel này là thiết kế bằng dòng <em>Linen cát cao cấp</em> của VibeChic ạ. Dòng vải này đanh mát, có độ rủ tự nhiên và đặc biệt là hạn chế nhăn xù tốt hơn hẳn linen thông thường nên mặc đi làm cả ngày rất thoải mái nha Nàng.<br>Thiết kế áo tay dơi giấu khuyết điểm bắp tay khéo léo kết hợp chân váy cạp cao tôn dáng:<br><ul><li>Áo sơ mi tay dơi: <strong>490.000đ</strong></li><li>Chân váy linen cát dáng suông: <strong>690.000đ</strong></li><li>Khi Nàng thỉnh trọn set, VibeChic áp dụng chính sách ưu đãi combo <strong><em>1.090.000đ</em></strong> và <em>miễn phí vận chuyển tận nơi</em> cho Nàng ạ.</li></ul><br>Nàng cho em xin chiều cao và cân nặng để em chọn size vừa vặn nhất cho mình nha!`;

  const SAMPLE_INTRO = `Dạ chào Nàng, set đồ tone xanh pastel này là thiết kế bằng dòng <em>Linen cát cao cấp</em> của VibeChic ạ. Dòng vải này đanh mát, có độ rủ tự nhiên và đặc biệt là hạn chế nhăn xù tốt hơn hẳn linen thông thường nên mặc đi làm cả ngày rất thoải mái nha Nàng.<br>Thiết kế áo tay dơi giấu khuyết điểm bắp tay khéo léo kết hợp chân váy cạp cao tôn dáng.`;

  const SAMPLE_PRICE_SIZE = `Dạ gửi Nàng bảng giá set linen xanh pastel ạ:<br><ul><li>Áo sơ mi tay dơi: <strong>490.000đ</strong></li><li>Chân váy linen cát dáng suông: <strong>690.000đ</strong></li><li>Khi Nàng thỉnh trọn set, VibeChic áp dụng chính sách ưu đãi combo <strong><em>1.090.000đ</em></strong> và <em>miễn phí vận chuyển tận nơi</em> cho Nàng ạ.</li></ul><br>Nàng cho em xin chiều cao và cân nặng để em chọn size vừa vặn nhất cho mình nha!`;

  function sampleProduct() {
    return {
      id: 'sample-linen-xanh-pastel',
      title: 'Set linen xanh pastel',
      category: 'Tư vấn sản phẩm',
      images: [],
      sortOrder: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      variants: [
        { id: 'sample-var-full', label: 'Tin đầy đủ', html: SAMPLE_FULL, sortOrder: 0 },
        { id: 'sample-var-intro', label: 'Chào + giới thiệu', html: SAMPLE_INTRO, sortOrder: 1 },
        { id: 'sample-var-price', label: 'Báo giá + hỏi size', html: SAMPLE_PRICE_SIZE, sortOrder: 2 }
      ]
    };
  }

  global.VC = {
    uid, sanitizeHtml, htmlToPlain, htmlToClipboardHtml,
    migrateProduct, packProductsTextOnly, packProductsForSync, exportFileName, parseImportList,
    sampleProduct, mapStyled, BOLD_MAP, ITALIC_MAP, BOLD_ITALIC_MAP,
    imagePublicUrl, pagesBase, sha256Hex, dataURLToBytes, bytesToBase64
  };
})(typeof window !== 'undefined' ? window : globalThis);
