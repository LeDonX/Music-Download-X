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

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!ok) throw new Error('copy failed');
}

function startDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function init() {
  const { url, filename } = getParams();
  const startBtn = document.getElementById('startDownloadBtn');
  const copyBtn = document.getElementById('copyDownloadBtn');

  setText('downloadFilename', filename);

  if (!url || !/^https?:\/\//i.test(url)) {
    setText('downloadHint', '下载链接无效，请返回重新生成下载任务。');
    if (startBtn) startBtn.disabled = true;
    if (copyBtn) copyBtn.disabled = true;
    return;
  }

  startBtn?.addEventListener('click', () => {
    startDownload(url, filename);
    startBtn.textContent = '已交给浏览器';
    setText('downloadHint', '下载已交给浏览器处理。如果没有看到进度，请打开浏览器下载列表，或回到桌面查看系统下载状态。');
  });

  copyBtn?.addEventListener('click', async () => {
    try {
      await copyText(url);
      copyBtn.textContent = '已复制';
      setTimeout(() => {
        copyBtn.textContent = '复制下载链接';
      }, 1800);
    } catch (_) {
      setText('downloadHint', '复制失败，请长按地址栏复制当前下载页链接。');
    }
  });
}

window.addEventListener('DOMContentLoaded', init);
