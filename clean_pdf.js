/**
 * PDFからコピーしたテキストの不要な改行やハイフネーションを整形する
 * @param {string} text - 入力テキスト
 * @returns {string} - 整形後のテキスト
 */
function cleanPdfText(text) {
  let cleanedText = text;

  // 1. ハイフネーション（行末のハイフン + 改行）を削除
  cleanedText = cleanedText.replace(/-\n/g, '');

  // 2. 段落の区切り（2回以上の連続した改行）を一時的なマーカーに置換
  cleanedText = cleanedText.replace(/\n{2,}/g, '__PARAGRAPH_BREAK__');

  // 3. 文中の不要な改行（1回だけの改行）を「削除」
  cleanedText = cleanedText.replace(/\n/g, '');

  // 4. マーカーを段落の区切りに戻す（マーカー前後の余計なスペースも削除）
  // (元のテキストのスペースを保持するため、連続スペースの処理は行わない)
  cleanedText = cleanedText.replace(/ *__PARAGRAPH_BREAK__ */g, '\n\n');

  // 5. 先頭と末尾の余計な空白・改行を削除
  return cleanedText.trim();
}


// --- 実行サンプル ---

// ここにPDFからコピーしたテキストを貼り付ける
const sampleText = `
これはPDFのサンプルテ
キストです。文の途
中で改行が入ってし
まいます。

このよ
う
に、段落
が変わる
場合は2行の空
行が入ります。

元のテ
キストに   意図した複数のスペースが
あっても、
保持されます。
`;

console.log('--- 整形前 ---');
console.log(sampleText);

const cleanedText = cleanPdfText(sampleText);

console.log('\n--- 整形後 ---');
console.log(cleanedText);