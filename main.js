// main.js (デバッグ向け)
const fileInput = document.getElementById('fileInput');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const pageIndicator = document.getElementById('pageIndicator');
const pdfCanvas = document.getElementById('pdfCanvas');
const overlay = document.getElementById('overlay');

function showOverlay(msg) {
  overlay.style.display = msg ? 'block' : 'none';
  overlay.textContent = msg || '';
}

// early checks
if (!window.pdfjsLib) {
  showOverlay('pdfjsLib が見つかりません。index.html で pdf.min.js を読み込んでください。');
  throw new Error('pdfjsLib not loaded');
}
if (!pdfCanvas) {
  showOverlay('キャンバス要素が見つかりません (id="pdfCanvas")');
  throw new Error('canvas not found');
}

const ctx = pdfCanvas.getContext('2d');
let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let scale = 1.0;

function updateIndicator() {
  pageIndicator.textContent = `${currentPage} / ${totalPages || '—'}`;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= totalPages;
}

async function renderPage(num) {
  if (!pdfDoc) return;
  showOverlay('レンダリング中…');
  try {
    const page = await pdfDoc.getPage(num);
    const viewport = page.getViewport({ scale });
    pdfCanvas.width = Math.round(viewport.width);
    pdfCanvas.height = Math.round(viewport.height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, pdfCanvas.width, pdfCanvas.height);
    const renderTask = page.render({ canvasContext: ctx, viewport });
    await renderTask.promise;
    currentPage = num;
    updateIndicator();
  } catch (e) {
    console.error('render error', e);
    showOverlay('レンダリング失敗: ' + (e.message || e));
  } finally {
    setTimeout(() => showOverlay(''), 300); // 短く消す
  }
}

async function loadPdf(source) {
  showOverlay('PDF 読み込み中…');
  try {
    if (pdfDoc) {
      try { await pdfDoc.destroy(); } catch (e) { }
      pdfDoc = null;
    }
    const loadingTask = pdfjsLib.getDocument(source);
    pdfDoc = await loadingTask.promise;
    totalPages = pdfDoc.numPages;
    currentPage = 1;
    updateIndicator();
    await renderPage(currentPage);
  } catch (e) {
    console.error('loadPdf error', e);
    showOverlay('PDF 読み込み失敗: ' + (e.message || e));
  } finally {
    setTimeout(() => showOverlay(''), 300);
  }
}

// file input -> objectURL が安全
fileInput.addEventListener('change', (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  const objUrl = URL.createObjectURL(f);
  loadPdf(objUrl);
  // URL.revokeObjectURL(objUrl) は表示終了後に行うなど
});

prevBtn.addEventListener('click', () => {
  if (currentPage > 1) renderPage(currentPage - 1);
});
nextBtn.addEventListener('click', () => {
  if (currentPage < totalPages) renderPage(currentPage + 1);
});

// 初期 UI
updateIndicator();
