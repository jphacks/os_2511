// main.js
// PDF.js + Tesseract.js (OCR) — 安定版統合スクリプト
// - 動的にライブラリを読み込む（フォールバック複数CDN）
// - pdf.js の cMap/workers を設定
// - getTextContent() が貧弱なページは Tesseract OCR で補完
// - クリックで「一文」を抽出してクリップボードへ（HTML付き）
// NOTE: HTML 側で pdf/tesseract を別に読み込まないこと（重複読み込み防止）

/* =======================
   CONFIG: preferred URLs
   ======================= */
const PREFERRED_PDFJS = { // prefer pdfjs-dist@5.4.296 but include fallbacks
  srcs: [
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.296/build/pdf.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.8.162/pdf.min.js',
    'https://unpkg.com/pdfjs-dist@5.4.296/build/pdf.min.js'
  ],
  workers: [
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.296/build/pdf.worker.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.8.162/pdf.worker.min.js',
    'https://unpkg.com/pdfjs-dist@5.4.296/build/pdf.worker.min.js'
  ],
  cmaps: [
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.296/cmaps/',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.8.162/cmaps/',
    'https://unpkg.com/pdfjs-dist@5.4.296/cmaps/'
  ]
};
const PREFERRED_TESSERACT = [
  'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@4.0.2/dist/tesseract.min.js',
  'https://unpkg.com/tesseract.js@6.0.1/dist/tesseract.min.js'
];

/* =======================
   Utility: safe DOM getters
   ======================= */
function $id(id) { return document.getElementById(id); }
function safeText(id, txt) { const el = $id(id); if (el) el.textContent = txt; }

/* =======================
   Toast helper
   ======================= */
function showTemporaryToast(msg, ms = 1400) {
  const t = $id('toast');
  if (!t) { console.log('TOAST:', msg); return; }
  t.textContent = msg;
  t.classList.remove('hidden', 'toast-hide');
  t.classList.add('toast-show');
  setTimeout(() => {
    t.classList.remove('toast-show');
    t.classList.add('toast-hide');
    setTimeout(() => t.classList.add('hidden'), 240);
  }, ms);
}

/* =======================
   dynamic script loader (with timeout)
   ======================= */
async function loadScriptUrl(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = url;
    s.async = false; // keep order for pdf.js
    let done = false;
    const to = setTimeout(() => {
      if (done) return;
      done = true;
      s.onload = s.onerror = null;
      reject(new Error('timeout ' + url));
    }, timeout);
    s.onload = () => {
      if (done) return;
      done = true;
      clearTimeout(to);
      resolve();
    };
    s.onerror = (e) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      reject(new Error('load failed ' + url));
    };
    document.head.appendChild(s);
  });
}

/* =======================
   Ensure pdf.js is loaded (try multiple CDNs)
   and configure worker / cMap
   ======================= */
async function ensurePdfJs() {
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.8.162/pdf.worker.min.js';
    pdfjsLib.GlobalWorkerOptions.cMapUrl = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.8.162/cmaps/';
    pdfjsLib.GlobalWorkerOptions.cMapPacked = true;
    console.log('pdf.worker set to cdnjs 3.8.162');
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsLib.GlobalWorkerOptions.workerSrc || PREFERRED_PDFJS.workers[0];
      pdfjsLib.GlobalWorkerOptions.cMapUrl = pdfjsLib.GlobalWorkerOptions.cMapUrl || PREFERRED_PDFJS.cmaps[0];
      pdfjsLib.GlobalWorkerOptions.cMapPacked = (typeof pdfjsLib.GlobalWorkerOptions.cMapPacked !== 'undefined') ? pdfjsLib.GlobalWorkerOptions.cMapPacked : true;
    } catch (e) { console.warn('pdfjs configure safe failed', e); }
    return window.pdfjsLib;
  }

  let lastErr = null;
  for (let i = 0; i < PREFERRED_PDFJS.srcs.length; i++) {
    const src = PREFERRED_PDFJS.srcs[i];
    const worker = PREFERRED_PDFJS.workers[i] || PREFERRED_PDFJS.workers[0];
    const cmap = PREFERRED_PDFJS.cmaps[i] || PREFERRED_PDFJS.cmaps[0];
    try {
      await loadScriptUrl(src, 14000);
      // small wait
      await new Promise(r => setTimeout(r, 60));
      if (window.pdfjsLib) {
        try {
          pdfjsLib.GlobalWorkerOptions.workerSrc = worker;
          pdfjsLib.GlobalWorkerOptions.cMapUrl = cmap;
          pdfjsLib.GlobalWorkerOptions.cMapPacked = true;
          console.log('pdfjs loaded from', src, 'worker->', worker, 'cMap->', cmap);
        } catch (e) {
          console.warn('failed to set worker/cmap', e);
        }
        return window.pdfjsLib;
      } else {
        lastErr = new Error('script loaded but pdfjsLib not attached: ' + src);
        console.warn(lastErr);
      }
    } catch (e) {
      console.warn('pdfjs load failed for', src, e);
      lastErr = e;
      // try next
    }
  }
  throw new Error('All pdf.js load attempts failed. Last: ' + (lastErr && lastErr.message));
}

/* =======================
   Ensure Tesseract is loaded (try multiple CDNs)
   ======================= */
async function ensureTesseract() {
  if (window.Tesseract) { console.log('Tesseract already present'); return window.Tesseract; }
  let lastErr = null;
  for (const url of PREFERRED_TESSERACT) {
    try {
      await loadScriptUrl(url, 14000);
      await new Promise(r => setTimeout(r, 60));
      if (window.Tesseract) {
        console.log('Tesseract loaded from', url);
        return window.Tesseract;
      }
    } catch (e) {
      console.warn('tesseract load failed for', url, e);
      lastErr = e;
    }
  }
  // not fatal — OCR can be optional
  console.warn('Tesseract could not be loaded. OCR disabled. Last:', lastErr && lastErr.message);
  return null;
}

/* =======================
   Clipboard helper (HTML + plain)
   ======================= */
async function copyToClipboard(plain, html) {
  try {
    if (navigator.clipboard && navigator.clipboard.write) {
      const blobPlain = new Blob([plain], { type: 'text/plain' });
      const blobHtml = new Blob([html], { type: 'text/html' });
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blobPlain, 'text/html': blobHtml })]);
      showTemporaryToast('コピーしました（HTML含む）');
      return true;
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(plain);
      showTemporaryToast('コピーしました（プレーン）');
      return true;
    } else {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = plain;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showTemporaryToast('コピーしました（フォールバック）');
      return true;
    }
  } catch (e) {
    console.error('copy failed', e);
    showTemporaryToast('コピーに失敗しました');
    return false;
  }
}

/* =======================
   Tesseract compatibility layer
   ======================= */
// we intentionally avoid let redeclare if present
if (typeof window._tesseractWorker === 'undefined') window._tesseractWorker = null;
if (typeof window._tesseractWorkerLang === 'undefined') window._tesseractWorkerLang = null;

async function getTesseractWorkerCompat(lang = 'jpn') {
  if (typeof window.Tesseract === 'undefined') return null;
  // prefer createWorker API
  if (typeof window.Tesseract.createWorker === 'function') {
    // reuse
    if (window._tesseractWorker && window._tesseractWorkerLang === lang) return window._tesseractWorker;
    try {
      const worker = await window.Tesseract.createWorker({
        logger: (m) => { if (m && m.status) console.debug('TESS:', m); }
      });
      // some builds expose load/loadLanguage/initialize, others have slightly different shapes.
      // We'll try the common sequence but catch if functions missing.
      if (typeof worker.load === 'function') {
        await worker.load();
      }
      if (typeof worker.loadLanguage === 'function') {
        await worker.loadLanguage(lang);
      }
      if (typeof worker.initialize === 'function') {
        await worker.initialize(lang);
      }
      window._tesseractWorker = worker;
      window._tesseractWorkerLang = lang;
      console.log('Tesseract worker ready (compat)');
      // debug: list methods
      try { console.debug('Tesseract worker methods:', Object.keys(worker).filter(k => typeof worker[k] === 'function')); } catch (e) { }
      return worker;
    } catch (e) {
      console.warn('Tesseract createWorker/init failed, will fallback to direct recognize if available', e);
      try { if (worker && typeof worker.terminate === 'function') await worker.terminate(); } catch (__) { }
      window._tesseractWorker = null;
      window._tesseractWorkerLang = null;
      return null;
    }
  }
  // fallback: if Tesseract.recognize exists (older API)
  if (typeof window.Tesseract.recognize === 'function') {
    return null; // indicator to use direct recognize
  }
  return null;
}

async function ocrCanvasCompat(canvas, lang = 'jpn') {
  if (typeof window.Tesseract === 'undefined') return '';
  const worker = await getTesseractWorkerCompat(lang);
  // if worker exists and has recognize -> use it
  if (worker && typeof worker.recognize === 'function') {
    try {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      if (!blob) return '';
      const res = await worker.recognize(blob);
      return (res && (res.data && res.data.text || res.text)) || '';
    } catch (e) {
      console.warn('worker.recognize failed', e);
    }
  }
  // if worker exists but recognize missing, try direct recognize via Tesseract.recognize
  if (typeof window.Tesseract.recognize === 'function') {
    try {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      if (!blob) return '';
      const res = await window.Tesseract.recognize(blob, lang, { logger: m => { if (m && m.status) console.debug('TESS:', m); } });
      return (res && (res.data && res.data.text || res.text)) || '';
    } catch (e) {
      console.warn('direct Tesseract.recognize failed', e);
    }
  }
  return '';
}

async function terminateTesseractCompat() {
  try {
    if (window._tesseractWorker && typeof window._tesseractWorker.terminate === 'function') {
      await window._tesseractWorker.terminate();
    }
  } catch (e) { /* ignore */ }
  window._tesseractWorker = null;
  window._tesseractWorkerLang = null;
}

/* =======================
   Text splitting & scoring helpers
   ======================= */
function splitIntoSentences(text) {
  if (!text || !text.trim()) return [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  const hasCJK = /[。！？]/.test(normalized);
  if (hasCJK) return normalized.split(/(?<=[。！？])/g).map(s => s.trim()).filter(Boolean);
  return normalized.split(/(?<=[.?!])\s+(?=[A-Z0-9"“”'‘])/g).map(s => s.trim()).filter(Boolean);
}
function scoreSentences(sentences, keywords = [], minLen = 15, maxLen = 160) {
  const seen = new Set(); const kws = (keywords || []).map(k => k.trim()).filter(Boolean);
  const scored = [];
  for (const s of sentences) {
    const norm = s.replace(/\s+/g, ' ').trim();
    if (!norm || seen.has(norm)) continue; seen.add(norm);
    const len = [...norm].length;
    if (len < 2) continue;
    let score = 0;
    if (len >= minLen && len <= maxLen) score += 10;
    else { const diff = Math.max(minLen - len, len - maxLen); score -= diff * 0.2; }
    for (const kw of kws) if (kw && norm.includes(kw)) score += 3;
    if (/[、,，:：;；]/.test(norm)) score += 1;
    scored.push({ text: norm, score, len });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.len - a.len));
  return scored;
}
// main.js - PDF.js + Tesseract OCR fallback (minimal, robust)
// 前提: index.html で pdf.min.js と tesseract.js を main.js より先に読み込んでください.

const RENDER_SCALE = 1.25;

/* ---------- ユーティリティ ---------- */
function $id(id) { return document.getElementById(id); }
function showTemporaryToast(msg, ms = 1200) {
  const t = $id('toast'); if (!t) return; t.textContent = msg;
  t.classList.remove('hidden', 'toast-hide'); t.classList.add('toast-show');
  setTimeout(() => { t.classList.remove('toast-show'); t.classList.add('toast-hide'); setTimeout(() => t.classList.add('hidden'), 240); }, ms);
}
function humanFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  return (bytes / Math.pow(1024, i)).toFixed((i === 0) ? 0 : 1) + ' ' + sizes[i];
}
function escapeHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function heuristicsHtmlForText(s) {
  let html = escapeHtml(s || '');
  html = html.replace(/([A-Za-z\)\]])([0-9]+)(?=[^0-9]|$)/g, (m, p1, p2) => `${p1}<sub>${p2}</sub>`);
  html = html.replace(/([A-Za-z0-9\)\]])\^(-?\d+)/g, (m, p1, p2) => `${p1}<sup>${p2}</sup>`);
  html = html.replace(/10\^(-?\d+)/g, (m, p1) => `10<sup>${p1}</sup>`);
  return html;
}

/* ---------- ライブラリ存在チェック / 初期化 ---------- */
async function ensurePdfJs() {
  if (window.pdfjsLib) {
    console.log('pdfjs already present', pdfjsLib.version || 'unknown');
    return;
  }
  // もし html 側で読み込まれていないならここでエラーにする（外部 script を推奨）
  throw new Error('pdfjsLib not available. Include pdf.min.js before main.js.');
}

let _tesseractWorker = null;
async function ensureTesseract(lang = 'jpn') {
  if (typeof Tesseract === 'undefined') {
    console.warn('Tesseract not present; OCR disabled.');
    return null;
  }
  // create worker lazily and reuse
  if (_tesseractWorker) return _tesseractWorker;
  try {
    if (typeof Tesseract.createWorker === 'function') {
      _tesseractWorker = Tesseract.createWorker({
        logger: m => { /* optional: console.log('TESS', m); */ }
      });
      await _tesseractWorker.load();
      await _tesseractWorker.loadLanguage(lang);
      await _tesseractWorker.initialize(lang);
      console.log('tesseract worker initialized', lang);
      return _tesseractWorker;
    } else {
      // older/newer API differences: some bundles expose Tesseract.recognize directly
      console.warn('Tesseract.createWorker not available; will try direct API if present.');
      return null;
    }
  } catch (e) {
    console.warn('tesseract init failed', e);
    try { if (_tesseractWorker && _tesseractWorker.terminate) await _tesseractWorker.terminate(); } catch (_) { }
    _tesseractWorker = null;
    return null;
  }
}
async function terminateTesseractWorker() {
  if (_tesseractWorker && _tesseractWorker.terminate) {
    try { await _tesseractWorker.terminate(); } catch (e) { /* ignore */ }
    _tesseractWorker = null;
  }
}

/* OCR wrapper: canvas -> text (兼容処理) */
async function ocrCanvasCompat(canvas, lang = 'jpn') {
  if (typeof Tesseract === 'undefined') return '';
  // prefer worker if available
  if (typeof Tesseract.createWorker === 'function') {
    const w = await ensureTesseract(lang);
    if (!w) return '';
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    if (!blob) return '';
    try {
      const res = await w.recognize(blob);
      return (res && res.data && res.data.text) ? res.data.text : '';
    } catch (e) {
      console.warn('ocr (worker) failed', e);
      return '';
    }
  } else if (typeof Tesseract.recognize === 'function') {
    // fallback: direct API
    try {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      if (!blob) return '';
      const arr = await blob.arrayBuffer();
      // some builds accept ArrayBuffer / Image
      const result = await Tesseract.recognize(arr, { lang });
      return result?.data?.text || '';
    } catch (e) {
      console.warn('ocr (direct) failed', e);
      return '';
    }
  } else {
    return '';
  }
}

/* ---------- PDF 読み込み + レンダリング + テキスト抽出 ---------- */
async function loadAndRenderPdf(fileOrUrl) {
  // ensure libs
  try {
    await ensurePdfJs();
  } catch (e) {
    console.error('pdf.js not loaded', e);
    showTemporaryToast('pdf.js がロードされていません（HTMLにscript追加してください）', 2000);
    const st = $id('extractStatus'); if (st) st.textContent = 'pdf.js 未検出';
    return;
  }

  // ここで worker の上書きを行う（***重要***）
  try {
    // 同一バージョンの worker を指すと安定しやすい。あなたの環境で動いていたバージョンをセット。
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.8.162/pdf.worker.min.js';
    // optional cmap for some PDFs (日本語フォント等)
    pdfjsLib.GlobalWorkerOptions.cMapUrl = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.8.162/cmaps/';
    pdfjsLib.GlobalWorkerOptions.cMapPacked = true;
    console.log('pdf.worker set -> cdnjs 3.8.162');
  } catch (e) {
    console.warn('set workerSrc failed', e);
  }

  // Tesseract は遅いので非同期初期化（必要なら後で利用）
  ensureTesseract().catch(() => { /* ignore */ });

  const extractStatusEl = $id('extractStatus'); if (extractStatusEl) extractStatusEl.textContent = '読み込み中...';
  window.pageItems = []; window.pageTexts = []; window.pageSentences = [];
  const viewer = $id('viewer'); if (!viewer) { showTemporaryToast('viewer が見つかりません'); return; }
  viewer.innerHTML = '';

  // prepare loadingTask
  let loadingTask;
  try {
    if (fileOrUrl instanceof Blob || (window.File && fileOrUrl instanceof File)) {
      const arr = await fileOrUrl.arrayBuffer();
      loadingTask = pdfjsLib.getDocument({ data: arr });
    } else if (typeof fileOrUrl === 'string') {
      loadingTask = pdfjsLib.getDocument(fileOrUrl);
    } else {
      throw new Error('Unsupported PDF source');
    }
  } catch (e) {
    console.error('getDocument init failed', e);
    showTemporaryToast('PDF の初期化に失敗しました');
    if (extractStatusEl) extractStatusEl.textContent = '初期化エラー';
    return;
  }

  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (e) {
    console.error('pdf promise failed', e);
    showTemporaryToast('PDF 読み込みに失敗しました（worker やファイルの問題）', 2000);
    if (extractStatusEl) extractStatusEl.textContent = '読み込み失敗';
    return;
  }

  const numPages = pdf.numPages || 0;
  if (extractStatusEl) extractStatusEl.textContent = `ページ数 ${numPages} を処理中...`;

  const autoOcr = !!($id('autoOcr') && $id('autoOcr').checked);
  const ocrLang = ($id('ocrLang') && $id('ocrLang').value) ? $id('ocrLang').value : 'jpn';

  for (let p = 1; p <= numPages; p++) {
    try {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: RENDER_SCALE });

      // canvas + overlay
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      canvas.style.width = Math.round(viewport.width) + 'px'; canvas.style.height = Math.round(viewport.height) + 'px';
      canvas.dataset.pageNumber = p; canvas.className = 'pdf-page-canvas';
      const overlay = document.createElement('canvas');
      overlay.width = canvas.width; overlay.height = canvas.height;
      overlay.style.width = canvas.style.width; overlay.style.height = canvas.style.height;
      overlay.className = 'pdf-page-overlay';
      overlay.style.position = 'absolute'; overlay.style.left = '0'; overlay.style.top = '0'; overlay.style.pointerEvents = 'none';

      const wrapper = document.createElement('div'); wrapper.className = 'page-wrapper';
      wrapper.style.position = 'relative'; wrapper.style.display = 'inline-block'; wrapper.style.width = '100%';
      const label = document.createElement('div'); label.textContent = `Page ${p}`; label.className = 'text-xs text-gray-500 mb-1';
      wrapper.appendChild(label); wrapper.appendChild(canvas); wrapper.appendChild(overlay);
      viewer.appendChild(wrapper);

      // render page to canvas
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      // get text content
      const content = await page.getTextContent({ normalizeWhitespace: true }).catch(e => { console.warn('getTextContent failed', e); return { items: [] }; });
      const items = content.items || [];
      const pageTokens = []; const textParts = [];

      for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx];
        const str = it.str || '';
        if (!str.trim()) continue;
        // try transform combination (pdfjs.Util.transform might exist)
        let tr = it.transform || [1, 0, 0, 1, 0, 0];
        try {
          if (pdfjsLib && pdfjsLib.Util && typeof pdfjsLib.Util.transform === 'function' && viewport && viewport.transform) {
            tr = pdfjsLib.Util.transform(viewport.transform, it.transform || tr);
          } else if (viewport && viewport.convertToViewportPoint && it.transform) {
            try {
              const [vx, vy] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
              tr = [1, 0, 0, 1, vx, vy];
            } catch (_) { }
          }
        } catch (_) { }
        const vx = tr[4] || 0; const vy = tr[5] || 0;
        const fontSize = Math.hypot(tr[0] || 1, tr[1] || 0) || (it.height || 10);
        const itemWidth = (typeof it.width === 'number' && it.width > 0) ? (it.width * (viewport.scale || RENDER_SCALE)) : Math.max(6, str.length * fontSize * 0.45);
        const itemHeight = fontSize * 1.15;
        pageTokens.push({ page: p, str, x: vx, y: vy, width: itemWidth, height: itemHeight, fontSize, idx });
        textParts.push(str);
      }

      let pageText = textParts.join(' ');
      console.log(`page ${p}: tokens=${pageTokens.length}`);

      const needOcr = ((!pageText || pageText.trim().length < 8) && autoOcr);
      if (needOcr) {
        if (extractStatusEl) extractStatusEl.textContent = `ページ ${p} を OCR 中...（言語: ${ocrLang}）`;
        try {
          const ocrResult = await ocrCanvasCompat(canvas, ocrLang);
          if (ocrResult && ocrResult.trim().length > 2) {
            pageText = ocrResult;
            pageTokens.length = 0;
            const ocrParts = pageText.split(/\s+/).filter(Boolean);
            for (let ii = 0; ii < ocrParts.length; ii++) {
              pageTokens.push({ page: p, str: ocrParts[ii], x: 0, y: 0, width: 0, height: 0, fontSize: 0, idx: ii });
            }
            console.log(`page ${p}: OCR produced ${ocrParts.length} parts`);
          } else {
            console.log(`page ${p}: OCR empty`);
          }
        } catch (e) { console.warn('OCR failed for page', p, e); }
      }

      // save
      window.pageItems.push(...pageTokens);
      window.pageTexts[p - 1] = pageText;
      window.pageSentences[p - 1] = buildSentencesAndMapItems(pageText, pageTokens);

      await new Promise(r => setTimeout(r, 20));
    } catch (err) {
      console.error('page loop error', p, err);
    }
  } // end pages

  if (extractStatusEl) extractStatusEl.textContent = `レンダリング・抽出完了（${numPages}ページ）`;
  showTemporaryToast('PDF解析が完了しました', 900);
  attachCanvasClickHandlers();
}

/* ---------- 文分割＋マッピング（あなたの既存ロジックを流用） ---------- */
function splitIntoSentences(text) {
  if (!text || !text.trim()) return [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  const hasCJK = /[。！？]/.test(normalized);
  if (hasCJK) return normalized.split(/(?<=[。！？])/g).map(s => s.trim()).filter(Boolean);
  return normalized.split(/(?<=[.?!])\s+(?=[A-Z0-9"“”'‘])/g).map(s => s.trim()).filter(Boolean);
}
function buildSentencesAndMapItems(pageText, items) {
  const sentencesText = splitIntoSentences(pageText || '');
  const ranges = []; let cursor = 0;
  for (const it of items) {
    const s = it.str || '';
    const start = cursor, end = cursor + s.length;
    ranges.push({ it, start, end });
    cursor = end + 1;
  }
  const sentences = [];
  let searchFrom = 0;
  for (const s of sentencesText) {
    const t = s.trim(); if (!t) { searchFrom += 1; continue; }
    const idx = (pageText || '').indexOf(t, searchFrom);
    if (idx === -1) { searchFrom += t.length + 1; continue; }
    const st = idx, ed = idx + t.length;
    const included = [];
    ranges.forEach((r, i) => { if (!(r.end < st || r.start > ed)) included.push(i); });
    sentences.push({ text: t, startChar: st, endChar: ed, itemIndices: included });
    searchFrom = ed + 1;
  }
  return sentences;
}

/* ---------- Canvas クリック -> 近傍トークン -> 文 -> クリップボード ---------- */
function attachCanvasClickHandlers() {
  const canvases = Array.from(document.querySelectorAll('.pdf-page-canvas'));
  canvases.forEach(canvas => {
    if (canvas._handlerAttached) return;
    canvas._handlerAttached = true;
    canvas.addEventListener('click', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
      const pageNum = parseInt(canvas.dataset.pageNumber, 10);
      handleCanvasClick(pageNum, x, y, canvas, rect);
    });
  });
}
function handleCanvasClick(pageNum, x, y, canvas) {
  const itemsOnPage = window.pageItems.filter(it => it.page === pageNum);
  if (!itemsOnPage.length) { showTemporaryToast('このページにテキストが見つかりません'); return; }
  // find nearest with coords
  let best = null;
  for (const it of itemsOnPage) {
    if (!it.x && !it.y) continue;
    const cx = (it.x || 0) + (it.width || 0) / 2;
    const cy = (it.y || 0) - (it.height || 0) / 2;
    const dx = cx - x, dy = cy - y;
    const d = dx * dx + dy * dy;
    if (!best || d < best.d) best = { d, it };
  }
  let chosen = best ? best.it : itemsOnPage[0];
  const sentences = window.pageSentences[pageNum - 1] || [];
  let found = sentences.find(s => s.itemIndices && s.itemIndices.includes(chosen.idx));
  if (!found) found = sentences[0];
  if (!found) { showTemporaryToast('文の検出に失敗しました'); return; }
  const plain = found.text;
  const html = heuristicsHtmlForText(plain);
  copyToClipboard(plain, html);
  highlightOnOverlay(canvas, chosen);
}

/* overlay highlight */
function highlightOnOverlay(canvas, item) {
  const wrapper = canvas.parentElement; if (!wrapper) return;
  const overlay = wrapper.querySelector('.pdf-page-overlay'); if (!overlay) return;
  const ctx = overlay.getContext('2d'); if (!ctx) return;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!item || (!item.x && !item.y)) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,165,0,0.95)'; ctx.lineWidth = Math.max(2, (item.fontSize || 10) * 0.12);
  const x = Math.max(0, item.x - 2);
  const y = Math.max(0, item.y - item.height - 2);
  const w = (item.width || 40) + 4; const h = (item.height || 12) + 4;
  ctx.strokeRect(x, y, w, h);
  setTimeout(() => { if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height); }, 600);
  ctx.restore();
}

/* clipboard HTML+plain */
async function copyToClipboard(plain, html) {
  try {
    if (navigator.clipboard && navigator.clipboard.write) {
      const blobPlain = new Blob([plain], { type: 'text/plain' });
      const blobHtml = new Blob([html], { type: 'text/html' });
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blobPlain, 'text/html': blobHtml })]);
      showTemporaryToast('コピーしました（HTML含む）', 900);
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(plain);
      showTemporaryToast('コピーしました（プレーン）', 900);
      return;
    }
    const ta = document.createElement('textarea'); ta.value = plain; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta); showTemporaryToast('コピーしました（フォールバック）', 900);
  } catch (e) {
    console.error('clipboard error', e);
    showTemporaryToast('コピーに失敗しました', 1200);
  }
}

/* ---------- 最低限の UI ハンドラ（ファイル選択 etc.） ---------- */
(function attachFileHandlers() {
  const fileInput = $id('fileInput');
  const chooseBtn = $id('chooseBtn');
  const dropArea = $id('dropArea');
  const resetBtn = $id('resetBtn');
  const downloadLink = $id('downloadLink');

  if (!fileInput || !chooseBtn || !dropArea || !resetBtn) {
    setTimeout(attachFileHandlers, 200);
    return;
  }

  chooseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) { showTemporaryToast('ファイルが選択されていません'); return; }
    $id('fileName').textContent = f.name; $id('fileSize').textContent = humanFileSize(f.size);
    try { await loadAndRenderPdf(f); } catch (err) { console.error(err); showTemporaryToast('解析に失敗しました', 1500); }
  });

  ['dragenter', 'dragover'].forEach(ev => dropArea.addEventListener(ev, (e) => { e.preventDefault(); dropArea.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach(ev => dropArea.addEventListener(ev, (e) => { e.preventDefault(); dropArea.classList.remove('drag-over'); }));
  dropArea.addEventListener('drop', async (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) { showTemporaryToast('ファイルがドロップされていません'); return; }
    $id('fileName').textContent = f.name; $id('fileSize').textContent = humanFileSize(f.size);
    try { await loadAndRenderPdf(f); } catch (err) { console.error(err); showTemporaryToast('解析に失敗しました', 1500); }
  });

  resetBtn.addEventListener('click', () => { $id('fileName').textContent = '未選択'; $id('fileSize').textContent = '-'; $id('viewer').innerHTML = ''; window.pageItems = []; window.pageTexts = []; });
  downloadLink.addEventListener('click', (e) => { if (!window.currentFile) { e.preventDefault(); showTemporaryToast('ダウンロードするファイルがありません'); } });

  console.log('attachFileHandlers: ready');
})();

/* ---------- その他 UI ボタン ---------- */
document.addEventListener('click', (ev) => {
  const el = ev.target;
  if (!el) return;
  if (el.id === 'doExtract') {
    const full = (window.pageTexts || []).join('\n\n');
    if (!full) { showTemporaryToast('まずPDFを解析してください'); return; }
    $id('extractedText').value = full.slice(0, 2000) + (full.length > 2000 ? '\n\n...（省略）' : '');
    $id('extractStatus').textContent = '抽出済';
    showTemporaryToast('全文抽出を表示しました', 900);
  } else if (el.id === 'genQuotes') {
    const full = (window.pageTexts || []).join('\n\n');
    if (!full) { showTemporaryToast('まずPDFを解析してください'); return; }
    const minLen = parseInt($id('minLen').value || '15', 10);
    const maxLen = parseInt($id('maxLen').value || '160', 10);
    const n = parseInt($id('numCandidates').value || '6', 10);
    const kwRaw = $id('keywordInput').value || '';
    const keywords = kwRaw.split(',').map(s => s.trim()).filter(Boolean);
    const sentences = splitIntoSentences(full);
    const scored = scoreSentences(sentences, keywords, minLen, maxLen);
    renderQuotes(scored, n);
  } else if (el.id === 'clearExtract') {
    $id('extractedText').value = ''; $id('extractStatus').textContent = '未抽出'; $id('quotesArea').innerHTML = ''; window.pageItems = []; window.pageTexts = []; window.pageSentences = []; $id('viewer').innerHTML = '';
    showTemporaryToast('クリアしました');
  }
});

/* ---------- scoring/rendering (既存ロジック) ---------- */
function scoreSentences(sentences, keywords = [], minLen = 15, maxLen = 160) {
  const seen = new Set(); const kws = (keywords || []).map(k => k.trim()).filter(Boolean); const out = [];
  for (const s of sentences) {
    const norm = s.replace(/\s+/g, ' ').trim();
    if (!norm || seen.has(norm)) continue; seen.add(norm);
    const len = [...norm].length; if (len < 2) continue;
    let score = 0; if (len >= minLen && len <= maxLen) score += 10; else { const diff = Math.max(minLen - len, len - maxLen); score -= diff * 0.2; }
    for (const kw of kws) if (kw && norm.includes(kw)) score += 3;
    if (/[、,，:：;；]/.test(norm)) score += 1;
    out.push({ text: norm, score, len });
  }
  out.sort((a, b) => (b.score - a.score) || (b.len - a.len));
  return out;
}
function renderQuotes(candidates, n = 6) {
  const quotesArea = $id('quotesArea'); if (!quotesArea) return; quotesArea.innerHTML = '';
  const take = (candidates && candidates.length) ? candidates.slice(0, n) : [];
  if (!take.length) { quotesArea.innerHTML = '<div class="text-sm text-gray-500">候補が見つかりません</div>'; return; }
  for (const c of take) {
    const wrap = document.createElement('div'); wrap.className = 'p-3 bg-gray-50 border rounded flex justify-between items-start gap-3';
    const left = document.createElement('div'); left.className = 'flex-1';
    const p = document.createElement('p'); p.className = 'text-sm text-gray-800'; p.textContent = c.text; p.style.cursor = 'pointer'; p.title = 'クリックでコピー';
    p.onclick = async () => { await copyToClipboard(c.text, heuristicsHtmlForText(c.text)); showTemporaryToast('引用をコピーしました'); };
    left.appendChild(p);
    const actions = document.createElement('div'); actions.className = 'flex flex-col gap-2';
    const insertBtn = document.createElement('button'); insertBtn.className = 'px-2 py-1 bg-green-600 text-white rounded text-sm'; insertBtn.textContent = 'カードに表示';
    insertBtn.onclick = () => { if (typeof window.setCardNotice === 'function') { window.setCardNotice(c.text); showTemporaryToast('カードに反映しました'); } };
    actions.appendChild(insertBtn); wrap.appendChild(left); wrap.appendChild(actions); quotesArea.appendChild(wrap);
  }
}

/* ---------- helper: copy ---------- */
async function copyToClipboard(plain, html) {
  try {
    if (navigator.clipboard && navigator.clipboard.write) {
      const blobPlain = new Blob([plain], { type: 'text/plain' });
      const blobHtml = new Blob([html], { type: 'text/html' });
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blobPlain, 'text/html': blobHtml })]);
      showTemporaryToast('コピーしました（HTML含む）', 900);
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(plain); showTemporaryToast('コピーしました', 900); return;
    }
    const ta = document.createElement('textarea'); ta.value = plain; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta); showTemporaryToast('コピーしました（フォールバック）', 900);
  } catch (e) { console.error(e); showTemporaryToast('コピーに失敗しました', 1200); }
}

/* demo card */
window.setCardNotice = function (msg) { const area = $id('fileName'); if (area) area.textContent = 'Card: ' + (msg && msg.slice(0, 50)); showTemporaryToast('カードに表示しました', 800); };

/* selection length counter */
document.addEventListener('selectionchange', () => { const sel = document.getSelection(); const txt = sel ? sel.toString() : ''; const el = $id('selectionCount'); if (el) el.textContent = `${[...txt].length}`; });

console.log('main.js loaded — ready');


/* =======================
   sentence <-> token mapping
   ======================= */
function buildSentencesAndMapItems(pageText, items) {
  const sentencesText = splitIntoSentences(pageText || '');
  const ranges = [];
  let cursor = 0;
  for (const it of items) {
    const s = it.str || '';
    const start = cursor;
    const end = cursor + s.length;
    ranges.push({ it, start, end });
    cursor = end + 1;
  }
  const sentences = [];
  let searchFrom = 0;
  for (const s of sentencesText) {
    const t = s.trim();
    if (!t) { searchFrom += 1; continue; }
    const idx = (pageText || '').indexOf(t, searchFrom);
    if (idx === -1) { searchFrom += t.length + 1; continue; }
    const st = idx, ed = idx + t.length;
    const included = [];
    ranges.forEach((r, i) => { if (!(r.end < st || r.start > ed)) included.push(i); });
    sentences.push({ text: t, startChar: st, endChar: ed, itemIndices: included });
    searchFrom = ed + 1;
  }
  return sentences;
}

/* =======================
   canvas click handling => nearest token => sentence => copy
   ======================= */
function attachCanvasClickHandlers() {
  const canvases = Array.from(document.querySelectorAll('.pdf-page-canvas'));
  canvases.forEach(canvas => {
    // avoid double attaching
    if (canvas._pdfClickAttached) return;
    canvas._pdfClickAttached = true;
    canvas.addEventListener('click', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const pageNum = parseInt(canvas.dataset.pageNumber, 10);
      handleCanvasClick(pageNum, x, y, canvas, rect);
    });
  });
}

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function heuristicsHtmlForText(s) {
  let html = escapeHtml(s || '');
  html = html.replace(/([A-Za-z\)\]])([0-9]+)(?=[^0-9]|$)/g, (m, p1, p2) => `${p1}<sub>${p2}</sub>`);
  html = html.replace(/([A-Za-z0-9\)\]])\^(-?\d+)/g, (m, p1, p2) => `${p1}<sup>${p2}</sup>`);
  html = html.replace(/10\^(-?\d+)/g, (m, p1) => `10<sup>${p1}</sup>`);
  return html;
}

function handleCanvasClick(pageNum, x, y, canvas, rect) {
  const itemsOnPage = window.pageItems.filter(it => it.page === pageNum);
  if (!itemsOnPage.length) { showTemporaryToast('このページにテキストが見つかりません'); return; }

  // find nearest token with coords
  let best = null;
  for (const it of itemsOnPage) {
    // skip OCR placeholder tokens without coords
    if (!it.x && !it.y) continue;
    const cx = (it.x || 0) + (it.width || 0) / 2;
    const cy = (it.y || 0) - (it.height || 0) / 2;
    const dx = cx - x;
    const dy = cy - y;
    const d = dx * dx + dy * dy;
    if (!best || d < best.d) best = { d, it };
  }

  let chosenItem = null;
  if (best) chosenItem = best.it;
  else chosenItem = itemsOnPage[0];

  const sentences = window.pageSentences[pageNum - 1] || [];
  let found = sentences.find(s => s.itemIndices && s.itemIndices.includes(chosenItem.idx));
  if (!found) found = sentences[0];
  if (!found) { showTemporaryToast('文検出に失敗しました'); return; }

  const plain = found.text;
  const html = heuristicsHtmlForText(plain);
  copyToClipboard(plain, html);
  highlightOnOverlay(canvas, chosenItem);
}

/* overlay highlight (non-destructive) */
function highlightOnOverlay(canvas, item) {
  const wrapper = canvas.parentElement;
  if (!wrapper) return;
  const overlay = wrapper.querySelector('.pdf-page-overlay');
  if (!overlay) return;
  const ctx = overlay.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!item || (!item.x && !item.y)) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,165,0,0.95)';
  ctx.lineWidth = Math.max(2, (item.fontSize || 10) * 0.12);
  const x = Math.max(0, item.x - 2);
  const y = Math.max(0, item.y - item.height - 2);
  const w = (item.width || 40) + 4;
  const h = (item.height || 12) + 4;
  try { ctx.strokeRect(x, y, w, h); } catch (e) { /* ignore */ }
  setTimeout(() => { try { ctx.clearRect(0, 0, overlay.width, overlay.height); } catch (_) { } }, 700);
  ctx.restore();
}

/* =======================
   UI handlers (file open / drag-drop / buttons)
   ======================= */
(function attachFileHandlers() {
  const fileInput = $id('fileInput');
  const chooseBtn = $id('chooseBtn');
  const dropArea = $id('dropArea');
  const resetBtn = $id('resetBtn');
  const downloadLink = $id('downloadLink');
  const doExtractBtn = $id('doExtract');
  const genQuotesBtn = $id('genQuotes');
  const clearExtractBtn = $id('clearExtract');

  if (!fileInput || !chooseBtn || !dropArea || !resetBtn) {
    console.warn('attachFileHandlers: UI missing; retrying in 200ms');
    setTimeout(attachFileHandlers, 200);
    return;
  }

  const isPdfFile = (file) => {
    if (!file) return false;
    return (file.type && file.type.toLowerCase().includes('pdf')) || (typeof file.name === 'string' && file.name.toLowerCase().endsWith('.pdf'));
  };

  chooseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) { showTemporaryToast('ファイルが選択されていません'); return; }
    if (!isPdfFile(f)) { showTemporaryToast('PDFファイルを選択してください (.pdf)'); return; }
    // set UI
    if ($id('fileName')) $id('fileName').textContent = f.name;
    if ($id('fileSize')) $id('fileSize').textContent = (f.size ? (f.size / 1024 | 0) + ' KB' : '-');
    try { await loadAndRenderPdf(f); } catch (err) { console.error('loadAndRenderPdf failed', err); showTemporaryToast('解析に失敗しました'); }
  });

  ['dragenter', 'dragover'].forEach(ev => dropArea.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropArea.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach(ev => dropArea.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropArea.classList.remove('drag-over'); }));
  dropArea.addEventListener('drop', async (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) { showTemporaryToast('ファイルがドロップされていません'); return; }
    if (!isPdfFile(f)) { showTemporaryToast('PDFファイルをドロップしてください (.pdf)'); return; }
    if ($id('fileName')) $id('fileName').textContent = f.name;
    if ($id('fileSize')) $id('fileSize').textContent = (f.size ? (f.size / 1024 | 0) + ' KB' : '-');
    try { await loadAndRenderPdf(f); } catch (err) { console.error('loadAndRenderPdf failed (drop)', err); showTemporaryToast('解析に失敗しました'); }
  });

  resetBtn.addEventListener('click', async () => {
    if ($id('fileName')) $id('fileName').textContent = '未選択';
    if ($id('fileSize')) $id('fileSize').textContent = '-';
    if ($id('viewer')) $id('viewer').innerHTML = '';
    window.pageItems = []; window.pageTexts = []; window.pageSentences = [];
    await terminateTesseractCompat();
    showTemporaryToast('ファイルをクリアしました');
  });

  if (downloadLink) downloadLink.addEventListener('click', (e) => { if (!window.currentFile) { e.preventDefault(); showTemporaryToast('ダウンロードするファイルがありません'); } });

  if (doExtractBtn) doExtractBtn.addEventListener('click', () => {
    const full = (window.pageTexts || []).join('\n\n');
    if (!full) { showTemporaryToast('まずPDFを解析してください'); return; }
    const ex = $id('extractedText');
    if (ex) ex.value = full.slice(0, 2000) + (full.length > 2000 ? '\n\n...（省略）' : '');
    if ($id('extractStatus')) $id('extractStatus').textContent = '抽出済';
    showTemporaryToast('全文抽出を表示しました', 900);
  });

  if (genQuotesBtn) genQuotesBtn.addEventListener('click', () => {
    const full = (window.pageTexts || []).join('\n\n');
    if (!full) { showTemporaryToast('まずPDFを解析してください'); return; }
    const minLen = parseInt(($id('minLen') && $id('minLen').value) || '15', 10);
    const maxLen = parseInt(($id('maxLen') && $id('maxLen').value) || '160', 10);
    const n = parseInt(($id('numCandidates') && $id('numCandidates').value) || '6', 10);
    const kwRaw = ($id('keywordInput') && $id('keywordInput').value) || '';
    const keywords = kwRaw.split(',').map(s => s.trim()).filter(Boolean);
    const sentences = splitIntoSentences(full);
    const scored = scoreSentences(sentences, keywords, minLen, maxLen);
    renderQuotes(scored, n);
  });

  if (clearExtractBtn) clearExtractBtn.addEventListener('click', async () => {
    if ($id('extractedText')) $id('extractedText').value = '';
    if ($id('extractStatus')) $id('extractStatus').textContent = '未抽出';
    if ($id('quotesArea')) $id('quotesArea').innerHTML = '';
    window.pageItems = []; window.pageTexts = []; window.pageSentences = [];
    if ($id('viewer')) $id('viewer').innerHTML = '';
    await terminateTesseractCompat();
    showTemporaryToast('クリアしました');
  });

  // selection count
  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    const text = sel ? sel.toString() : '';
    const el = $id('selectionCount');
    if (el) el.textContent = `${[...text].length}`;
  });

  console.log('attachFileHandlers: ready');
})();

/* =======================
   quote rendering
   ======================= */
function renderQuotes(candidates, n = 6) {
  const quotesArea = $id('quotesArea');
  if (!quotesArea) return;
  quotesArea.innerHTML = '';
  const take = (candidates && candidates.length) ? candidates.slice(0, n) : [];
  if (!take.length) { quotesArea.innerHTML = '<div class="text-sm text-gray-500">候補が見つかりません</div>'; return; }
  for (const c of take) {
    const wrap = document.createElement('div'); wrap.className = 'p-3 bg-gray-50 border rounded flex justify-between items-start gap-3';
    const left = document.createElement('div'); left.className = 'flex-1';
    const p = document.createElement('p'); p.className = 'text-sm text-gray-800'; p.textContent = c.text; p.style.cursor = 'pointer'; p.title = 'クリックでコピー';
    p.onclick = async () => { await copyToClipboard(c.text, heuristicsHtmlForText(escapeHtml(c.text))); showTemporaryToast('引用をコピーしました'); };
    left.appendChild(p);
    const actions = document.createElement('div'); actions.className = 'flex flex-col gap-2';
    const insertBtn = document.createElement('button'); insertBtn.className = 'px-2 py-1 bg-green-600 text-white rounded text-sm'; insertBtn.textContent = 'カードに表示';
    insertBtn.onclick = () => { if (typeof window.setCardNotice === 'function') { window.setCardNotice(c.text); showTemporaryToast('カードに反映しました'); } };
    actions.appendChild(insertBtn);
    wrap.appendChild(left); wrap.appendChild(actions); quotesArea.appendChild(wrap);
  }
}

/* =======================
   small helpers
   ======================= */
function escapeHtmlSafe(s) { return escapeHtml(s || ''); }
function heuristicsHtmlForText(s) {
  let html = escapeHtmlSafe(s || '');
  html = html.replace(/([A-Za-z\)\]])([0-9]+)(?=[^0-9]|$)/g, (m, p1, p2) => `${p1}<sub>${p2}</sub>`);
  html = html.replace(/([A-Za-z0-9\)\]])\^(-?\d+)/g, (m, p1, p2) => `${p1}<sup>${p2}</sup>`);
  html = html.replace(/10\^(-?\d+)/g, (m, p1) => `10<sup>${p1}</sup>`);
  return html;
}

/* =======================
   demo card (replace with app logic)
   ======================= */
window.setCardNotice = function (msg) {
  const area = $id('fileName');
  if (area) area.textContent = 'Card: ' + (msg && msg.slice(0, 50));
  showTemporaryToast('カードに表示しました', 800);
};

/* =======================
   expose some debug helpers in window for quick troubleshooting
   ======================= */
window.pdfOcrDebug = {
  ensurePdfJs, ensureTesseract, ocrCanvasCompat, terminateTesseractCompat,
  getState: () => ({ pdfjs: !!window.pdfjsLib && window.pdfjsLib.version, tesseract: !!window.Tesseract, worker: !!window._tesseractWorker })
};

console.log('main.js loaded — ready');
