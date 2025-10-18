// main.js — 改良版: pdf.js + Tesseract OCR フォールバック（推奨実装）
/* 前提: index.html で pdf.js と tesseract.js を先に読み込んでいること */

if (window['pdfjsLib']) {
  // PDF.js worker の参照
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.8.162/pdf.worker.min.js';
}

/* --- UI helpers --- */
function showTemporaryToast(msg, ms = 1200) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden', 'toast-hide');
  t.classList.add('toast-show');
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
  let html = s;
  html = html.replace(/([A-Za-z\)\]])([0-9]+)(?=[^0-9]|$)/g, (m, p1, p2) => `${p1}<sub>${p2}</sub>`);
  html = html.replace(/([A-Za-z0-9\)\]])\^(-?\d+)/g, (m, p1, p2) => `${p1}<sup>${p2}</sup>`);
  html = html.replace(/10\^(-?\d+)/g, (m, p1) => `10<sup>${p1}</sup>`);
  return html;
}

/* --- グローバル状態 --- */
window.currentFile = null;
window.pageItems = [];      // {page,str,x,y,width,height,fontSize,idx}
window.pageTexts = [];      // ページごとのテキスト
window.pageSentences = [];  // ページごとの文配列
const RENDER_SCALE = 1.25;

/* --- Tesseract ワーカー再利用 --- */
let _tesseractWorker = null;
async function getTesseractWorker(lang = 'jpn') {
  if (typeof Tesseract === 'undefined') return null;
  if (_tesseractWorker) return _tesseractWorker; // 再利用
  _tesseractWorker = Tesseract.createWorker({
    logger: m => { /* optional: console.log('TESS', m); */ }
  });
  await _tesseractWorker.load();
  await _tesseractWorker.loadLanguage(lang);
  await _tesseractWorker.initialize(lang);
  return _tesseractWorker;
}
async function terminateTesseractWorker() {
  if (_tesseractWorker) {
    try { await _tesseractWorker.terminate(); } catch (e) { /* ignore */ }
    _tesseractWorker = null;
  }
}

/* --- clipboard write (HTML+plain) --- */
async function copyToClipboard(plain, html) {
  try {
    if (navigator.clipboard && navigator.clipboard.write) {
      const blobPlain = new Blob([plain], { type: 'text/plain' });
      const blobHtml = new Blob([html], { type: 'text/html' });
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blobPlain, 'text/html': blobHtml })]);
      showTemporaryToast('コピーしました（HTML含む）');
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(plain);
      showTemporaryToast('コピーしました（プレーン）');
      return;
    }
    const ta = document.createElement('textarea'); ta.value = plain; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    showTemporaryToast('コピーしました（フォールバック）');
  } catch (e) {
    console.error('clipboard error', e);
    showTemporaryToast('コピーに失敗しました');
  }
}

/* --- setFile (UI only) --- */
async function setFile(file) {
  const fileNameEl = document.getElementById('fileName');
  const fileSizeEl = document.getElementById('fileSize');
  const statusEl = document.getElementById('status');
  if (!file) {
    if (fileNameEl) fileNameEl.textContent = '未選択';
    if (fileSizeEl) fileSizeEl.textContent = '-';
    if (statusEl) statusEl.textContent = 'ファイル未選択';
    window.currentFile = null;
    document.getElementById('viewer').innerHTML = '';
    showTemporaryToast('ファイルをクリアしました');
    return;
  }
  window.currentFile = file;
  if (fileNameEl) fileNameEl.textContent = file.name;
  if (fileSizeEl) fileSizeEl.textContent = humanFileSize(file.size);
  if (statusEl) statusEl.textContent = 'プレビュー中';
  showTemporaryToast('PDFを読み込みました', 700);
}

/* --- OCR helper using shared worker --- */
async function ocrCanvasForPage(canvas, lang = 'jpn') {
  if (typeof Tesseract === 'undefined') { console.warn('Tesseract not loaded'); return ''; }
  const worker = await getTesseractWorker(lang);
  if (!worker) return '';
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  if (!blob) return '';
  try {
    const res = await worker.recognize(blob);
    return res?.data?.text || '';
  } catch (e) {
    console.error('OCR error', e);
    return '';
  }
}

/* --- 主要: PDF を読む・レンダリング・token を作る --- */
async function loadAndRenderPdf(fileOrUrl) {
  const extractStatus = document.getElementById('extractStatus');
  extractStatus.textContent = '読み込み中...';
  window.pageItems = []; window.pageTexts = []; window.pageSentences = [];
  document.getElementById('viewer').innerHTML = '';

  let loadingTask;
  if (fileOrUrl instanceof Blob || (window.File && fileOrUrl instanceof File)) {
    const arr = await fileOrUrl.arrayBuffer();
    loadingTask = pdfjsLib.getDocument({ data: arr });
  } else if (typeof fileOrUrl === 'string') {
    loadingTask = pdfjsLib.getDocument(fileOrUrl);
  } else {
    throw new Error('Unsupported PDF source');
  }

  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  extractStatus.textContent = `ページ数 ${numPages} を処理中...`;

  const autoOcr = !!(document.getElementById('autoOcr') && document.getElementById('autoOcr').checked);
  const ocrLang = (document.getElementById('ocrLang') || {}).value || 'jpn';

  for (let p = 1; p <= numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: RENDER_SCALE });

    // canvas: 描画用
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    canvas.style.width = Math.round(viewport.width) + 'px';
    canvas.style.height = Math.round(viewport.height) + 'px';
    canvas.dataset.pageNumber = p;
    canvas.className = 'pdf-page-canvas';

    // overlay canvas for highlights (separate so we don't repaint base)
    const overlay = document.createElement('canvas');
    overlay.width = canvas.width; overlay.height = canvas.height;
    overlay.style.width = canvas.style.width; overlay.style.height = canvas.style.height;
    overlay.className = 'pdf-page-overlay';
    overlay.style.position = 'absolute'; overlay.style.left = '0'; overlay.style.top = '0';
    overlay.style.pointerEvents = 'none';

    // wrapper that positions overlay on top of canvas
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.style.position = 'relative';
    const label = document.createElement('div'); label.textContent = `Page ${p}`; label.className = 'text-xs text-gray-500 mb-1';
    wrapper.appendChild(label);
    wrapper.appendChild(canvas);
    wrapper.appendChild(overlay);
    document.getElementById('viewer').appendChild(wrapper);

    // render page to canvas
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    // extract text tokens from page.getTextContent()
    const content = await page.getTextContent({ normalizeWhitespace: true });
    const items = content.items || [];
    const textParts = [];
    const pageTokens = [];

    // NOTE: use pdfjsLib.Util.transform to combine viewport.transform and item.transform safely
    const util = pdfjsLib.Util || (pdfjsLib && pdfjsLib.PDFJS && pdfjsLib.PDFJS.Util);
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const str = it.str || '';
      if (!str.trim()) continue;
      const itTransform = it.transform || [1, 0, 0, 1, 0, 0];
      // combined matrix = viewport.transform * item.transform
      let tr = itTransform;
      try {
        if (util && typeof util.transform === 'function' && viewport && viewport.transform) {
          tr = util.transform(viewport.transform, itTransform);
        } else {
          // fallback: keep item transform as-is
          tr = itTransform;
        }
      } catch (e) {
        console.warn('transform combine failed', e);
        tr = itTransform;
      }
      const vx = tr[4];
      const vy = tr[5];
      // estimate fontSize from matrix scale
      const fontSize = Math.hypot(tr[0], tr[1]) || (it.height || 10);
      // width: prefer item.width if present, scaled by viewport.scale
      const itemWidth = (typeof it.width === 'number' && it.width > 0) ? (it.width * (viewport.scale || RENDER_SCALE)) : Math.max(6, str.length * fontSize * 0.45);
      const itemHeight = fontSize * 1.15;
      pageTokens.push({ page: p, str, x: vx, y: vy, width: itemWidth, height: itemHeight, fontSize, idx });
      textParts.push(str);
    }

    console.log(`page ${p}: tokens=${pageTokens.length}`, pageTokens.slice(0, 12));

    // pageText (join)
    let pageText = textParts.join(' ');

    // detect "no text" or "garbled" => OCR fallback if autoOcr enabled
    const needOcr = (!pageText || pageText.trim().length < 8) && autoOcr;
    if (needOcr) {
      extractStatus.textContent = `ページ ${p} を OCR 中...（言語: ${ocrLang}）`;
      try {
        const ocrResult = await ocrCanvasForPage(canvas, ocrLang);
        if (ocrResult && ocrResult.trim().length > 2) {
          pageText = ocrResult;
          // OCR では座標が無いので placeholder tokens (idx only) を作る
          pageTokens.length = 0;
          const ocrParts = pageText.split(/\s+/).filter(Boolean);
          let idxCounter = 0;
          for (const part of ocrParts) {
            pageTokens.push({ page: p, str: part, x: 0, y: 0, width: 0, height: 0, fontSize: 0, idx: idxCounter++ });
          }
          console.log(`page ${p}: OCR produced ${ocrParts.length} parts`);
        } else {
          console.log(`page ${p}: OCR returned empty or too short`);
        }
      } catch (e) {
        console.warn('OCR failed for page', p, e);
      }
    }

    // save
    window.pageItems.push(...pageTokens);
    window.pageTexts[p - 1] = pageText;
    window.pageSentences[p - 1] = buildSentencesAndMapItems(pageText, pageTokens);

    // small pause
    await new Promise(r => setTimeout(r, 20));
  }

  extractStatus.textContent = `レンダリング・抽出完了（${numPages}ページ）`;
  showTemporaryToast('PDF解析が完了しました', 900);

  // attach click handlers to canvases (overlay exists as sibling)
  attachCanvasClickHandlers();
}

/* --- 文分割 + token->sentence mapping (簡易) --- */
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

/* --- 文分割（CJK および英語対応） --- */
function splitIntoSentences(text) {
  if (!text || !text.trim()) return [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  const hasCJK = /[。！？]/.test(normalized);
  if (hasCJK) return normalized.split(/(?<=[。！？])/g).map(s => s.trim()).filter(Boolean);
  return normalized.split(/(?<=[.?!])\s+(?=[A-Z0-9"“”'‘])/g).map(s => s.trim()).filter(Boolean);
}

/* --- Canvas click handling --- */
function attachCanvasClickHandlers() {
  const canvases = Array.from(document.querySelectorAll('.pdf-page-canvas'));
  canvases.forEach(canvas => {
    // ensure wrapper overlay exists; overlay is nextSibling in our build
    canvas.addEventListener('click', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const pageNum = parseInt(canvas.dataset.pageNumber, 10);
      handleCanvasClick(pageNum, x, y, canvas, rect);
    });
  });
}

function handleCanvasClick(pageNum, x, y, canvas, rect) {
  const itemsOnPage = window.pageItems.filter(it => it.page === pageNum);
  if (!itemsOnPage.length) { showTemporaryToast('このページにテキストが見つかりません'); return; }

  // find nearest token with coords; if none (OCR-only), fallback to first sentence
  let best = null;
  for (const it of itemsOnPage) {
    if (!it.x && !it.y) continue; // skip placeholder OCR tokens
    // item coordinates are in PDF viewport coordinates (we used transform), which correspond to canvas pixels
    const cx = (it.x || 0) + (it.width || 0) / 2;
    // pdf.js y often is baseline, so approximate center:
    const cy = (it.y || 0) - (it.height || 0) / 2;
    const dx = cx - x;
    const dy = cy - y;
    const d = dx * dx + dy * dy;
    if (!best || d < best.d) best = { d, it };
  }

  let chosenItem = null;
  if (best) chosenItem = best.it;
  else chosenItem = itemsOnPage[0]; // fallback when no coords

  const sentences = window.pageSentences[pageNum - 1] || [];
  let found = sentences.find(s => s.itemIndices && s.itemIndices.includes(chosenItem.idx));
  if (!found) found = sentences[0];
  if (!found) { showTemporaryToast('文検出に失敗しました'); return; }

  const plain = found.text;
  const html = heuristicsHtmlForText(escapeHtml(plain));
  copyToClipboard(plain, html);
  highlightOnOverlay(canvas, chosenItem);
}

/* --- overlay highlighting (doesn't destroy base canvas) --- */
function highlightOnOverlay(canvas, item) {
  const wrapper = canvas.parentElement;
  if (!wrapper) return;
  const overlay = wrapper.querySelector('.pdf-page-overlay');
  if (!overlay) return;
  const ctx = overlay.getContext('2d');
  if (!ctx) return;
  // clear previous
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!item) return;
  // if item has no coords (OCR placeholder), nothing to highlight
  if (!item.x && !item.y) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,165,0,0.95)';
  ctx.lineWidth = Math.max(2, (item.fontSize || 10) * 0.12);
  const x = Math.max(0, item.x - 2);
  const y = Math.max(0, item.y - item.height - 2);
  const w = (item.width || 40) + 4;
  const h = (item.height || 12) + 4;
  ctx.strokeRect(x, y, w, h);
  // fade after short time
  setTimeout(() => { ctx.clearRect(0, 0, overlay.width, overlay.height); }, 600);
  ctx.restore();
}

/* --- ハンドラ / UI --- */
(function attachFileHandlers() {
  const fileInput = document.getElementById('fileInput');
  const chooseBtn = document.getElementById('chooseBtn');
  const dropArea = document.getElementById('dropArea');
  const resetBtn = document.getElementById('resetBtn');
  const downloadLink = document.getElementById('downloadLink');

  if (!fileInput || !chooseBtn || !dropArea || !resetBtn) { setTimeout(attachFileHandlers, 200); return; }

  chooseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) { showTemporaryToast('ファイルが選択されていません'); return; }
    await setFile(f);
    try { await loadAndRenderPdf(f); } catch (err) { console.error(err); showTemporaryToast('解析に失敗しました'); }
  });

  ['dragenter', 'dragover'].forEach(ev => dropArea.addEventListener(ev, (e) => { e.preventDefault(); dropArea.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach(ev => dropArea.addEventListener(ev, (e) => { e.preventDefault(); dropArea.classList.remove('drag-over'); }));
  dropArea.addEventListener('drop', async (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) { showTemporaryToast('ファイルがドロップされていません'); return; }
    await setFile(f);
    try { await loadAndRenderPdf(f); } catch (err) { console.error(err); showTemporaryToast('解析に失敗しました'); }
  });

  resetBtn.addEventListener('click', () => { setFile(null); terminateTesseractWorker().catch(() => { }); });
  downloadLink.addEventListener('click', (e) => { if (!window.currentFile) { e.preventDefault(); showTemporaryToast('ダウンロードするファイルがありません'); } });

  console.log('attachFileHandlers: ready');
})();

/* --- 抽出 / 引用生成など UI ボタン --- */
document.getElementById('doExtract').addEventListener('click', () => {
  const full = (window.pageTexts || []).join('\n\n');
  if (!full) { showTemporaryToast('まずPDFを解析してください'); return; }
  document.getElementById('extractedText').value = full.slice(0, 2000) + (full.length > 2000 ? '\n\n...（省略）' : '');
  document.getElementById('extractStatus').textContent = '抽出済';
  showTemporaryToast('全文抽出を表示しました', 900);
});

document.getElementById('genQuotes').addEventListener('click', () => {
  const full = (window.pageTexts || []).join('\n\n');
  if (!full) { showTemporaryToast('まずPDFを解析してください'); return; }
  const minLen = parseInt(document.getElementById('minLen').value || '15', 10);
  const maxLen = parseInt(document.getElementById('maxLen').value || '160', 10);
  const n = parseInt(document.getElementById('numCandidates').value || '6', 10);
  const kwRaw = document.getElementById('keywordInput').value || '';
  const keywords = kwRaw.split(',').map(s => s.trim()).filter(Boolean);
  const sentences = splitIntoSentences(full);
  const scored = scoreSentences(sentences, keywords, minLen, maxLen);
  renderQuotes(scored, n);
});

document.getElementById('clearExtract').addEventListener('click', () => {
  document.getElementById('extractedText').value = '';
  document.getElementById('extractStatus').textContent = '未抽出';
  document.getElementById('quotesArea').innerHTML = '';
  window.pageItems = []; window.pageTexts = []; window.pageSentences = [];
  document.getElementById('viewer').innerHTML = '';
  showTemporaryToast('クリアしました');
});

/* --- 選択文字数カウント --- */
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  const text = sel ? sel.toString() : '';
  const el = document.getElementById('selectionCount');
  if (el) el.textContent = `${[...text].length}`;
});

/* --- 既存の scoring/rendering helpers --- */
function scoreSentences(sentences, keywords = [], minLen = 15, maxLen = 160) {
  const seen = new Set();
  const kws = (keywords || []).map(k => k.trim()).filter(Boolean);
  const out = [];
  for (const s of sentences) {
    const norm = s.replace(/\s+/g, ' ').trim();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const len = [...norm].length;
    if (len < 2) continue;
    let score = 0;
    if (len >= minLen && len <= maxLen) score += 10;
    else { const diff = Math.max(minLen - len, len - maxLen); score -= diff * 0.2; }
    for (const kw of kws) if (kw && norm.includes(kw)) score += 3;
    if (/[、,，:：;；]/.test(norm)) score += 1;
    out.push({ text: norm, score, len });
  }
  out.sort((a, b) => (b.score - a.score) || (b.len - a.len));
  return out;
}
function renderQuotes(candidates, n = 6) {
  const quotesArea = document.getElementById('quotesArea');
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

/* demo card */
window.setCardNotice = function (msg) {
  const area = document.getElementById('fileName');
  if (area) area.textContent = 'Card: ' + (msg && msg.slice(0, 50));
  showTemporaryToast('カードに表示しました', 800);
};
