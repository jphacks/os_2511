// contentScript.js
const currentUrl = window.location.href;

// PDFファイルを検出
if (currentUrl.endsWith('.pdf') || currentUrl.includes('application/pdf')) {
    // カスタムビューアのURLを構築
    // 拡張機能内のviewer.htmlに、元のPDFのURLをパラメータとして渡す
    const viewerUrl = chrome.runtime.getURL('viewer/viewer.html') + 
                      '?pdf_url=' + encodeURIComponent(currentUrl);

    // ブラウザのデフォルトのPDFビューアをオーバーライドし、リダイレクト
    window.location.replace(viewerUrl);
}