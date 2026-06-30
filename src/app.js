import { initResolverSandbox } from './resolver-sandbox.js';

const SOURCE_URLS = [
  'https://fastly.jsdelivr.net/gh/pdone/lx-music-source@main/lx/latest.js',
  'https://fastly.jsdelivr.net/gh/pdone/lx-music-source@main/huibq/latest.js',
  'https://fastly.jsdelivr.net/gh/pdone/lx-music-source@main/sixyin/latest.js',
  'https://fastly.jsdelivr.net/gh/pdone/lx-music-source@main/flower/latest.js',
  'https://fastly.jsdelivr.net/gh/pdone/lx-music-source@main/ikun/latest.js',
  'https://fastly.jsdelivr.net/gh/pdone/lx-music-source@main/grass/latest.js',
  'https://fastly.jsdelivr.net/gh/pdone/lx-music-source@main/juhe/latest.js',
];
const loadedSandboxes = {};
const PLATFORM_IDS = ['kw', 'kg', 'tx', 'wy', 'mg'];
const PLATFORM_NAMES = {
  kw: '酷我',
  kg: '酷狗',
  tx: 'QQ',
  wy: '网易',
  mg: '咪咕',
};
const SEARCH_TIMEOUT_MS = 18000;
const SEARCH_EMPTY_RETRY_LIMIT = 3;
const SEARCH_RETRY_DELAYS = [250, 700, 1400];
const RESOLVE_TIMEOUT_MS = 22000;
const ORDERED_QUALITIES = new Set(['128k', '320k', 'flac', 'flac24bit']);

// Application State
const state = {
  scriptUrl: 'https://fastly.jsdelivr.net/gh/pdone/lx-music-source@main/lx/latest.js',
  sandbox: null,
  currentResults: [],
  currentSource: 'tx',
  downloadQueue: [],
  currentPage: 1,
  totalCount: 0,
  limit: 15,
  currentKeyword: '',
  isLoading: false,
  searchRequestId: 0,
  searchAbortController: null,
  activeSearchKey: '',
  loadingMode: '',
  isInputComposing: false,
};

function buildQualityMap(song) {
  const qualityMap = { ...(song._types || {}) };
  for (const typeInfo of song.types || []) {
    qualityMap[typeInfo.type] = {
      ...(qualityMap[typeInfo.type] || {}),
      ...typeInfo,
    };
  }
  return qualityMap;
}

function getResolverId(song, quality) {
  const qualityMap = buildQualityMap(song);
  const qualityHash = quality ? qualityMap[quality]?.hash : null;
  if (qualityHash) return qualityHash;

  switch (song.source) {
    case 'kg':
      return song.hash || qualityMap['128k']?.hash || song.songmid || '';
    case 'mg':
      return song.copyrightId || song.songmid || '';
    case 'tx':
    case 'wy':
    case 'kw':
    default:
      return song.songmid || song.hash || '';
  }
}

function withResolverHashes(song, qualityMap) {
  const next = { ...qualityMap };
  for (const typeInfo of song.types || []) {
    const type = typeInfo.type;
    const resolverId = getResolverId(song, type);
    next[type] = {
      ...(next[type] || {}),
      ...typeInfo,
      ...(resolverId ? { hash: resolverId } : {}),
    };
  }
  return next;
}

function toNewMusicInfo(song) {
  const qualitys = song.types || [];
  const _qualitys = withResolverHashes(song, buildQualityMap(song));
  const meta = {
    songId: song.songmid,
    albumName: song.albumName || '',
    picUrl: song.img || '',
    qualitys,
    _qualitys,
    albumId: song.albumId || '',
  };

  switch (song.source) {
    case 'kg':
      meta.hash = getResolverId(song, '128k');
      break;
    case 'tx':
      meta.strMediaMid = song.strMediaMid || '';
      meta.id = song.songId || '';
      meta.albumMid = song.albumMid || '';
      break;
    case 'mg':
      meta.copyrightId = song.copyrightId || '';
      meta.lrcUrl = song.lrcUrl || '';
      meta.mrcUrl = song.mrcUrl || '';
      meta.trcUrl = song.trcUrl || '';
      break;
  }

  return {
    id: song.source === 'kg'
      ? `${song.songmid}_${meta.hash || ''}`
      : `${song.source}_${song.songmid}`,
    name: song.name,
    singer: song.singer,
    source: song.source,
    interval: song.interval || '00:00',
    meta,
  };
}

function toOldMusicInfo(song) {
  const _types = withResolverHashes(song, buildQualityMap(song));
  const fallbackHash = getResolverId(song, '128k');
  return {
    songmid: song.songmid,
    name: song.name,
    singer: song.singer,
    source: song.source,
    albumName: song.albumName || '',
    albumId: song.albumId || '',
    img: song.img || '',
    interval: song.interval || '00:00',
    strMediaMid: song.strMediaMid || '',
    albumMid: song.albumMid || '',
    songId: song.songId || '',
    hash: song.hash || fallbackHash || '',
    copyrightId: song.copyrightId || '',
    lrcUrl: song.lrcUrl || '',
    mrcUrl: song.mrcUrl || '',
    trcUrl: song.trcUrl || '',
    types: song.types || [],
    _types,
    typeUrl: {},
  };
}

function getResolvedUrlPayload(resolved) {
  const finalUrl = typeof resolved === 'string' ? resolved : resolved?.url || resolved?.data?.url;
  const finalHeaders = typeof resolved === 'string' ? {} : resolved?.headers || resolved?.data?.headers || {};
  const finalType = typeof resolved === 'string'
    ? ''
    : normalizeQualityType(resolved?.type || resolved?.data?.type || resolved?.quality || resolved?.data?.quality);
  return {
    finalUrl,
    finalHeaders,
    finalType,
  };
}

function normalizeQualityType(type) {
  if (type == null || type === '') return '';
  const value = String(type).trim().toLowerCase();
  if (!value) return '';

  if (['flac24bit', 'flac24', '24bit', 'hires', 'hr'].includes(value)) return 'flac24bit';
  if (['flac', 'lossless', 'sq', '999', '999k', '999000'].includes(value)) return 'flac';
  if (['320', '320k', '320000', 'exhigh'].includes(value)) return '320k';
  if (['128', '128k', '128000', 'standard'].includes(value)) return '128k';
  return value;
}

function formatQualityLabel(type) {
  const value = normalizeQualityType(type);
  if (value === 'flac24bit') return 'Hi-Res';
  if (value === 'flac') return 'FLAC';
  if (value === '320k') return '320K';
  if (value === '128k') return '128K';
  return String(type || '').toUpperCase();
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSongFilename(song, ext) {
  const singer = sanitizeFilenamePart(song.singer) || '未知歌手';
  const name = sanitizeFilenamePart(song.name) || '未知歌曲';
  return `${singer} - ${name}.${ext}`;
}

function getDefaultExtensionForQuality(quality) {
  const value = normalizeQualityType(quality);
  return value.startsWith('flac') ? 'flac' : 'mp3';
}

function getExtensionFromUrl(url) {
  if (!url) return '';
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]+)$/);
    const ext = match?.[1] || '';
    if (['flac', 'mp3', 'm4a', 'aac', 'ogg', 'wav'].includes(ext)) return ext;
  } catch (_) {
    return '';
  }
  return '';
}

function getExtensionFromMedia(contentType, fallbackExt, url = '') {
  const value = String(contentType || '').toLowerCase();
  if (value.includes('flac')) return 'flac';
  if (value.includes('mpeg') || value.includes('mp3')) return 'mp3';
  if (value.includes('m4a') || value.includes('mp4') || value.includes('aac')) return 'm4a';
  if (value.includes('ogg')) return 'ogg';
  if (value.includes('wav')) return 'wav';
  return getExtensionFromUrl(url) || fallbackExt;
}

function getActualQuality(selectedQuality, resolvedQuality, actualExt) {
  const selected = normalizeQualityType(selectedQuality) || selectedQuality;
  const resolved = normalizeQualityType(resolvedQuality);
  if (resolved) {
    if (!ORDERED_QUALITIES.has(resolved) && !selected.startsWith('flac')) return selected;
    if (selected.startsWith('flac') && resolved === selected && actualExt !== 'flac') return actualExt;
    return resolved;
  }
  if (selected.startsWith('flac') && actualExt !== 'flac') return actualExt;
  if (!selected.startsWith('flac') && actualExt === 'flac') return 'flac';
  return selected;
}

function getDownloadMediaInfo(contentType, selectedQuality, resolvedQuality, url = '') {
  const selected = normalizeQualityType(selectedQuality) || selectedQuality;
  const resolverQuality = normalizeQualityType(resolvedQuality);
  const actualExt = getExtensionFromMedia(contentType, getDefaultExtensionForQuality(resolverQuality || selected), url);
  const actualQuality = getActualQuality(selected, resolverQuality, actualExt);
  const isQualityChanged = Boolean(actualQuality) && actualQuality !== selected;
  return {
    selectedQuality: selected,
    resolverQuality,
    actualExt,
    actualQuality,
    isQualityChanged,
  };
}

function getResolverName(url) {
  const key = url.split('/').slice(-2, -1)[0] || '';
  return key === 'lx' ? '默认解析服务' : '备用解析服务';
}

function getPlatformName(source) {
  return PLATFORM_NAMES[source] || source || '未知平台';
}

function getSongKey(song) {
  return `${song?.source || ''}_${song?.songmid || song?.hash || song?.copyrightId || ''}`;
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function getImageProxyUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  return `/api/image?url=${encodeURIComponent(url)}`;
}

function isWeChatBrowser() {
  return /MicroMessenger/i.test(navigator.userAgent || '');
}

function isIOSBrowser() {
  const ua = navigator.userAgent || '';
  return /iP(hone|ad|od)/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function toAbsoluteUrl(url) {
  return new URL(url, window.location.href).toString();
}

function buildDownloadPageUrl(downloadUrl, filename) {
  const pageUrl = new URL('/download.html', window.location.href);
  pageUrl.hash = new URLSearchParams({
    url: toAbsoluteUrl(downloadUrl),
    filename: filename || 'music',
  }).toString();
  return pageUrl.toString();
}

function buildHomePageUrl() {
  return new URL('/', window.location.href).toString();
}

async function copyTextToClipboard(text) {
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
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) throw new Error('复制失败');
}

function closeWeChatDownloadModal() {
  document.getElementById('wechatDownloadModal')?.remove();
}

function showWeChatDownloadModal(downloadUrl, filename) {
  const pageUrl = buildDownloadPageUrl(downloadUrl, filename);
  const homeUrl = buildHomePageUrl();
  closeWeChatDownloadModal();

  const overlay = document.createElement('div');
  overlay.id = 'wechatDownloadModal';
  overlay.className = 'modal-overlay active wechat-download-modal';
  overlay.innerHTML = `
    <div class="glass-panel modal-content wechat-download-content">
      <h3 class="modal-title">微信内无法直接下载</h3>
      <div class="modal-song-name" title="${escapeHtml(filename)}">${escapeHtml(filename)}</div>
      <p class="wechat-download-tip">请复制下载页链接到系统浏览器打开，下载页会保留明确的开始下载提示。</p>
      <div class="wechat-download-actions">
        <button class="wechat-download-btn" type="button" data-action="copy-home">复制主页网址</button>
        <button class="wechat-download-btn primary" type="button" data-action="copy-page">复制下载页链接</button>
      </div>
      <button class="modal-close-btn" type="button" data-action="close">关闭</button>
    </div>
  `;

  overlay.addEventListener('click', async (e) => {
    const action = e.target?.getAttribute?.('data-action');
    if (e.target === overlay || action === 'close') {
      closeWeChatDownloadModal();
      return;
    }
    if (action === 'copy-page') {
      try {
        await copyTextToClipboard(pageUrl);
        showToast('下载页链接已复制，请在系统浏览器打开', 'success');
      } catch (err) {
        showToast('复制失败，请使用右上角在浏览器打开', 'error');
      }
      return;
    }
    if (action === 'copy-home') {
      try {
        await copyTextToClipboard(homeUrl);
        showToast('主页网址已复制，请在系统浏览器打开', 'success');
      } catch (err) {
        showToast('复制失败，请使用右上角在浏览器打开', 'error');
      }
      return;
    }
  });

  document.body.appendChild(overlay);
  return pageUrl;
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (!Number.isFinite(size) || size <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function getMimeTypeFromFilename(filename) {
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'flac') return 'audio/flac';
  return 'application/octet-stream';
}

function getDownloadContentLength(res) {
  return Number(res.headers.get('x-content-length') || res.headers.get('content-length') || 0);
}

function triggerBrowserDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function saveBlobFromPage(blob, filename) {
  const type = blob.type || getMimeTypeFromFilename(filename);
  const file = typeof File === 'function' ? new File([blob], filename, { type }) : null;

  try {
    if (file && navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
  }

  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
}

function showInPageSaveAction({ actionEl, blob, filename, statusText }) {
  if (!actionEl) return;

  const button = document.createElement('button');
  button.className = 'queue-save-btn';
  button.type = 'button';
  button.textContent = '保存文件';
  actionEl.innerHTML = '';
  actionEl.appendChild(button);

  button.addEventListener('click', async () => {
    button.disabled = true;
    statusText.innerText = '正在打开保存面板...';
    try {
      await saveBlobFromPage(blob, filename);
      statusText.innerText = '已打开保存面板，请选择存储位置';
      statusText.className = 'queue-status completed';
    } catch (err) {
      if (err?.name === 'AbortError') {
        statusText.innerText = '保存已取消，可重新点击保存文件';
        statusText.className = 'queue-status warning';
      } else {
        statusText.innerText = '保存失败，可重新点击保存文件';
        statusText.className = 'queue-status failed';
        console.warn('[Download] in-page save failed:', err);
      }
    } finally {
      button.disabled = false;
    }
  });
}

async function downloadInsidePage(downloadUrl, filename, ui, song) {
  const { statusText, sizeText, progressFill, pctText, actionEl } = ui;
  statusText.innerText = '正在网页内生成带封面文件...';
  sizeText.innerText = '正在连接...';
  progressFill.style.width = '5%';
  pctText.innerText = '0%';

  const res = await fetch(downloadUrl, { cache: 'no-store' });
  if (!res.ok) {
    const message = (await res.text().catch(() => '')).slice(0, 160);
    throw new Error(message || `HTTP ${res.status}`);
  }

  const total = getDownloadContentLength(res);
  const contentType = res.headers.get('content-type') || getMimeTypeFromFilename(filename);
  let received = 0;
  let lastPct = 0;

  const updateProgress = () => {
    if (total > 0) {
      const pct = Math.max(1, Math.min(99, Math.floor((received / total) * 100)));
      if (pct !== lastPct) {
        lastPct = pct;
        progressFill.style.width = `${pct}%`;
        pctText.innerText = `${pct}%`;
        updateDownloadProgressOnCard(song.songmid, song.source, pct);
      }
      sizeText.innerText = `${formatFileSize(received)} / ${formatFileSize(total)}`;
    } else {
      progressFill.style.width = '35%';
      pctText.innerText = formatFileSize(received) || '接收中';
      sizeText.innerText = '正在接收文件...';
    }
  };

  let blob;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      updateProgress();
    }
    blob = new Blob(chunks, { type: contentType });
  } else {
    blob = await res.blob();
    received = blob.size;
  }

  progressFill.style.width = '100%';
  pctText.innerText = '100%';
  sizeText.innerText = formatFileSize(blob.size) || '已完成';
  statusText.innerText = '文件已在网页内准备好，请点击保存';
  statusText.className = 'queue-status completed';
  updateDownloadProgressOnCard(song.songmid, song.source, 100, false, true);
  showInPageSaveAction({ actionEl, blob, filename, statusText });
}

function buildPicParams(song) {
  return new URLSearchParams({
    source: song.source,
    songmid: song.songmid || '',
    albumId: song.albumId || '',
    hash: song.hash || '',
    name: song.name || '',
    singer: song.singer || '',
    img: song.img || '',
  });
}

function buildLyricParams(song) {
  return new URLSearchParams({
    source: song.source || '',
    songmid: song.songmid || '',
    songId: song.songId || '',
    hash: song.hash || getResolverId(song, '128k') || '',
    copyrightId: song.copyrightId || '',
    name: song.name || '',
    singer: song.singer || '',
    albumName: song.albumName || '',
    interval: song.interval || '',
    lrcUrl: song.lrcUrl || '',
    mrcUrl: song.mrcUrl || '',
    trcUrl: song.trcUrl || '',
  });
}

function applyCoverImage(imgEl, placeholderEl, url, { useProxy = true } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  imgEl.dataset.originalSrc = url;
  imgEl.dataset.proxySrc = useProxy ? '1' : '0';
  imgEl.src = useProxy ? getImageProxyUrl(url) : url;
  imgEl.style.display = 'block';
  placeholderEl.style.display = 'none';
  return true;
}

async function resolveMusicUrl(sandboxInstance, song, quality) {
  const attempts = [
    { label: 'new', musicInfo: toNewMusicInfo(song) },
    { label: 'old', musicInfo: toOldMusicInfo(song) },
  ];
  let lastError = null;

  for (const attempt of attempts) {
    try {
      const resolved = await sandboxInstance.requestUrl(song.source, 'musicUrl', {
        type: quality,
        musicInfo: attempt.musicInfo,
      });
      const payload = getResolvedUrlPayload(resolved);
      if (payload.finalUrl && payload.finalUrl.startsWith('http')) return payload;
    } catch (err) {
      lastError = err;
      console.warn(`[Download] ${attempt.label} musicInfo resolve failed:`, err.message);
    }
  }

  if (lastError) throw lastError;
  throw new Error('解析服务未返回有效链接');
}

function sortSingerName(singer) {
  const separators = /、|&|;|；|\/|,|，|\|/;
  const value = String(singer || '').trim();
  return separators.test(value)
    ? value.split(separators).map(s => s.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)).join('、')
    : value;
}

function filterCompareText(value) {
  return String(value || '')
    .replace(/\s|'|\.|,|，|&|"|、|\(|\)|（|）|`|~|-|<|>|\||\/|\]|\[|!|！/g, '')
    .toLowerCase();
}

function intervalToSeconds(interval) {
  if (typeof interval === 'number') return interval;
  const parts = String(interval || '').split(':').map(n => parseInt(n, 10));
  if (!parts.length || parts.some(Number.isNaN)) return 0;
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}

function rankAlternativeSong(target, candidate, quality) {
  if (!buildQualityMap(candidate)[quality]) return -1;

  const targetName = filterCompareText(target.name);
  const targetSinger = filterCompareText(sortSingerName(target.singer));
  const targetAlbum = filterCompareText(target.albumName);
  const targetInterval = intervalToSeconds(target.interval);
  const candidateName = filterCompareText(candidate.name);
  const candidateSinger = filterCompareText(sortSingerName(candidate.singer));
  const candidateAlbum = filterCompareText(candidate.albumName);
  const candidateInterval = intervalToSeconds(candidate.interval);

  if (!targetName || !candidateName) return -1;
  if (targetInterval && candidateInterval && Math.abs(targetInterval - candidateInterval) >= 5) return -1;

  const nameEquals = candidateName === targetName;
  const nameIncludes = targetName.includes(candidateName) || candidateName.includes(targetName);
  const singerIncludes = targetSinger
    ? targetSinger.includes(candidateSinger) || candidateSinger.includes(targetSinger)
    : true;
  const albumEquals = targetAlbum ? targetAlbum === candidateAlbum : true;

  let score = 0;
  if (nameEquals && singerIncludes) score += 80;
  if (nameEquals) score += 40;
  if (nameIncludes) score += 20;
  if (singerIncludes) score += 20;
  if (albumEquals) score += 10;
  if (targetInterval && candidateInterval) score += 10 - Math.min(10, Math.abs(targetInterval - candidateInterval));

  return score >= 60 ? score : -1;
}

async function fetchSourceSearch(keyword, source, limit = 25) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const url = `/api/search?keyword=${encodeURIComponent(keyword)}&source=${source}&page=1&limit=${limit}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return res.json();
  } catch (err) {
    console.warn(`[Download] fallback search failed for ${source}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSearchParams(page) {
  return {
    keyword: state.currentKeyword,
    source: state.currentSource,
    page,
    limit: state.limit,
  };
}

function getSearchKey(keyword, source) {
  return `${source}\u0000${keyword}`;
}

async function fetchSearchData(params, { signal } = {}) {
  const searchUrl = `/api/search?keyword=${encodeURIComponent(params.keyword)}&source=${params.source}&page=${params.page}&limit=${params.limit}&_=${Date.now()}`;
  const res = await fetch(searchUrl, {
    signal,
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache',
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `Search request failed (${res.status})`);
  }
  return res.json();
}

function createAttemptSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('search timeout')), timeoutMs);
  const abortFromParent = () => controller.abort(parentSignal.reason);

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
    wasParentAborted() {
      return Boolean(parentSignal?.aborted);
    },
  };
}

async function fetchSearchDataWithRetry(params, requestId, controller, { retryEmpty = params.page === 1 } = {}) {
  let lastData = null;
  let lastError = null;
  const maxAttempts = retryEmpty ? SEARCH_EMPTY_RETRY_LIMIT + 1 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (requestId !== state.searchRequestId) return null;
    const attemptSignal = createAttemptSignal(controller.signal, SEARCH_TIMEOUT_MS);
    try {
      const data = await fetchSearchData(params, { signal: attemptSignal.signal });
      if (attemptSignal.wasParentAborted() || requestId !== state.searchRequestId) return null;
      lastData = data;
      const list = data.list || [];
      if (!retryEmpty || list.length || attempt === maxAttempts - 1) return data;
    } catch (err) {
      lastError = err;
      if (attemptSignal.wasParentAborted() || requestId !== state.searchRequestId || attempt === maxAttempts - 1) throw err;
    } finally {
      attemptSignal.dispose();
    }

    if (requestId !== state.searchRequestId) return null;
    el.resultsCount.innerText = `正在搜索... (${attempt + 2}/${maxAttempts})`;
    await delay(SEARCH_RETRY_DELAYS[attempt] || SEARCH_RETRY_DELAYS[SEARCH_RETRY_DELAYS.length - 1]);
  }

  if (lastData) return lastData;
  throw lastError || new Error('Search request failed');
}

async function findAlternativeSongs(song, quality) {
  const keyword = `${song.name || ''} ${song.singer || ''}`.trim();
  if (!keyword) return [];

  const sources = PLATFORM_IDS.filter(source => source !== song.source);
  const results = await Promise.all(sources.map(source => fetchSourceSearch(keyword, source)));
  const ranked = [];
  const seen = new Set();

  results.forEach((data) => {
    for (const candidate of data?.list || []) {
      const score = rankAlternativeSong(song, candidate, quality);
      if (score < 0) continue;
      const key = `${candidate.source}_${candidate.songmid}_${candidate.hash || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ranked.push({ ...candidate, _fallbackScore: score });
    }
  });

  return ranked.sort((a, b) => b._fallbackScore - a._fallbackScore).map(({ _fallbackScore, ...candidate }) => candidate);
}

async function resolveWithScripts(song, quality, statusText, validateResolution) {
  const urlsToTry = [state.scriptUrl, ...SOURCE_URLS.filter(u => u !== state.scriptUrl)];
  let lastError = null;

  for (const url of urlsToTry) {
    try {
      const sourceName = getResolverName(url);
      statusText.innerText = `正在用${sourceName}解析 ${getPlatformName(song.source)}...`;
      console.log(`[Download] Trying resolution with resolver: ${url}`);

      const sandboxInstance = await withTimeout(
        getOrLoadSandbox(url),
        RESOLVE_TIMEOUT_MS,
        `${sourceName}加载超时`
      );
      const { finalUrl, finalHeaders, finalType } = await withTimeout(
        resolveMusicUrl(sandboxInstance, song, quality),
        RESOLVE_TIMEOUT_MS,
        `${sourceName}解析超时`
      );
      if (finalUrl && finalUrl.startsWith('http')) {
        const resolution = {
          audioUrl: finalUrl,
          audioHeaders: finalHeaders,
          resolvedQuality: finalType,
          successfulUrl: url,
          resolvedSong: song,
        };
        if (validateResolution) return await validateResolution(resolution, song);
        return resolution;
      }
    } catch (err) {
      lastError = err;
      console.warn(`[Download] Resolver ${url} failed:`, err.message);
    }
  }

  if (lastError) throw lastError;
  throw new Error('解析服务未返回有效链接');
}

async function buildDownloadUrlFromResolution(resolution, quality, filename, song, statusText) {
  const sourceName = getResolverName(resolution.successfulUrl);
  statusText.innerText = `[${sourceName}] 正在准备下载...`;

  const mediaInfo = getDownloadMediaInfo('', quality, resolution.resolvedQuality, resolution.audioUrl);
  const finalExt = mediaInfo.actualExt || getDefaultExtensionForQuality(mediaInfo.actualQuality || quality);
  const finalFilename = buildSongFilename(song, finalExt);
  const metadataSong = resolution.resolvedSong || song;
  const coverUrl = await getBestCoverUrl(metadataSong);
  const params = new URLSearchParams({
    url: resolution.audioUrl,
    filename: finalFilename,
    headers: JSON.stringify(resolution.audioHeaders || {}),
    title: metadataSong.name || song.name || '',
    artist: metadataSong.singer || song.singer || '',
    album: metadataSong.albumName || song.albumName || '',
    cover: coverUrl || '',
    ext: finalExt,
  });

  return {
    downloadUrl: `/api/download?${params.toString()}`,
    resolution,
    mediaInfo,
    finalFilename,
  };
}

async function createDownloadLink(song, quality, filename, statusText) {
  return resolveWithScripts(song, quality, statusText, (resolution) => {
    return buildDownloadUrlFromResolution(resolution, quality, filename, song, statusText);
  });
}

async function createDownloadLinkWithFallback(song, quality, filename, statusText) {
  let lastError = null;
  try {
    return await createDownloadLink(song, quality, filename, statusText);
  } catch (err) {
    lastError = err;
    console.warn('[Download] original source failed:', err.message);
  }

  statusText.innerText = '原平台不可用，正在匹配其它平台...';
  const alternatives = await findAlternativeSongs(song, quality);
  if (!alternatives.length) throw lastError || new Error('没有找到可用的备用平台');

  for (const candidate of alternatives) {
    try {
      statusText.innerText = `正在尝试 ${getPlatformName(candidate.source)}...`;
      return await createDownloadLink(candidate, quality, filename, statusText);
    } catch (err) {
      lastError = err;
      console.warn(`[Download] fallback ${candidate.source} failed:`, err.message);
    }
  }

  throw lastError || new Error('所有平台均解析失败');
}

async function getBestCoverUrl(song) {
  if (song.img && /^https?:\/\//i.test(song.img)) {
    return song.img;
  }

  try {
    const params = buildPicParams(song);
    const res = await fetch(`/api/pic?${params.toString()}`, { cache: 'force-cache' });
    if (!res.ok) return '';
    const data = await res.json();
    if (data.img && /^https?:\/\//i.test(data.img)) {
      song.img = data.img;
      return data.img;
    }
  } catch (err) {
    console.warn('[Download] cover lookup failed:', err.message);
  }
  return song.img && /^https?:\/\//i.test(song.img) ? song.img : '';
}

async function getOrLoadSandbox(url) {
  if (loadedSandboxes[url]) return loadedSandboxes[url];
  
  let scriptContent = '';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error();
    scriptContent = await res.text();
  } catch (e) {
    const proxyRes = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, method: 'GET' }),
    });
    if (!proxyRes.ok) throw new Error(`HTTP ${proxyRes.status} from proxy`);
    scriptContent = await proxyRes.text();
  }
  
  const name = getResolverName(url);
  const sandbox = await initResolverSandbox(scriptContent, {
    name: name,
    version: '4',
    description: '音乐解析服务',
  });
  
  loadedSandboxes[url] = sandbox;
  return sandbox;
}

// DOM Elements
const el = {
  searchInput: document.getElementById('searchInput'),
  clearSearchBtn: document.getElementById('clearSearchBtn'),
  searchBtn: document.getElementById('searchBtn'),
  customSelect: document.getElementById('customSelect'),
  selectedPlatform: document.getElementById('selectedPlatform'),
  songList: document.getElementById('songList'),
  resultsCount: document.getElementById('resultsCount'),
  
  scriptInput: document.getElementById('scriptInput'),
  saveScriptBtn: document.getElementById('saveScriptBtn'),
  sourceStatusDot: document.getElementById('sourceStatusDot'),
  sourceStatusText: document.getElementById('sourceStatusText'),
  
  queueList: document.getElementById('queueList'),
  
  qualityModal: document.getElementById('qualityModal'),
  modalSongName: document.getElementById('modalSongName'),
  modalCloseBtn: document.getElementById('modalCloseBtn'),
  qualityBtns: document.querySelectorAll('.quality-btn'),
  
  toastContainer: document.getElementById('toastContainer'),
};

let songToDownload = null;

// Initialize Application
async function init() {
  // Load saved script URL from localStorage if any
  const legacyStorageKey = ['l', 'x_script_url'].join('');
  const savedUrl = localStorage.getItem('resolver_script_url') || localStorage.getItem(legacyStorageKey);
  if (savedUrl) {
    state.scriptUrl = savedUrl;
    localStorage.setItem('resolver_script_url', savedUrl);
    localStorage.removeItem(legacyStorageKey);
  }
  el.scriptInput.value = state.scriptUrl;

  // Setup Event Listeners first so search/input elements are immediately active
  setupEventListeners();

  // Load Custom Music Source in background
  await loadMusicSource(state.scriptUrl);
}

// Setup Event Listeners
function setupEventListeners() {
  document.addEventListener('pointerup', blurInteractiveTarget, true);
  document.addEventListener('click', blurInteractiveTarget, true);

  // Search actions
  el.searchBtn.addEventListener('click', performSearch);
  el.searchInput.addEventListener('input', updateClearSearchButton);
  el.searchInput.addEventListener('compositionstart', () => {
    state.isInputComposing = true;
  });
  el.searchInput.addEventListener('compositionend', () => {
    state.isInputComposing = false;
  });
  el.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && !state.isInputComposing) performSearch();
  });
  el.clearSearchBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
  });
  el.clearSearchBtn.addEventListener('click', clearSearchInput);
  updateClearSearchButton();

  const selectTrigger = el.customSelect.querySelector('.custom-select-trigger');

  // Toggle custom dropdown menu
  selectTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    el.customSelect.classList.toggle('open');
  });

  // Handle custom option selection
  const options = el.customSelect.querySelectorAll('.custom-option');
  const selectPlatformOption = (option) => {
    const value = option.getAttribute('data-value');
    const text = option.innerText;
    if (!value || value === state.currentSource) {
      el.customSelect.classList.remove('open');
      return;
    }

    state.currentSource = value;
    el.selectedPlatform.innerText = text;

    options.forEach(opt => opt.classList.remove('active'));
    option.classList.add('active');

    el.customSelect.classList.remove('open');

    if (el.searchInput.value.trim()) {
      performSearch();
    }
  };

  options.forEach(option => {
    const handleOptionSelect = (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectPlatformOption(option);
    };

    option.addEventListener('pointerdown', handleOptionSelect);
    option.addEventListener('click', handleOptionSelect);
  });

  // Close custom dropdown when clicking outside
  document.addEventListener('click', () => {
    el.customSelect.classList.remove('open');
  });

  const maybeLoadMore = () => maybeLoadNextPage();

  // Intersection Observer for waterfall lazy loading (infinite scroll)
  const scrollAnchor = document.getElementById('scrollAnchor');
  if (scrollAnchor) {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        maybeLoadMore();
      }
    }, {
      rootMargin: '150px', // Trigger when anchor is within 150px of the viewport bottom
    });
    observer.observe(scrollAnchor);
  }

  // iOS Safari can miss 1px IntersectionObserver anchors while the browser chrome
  // collapses/expands, so keep a scroll-position fallback for infinite loading.
  setupScrollLoadFallback(maybeLoadMore);

  // Script load button
  el.saveScriptBtn.addEventListener('click', async () => {
    const url = el.scriptInput.value.trim();
    if (url) {
      state.scriptUrl = url;
      localStorage.setItem('resolver_script_url', url);
      await loadMusicSource(url);
    }
  });

  // Preset source buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.getAttribute('data-url');
      el.scriptInput.value = url;
      state.scriptUrl = url;
      localStorage.setItem('resolver_script_url', url);
      await loadMusicSource(url);
    });
  });

  // Quality modal close
  el.modalCloseBtn.addEventListener('click', () => {
    el.qualityModal.classList.remove('active');
    songToDownload = null;
  });

  // Select quality download
  el.qualityBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const quality = btn.getAttribute('data-quality');
      if (songToDownload) {
        startDownloadTask(songToDownload, quality);
      }
      el.qualityModal.classList.remove('active');
      songToDownload = null;
    });
  });
}

function updateClearSearchButton() {
  el.searchInput.parentElement?.classList.toggle('has-value', Boolean(el.searchInput.value));
}

function renderInitialEmptyState() {
  el.songList.innerHTML = `
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <p>探索你喜爱的海量高品质音乐</p>
      <p style="font-size: 0.8rem; opacity: 0.8;">输入关键词并选择平台以开始搜索</p>
    </div>
  `;
  el.resultsCount.innerText = '共 0 首歌曲';
}

function clearSearchInput() {
  if (state.searchAbortController) {
    state.searchAbortController.abort();
    state.searchAbortController = null;
  }
  state.searchRequestId += 1;
  state.currentKeyword = '';
  state.currentResults = [];
  state.currentPage = 1;
  state.totalCount = 0;
  state.isLoading = false;
  state.activeSearchKey = '';
  state.loadingMode = '';
  el.searchInput.value = '';
  updateClearSearchButton();
  showBottomLoadingIndicator(false);
  renderInitialEmptyState();
  requestAnimationFrame(() => {
    el.searchInput.focus({ preventScroll: true });
  });
}

function blurInteractiveTarget(e) {
  if (e.target?.closest?.('#clearSearchBtn')) return;
  const target = e.target?.closest?.('button, .custom-select-trigger, .custom-option, .song-btn, .quality-btn, .download-progress-wrapper, .modal-close-btn');
  if (!target) return;
  requestAnimationFrame(() => {
    target.blur?.();
    if (document.activeElement instanceof HTMLElement && target.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  });
}

function canLoadNextPage() {
  if (state.isLoading) return false;
  if (!state.currentKeyword) return false;
  if (state.currentResults.length === 0) return false;
  if (state.currentResults.length >= state.totalCount) return false;
  return true;
}

function maybeLoadNextPage() {
  if (!canLoadNextPage()) return;
  loadNextPage();
}

function setupScrollLoadFallback(onNearBottom) {
  const threshold = 260;
  let ticking = false;

  const getScrollTop = () => (
    window.scrollY ||
    document.documentElement.scrollTop ||
    document.body.scrollTop ||
    0
  );

  const getScrollHeight = () => Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
  );

  const checkNearBottom = () => {
    ticking = false;
    const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
    const distanceToBottom = getScrollHeight() - (getScrollTop() + viewportHeight);
    if (distanceToBottom <= threshold) {
      onNearBottom();
    }
  };

  const scheduleCheck = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(checkNearBottom);
  };

  window.addEventListener('scroll', scheduleCheck, { passive: true });
  window.addEventListener('touchend', scheduleCheck, { passive: true });
  window.addEventListener('resize', scheduleCheck);
  window.visualViewport?.addEventListener('resize', scheduleCheck);
}

// Load Custom Source Script
async function loadMusicSource(url) {
  el.sourceStatusDot.className = 'status-dot';
  el.sourceStatusText.innerText = '正在加载解析引擎...';

  try {
    console.log(`[App] Loading script: ${url}`);
    
    // Fetch directly, if fails, proxy via Cloudflare Pages Function
    let scriptContent = '';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      scriptContent = await res.text();
    } catch (e) {
      console.warn('[App] Direct fetch failed, trying proxy...');
      const proxyRes = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, method: 'GET' }),
      });
      if (!proxyRes.ok) throw new Error(`HTTP ${proxyRes.status} from proxy`);
      scriptContent = await proxyRes.text();
    }

    // Initialize Sandbox
    state.sandbox = await getOrLoadSandbox(url);

    el.sourceStatusDot.classList.add('active');
    el.sourceStatusText.innerText = '解析引擎已就绪';
  } catch (err) {
    console.error('[App Init Error]', err);
    el.sourceStatusDot.classList.remove('active');
    el.sourceStatusText.innerText = '解析引擎就绪失败';
    showToast('服务引擎启动失败: ' + err.message, 'error');
  }
}

// Perform Music Search (New search keyword entrypoint)
async function performSearch() {
  const keyword = el.searchInput.value.trim();
  if (!keyword) return;

  const searchKey = getSearchKey(keyword, state.currentSource);
  if (state.isLoading && state.loadingMode === 'search' && state.activeSearchKey === searchKey) {
    return;
  }

  if (state.searchAbortController) {
    state.searchAbortController.abort();
  }
  state.searchRequestId += 1;
  state.currentPage = 1;
  state.currentKeyword = keyword;
  state.currentResults = []; // Clear previous batch
  state.totalCount = 0;
  state.activeSearchKey = searchKey;
  showBottomLoadingIndicator(false);
  const params = getSearchParams(state.currentPage);
  await fetchPage(params, state.searchRequestId);
}

// Fetch Search Results for Specific Page (Waterfall Initial Page)
async function fetchPage(params, requestId = state.searchRequestId) {
  state.isLoading = true;
  state.loadingMode = 'search';
  const controller = new AbortController();
  state.searchAbortController = controller;
  el.songList.innerHTML = `
    <div class="empty-state">
      <div class="loading-spinner" style="width:30px; height:30px;"></div>
      <p>正在搜寻中...</p>
    </div>
  `;
  el.resultsCount.innerText = '正在搜索...';

  try {
    const data = await fetchSearchDataWithRetry(params, requestId, controller, { retryEmpty: true });
    if (!data) return;
    if (requestId !== state.searchRequestId) return;
    state.currentResults = data.list || [];
    
    if (params.page === 1) {
      state.totalCount = data.total || 0;
    }
    
    renderSearchResults();
  } catch (err) {
    if (err.name === 'AbortError' || requestId !== state.searchRequestId) return;
    console.error('[Search Error]', err);
    showToast('搜索失败，请重试', 'error');
    el.songList.innerHTML = `
      <div class="empty-state">
        <p>搜索失败了，请重试</p>
      </div>
    `;
    el.resultsCount.innerText = '共 0 首歌曲';
  } finally {
    if (requestId === state.searchRequestId) {
      state.isLoading = false;
      state.loadingMode = '';
      if (state.searchAbortController === controller) {
        state.searchAbortController = null;
      }
    }
  }
}

// Fetch Next Page (Waterfall Lazy Load Appender)
async function loadNextPage() {
  const requestId = state.searchRequestId;
  state.isLoading = true;
  const nextPage = state.currentPage + 1;
  const params = getSearchParams(nextPage);
  const controller = new AbortController();
  state.searchAbortController = controller;
  state.loadingMode = 'page';
  
  showBottomLoadingIndicator(true);

  let success = false;
  let isAbortError = false;

  try {
    const data = await fetchSearchDataWithRetry(params, requestId, controller, { retryEmpty: false });
    if (!data) return;
    if (requestId !== state.searchRequestId) return;
    const newSongs = data.list || [];
    
    if (newSongs.length === 0) {
      state.totalCount = state.currentResults.length; // Lock at current
    } else {
      state.currentPage = nextPage;
      state.currentResults = [...state.currentResults, ...newSongs];
      appendSearchResults(newSongs);
    }
    success = true;
  } catch (err) {
    if (requestId !== state.searchRequestId) return;
    if (err.name === 'AbortError') {
      isAbortError = true;
      return;
    }
    console.error('[Lazy Load Error]', err);
    showToast('获取更多歌曲失败', 'error');
  } finally {
    if (requestId === state.searchRequestId) {
      state.isLoading = false;
      state.loadingMode = '';
      if (state.searchAbortController === controller) {
        state.searchAbortController = null;
      }
      if (success) {
        showBottomLoadingIndicator(false);
      } else if (!isAbortError) {
        showBottomErrorIndicator();
      } else {
        showBottomLoadingIndicator(false);
      }
    }
  }
}

// Show/Hide bottom loading spinner
function showBottomLoadingIndicator(show) {
  let indicator = document.getElementById('bottomLoader');
  if (show) {
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'bottomLoader';
      indicator.className = 'bottom-loader-indicator';
      el.songList.after(indicator);
    }
    indicator.innerHTML = `
      <div class="loading-spinner" style="width:20px; height:20px; margin: 0 auto;"></div>
      <span style="font-size:0.8rem; color:var(--text-muted); margin-top:5px;">正在加载更多...</span>
    `;
  } else {
    if (indicator) {
      indicator.remove();
    }
  }
}

// Show error retry layout at the bottom
function showBottomErrorIndicator() {
  let indicator = document.getElementById('bottomLoader');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'bottomLoader';
    indicator.className = 'bottom-loader-indicator';
    el.songList.after(indicator);
  }
  indicator.innerHTML = `
    <span class="bottom-loader-retry-btn" style="font-size: 0.8rem; color: var(--primary-accent); cursor: pointer; text-decoration: underline; font-weight: 500;">加载失败，点击重试</span>
  `;
  
  const retryBtn = indicator.querySelector('.bottom-loader-retry-btn');
  retryBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    loadNextPage();
  });
}

// Render Search Results
function renderSearchResults() {
  const list = state.currentResults;
  el.resultsCount.innerText = `共 ${state.totalCount} 首歌曲`;

  if (list.length === 0) {
    el.songList.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p>未找到相关歌曲</p>
      </div>
    `;
    return;
  }

  el.songList.innerHTML = '';
  appendSearchResults(list);
}

// Append new search results items to DOM
function appendSearchResults(songs) {
  const startIndex = state.currentResults.length - songs.length;
  
  songs.forEach((song, idx) => {
    const globalIdx = startIndex + idx;
    const item = document.createElement('div');
    item.className = 'song-item';
    item.id = `song-item-${globalIdx}`;
    const songKey = getSongKey(song);

    const hasCover = Boolean(song.img && /^https?:\/\//i.test(song.img));

    item.innerHTML = `
      <div class="song-cover-wrapper">
        <div class="song-cover-placeholder" style="${hasCover ? 'display:none;' : ''}">♪</div>
        <img class="song-cover" alt="Cover" style="${hasCover ? 'display:block;' : 'display:none;'}">
      </div>
      <div class="song-info">
        <div class="song-title">${escapeHtml(song.name)}</div>
        <div class="song-artist">${escapeHtml(song.singer)}</div>
        <div class="player-progress-container">
          <span class="player-current-time">00:00</span>
          <input type="range" class="player-progress-slider" min="0" max="100" value="0">
          <span class="player-total-time">${song.interval || '00:00'}</span>
        </div>
      </div>
      <div class="player-lyric-container">
        <div class="player-lyric-line active"></div>
      </div>
      <div class="song-album">${escapeHtml(song.albumName || '未知专辑')}</div>
      <div class="song-duration">${song.interval || '00:00'}</div>
      <div class="song-actions">
        <div class="play-progress-wrapper" data-songmid="${song.songmid}" data-source="${song.source}">
          <svg class="progress-ring" width="36" height="36">
            <circle class="progress-ring__track" stroke-dasharray="103.67" stroke-width="2.5" fill="transparent" r="16.5" cx="18" cy="18"/>
            <circle class="progress-ring__circle" stroke-dasharray="103.67" stroke-width="2.5" fill="transparent" r="16.5" cx="18" cy="18"/>
          </svg>
          <button class="song-btn play-btn" title="播放">
            <svg class="play-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            <svg class="pause-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display: none;">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
            </svg>
          </button>
        </div>
        <div class="download-progress-wrapper" data-songmid="${song.songmid}" data-source="${song.source}">
          <svg class="progress-ring" width="36" height="36">
            <circle class="progress-ring__track" stroke-dasharray="103.67" stroke-width="2.5" fill="transparent" r="16.5" cx="18" cy="18"/>
            <circle class="progress-ring__circle" stroke-dasharray="103.67" stroke-width="2.5" fill="transparent" r="16.5" cx="18" cy="18"/>
          </svg>
          <button class="song-btn download-btn" title="下载">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    item.querySelector('.download-progress-wrapper').addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.currentTarget.classList.contains('downloading')) return;
      openDownloadModal(song);
    });

    const setSongItemExpanded = ({ toggle = false } = {}) => {
      document.querySelectorAll('.song-item.expanded').forEach(el => {
        if (el !== item) {
          el.classList.remove('expanded');
        }
      });

      const isExpanding = !item.classList.contains('expanded');
      if (toggle) {
        item.classList.toggle('expanded');
      } else {
        item.classList.add('expanded');
      }

      if (isExpanding || item.classList.contains('expanded')) {
        if (activeSongId === songKey) {
          activePlayBtn = item.querySelector('.play-btn');
          activeProgressSlider = item.querySelector('.player-progress-slider');
          activeCurrentTimeText = item.querySelector('.player-current-time');
          activeTotalTimeText = item.querySelector('.player-total-time');
          activeLyricContainer = item.querySelector('.player-lyric-container');
          activeLyricLineEl = item.querySelector('.player-lyric-line');

          if (!audio.paused) {
            activePlayBtn.querySelector('.play-icon').style.display = 'none';
            activePlayBtn.querySelector('.pause-icon').style.display = 'block';
          } else {
            activePlayBtn.querySelector('.play-icon').style.display = 'block';
            activePlayBtn.querySelector('.pause-icon').style.display = 'none';
          }
          if (audio.duration) {
            activeTotalTimeText.innerText = formatTime(audio.duration);
            activeProgressSlider.value = (audio.currentTime / audio.duration) * 100 || 0;
          }
          triggerLyricScrollSync();
        } else {
          item.querySelector('.player-lyric-line').innerText = '';
        }
      }
    };

    // Expand / Collapse card click handler
    item.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('.download-progress-wrapper') || e.target.closest('.play-progress-wrapper') || e.target.closest('.player-progress-container') || e.target.closest('.player-lyric-container')) {
        return;
      }

      setSongItemExpanded({ toggle: true });
    });

    // Play Button click handler
    const playWrapper = item.querySelector('.play-progress-wrapper');
    playWrapper.addEventListener('click', (e) => {
      e.stopPropagation();
      if (playWrapper.classList.contains('loading')) return;
      setSongItemExpanded();
      togglePlay(song, item);
    });

    // Seek range input handlers
    const slider = item.querySelector('.player-progress-slider');
    const currentTimeText = item.querySelector('.player-current-time');

    const seekAudioFromSlider = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      const seekTime = (Number(slider.value) / 100) * audio.duration;
      audio.currentTime = seekTime;
      currentTimeText.innerText = formatTime(seekTime);
      if (activeSongId === songKey) {
        triggerLyricScrollSync();
      }
    };

    slider.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      isUserSeeking = true;
    });

    slider.addEventListener('input', (e) => {
      e.stopPropagation();
      isUserSeeking = true;
      seekAudioFromSlider();
    });

    slider.addEventListener('change', (e) => {
      e.stopPropagation();
      seekAudioFromSlider();
      isUserSeeking = false;
    });

    slider.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      seekAudioFromSlider();
      isUserSeeking = false;
    });

    slider.addEventListener('pointercancel', () => {
      isUserSeeking = false;
    });

    slider.addEventListener('touchend', (e) => {
      e.stopPropagation();
      seekAudioFromSlider();
      isUserSeeking = false;
    });

    slider.addEventListener('click', (e) => e.stopPropagation());

    el.songList.appendChild(item);

    const imgEl = item.querySelector('.song-cover');
    const placeholderEl = item.querySelector('.song-cover-placeholder');
    imgEl.addEventListener('error', () => {
      if (imgEl.dataset.proxySrc === '1' && imgEl.dataset.originalSrc) {
        applyCoverImage(imgEl, placeholderEl, imgEl.dataset.originalSrc, { useProxy: false });
        return;
      }
      imgEl.style.display = 'none';
      placeholderEl.style.display = 'flex';
      if (imgEl.dataset.coverLookupTried === '1') return;
      imgEl.dataset.coverLookupTried = '1';
      lazyLoadCover(song, imgEl, placeholderEl, globalIdx);
    });

    if (hasCover) {
      applyCoverImage(imgEl, placeholderEl, song.img);
    } else {
      lazyLoadCover(song, imgEl, placeholderEl, globalIdx);
    }
  });
}

async function lazyLoadCover(song, imgEl, placeholderEl, idx) {
  try {
    const params = buildPicParams(song);
    const res = await fetch(`/api/pic?${params.toString()}`, { cache: 'force-cache' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.img && /^https?:\/\//i.test(data.img)) {
      applyCoverImage(imgEl, placeholderEl, data.img);
      state.currentResults[idx].img = data.img;
      song.img = data.img;
    }
  } catch (err) {
    // Fail silently
  }
}

// Download Tasks
function openDownloadModal(song) {
  songToDownload = song;
  el.modalSongName.innerText = `${song.singer} - ${song.name}`;
  
  // Show/hide quality options based on actual song capabilities and active sandbox support
  const songQualities = (song.types || []).map(t => t.type);
  const activeSources = state.sandbox?.sources || {};
  const scriptSupportedQualities = activeSources[song.source]?.qualitys || [];
  
  // Intersect them after the resolver is loaded; before that, keep the song's own qualities selectable.
  const supported = scriptSupportedQualities.length
    ? songQualities.filter(q => scriptSupportedQualities.includes(q))
    : songQualities;
  
  el.qualityBtns.forEach(btn => {
    const q = btn.getAttribute('data-quality');
    const sizeEl = btn.querySelector('.quality-size');
    if (supported.includes(q)) {
      btn.style.display = 'flex';
      const typeInfo = song.types.find(t => t.type === q);
      if (typeInfo && sizeEl) {
        sizeEl.innerText = `约 ${typeInfo.size}`;
      }
    } else {
      btn.style.display = 'none';
    }
  });
  
  el.qualityModal.classList.add('active');
}

async function startDownloadTask(song, quality) {
  const selectedQuality = normalizeQualityType(quality) || quality;
  const defaultExt = getDefaultExtensionForQuality(selectedQuality);
  const displayFilename = buildSongFilename(song, defaultExt);
  const taskId = Date.now().toString();

  // Create UI list item
  const taskEl = document.createElement('div');
  taskEl.className = 'queue-item';
  taskEl.id = `task-${taskId}`;
  taskEl.innerHTML = `
    <div class="queue-info">
      <div class="queue-name" title="${escapeHtml(displayFilename)}">${escapeHtml(displayFilename)}</div>
      <div class="queue-size" id="task-size-${taskId}">解析中...</div>
    </div>
    <div class="queue-progress-bar-bg">
      <div class="queue-progress-bar-fill" id="task-progress-${taskId}"></div>
    </div>
    <div class="queue-footer">
      <div class="queue-status" id="task-status-${taskId}">等待获取链接</div>
      <div class="queue-percentage" id="task-pct-${taskId}">0%</div>
    </div>
    <div class="queue-action" id="task-action-${taskId}"></div>
  `;

  // Insert to the top of queue
  const firstChild = el.queueList.firstChild;
  if (firstChild && el.queueList.querySelector('.empty-state')) {
    el.queueList.innerHTML = '';
  }
  el.queueList.insertBefore(taskEl, el.queueList.firstChild);

  showToast(`开始下载任务: ${song.name}`, 'info');
  updateDownloadProgressOnCard(song.songmid, song.source, 0);

  try {
    const statusText = document.getElementById(`task-status-${taskId}`);
    const sizeText = document.getElementById(`task-size-${taskId}`);
    const progressFill = document.getElementById(`task-progress-${taskId}`);
    const pctText = document.getElementById(`task-pct-${taskId}`);
    const actionEl = document.getElementById(`task-action-${taskId}`);

    const useInPageDownload = isIOSBrowser() && !isWeChatBrowser();
    statusText.innerText = useInPageDownload ? '正在解析页内下载链接...' : '正在解析链接...';
    updateDownloadProgressOnCard(song.songmid, song.source, 5);

    const { downloadUrl, resolution, mediaInfo, finalFilename } = await createDownloadLinkWithFallback(song, quality, displayFilename, statusText);
    const resolvedSong = resolution.resolvedSong;
    const usedFallback = resolvedSong.source !== song.source || resolvedSong.songmid !== song.songmid;
    const actualQuality = mediaInfo.actualQuality;
    const isQualityChanged = Boolean(actualQuality) && actualQuality !== selectedQuality;

    const nameEl = taskEl.querySelector('.queue-name');
    if (nameEl) {
      nameEl.innerText = finalFilename;
      nameEl.title = finalFilename;
    }

    let qualityWarnText = '';
    if (isQualityChanged) {
      qualityWarnText = ` (实际下载为 ${formatQualityLabel(actualQuality)})`;
    }

    if (isWeChatBrowser()) {
      showWeChatDownloadModal(downloadUrl, finalFilename);
      statusText.innerText = '微信内无法直接下载' + qualityWarnText;
      statusText.className = 'queue-status warning';
      sizeText.innerText = '请复制链接或在浏览器打开';
      progressFill.style.width = '100%';
      pctText.innerText = '待处理';
      updateDownloadProgressOnCard(song.songmid, song.source, 100, false, true);
      showToast('微信内无法直接下载，请在系统浏览器打开', 'warning');
      return;
    }

    if (useInPageDownload) {
      await downloadInsidePage(downloadUrl, finalFilename, { statusText, sizeText, progressFill, pctText, actionEl }, song);
      if (isQualityChanged) {
        showToast(`文件已生成: ${song.name} (实际下载为 ${formatQualityLabel(actualQuality)})`, 'warning');
      } else if (usedFallback) {
        showToast(`文件已生成: ${song.name} (已自动切换到${getPlatformName(resolvedSong.source)})`, 'success');
      } else {
        showToast('文件已生成，点击保存文件即可存到手机', 'success');
      }
      return;
    }

    triggerBrowserDownload(downloadUrl, finalFilename);

    statusText.innerText = '已创建浏览器下载任务' + qualityWarnText;
    statusText.className = 'queue-status completed';
    sizeText.innerText = '请在浏览器下载栏查看进度';
    progressFill.style.width = '100%';
    pctText.innerText = '已创建';
    updateDownloadProgressOnCard(song.songmid, song.source, 100, false, true);
    
    if (isQualityChanged) {
      showToast(`已创建下载任务: ${song.name} (实际下载为 ${formatQualityLabel(actualQuality)})`, 'warning');
    } else if (usedFallback) {
      showToast(`已创建下载任务: ${song.name} (已自动切换到${getPlatformName(resolvedSong.source)})`, 'success');
    } else {
      showToast(`已创建下载任务: ${song.name}`, 'success');
    }

  } catch (err) {
    console.error('[Download Task Error]', err);
    showToast(`下载失败: ${song.name} (${err.message})`, 'error');
    updateDownloadProgressOnCard(song.songmid, song.source, 0, true);
    
    const statusText = document.getElementById(`task-status-${taskId}`);
    if (statusText) {
      statusText.innerText = '下载失败: ' + err.message;
      statusText.className = 'queue-status failed';
    }
  }
}

// HTML Escaper helper
function escapeHtml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerText = message;
  
  el.toastContainer.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => {
      el.toastContainer.removeChild(toast);
    }, 300);
  }, 3500);
}

// Update Song Card Download Progress Ring
function updateDownloadProgressOnCard(songmid, source, pct, isError = false, isSuccess = false) {
  const wrappers = document.querySelectorAll(`.download-progress-wrapper[data-songmid="${songmid}"][data-source="${source}"]`);
  wrappers.forEach(wrapper => {
    const ring = wrapper.querySelector('.progress-ring');
    const circle = wrapper.querySelector('.progress-ring__circle');
    if (!ring || !circle) return;

    if (isError) {
      ring.classList.remove('active');
      circle.style.stroke = '#ef4444'; // Red color
      circle.style.strokeDashoffset = '0';
      wrapper.classList.remove('downloading');
      setTimeout(() => {
        circle.style.stroke = 'var(--primary-accent)';
        circle.style.strokeDashoffset = '103.67';
      }, 2000);
      return;
    }

    if (isSuccess) {
      circle.style.stroke = '#22c55e'; // Green color
      circle.style.strokeDashoffset = '0';
      wrapper.classList.remove('downloading');
      setTimeout(() => {
        ring.classList.remove('active');
        circle.style.stroke = 'var(--primary-accent)';
        circle.style.strokeDashoffset = '103.67';
      }, 1500);
      return;
    }

    // Normal downloading
    ring.classList.add('active');
    wrapper.classList.add('downloading');
    const circumference = 103.67;
    const offset = circumference - (pct / 100) * circumference;
    circle.style.stroke = 'var(--primary-accent)';
    circle.style.strokeDashoffset = offset;
  });
}

// Global Audio Player Setup
const audio = new Audio();
let activeSongId = null;
let loadingSongId = null;
let activePlayBtn = null;
let activeProgressSlider = null;
let activeCurrentTimeText = null;
let activeTotalTimeText = null;
let activeLyricContainer = null;
let activeLyricLineEl = null;
let activeLyrics = [];
let lastLyricIndex = -1;
let isUserSeeking = false;

audio.addEventListener('timeupdate', () => {
  if (activeSongId && activeProgressSlider && activeCurrentTimeText && !isUserSeeking) {
    const pct = (audio.currentTime / audio.duration) * 100 || 0;
    activeProgressSlider.value = pct;
    activeCurrentTimeText.innerText = formatTime(audio.currentTime);
  }

  // Sync single line lyric
  if (activeSongId && activeLyrics.length > 0 && activeLyricLineEl) {
    const currentTime = audio.currentTime;
    let index = activeLyrics.findIndex((line) => line.time > currentTime);
    if (index === -1) {
      index = activeLyrics.length - 1;
    } else {
      index = Math.max(0, index - 1);
    }
    
    if (index !== lastLyricIndex) {
      lastLyricIndex = index;
      activeLyricLineEl.innerText = activeLyrics[index].text || ' ';
    }
  }
});

audio.addEventListener('loadedmetadata', () => {
  if (activeSongId && activeTotalTimeText) {
    activeTotalTimeText.innerText = formatTime(audio.duration);
  }
});

audio.addEventListener('playing', () => {
  if (activePlayBtn) {
    activePlayBtn.querySelector('.play-icon').style.display = 'none';
    activePlayBtn.querySelector('.pause-icon').style.display = 'block';
    const wrapper = activePlayBtn.closest('.play-progress-wrapper');
    if (wrapper) {
      wrapper.classList.remove('loading');
    }
  }
});

audio.addEventListener('pause', () => {
  if (activePlayBtn) {
    activePlayBtn.querySelector('.play-icon').style.display = 'block';
    activePlayBtn.querySelector('.pause-icon').style.display = 'none';
    const wrapper = activePlayBtn.closest('.play-progress-wrapper');
    if (wrapper) {
      wrapper.classList.remove('loading');
    }
  }
});

audio.addEventListener('ended', () => {
  if (activePlayBtn) {
    activePlayBtn.querySelector('.play-icon').style.display = 'block';
    activePlayBtn.querySelector('.pause-icon').style.display = 'none';
    const wrapper = activePlayBtn.closest('.play-progress-wrapper');
    if (wrapper) {
      wrapper.classList.remove('loading');
    }
  }
  if (activeProgressSlider) activeProgressSlider.value = 0;
  if (activeCurrentTimeText) activeCurrentTimeText.innerText = '00:00';
});

audio.addEventListener('error', () => {
  if (activeSongId) {
    console.error('[Audio Error]', audio.error);
    showToast('播放出错，无法加载音频流', 'error');
    resetActiveSongUI();
  }
});

function formatTime(seconds) {
  if (isNaN(seconds) || seconds === Infinity) return '00:00';
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function triggerLyricScrollSync() {
  lastLyricIndex = -1;
  const e = new Event('timeupdate');
  audio.dispatchEvent(e);
}

function getLyricTextFromPayload(payload) {
  if (!payload) return '';
  const data = payload.data || payload;
  return data.lyric || data.lrc || data.rawLrc || data.lxlyric || data.text || '';
}

// Fetch lyrics with native sandbox first, falling back to platform APIs.
async function fetchLyrics(song) {
  // 1. Try native source from sandbox first (extremely accurate & fast).
  if (state.sandbox) {
    const attempts = [
      { label: 'new', musicInfo: toNewMusicInfo(song) },
      { label: 'old', musicInfo: toOldMusicInfo(song) },
    ];

    for (const attempt of attempts) {
      try {
        const resolved = await state.sandbox.requestUrl(song.source, 'lyric', {
          musicInfo: attempt.musicInfo,
        });
        const lrcText = getLyricTextFromPayload(resolved);
        const parsed = parseLrc(lrcText);
        if (parsed && parsed.length > 0) {
          console.log(`[Lyric] Successfully fetched native lyrics from sandbox (${attempt.label})`);
          return parsed;
        }
      } catch (err) {
        console.warn(`[Lyric] Native sandbox ${attempt.label} lyric fetch failed, trying next source...`, err);
      }
    }
  }

  // 2. Fallback: ask the worker to try platform official lyric APIs and cross-source matches.
  try {
    const res = await fetch(`/api/lyric?${buildLyricParams(song).toString()}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const parsed = parseLrc(getLyricTextFromPayload(data));
      if (parsed && parsed.length > 0) {
        console.log(`[Lyric] Successfully fetched fallback lyrics from ${data.provider || 'api'}`);
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[Lyric] Platform fallback lyric fetch failed', err);
  }

  return [];
}

function parseLrc(lrcText) {
  const lines = lrcText.split('\n');
  const parsed = [];
  const timeReg = /\[(\d+):(\d+)(?:\.(\d+))?\]/g;
  for (const line of lines) {
    const text = line
      .replace(timeReg, '')
      .replace(/<(-?\d+),(-?\d+)(?:,-?\d+)?>/g, '')
      .replace(/\((\d+),(\d+)\)/g, '')
      .trim();
    let match;
    timeReg.lastIndex = 0;
    while ((match = timeReg.exec(line)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].slice(0, 3).padEnd(3, '0'), 10) : 0;
      const time = min * 60 + sec + ms / 1000;
      parsed.push({ time, text });
    }
  }
  return parsed.sort((a, b) => a.time - b.time);
}

async function togglePlay(song, itemEl) {
  const songKey = getSongKey(song);
  const playWrapper = itemEl.querySelector('.play-progress-wrapper');
  const playBtn = itemEl.querySelector('.play-btn');
  const slider = itemEl.querySelector('.player-progress-slider');
  const currentTimeText = itemEl.querySelector('.player-current-time');
  const totalTimeText = itemEl.querySelector('.player-total-time');

  if (activeSongId === songKey) {
    if (audio.paused) {
      try {
        await audio.play();
      } catch (err) {
        showToast('播放失败: ' + err.message, 'error');
      }
    } else {
      audio.pause();
    }
    return;
  }

  // Cancel any currently loading song
  if (loadingSongId && loadingSongId !== songKey) {
    const prevLoadingWrapper = document.querySelector(`.play-progress-wrapper.loading`);
    if (prevLoadingWrapper) {
      prevLoadingWrapper.classList.remove('loading');
    }
    loadingSongId = null;
  }

  // Set new loading state
  loadingSongId = songKey;
  playWrapper.classList.add('loading');

  const dummyStatusText = {
    set innerText(val) {
      console.log('[Play Resolution]', val);
    }
  };

  try {
    const displayFilename = buildSongFilename(song, 'mp3');
    const { downloadUrl } = await createDownloadLinkWithFallback(song, '128k', displayFilename, dummyStatusText);
    
    if (loadingSongId !== songKey) return;
    
    // Loaded URL successfully! Stop current song and switch now
    loadingSongId = null;

    if (activeSongId) {
      audio.pause();
      if (activePlayBtn) {
        activePlayBtn.querySelector('.play-icon').style.display = 'block';
        activePlayBtn.querySelector('.pause-icon').style.display = 'none';
        const prevWrapper = activePlayBtn.closest('.play-progress-wrapper');
        if (prevWrapper) {
          prevWrapper.classList.remove('loading');
        }
      }
      if (activeLyricLineEl) {
        activeLyricLineEl.innerText = '';
      }
    }

    activeSongId = songKey;
    activePlayBtn = playBtn;
    activeProgressSlider = slider;
    activeCurrentTimeText = currentTimeText;
    activeTotalTimeText = totalTimeText;
    activeLyricContainer = itemEl.querySelector('.player-lyric-container');
    activeLyricLineEl = itemEl.querySelector('.player-lyric-line');
    
    activeLyrics = [];
    lastLyricIndex = -1;

    currentTimeText.innerText = '00:00';
    slider.value = 0;
    if (activeLyricLineEl) activeLyricLineEl.innerText = '歌词加载中...';

    audio.src = downloadUrl + '&play=1';
    fetchLyrics(song).then((parsedLyrics) => {
      if (activeSongId !== songKey) return;
      activeLyrics = parsedLyrics || [];
      lastLyricIndex = -1;
      if (activeLyrics.length === 0) {
        if (activeLyricLineEl) activeLyricLineEl.innerText = '暂无歌词';
        return;
      }
      triggerLyricScrollSync();
    }).catch((err) => {
      console.error('[Lyric Fetch Error]', err);
      if (activeSongId === songKey && activeLyricLineEl) {
        activeLyricLineEl.innerText = '暂无歌词';
      }
    });
    
    try {
      await audio.play();
    } catch (err) {
      showToast('播放失败: ' + err.message, 'error');
      resetActiveSongUI();
    }
  } catch (err) {
    if (loadingSongId === songKey) {
      loadingSongId = null;
      playWrapper.classList.remove('loading');
      showToast('解析失败: ' + err.message, 'error');
    }
  }
}

function resetActiveSongUI() {
  if (activePlayBtn) {
    activePlayBtn.querySelector('.play-icon').style.display = 'block';
    activePlayBtn.querySelector('.pause-icon').style.display = 'none';
    const wrapper = activePlayBtn.closest('.play-progress-wrapper');
    if (wrapper) {
      wrapper.classList.remove('loading');
    }
  }
  if (activeLyricLineEl) {
    activeLyricLineEl.innerText = '';
  }
  activeSongId = null;
  activePlayBtn = null;
  activeProgressSlider = null;
  activeCurrentTimeText = null;
  activeTotalTimeText = null;
  activeLyricContainer = null;
  activeLyricLineEl = null;
  activeLyrics = [];
  lastLyricIndex = -1;
}

// Run App
window.addEventListener('DOMContentLoaded', init);
