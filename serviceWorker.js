// serviceWorker.js
const viewerPath = 'viewer/viewer.html';

chrome.webRequest.onHeadersReceived.addListener(
  function(details) {
    const contentTypeHeader = details.responseHeaders.find(
      header => header.name.toLowerCase() === 'content-type'
    );
    
    // Content-Typeが'application/pdf'であることをチェック
    if (contentTypeHeader && contentTypeHeader.value.includes('application/pdf')) {
      const pdfUrl = details.url;
      const viewerUrl = chrome.runtime.getURL(viewerPath) + 
                        '?pdf_url=' + encodeURIComponent(pdfUrl);
      
      // リダイレクトの指示を返す
      // statusLineを上書きすることで、リダイレクトを実行
      return { 
        redirectUrl: viewerUrl 
      };
    }
    // PDFでなければ何もしない
  },
  {
    urls: ["<all_urls>"], // すべてのネットワークリクエストを監視
    types: ["main_frame", "sub_frame"] // メインのタブの読み込みのみを対象
  },
  ["responseHeaders", "blocking"] // ヘッダー情報とブロッキング実行（リダイレクトに必要）
);