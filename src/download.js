function getParams() {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  const params = new URLSearchParams(hash || window.location.search);
  return {
    url: params.get('url') || '',
    filename: params.get('filename') || 'music',
  };
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function startDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function isIOSBrowser() {
  const ua = navigator.userAgent || '';
  return /iP(hone|ad|od)/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function init() {
  const { url, filename } = getParams();
  const startBtn = document.getElementById('startDownloadBtn');
  const homeBtn = document.getElementById('homeBtn');

  setText('downloadFilename', filename);

  if (!url || !/^https?:\/\//i.test(url)) {
    setText('downloadHint', '下载链接无效，请返回重新生成下载任务。');
    if (startBtn) startBtn.disabled = true;
  }

  startBtn?.addEventListener('click', () => {
    if (!url || !/^https?:\/\//i.test(url)) return;
    startDownload(url, filename);
    if (isIOSBrowser()) {
      setTimeout(() => {
        window.location.href = url;
      }, 80);
    }
    startBtn.textContent = '已交给浏览器';
    setText('downloadHint', '下载已交给浏览器处理。如果没有看到进度，请打开浏览器下载列表，或回到桌面查看系统下载状态。');
  });

  homeBtn?.addEventListener('click', () => {
    window.location.href = '/';
  });
}

window.addEventListener('DOMContentLoaded', init);
