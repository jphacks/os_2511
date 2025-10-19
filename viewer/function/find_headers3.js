// ====== PDF.js の読み込みとWorker設定 ======
import * as pdfjsLib from "../../build/pdf.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL("../../build/pdf.worker.mjs", import.meta.url).toString();

// ====== UI参照 ======
const els = {
  file: document.getElementById("file"),
  extract: document.getElementById("extract"),
  out: document.getElementById("out"),
  refs: document.getElementById("refs"),
  log: document.getElementById("log"),
  lines: document.getElementById("lines"),
};

let chooseFlag = false;
// 参照チェック
assertElements(els);

// ====== 状態 ======
let pdfBytes = null;
let currentFile = null; // ★ファイルオブジェクトを保持

// ====== 初期化 ======
bindUI();

/* ================================================================
 * ★★★ ヘッダー/フッター検出ロジック (Node.js版から移植) ★★★
 * ================================================================ */

// ★ヘッダー/フッターと見なす「座標のしきい値」（ポイント単位）
const HEADER_MARGIN_TOP = 100;
const FOOTER_MARGIN_BOTTOM = 100;

// ★数字を置換するための、論文では通常使われない記号
const NON_PAPER_SYMBOL = '■';

// --- 結合とフィルタリングのための許容誤差設定 ---
const Y_GROUPING_TOLERANCE = 5;
const X_MERGE_THRESHOLD = 5;
const POSITION_TOLERANCE = 10;
// ★文字列が一致していると見なすための類似度のしきい値 (50%)
const SIMILARITY_THRESHOLD = 0.5;


/**
 * 2つの文字列の最長共通部分列（LCS）の長さを計算する
 */
function lcs(str1, str2) {
    const m = str1.length;
    const n = str2.length;
    const dp = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    return dp[m][n];
}

/**
 * 2つの文字列の類似度をLCSに基づいて計算する (0から1のスコア)
 */
function calculateSimilarity(str1, str2) {
    const normStr1 = str1.replace(/\s/g, '');
    const normStr2 = str2.replace(/\s/g, '');

    if (normStr1.length === 0 || normStr2.length === 0) {
        return 0;
    }

    const commonLength = lcs(normStr1, normStr2);
    const longerLength = Math.max(normStr1.length, normStr2.length);
    
    return commonLength / longerLength;
}

/**
 * PDFから抽出したテキスト塊を、Y座標のズレを許容しつつ行グループにまとめ、水平方向に隣接するものを結合する
 */
function reconstructAndMergeLines(textItems) {
    if (!textItems || textItems.length === 0) {
        return [];
    }
    const sortedItems = [...textItems].sort((a, b) => b.transform[5] - a.transform[5]); // Y座標で降順ソート
    const lines = [];
    let processedIndices = new Set();
    for (let i = 0; i < sortedItems.length; i++) {
        if (processedIndices.has(i)) continue;
        let currentLine = [sortedItems[i]];
        processedIndices.add(i);
        let currentY = sortedItems[i].transform[5];
        for (let j = i + 1; j < sortedItems.length; j++) {
            if (processedIndices.has(j)) continue;
            if (Math.abs(currentY - sortedItems[j].transform[5]) <= Y_GROUPING_TOLERANCE) {
                currentLine.push(sortedItems[j]);
                processedIndices.add(j);
            }
        }
        lines.push(currentLine);
    }
    const mergedItems = [];
    for (const line of lines) {
        if (line.length === 0) continue;
        const sortedLine = line.sort((a, b) => a.transform[4] - b.transform[4]); // X座標で昇順ソート
        let currentMergedItem = {
            text: sortedLine[0].str,
            x: sortedLine[0].transform[4],
            y: sortedLine[0].transform[5],
            width: sortedLine[0].width,
        };
        for (let i = 1; i < sortedLine.length; i++) {
            const prevItem = currentMergedItem;
            const currentItem = sortedLine[i];
            const endOfPrevX = prevItem.x + prevItem.width;
            const startOfCurrentX = currentItem.transform[4];
            const gap = startOfCurrentX - endOfPrevX;
            if (gap >= 0 && gap <= X_MERGE_THRESHOLD) {
                currentMergedItem.text += " " + currentItem.str;
                currentMergedItem.width = (currentItem.transform[4] + currentItem.width) - prevItem.x;
            } else {
                mergedItems.push(currentMergedItem);
                currentMergedItem = {
                    text: currentItem.str,
                    x: currentItem.transform[4],
                    y: currentItem.transform[5],
                    width: currentItem.width,
                };
            }
        }
        mergedItems.push(currentMergedItem);
    }
    return mergedItems;
}

/**
 * 渡されたテキストアイテムのリストを、出現頻度と座標の近さに基づいてフィルタリングする
 */
function filterByFrequency(items) {
    const normalizedMap = new Map();
    for (const item of items) {
        const normalizedText = item.text.replace(/\s/g, '').replace(/[0-9]/g, NON_PAPER_SYMBOL).replace(new RegExp(`${NON_PAPER_SYMBOL}+`, 'g'), NON_PAPER_SYMBOL);
        if (!normalizedMap.has(normalizedText) && normalizedText) {
            normalizedMap.set(normalizedText, []);
        }
        if(normalizedText) {
            normalizedMap.get(normalizedText).push(item);
        }
    }
    const filteredItems = [];
    for (const originalItems of normalizedMap.values()) {
        if (originalItems.length <= 1) {
            continue;
        }
        const positionGroups = [];
        for (const item of originalItems) {
            const currentX = parseInt(item.x, 10);
            const currentY = parseInt(item.y, 10);
            let foundGroup = false;
            for (const group of positionGroups) {
                const representativeX = group.representative.x;
                const representativeY = group.representative.y;
                if (Math.abs(currentX - representativeX) <= POSITION_TOLERANCE && Math.abs(currentY - representativeY) <= POSITION_TOLERANCE) {
                    group.items.push(item);
                    foundGroup = true;
                    break;
                }
            }
            if (!foundGroup) {
                positionGroups.push({ representative: { x: currentX, y: currentY }, items: [item] });
            }
        }
        for (const group of positionGroups) {
            if (group.items.length > 1) {
                filteredItems.push(...group.items);
            }
        }
    }
    return filteredItems;
}


/* =========================
 * バインディング／UI周り (変更あり)
 * ========================= */
function bindUI() {
  els.file.addEventListener("change", onFileChange);
  els.extract.addEventListener("click", onExtractClick);
  els.extract.disabled = true;
}

// 1文字=1コードポイント（絵文字対応）
function charCount(s) {
  return [...String(s)].length;
}

/**
 * ファイルが選択できているかの確認処理
 */
function onFileChange(e) {
  const f = e.target.files?.[0];
  currentFile = f; // ★ファイルオブジェクトを保持
  if (!f) return;

  log(`選択: ${f.name} (${Math.round(f.size / 1024)} KB)`);
  toUint8(f)
    .then(bytes => {
      pdfBytes = bytes;
      els.out.value = "PDF読み込み準備OK。「抽出（全ページ）」を押してください。";
      els.extract.disabled = false;
    })
    .catch(err => {
      log(`File read error: ${err.message}`);
    });
}


// ============ 抽出ボタン (変更あり) ============
async function onExtractClick() {
  if (!pdfBytes) return;
  els.out.value = "抽出中… (ヘッダー/フッターの特定と本文の再構築を行っています)";
  log("抽出処理を開始します...");

  try {
    const pdf = await loadPdf(pdfBytes.slice()); 
    log(`PDFロード完了。全 ${pdf.numPages} ページ。`);

    // ★★★ ここが合体ロジックの呼び出し ★★★
    // 空白を潰すなら stripSpaces: true
    const { lineEntries, meta } = await extractAllPages(pdf, { stripSpaces: true });
    // ★★★★★★★★★★★★★★★★★★★★★

    log(`処理完了。ヘッダー/フッター除去後の本文から ${lineEntries.length} 件の文を抽出しました。`);

    // テキストエリアに一覧表示
    els.out.value = lineEntries
      .map(e => `[${e.page}ページ目 文${e.index + 1} ${e.length}文字]:    ${e.text}`).join("  \n");

    //参考文献をテキストエリアに抽出 (元のロジックをそのまま利用)
    // ※ extractReferencesFromPDF はこのファイル内では定義されていませんが、
    //   元のスクリプトの呼び出しを尊重し、そのまま残します。
    //   もし不要、またはエラーになる場合は、以下の if (!currentFile) ... catch ... までを削除してください。
    if (!currentFile) return;
    const url = URL.createObjectURL(currentFile);
    log("参考文献の抽出を開始します...");
    extractReferencesFromPDF(url).then(list => {
      console.log("抽出候補 (参考文献)", list);
      if (els.refs) {
        els.refs.value =
          list.length ? list.map((x, i) => `[Ref ${i + 1}] ${x}`).join("\n")
                      : "参考文献らしきセクションが見つかりませんでした。";
      }
      log("参考文献の抽出が完了しました。");
    }).catch(err => {
      console.error(err);
      log(`参考文献抽出エラー: ${err.message}`);
    });

    // 1文=1カードで描画
    renderLineCards(lineEntries);
    chooseFlag = true;
    showPopupOnSelection(); // ※この関数も定義が見当たりませんが、元の呼び出しを残します
    log(`ページ数: ${meta.numPages}, 文総数: ${lineEntries.length}`);

  } catch (err) {
    console.error(err);
    els.out.value = "抽出に失敗しました（コンソールを確認）。";
    log(`エラー: ${err.message}`);
  }
}

/**
 * カードを表示
 * (変更なし)
 */
function renderLineCards(lineEntries) {
  if (!els.lines) return;
  els.lines.innerHTML = ""; // クリア

  const frag = document.createDocumentFragment();

  for (const e of lineEntries) {
    const card = document.createElement("div");
    card.className = "line-card";

    const textEl = document.createElement("div");
    textEl.className = "text";
    textEl.textContent = e.text; // 文テキスト

    const meta = document.createElement("div");
    meta.className = "meta";

    const left = document.createElement("div");
    left.className = "left";

    const bPage = document.createElement("span");
    bPage.className = "badge";
    bPage.textContent = `P${e.page}`;

    const bIdx = document.createElement("span");
    bIdx.className = "badge";
    bIdx.textContent = `文${e.index + 1}`;

    const len = document.createElement("span");
    len.textContent = `${e.length} 文字`; // 文字数

    const right = document.createElement("div");
    right.className = "right";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "コピー";
    copyBtn.title = "この1行をコピー";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(e.text); // ※copyTextも定義が見当たりませんが、元の呼び出しを残します
      // 軽いフィードバック
      const old = copyBtn.textContent;
      copyBtn.textContent = ok ? "✓ コピー済み" : "コピー失敗";
      copyBtn.disabled = true;
      setTimeout(() => {
        copyBtn.textContent = old;
        copyBtn.disabled = false;
      }, 1200);
    });
    right.appendChild(copyBtn);

    left.append(bPage, bIdx);
    meta.append(left, len, right);

    card.append(textEl, meta);
    frag.appendChild(card);
  }
  els.lines.appendChild(frag);
}

/* =============================================
 * ★★★ PDF抽出ロジック (合体・再設計) ★★★
 * ============================================= */

// PDFをロードする (変更なし)
function loadPdf(bytes) {
  const task = pdfjsLib.getDocument({ data: bytes });
  return task.promise;
}

// 「。」で文末。直後の閉じ記号は同じ文に含める (変更なし)
function splitByMaru(text) {
  const closers = new Set(["」", "』", "）", "］", "】", "》", "\"", "”", "’"]);
  const out = [];
  let buf = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;

    if (ch === "。" || ch === ".") {
      let j = i + 1;
      while (j < text.length && closers.has(text[j])) buf += text[j++];

      out.push(buf.trim());
      buf = "";
      i = j - 1;
    }
  }
  if (buf.trim()) out.push(buf.trim()); // 末尾が「。」で終わらない場合も拾う
  return out.filter(Boolean);
}

/**
 * ★★★ メインロジック ★★★
 * 全ページを走査し、ヘッダー/フッターを除去した上で「文エントリ」に
 */
async function extractAllPages(pdf, { stripSpaces = true } = {}) {
  const numPages = pdf.numPages;
  
  // --- フェーズ1: 全ページのヘッダー/フッター候補を収集 ---
  log("フェーズ1: ヘッダー/フッター候補を全ページから収集中...");
  const allHeaders = [];
  const allFooters = [];
  const allMergedItemsByPage = new Map();

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });
    const pageHeight = viewport.height;
    const textContent = await page.getTextContent();
    
    // 座標ベースで行を再構築
    const mergedItems = reconstructAndMergeLines(textContent.items);
    allMergedItemsByPage.set(i, mergedItems); // 後で本文再構築に使うため保存

    // ヘッダー/フッター候補を分類
    for (const mergedItem of mergedItems) {
        if (!mergedItem.text.trim()) continue;
        const itemData = { 
            page: i, 
            text: mergedItem.text, 
            x: mergedItem.x.toFixed(0), 
            y: mergedItem.y.toFixed(0) 
        };

        if (mergedItem.y > (pageHeight - HEADER_MARGIN_TOP)) {
            allHeaders.push(itemData);
        } else if (mergedItem.y < FOOTER_MARGIN_BOTTOM) {
            allFooters.push(itemData);
        }
    }
  }
  log(`フェーズ1完了。ヘッダー候補: ${allHeaders.length}件, フッター候補: ${allFooters.length}件`);


  // --- フェーズ2: 除去対象のヘッダー/フッターを特定 ---
  log("フェーズ2: 候補をフィルタリングし、除去対象を特定中...");
  
  // ステップ1: 繰り返し出現する「確定版」を検出
  const confirmedHeaders = filterByFrequency(allHeaders);
  const confirmedFooters = filterByFrequency(allFooters);

  // ステップ2: 確定版に類似するものを検出
  const similarHeaders = [];
  const confirmedHeaderText = new Set(confirmedHeaders.map(h => h.text));
  const potentialHeaders = allHeaders.filter(h => !confirmedHeaderText.has(h.text));
  for (const potential of potentialHeaders) {
      for (const confirmed of confirmedHeaders) {
          if (calculateSimilarity(potential.text, confirmed.text) >= SIMILARITY_THRESHOLD) {
              similarHeaders.push(potential);
              break; 
          }
      }
  }

  const similarFooters = [];
  const confirmedFooterText = new Set(confirmedFooters.map(f => f.text));
  const potentialFooters = allFooters.filter(f => !confirmedFooterText.has(f.text));
  for (const potential of potentialFooters) {
      for (const confirmed of confirmedFooters) {
          if (calculateSimilarity(potential.text, confirmed.text) >= SIMILARITY_THRESHOLD) {
              similarFooters.push(potential);
              break;
          }
      }
  }

  // ステップ3: 全ての結果を結合し、ブラックリストを作成
  const combinedResults = [...confirmedHeaders, ...confirmedFooters, ...similarHeaders, ...similarFooters];
  const itemsToRemove = new Set();
  combinedResults.forEach(item => {
    // キー: "ページ番号:テキスト:X座標:Y座標"
    const key = `${item.page}:${item.text}:${item.x}:${item.y}`;
    itemsToRemove.add(key);
  });
  log(`フェーズ2完了。除去対象のヘッダー/フッターを ${itemsToRemove.size} 件特定。`);


  // --- フェーズ3: 本文の再構築と文への分割 ---
  log("フェーズ3: 本文を再構築し、文に分割中...");
  const lineEntries = [];
  
  for (let p = 1; p <= numPages; p++) {
    const pageMergedItems = allMergedItemsByPage.get(p) || [];
    
    // 1. ブラックリストにないアイテム（＝本文）だけを抽出
    const bodyItems = pageMergedItems.filter(item => {
        const key = `${p}:${item.text}:${item.x.toFixed(0)}:${item.y.toFixed(0)}`;
        return !itemsToRemove.has(key);
    });

    // 2. 本文アイテムを座標でソート (Y: 降順 = 上から下へ, X: 昇順 = 左から右へ)
    bodyItems.sort((a, b) => {
        if (Math.abs(b.y - a.y) > Y_GROUPING_TOLERANCE) {
            return b.y - a.y; // Y座標が違うなら、Yでソート
        }
        return a.x - b.x; // Y座標が同じなら、Xでソート
    });

    // 3. ソートされた本文アイテムを1つの文字列に結合
    let pageText = '';
    let lastY = -1;
    for (const item of bodyItems) {
        if (!item.text.trim()) continue;

        if (lastY === -1) {
            pageText = item.text;
        } else if (Math.abs(item.y - lastY) > Y_GROUPING_TOLERANCE * 2) { // 許容誤差より大きくYが変わったら改行
            pageText += '\n' + item.text;
        } else {
            // Y座標がほぼ同じ = 同じ行（カラム違いなど）
            pageText += '   ' + item.text; // スペースで区切る
        }
        lastY = item.y;
    }
    
    // 4. 元のスクリプトの空白除去オプションを適用
    if (stripSpaces) {
        pageText = pageText.replace(/\s+/g, ""); // レイアウト依存の空白を潰す
    }

    // 5. 「。」で文に分割
    const sentences = splitByMaru(pageText);

    // 6. 最終結果に追加
    sentences.forEach((text, i) => {
      lineEntries.push({
        page: p,
        index: i,              // ページ内の文番号（0始まり）
        text,
        length: charCount(text) // 1文の文字数
      });
    });
  }
  log("フェーズ3完了。");

  return {
    lineEntries,
    meta: { numPages }
  };
}


/* =========================
 * ユーティリティ (変更なし)
 * ========================= */

/**
 * @param {*} file PDFファイル（または他のバイナリファイル）を「Uint8Array（バイト配列）」に変換する関数
 */
function toUint8(file) {
  return file.arrayBuffer().then(buf => new Uint8Array(buf));
}
/**
 * @param {*} message ..画面にlogを残す。
 */
function log(message) {
  if (!els.log) return;
  const time = new Date().toLocaleTimeString();
  els.log.innerHTML += `[${time}] ${escapeHtml(message)}<br>`;
  // 自動スクロール
  els.log.scrollTop = els.log.scrollHeight;
}

function assertElements(obj) {
  const missing = Object.entries(obj)
    .filter(([_, el]) => !el)
    .map(([k]) => k);
  if (missing.length) {
    console.error("❌ 要素が取得できていません:", missing.join(", "));
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * 参考文献のコピーの実装
 * (変更なし)
 */
const copyRefsBtn = document.getElementById("copyRefs");
if (copyRefsBtn) {
  copyRefsBtn.addEventListener("click", async () => {
    const txt = els.refs?.value || "";
    const ok = await copyText(txt); // ※copyTextの定義は外部にあると想定
    copyRefsBtn.textContent = ok ? "✓ コピー済み" : "コピー失敗";
    copyRefsBtn.disabled = true;
    setTimeout(() => {
      copyRefsBtn.textContent = "参考文献をコピー";
      copyRefsBtn.disabled = false;
    }, 1200);
  });
}

// ----------------------------------------------------------------
// ★★★ 未定義の関数に関する注意 ★★★
// ----------------------------------------------------------------
// 以下の関数は、元の one_sentence.js で呼び出されていましたが、
// 提示されたコード内に定義がありませんでした。
// 動作には、これらの関数が別途定義されている必要があります。

if (typeof showPopupOnSelection === 'undefined') {
    globalThis.showPopupOnSelection = () => {
        // console.warn("showPopupOnSelection が未定義です");
    };
}

if (typeof copyText === 'undefined') {
    globalThis.copyText = async (text) => {
        try {
            await navigator.clipboard.writeText(text);
            console.log("クリップボードにコピーしました:", text);
            return true;
        } catch (err) {
            console.error("クリップボードへのコピーに失敗しました:", err);
            return false;
        }
    };
}

if (typeof extractReferencesFromPDF === 'undefined') {
    globalThis.extractReferencesFromPDF = async (url) => {
        console.warn("extractReferencesFromPDF が未定義です。ダミーデータを返します。");
        // この関数はPDFを再解析する複雑なロジックと想定されるため、
        // ここではダミー（空のリスト）を返すようにしています。
        // 実際のロジックがある場合は、この関数を置き換えてください。
        return [];
    };
}
// ----------------------------------------------------------------