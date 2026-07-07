import { initResolverSandbox } from './resolver-sandbox.js';
import { createPlayerPageController } from './player-page.js';

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
const DOWNLOAD_RESOLVE_TIMEOUT_MS = 9000;
const MOBILE_DOWNLOAD_RESOLVE_TIMEOUT_MS = 6500;
const DOWNLOAD_FALLBACK_SEARCH_TIMEOUT_MS = 6000;
const MOBILE_DOWNLOAD_FALLBACK_SEARCH_TIMEOUT_MS = 3500;
const DOWNLOAD_MAX_RESOLVERS = 3;
const MOBILE_DOWNLOAD_MAX_RESOLVERS = 1;
const DOWNLOAD_FALLBACK_BATCH_LIMIT = 2;
const MOBILE_DOWNLOAD_RACE_CANDIDATES_PER_SOURCE = 1;
const RESOLUTION_HEADER_TIMEOUT_MS = 7000;
const RESOLUTION_METADATA_TIMEOUT_MS = 12000;
const LYRIC_NATIVE_TIMEOUT_MS = 4200;
const LYRIC_API_TIMEOUT_MS = 8500;
const LYRIC_TOTAL_TIMEOUT_MS = 9500;
const LYRIC_CACHE_LIMIT = 80;
const PLAY_FALLBACK_SEARCH_TIMEOUT_MS = 6000;
const PLAYBACK_METADATA_TIMEOUT_MS = 5000;
const PLAYBACK_INVALID_SHORT_AUDIO_SECONDS = 10;
const PLAYBACK_SHORT_MIN_EXPECTED_SECONDS = 30;
const PLAY_RACE_CANDIDATES_PER_SOURCE = 1;
const SUSPICIOUS_SHORT_AUDIO_SECONDS = 15;
const SUSPICIOUS_SHORT_MIN_EXPECTED_SECONDS = 30;
const SUSPICIOUS_DURATION_RATIO = 0.35;
const SUSPICIOUS_DURATION_GAP_SECONDS = 20;
const SUSPICIOUS_TINY_AUDIO_BYTES = 512 * 1024;
const SUSPICIOUS_TINY_MIN_EXPECTED_SECONDS = 45;
const ORDERED_QUALITIES = new Set(['128k', '320k', 'flac', 'flac24bit']);
const SEARCH_STATE_STORAGE_KEY = 'music_download_x_search_state';
const PLAYBACK_STATE_STORAGE_KEY = 'music_download_x_playback_state';
const SEARCH_STATE_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_HOME_CHART = {
  source: 'tx',
  chart: 'hot',
  title: 'QQ音乐热歌榜',
};

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
  currentFeed: 'chart',
  currentChart: DEFAULT_HOME_CHART.chart,
  listTitle: DEFAULT_HOME_CHART.title,
  listUpdatedAt: '',
  isLoading: false,
  activeDownloadTask: null,
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

const lyricCache = new Map();
const lyricInflight = new Map();

function getLyricCacheKey(song) {
  return [
    song?.source || '',
    song?.songmid || '',
    song?.hash || '',
    song?.copyrightId || '',
    song?.name || '',
    song?.singer || '',
  ].join('|');
}

function cacheLyrics(key, lyrics) {
  if (!key || !Array.isArray(lyrics) || !lyrics.length) return;
  if (lyricCache.has(key)) lyricCache.delete(key);
  lyricCache.set(key, lyrics);
  while (lyricCache.size > LYRIC_CACHE_LIMIT) {
    const oldestKey = lyricCache.keys().next().value;
    lyricCache.delete(oldestKey);
  }
}

async function fetchWithAbortTimeout(url, options = {}, timeoutMs = LYRIC_API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`request timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
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

function getSongCoverUrl(song) {
  const coverUrl = song?.cover || song?.img || '';
  return /^https?:\/\//i.test(coverUrl) ? coverUrl : '';
}

function isWeChatBrowser() {
  return /MicroMessenger/i.test(navigator.userAgent || '');
}

function isIOSBrowser() {
  const ua = navigator.userAgent || '';
  return /iP(hone|ad|od)/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isMobileBrowser() {
  const ua = navigator.userAgent || '';
  return isIOSBrowser() || /Android|Mobile|Windows Phone/i.test(ua);
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

function buildSharePageUrl(payload) {
  const pageUrl = new URL('/share.html', window.location.href);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  pageUrl.hash = new URLSearchParams({
    data: btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
  }).toString();
  return pageUrl.toString();
}

function getSearchScrollTop() {
  return Math.max(
    window.scrollY || 0,
    document.documentElement.scrollTop || 0,
    document.body.scrollTop || 0
  );
}

function saveSearchStateSnapshot() {
  try {
    sessionStorage.setItem(SEARCH_STATE_STORAGE_KEY, JSON.stringify({
      savedAt: Date.now(),
      currentSource: state.currentSource,
      currentKeyword: state.currentFeed === 'chart' ? '' : (state.currentKeyword || el.searchInput.value.trim()),
      currentFeed: state.currentFeed,
      currentChart: state.currentChart,
      listTitle: state.listTitle,
      listUpdatedAt: state.listUpdatedAt,
      currentResults: state.currentResults,
      currentPage: state.currentPage,
      totalCount: state.totalCount,
      activeSearchKey: state.activeSearchKey,
      scrollTop: getSearchScrollTop(),
    }));
  } catch (err) {
    console.warn('[App] failed to save search state', err);
  }
}

function getFiniteSeconds(value) {
  const seconds = Number(value || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function setSelectedPlatformUI(source) {
  const value = source || 'tx';
  const options = el.customSelect?.querySelectorAll('.custom-option') || [];
  let selectedText = PLATFORM_NAMES[value] || value;

  options.forEach(option => {
    const isActive = option.getAttribute('data-value') === value;
    option.classList.toggle('active', isActive);
    if (isActive) selectedText = option.innerText;
  });

  state.currentSource = value;
  el.selectedPlatform.innerText = selectedText;
}

function restoreSearchStateSnapshot() {
  let snapshot = null;
  try {
    const raw = sessionStorage.getItem(SEARCH_STATE_STORAGE_KEY);
    if (!raw) return false;
    snapshot = JSON.parse(raw);
    sessionStorage.removeItem(SEARCH_STATE_STORAGE_KEY);
  } catch (err) {
    console.warn('[App] failed to restore search state', err);
    return false;
  }

  if (!snapshot || Date.now() - Number(snapshot.savedAt || 0) > SEARCH_STATE_MAX_AGE_MS) {
    return false;
  }

  const restoredResults = Array.isArray(snapshot.currentResults) ? snapshot.currentResults : [];
  const restoredKeyword = String(snapshot.currentKeyword || '');
  const restoredFeed = snapshot.currentFeed === 'chart' ? 'chart' : 'search';

  setSelectedPlatformUI(snapshot.currentSource || 'tx');
  state.currentFeed = restoredFeed;
  state.currentChart = restoredFeed === 'chart' ? (snapshot.currentChart || DEFAULT_HOME_CHART.chart) : '';
  state.listTitle = snapshot.listTitle || (restoredFeed === 'chart' ? DEFAULT_HOME_CHART.title : '');
  state.listUpdatedAt = snapshot.listUpdatedAt || '';
  state.currentKeyword = restoredFeed === 'chart' ? '' : restoredKeyword;
  state.currentResults = restoredResults;
  state.currentPage = Number(snapshot.currentPage || 1);
  state.totalCount = Number(snapshot.totalCount || restoredResults.length || 0);
  state.activeSearchKey = snapshot.activeSearchKey || getSearchKey(state.currentKeyword, state.currentSource, state.currentChart);
  state.isLoading = false;
  state.loadingMode = '';
  state.searchAbortController = null;
  el.searchInput.value = state.currentKeyword;
  updateClearSearchButton();
  showBottomLoadingIndicator(false);

  if ((state.currentKeyword || restoredFeed === 'chart') && restoredResults.length) {
    renderSearchResults();
    requestAnimationFrame(() => {
      window.scrollTo({ top: Number(snapshot.scrollTop || 0), left: 0, behavior: 'auto' });
    });
    return true;
  }

  renderInitialEmptyState();
  return false;
}

function savePlaybackStateSnapshot(snapshot) {
  if (!snapshot?.audioUrl || !snapshot?.song) return;
  try {
    sessionStorage.setItem(PLAYBACK_STATE_STORAGE_KEY, JSON.stringify({
      ...snapshot,
      savedAt: Date.now(),
    }));
  } catch (err) {
    console.warn('[App] failed to save playback state', err);
  }
}

function readPlaybackStateSnapshot() {
  try {
    const raw = sessionStorage.getItem(PLAYBACK_STATE_STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PLAYBACK_STATE_STORAGE_KEY);
    const snapshot = JSON.parse(raw);
    if (!snapshot || Date.now() - Number(snapshot.savedAt || 0) > SEARCH_STATE_MAX_AGE_MS) return null;
    return snapshot;
  } catch (err) {
    console.warn('[App] failed to read playback state', err);
    return null;
  }
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

function closeShareLinkModal() {
  document.getElementById('shareLinkModal')?.remove();
}

function showShareLinkModal(shareUrl) {
  closeShareLinkModal();

  const overlay = document.createElement('div');
  overlay.id = 'shareLinkModal';
  overlay.className = 'modal-overlay active share-link-modal';
  overlay.innerHTML = `
    <div class="glass-panel modal-content share-link-content">
      <h3 class="modal-title">分享链接已生成</h3>
      <p class="wechat-download-tip">浏览器没有允许自动复制，请手动复制下面的链接。</p>
      <textarea class="share-link-textarea" readonly>${escapeHtml(shareUrl)}</textarea>
      <div class="wechat-download-actions">
        <button class="wechat-download-btn primary" type="button" data-action="copy-share">复制链接</button>
      </div>
      <button class="modal-close-btn" type="button" data-action="close">关闭</button>
    </div>
  `;

  overlay.addEventListener('click', async (e) => {
    const action = e.target?.getAttribute?.('data-action');
    if (e.target === overlay || action === 'close') {
      closeShareLinkModal();
      return;
    }
    if (action === 'copy-share') {
      try {
        await copyTextToClipboard(shareUrl);
        showToast('分享链接已复制', 'success');
        closeShareLinkModal();
      } catch (err) {
        const textarea = overlay.querySelector('.share-link-textarea');
        textarea?.focus();
        textarea?.select();
        showToast('复制失败，请手动选择链接复制', 'error');
      }
    }
  });

  document.body.appendChild(overlay);
  const textarea = overlay.querySelector('.share-link-textarea');
  textarea?.focus();
  textarea?.select();
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

function getPlaybackDownloadUrl(downloadUrl) {
  return `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}play=1`;
}

function getContentRangeTotal(contentRange) {
  const match = String(contentRange || '').match(/\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

async function probeResolvedMediaHeaders(playbackUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLUTION_HEADER_TIMEOUT_MS);

  try {
    const res = await fetch(playbackUrl, {
      cache: 'no-store',
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal,
    });
    const contentRange = res.headers.get('content-range') || '';
    const contentLength = Number(res.headers.get('x-content-length') || res.headers.get('content-length') || 0);
    const totalLength = getContentRangeTotal(contentRange) || (res.status === 206 ? 0 : contentLength);

    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      contentLength,
      contentRange,
      totalLength,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function getFiniteAudioDuration(audioEl) {
  const duration = Number(audioEl?.duration || 0);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function probeAudioMetadata(playbackUrl, timeoutMs = RESOLUTION_METADATA_TIMEOUT_MS) {
  if (typeof Audio !== 'function') {
    return Promise.resolve({ duration: 0, inconclusive: true });
  }

  return new Promise((resolve, reject) => {
    const probe = new Audio();
    let settled = false;
    let metadataSeen = false;
    let settleTimer = null;

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(settleTimer);
      probe.removeEventListener('loadedmetadata', onMetadata);
      probe.removeEventListener('durationchange', onDurationChange);
      probe.removeEventListener('error', onError);
      probe.pause();
      probe.removeAttribute('src');
      probe.load();
    };

    const finish = (value, isError = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (isError) {
        reject(value);
      } else {
        resolve(value);
      }
    };

    const finishWithDuration = (extra = {}) => {
      finish({
        duration: getFiniteAudioDuration(probe),
        readyState: probe.readyState,
        ...extra,
      });
    };

    const onMetadata = () => {
      metadataSeen = true;
      if (getFiniteAudioDuration(probe) > 0) {
        finishWithDuration();
        return;
      }
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => finishWithDuration({ inconclusive: true }), 600);
    };

    const onDurationChange = () => {
      if (getFiniteAudioDuration(probe) > 0) finishWithDuration();
    };

    const onError = () => {
      finish(new Error('音频预检失败'), true);
    };

    const timeout = setTimeout(() => {
      if (metadataSeen) {
        finishWithDuration({ inconclusive: true, timedOut: true });
      } else {
        finish(new Error('音频元数据加载超时'), true);
      }
    }, timeoutMs);

    probe.preload = 'metadata';
    probe.addEventListener('loadedmetadata', onMetadata);
    probe.addEventListener('durationchange', onDurationChange);
    probe.addEventListener('error', onError);
    probe.src = playbackUrl;
    probe.load();
  });
}

function getSuspiciousResolvedMediaReason(probe, expectedSeconds) {
  const duration = Number(probe.duration || 0);
  const totalLength = Number(probe.totalLength || 0);

  if (expectedSeconds >= SUSPICIOUS_SHORT_MIN_EXPECTED_SECONDS && duration > 0) {
    if (duration <= SUSPICIOUS_SHORT_AUDIO_SECONDS) {
      return `解析结果只有 ${formatTime(duration)}，疑似试听片段`;
    }
    if (
      duration <= expectedSeconds * SUSPICIOUS_DURATION_RATIO &&
      expectedSeconds - duration >= SUSPICIOUS_DURATION_GAP_SECONDS
    ) {
      return `解析结果时长 ${formatTime(duration)} 与原曲 ${formatTime(expectedSeconds)} 不匹配`;
    }
  }

  if (
    expectedSeconds >= SUSPICIOUS_TINY_MIN_EXPECTED_SECONDS &&
    totalLength > 0 &&
    totalLength <= SUSPICIOUS_TINY_AUDIO_BYTES
  ) {
    return `解析结果文件过小 (${formatFileSize(totalLength)})，疑似无效音频`;
  }

  return '';
}

async function validateResolvedDownload(downloadUrl, song, statusText, resolution) {
  const sourceName = getResolverName(resolution.successfulUrl);
  const expectedSeconds = intervalToSeconds(song.interval);
  const playbackUrl = getPlaybackDownloadUrl(downloadUrl);

  statusText.innerText = `[${sourceName}] 正在校验音频完整性...`;

  const headers = await probeResolvedMediaHeaders(playbackUrl);
  if (!headers.ok) {
    throw new Error(`音频预检失败: HTTP ${headers.status}`);
  }

  const metadata = await probeAudioMetadata(playbackUrl);
  const issue = getSuspiciousResolvedMediaReason({
    ...headers,
    ...metadata,
  }, expectedSeconds);

  if (issue) throw new Error(issue);
}

async function validateResolvedDownloadHeaders(downloadUrl, song, statusText, resolution) {
  const sourceName = getResolverName(resolution.successfulUrl);
  const expectedSeconds = intervalToSeconds(song.interval);
  const playbackUrl = getPlaybackDownloadUrl(downloadUrl);

  statusText.innerText = `[${sourceName}] 正在快速校验下载链接...`;

  const headers = await probeResolvedMediaHeaders(playbackUrl);
  if (!headers.ok) {
    throw new Error(`音频预检失败: HTTP ${headers.status}`);
  }
  if (/text\/html|application\/json/i.test(headers.contentType)) {
    throw new Error('解析结果不是音频文件');
  }

  const issue = getSuspiciousResolvedMediaReason(headers, expectedSeconds);
  if (issue) throw new Error(issue);
}

async function validatePlaybackResolvedDownload(downloadUrl, song) {
  const expectedSeconds = intervalToSeconds(song.interval);
  if (expectedSeconds > 0 && expectedSeconds < PLAYBACK_SHORT_MIN_EXPECTED_SECONDS) return;

  const playbackUrl = getPlaybackDownloadUrl(downloadUrl);
  const metadata = await probeAudioMetadata(playbackUrl, PLAYBACK_METADATA_TIMEOUT_MS);
  const duration = Number(metadata.duration || 0);

  if (
    expectedSeconds >= PLAYBACK_SHORT_MIN_EXPECTED_SECONDS &&
    duration > 0 &&
    duration <= PLAYBACK_INVALID_SHORT_AUDIO_SECONDS
  ) {
    throw new Error(`解析结果只有 ${formatTime(duration)}，疑似试听片段`);
  }
}

function triggerBrowserDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function getActiveDownloadName() {
  return state.activeDownloadTask?.songName || '当前歌曲';
}

function isDownloadBusy() {
  return false;
}

function lockDownloadTask(taskId, song) {
  state.activeDownloadTask = {
    id: taskId,
    songName: song?.name || '当前歌曲',
    source: song?.source || '',
    songmid: song?.songmid || '',
  };
}

function releaseDownloadTask(taskId) {
  if (!taskId || state.activeDownloadTask?.id === taskId) {
    state.activeDownloadTask = null;
  }
}

function showDownloadBusyToast() {
  showToast(`当前正在下载: ${getActiveDownloadName()}，请完成后再下载下一首`, 'warning');
}

function getReadableError(err) {
  return err?.message || err?.name || String(err || '未知错误');
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

  return button;
}

async function tryAutoSaveBlob({ blob, filename, statusText, saveButton }) {
  statusText.innerText = '文件已生成，正在打开保存...';
  try {
    await saveBlobFromPage(blob, filename);
    statusText.innerText = '已打开保存/下载，请按浏览器提示完成';
    statusText.className = 'queue-status completed';
    if (saveButton) saveButton.textContent = '再次保存文件';
  } catch (err) {
    if (err?.name === 'AbortError') {
      statusText.innerText = '保存已取消，可点击保存文件重试';
      statusText.className = 'queue-status warning';
    } else {
      statusText.innerText = '浏览器未允许自动保存，请点击保存文件';
      statusText.className = 'queue-status warning';
      console.warn('[Download] auto save failed:', err);
    }
  }
}

function showBrowserDownloadAction({ actionEl, downloadUrl, filename, statusText, taskId }) {
  if (!actionEl) return;

  const button = document.createElement('button');
  button.className = 'queue-save-btn';
  button.type = 'button';
  button.textContent = '用浏览器下载';
  actionEl.innerHTML = '';
  actionEl.appendChild(button);

  button.addEventListener('click', () => {
    triggerBrowserDownload(downloadUrl, filename);
    statusText.innerText = '已交给浏览器下载';
    statusText.className = 'queue-status completed';
    releaseDownloadTask(taskId);
    actionEl.innerHTML = '';
  });
}

function showDownloadPageAction({ actionEl, downloadUrl, filename, statusText, taskId }) {
  if (!actionEl) return;

  const button = document.createElement('button');
  button.className = 'queue-save-btn';
  button.type = 'button';
  button.textContent = '打开下载页';
  actionEl.innerHTML = '';
  actionEl.appendChild(button);

  button.addEventListener('click', () => {
    window.location.href = buildDownloadPageUrl(downloadUrl, filename);
    statusText.innerText = '已打开下载页';
    statusText.className = 'queue-status completed';
    releaseDownloadTask(taskId);
  });
}

function canUseResolvedDownloadUrl(downloadUrl) {
  try {
    return Boolean(downloadUrl && /^https?:\/\//i.test(toAbsoluteUrl(downloadUrl)));
  } catch (_) {
    return false;
  }
}

function createDownloadTaskElement(taskId, displayFilename) {
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

  const firstChild = el.queueList.firstChild;
  if (firstChild && el.queueList.querySelector('.empty-state')) {
    el.queueList.innerHTML = '';
  }
  el.queueList.insertBefore(taskEl, el.queueList.firstChild);
  return taskEl;
}

function getDownloadTaskUi(taskId) {
  return {
    statusText: document.getElementById(`task-status-${taskId}`),
    sizeText: document.getElementById(`task-size-${taskId}`),
    progressFill: document.getElementById(`task-progress-${taskId}`),
    pctText: document.getElementById(`task-pct-${taskId}`),
    actionEl: document.getElementById(`task-action-${taskId}`),
  };
}

function createDownloadTaskFromResolvedUrl(song, downloadUrl, filename, options = {}) {
  if (!canUseResolvedDownloadUrl(downloadUrl)) return false;

  const finalFilename = filename || buildSongFilename(song, getDefaultExtensionForQuality('128k'));
  const taskId = Date.now().toString();
  createDownloadTaskElement(taskId, finalFilename);
  const { statusText, sizeText, progressFill, pctText, actionEl } = getDownloadTaskUi(taskId);
  const resolvedUrl = new URL(downloadUrl, window.location.href);
  if (isMobileBrowser()) resolvedUrl.searchParams.set('raw', '1');
  const absoluteDownloadUrl = resolvedUrl.toString();

  showToast(`开始下载任务: ${song?.name || finalFilename}`, 'info');
  updateDownloadProgressOnCard(song?.songmid, song?.source, 10);

  if (isWeChatBrowser()) {
    showWeChatDownloadModal(absoluteDownloadUrl, finalFilename);
    statusText.innerText = '微信内无法直接下载';
    statusText.className = 'queue-status warning';
    sizeText.innerText = '请复制链接或在浏览器打开';
    progressFill.style.width = '100%';
    pctText.innerText = '待处理';
    updateDownloadProgressOnCard(song?.songmid, song?.source, 100, false, true);
    return true;
  }

  downloadInsidePage(absoluteDownloadUrl, finalFilename, { statusText, sizeText, progressFill, pctText, actionEl }, song, { taskId })
    .then(() => {
      showToast(`文件已生成: ${song?.name || finalFilename}`, 'success');
    })
    .catch((err) => {
      console.warn('[Download] resolved in-page download interrupted:', err);
      const reason = getReadableError(err);
      statusText.innerText = `网页内下载中断: ${reason}`;
      statusText.className = 'queue-status warning';
      sizeText.innerText = '可改用浏览器下载同一文件';
      progressFill.style.width = '100%';
      pctText.innerText = '待处理';
      updateDownloadProgressOnCard(song?.songmid, song?.source, 100, false, true);
      showBrowserDownloadAction({ actionEl, downloadUrl: absoluteDownloadUrl, filename: finalFilename, statusText, taskId });
      showToast('网页内下载中断，请点击“用浏览器下载”继续', 'warning');
    });
  return true;
}

function tryDownloadFromActivePlayback(song, quality) {
  const selectedQuality = normalizeQualityType(quality) || quality;
  if (selectedQuality !== '128k') return false;
  if (!song || !activePlaybackContext?.downloadUrl || !activePlaybackContext?.song) return false;
  const playbackQuality = normalizeQualityType(activePlaybackContext.quality || '128k') || '128k';
  if (playbackQuality !== selectedQuality) return false;
  const activeSong = activePlaybackContext.song;
  const sameSong =
    getSongKey(activeSong) === getSongKey(song) ||
    (
      activeSong.name === song.name &&
      activeSong.singer === song.singer &&
      (!activeSong.interval || !song.interval || activeSong.interval === song.interval)
    );

  if (!sameSong) return false;

  return createDownloadTaskFromResolvedUrl(
    activeSong,
    activePlaybackContext.downloadUrl,
    activePlaybackContext.filename
  );
}

async function downloadInsidePage(downloadUrl, filename, ui, song, options = {}) {
  const { statusText, sizeText, progressFill, pctText, actionEl } = ui;
  const { taskId = '' } = options;
  statusText.innerText = '正在网页内生成带封面文件...';
  sizeText.innerText = '正在连接...';
  progressFill.style.width = '5%';
  pctText.innerText = '0%';

  const controller = new AbortController();
  if (taskId) {
    inPageDownloadTasks.set(taskId, {
      taskId,
      downloadUrl,
      filename,
      statusText,
      sizeText,
      progressFill,
      pctText,
      actionEl,
      song,
      controller,
      warnedHidden: false,
    });
  }

  let completed = false;
  try {
    const res = await fetch(downloadUrl, { cache: 'no-store', signal: controller.signal });
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
    statusText.innerText = '文件已在网页内准备好';
    statusText.className = 'queue-status completed';
    updateDownloadProgressOnCard(song.songmid, song.source, 100, false, true);
    const saveButton = showInPageSaveAction({ actionEl, blob, filename, statusText });
    await tryAutoSaveBlob({ blob, filename, statusText, saveButton });
    completed = true;
  } finally {
    if (taskId) inPageDownloadTasks.delete(taskId);
  }
}

function warnInPageDownloadsBackgrounded() {
  if (!inPageDownloadTasks.size) return;
  inPageDownloadTasks.forEach((task) => {
    if (task.warnedHidden) return;
    task.warnedHidden = true;
    task.statusText.innerText = '页面已转入后台，网页内下载可能会被浏览器暂停';
    task.statusText.className = 'queue-status warning';
    task.sizeText.innerText = '需要后台继续时请改用浏览器下载';
    showBrowserDownloadAction({
      actionEl: task.actionEl,
      downloadUrl: task.downloadUrl,
      filename: task.filename,
      statusText: task.statusText,
      taskId: task.taskId,
    });
  });
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

async function fetchSourceSearch(keyword, source, limit = 25, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

function collectRankedAlternativeSearchResults(song, quality, data, seen) {
  const ranked = [];
  for (const candidate of data?.list || []) {
    const score = rankAlternativeSong(song, candidate, quality);
    if (score < 0) continue;
    const key = `${candidate.source}_${candidate.songmid}_${candidate.hash || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push({ ...candidate, _fallbackScore: score });
  }
  return ranked;
}

function rankAlternativeSearchResults(song, quality, data, seen) {
  return collectRankedAlternativeSearchResults(song, quality, data, seen)
    .sort((a, b) => b._fallbackScore - a._fallbackScore)
    .map(({ _fallbackScore, ...candidate }) => candidate);
}

function createAlternativeSongCollector(song, quality, options = {}) {
  const { searchTimeoutMs = 15000 } = options;
  const keyword = `${song.name || ''} ${song.singer || ''}`.trim();
  const seen = new Set();
  let pending = [];

  if (keyword) {
    pending = PLATFORM_IDS
      .filter(source => source !== song.source)
      .map(source => ({
        source,
        promise: fetchSourceSearch(keyword, source, 25, searchTimeoutMs),
      }));
  }

  return {
    async nextBatch() {
      while (pending.length) {
        const result = await Promise.race(pending.map(entry => entry.promise.then(data => ({ entry, data }))));
        pending = pending.filter(entry => entry !== result.entry);
        const candidates = rankAlternativeSearchResults(song, quality, result.data, seen);
        if (candidates.length) return candidates;
      }
      return [];
    },
    async all() {
      const candidates = [];
      while (pending.length) {
        const batch = await this.nextBatch();
        candidates.push(...batch);
      }
      return candidates;
    },
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSearchParams(page) {
  const params = {
    keyword: state.currentFeed === 'chart' ? '' : state.currentKeyword,
    source: state.currentFeed === 'chart' ? DEFAULT_HOME_CHART.source : state.currentSource,
    page,
    limit: state.limit,
  };
  if (state.currentFeed === 'chart') {
    params.chart = state.currentChart || DEFAULT_HOME_CHART.chart;
  }
  return params;
}

function getSearchKey(keyword, source, chart = '') {
  return chart ? `${source}\u0000chart:${chart}` : `${source}\u0000${keyword}`;
}

async function fetchSearchData(params, { signal } = {}) {
  const searchParams = new URLSearchParams({
    keyword: params.keyword || '',
    source: params.source,
    page: String(params.page),
    limit: String(params.limit),
    _: String(Date.now()),
  });
  if (params.chart) searchParams.set('chart', params.chart);
  const searchUrl = `/api/search?${searchParams.toString()}`;
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
    ranked.push(...collectRankedAlternativeSearchResults(song, quality, data, seen));
  });

  return ranked.sort((a, b) => b._fallbackScore - a._fallbackScore).map(({ _fallbackScore, ...candidate }) => candidate);
}

function getResolverUrlsToTry() {
  return [state.scriptUrl, ...SOURCE_URLS.filter(u => u !== state.scriptUrl)];
}

function getDownloadResolverUrlsToTry(limit = DOWNLOAD_MAX_RESOLVERS) {
  return getResolverUrlsToTry().slice(0, Math.max(1, limit));
}

async function loadResolverForDownload(url, timeoutMs = RESOLVE_TIMEOUT_MS) {
  const sourceName = getResolverName(url);
  return withTimeout(
    getOrLoadSandbox(url),
    timeoutMs,
    `${sourceName}加载超时`
  );
}

async function resolveWithLoadedResolver(url, sandboxInstance, song, quality, statusText, validateResolution, options = {}) {
  const timeoutMs = options.resolveTimeoutMs || RESOLVE_TIMEOUT_MS;
  const sourceName = getResolverName(url);
  statusText.innerText = `正在用${sourceName}解析 ${getPlatformName(song.source)}...`;
  console.log(`[Download] Trying resolution with resolver: ${url}, source: ${song.source}`);

  const { finalUrl, finalHeaders, finalType } = await withTimeout(
    resolveMusicUrl(sandboxInstance, song, quality),
    timeoutMs,
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

  throw new Error('解析服务未返回有效链接');
}

async function resolveWithScripts(song, quality, statusText, validateResolution, options = {}) {
  let lastError = null;

  for (const url of getResolverUrlsToTry()) {
    try {
      const sandboxInstance = await loadResolverForDownload(url, options.loadTimeoutMs);
      return await resolveWithLoadedResolver(url, sandboxInstance, song, quality, statusText, validateResolution, options);
    } catch (err) {
      lastError = err;
      console.warn(`[Download] Resolver ${url} failed for ${song.source}:`, err.message);
    }
  }

  if (lastError) throw lastError;
  throw new Error('解析服务未返回有效链接');
}

function buildDownloadProxyUrl(resolution, finalFilename, metadataSong, finalExt, coverUrl = '', options = {}) {
  const params = new URLSearchParams({
    url: resolution.audioUrl,
    filename: finalFilename,
    headers: JSON.stringify(resolution.audioHeaders || {}),
    title: metadataSong.name || '',
    artist: metadataSong.singer || '',
    album: metadataSong.albumName || '',
    cover: coverUrl || '',
    ext: finalExt,
  });
  if (options.raw) params.set('raw', '1');
  return `/api/download?${params.toString()}`;
}

async function buildDownloadUrlFromResolution(resolution, quality, filename, song, statusText, options = {}) {
  const { validate = true, includeCover = true, useExistingCover = true, raw = false } = options;
  const sourceName = getResolverName(resolution.successfulUrl);

  const mediaInfo = getDownloadMediaInfo('', quality, resolution.resolvedQuality, resolution.audioUrl);
  const finalExt = mediaInfo.actualExt || getDefaultExtensionForQuality(mediaInfo.actualQuality || quality);
  const finalFilename = buildSongFilename(song, finalExt);
  const metadataSong = resolution.resolvedSong || song;
  const preliminaryDownloadUrl = buildDownloadProxyUrl(resolution, finalFilename, metadataSong, finalExt, '', { raw });
  if (validate === 'headers') {
    await validateResolvedDownloadHeaders(preliminaryDownloadUrl, metadataSong, statusText, resolution);
  } else if (validate) {
    await validateResolvedDownload(preliminaryDownloadUrl, metadataSong, statusText, resolution);
  }

  statusText.innerText = `[${sourceName}] 正在准备带封面和歌手信息的下载...`;
  const coverUrl = includeCover ? await getBestCoverUrl(metadataSong) : (useExistingCover ? (metadataSong.img || '') : '');
  const downloadUrl = buildDownloadProxyUrl(resolution, finalFilename, metadataSong, finalExt, coverUrl, { raw });

  return {
    downloadUrl,
    resolution,
    mediaInfo,
    finalFilename,
  };
}

async function createDownloadLink(song, quality, filename, statusText, options = {}) {
  return resolveWithScripts(song, quality, statusText, (resolution) => {
    return buildDownloadUrlFromResolution(resolution, quality, filename, song, statusText, options);
  }, options);
}

async function createDownloadLinkWithFallback(song, quality, filename, statusText, options = {}) {
  let lastError = null;
  const {
    eagerAlternatives = false,
    loadTimeoutMs = RESOLVE_TIMEOUT_MS,
    resolveTimeoutMs = RESOLVE_TIMEOUT_MS,
    fallbackBatchLimit = Infinity,
    fallbackSearchTimeoutMs = 15000,
    resolverUrls = getResolverUrlsToTry(),
    allowFallback = true,
  } = options;
  let alternativeCollector = eagerAlternatives
    ? createAlternativeSongCollector(song, quality, { searchTimeoutMs: fallbackSearchTimeoutMs })
    : null;

  const getAlternativeBatch = async (sourceName) => {
    if (!alternativeCollector) {
      statusText.innerText = `[${sourceName}] 原平台不可用，正在匹配其它平台...`;
      alternativeCollector = createAlternativeSongCollector(song, quality, { searchTimeoutMs: fallbackSearchTimeoutMs });
    }
    return alternativeCollector.nextBatch();
  };

  for (const url of resolverUrls) {
    const sourceName = getResolverName(url);
    let sandboxInstance = null;
    try {
      sandboxInstance = await loadResolverForDownload(url, loadTimeoutMs);
    } catch (err) {
      lastError = err;
      console.warn(`[Download] Resolver ${url} load failed:`, err.message);
      continue;
    }

    try {
      return await resolveWithLoadedResolver(url, sandboxInstance, song, quality, statusText, (resolution) => {
        return buildDownloadUrlFromResolution(resolution, quality, filename, song, statusText, options);
      }, { resolveTimeoutMs });
    } catch (err) {
      lastError = err;
      console.warn(`[Download] ${sourceName} original ${song.source} failed:`, err.message);
    }

    if (!allowFallback) continue;

    let triedAlternative = false;
    while (true) {
      const alternatives = await getAlternativeBatch(sourceName);
      if (!alternatives.length) break;
      triedAlternative = true;
      for (const candidate of alternatives.slice(0, fallbackBatchLimit)) {
        try {
          statusText.innerText = `[${sourceName}] 正在尝试 ${getPlatformName(candidate.source)}...`;
          return await resolveWithLoadedResolver(url, sandboxInstance, candidate, quality, statusText, (resolution) => {
            return buildDownloadUrlFromResolution(resolution, quality, filename, candidate, statusText, options);
          }, { resolveTimeoutMs });
        } catch (err) {
          lastError = err;
          console.warn(`[Download] ${sourceName} fallback ${candidate.source} failed:`, err.message);
        }
      }
    }

    if (!triedAlternative) {
      console.warn('[Download] no fallback platform candidates found');
    }
  }

  throw lastError || new Error('所有平台和解析服务均解析失败');
}

function createMobileDownloadCandidateProvider(song, quality) {
  const keyword = `${song.name || ''} ${song.singer || ''}`.trim();
  const seen = new Set();
  const entries = keyword
    ? PLATFORM_IDS
      .filter(source => source !== song.source)
      .map(source => ({
        source,
        promise: fetchSourceSearch(keyword, source, 12, MOBILE_DOWNLOAD_FALLBACK_SEARCH_TIMEOUT_MS)
          .then(data => rankAlternativeSearchResults(song, quality, data, seen).slice(0, MOBILE_DOWNLOAD_RACE_CANDIDATES_PER_SOURCE))
          .catch((err) => {
            console.warn(`[Download] mobile fallback search failed for ${source}:`, err.message || err);
            return [];
          }),
      }))
    : [];

  return {
    createTasks(resolveCandidate) {
      const tasks = [
        resolveCandidate(song, { original: true }),
      ];

      for (const entry of entries) {
        tasks.push(entry.promise.then(async (candidates) => {
          if (!candidates.length) {
            throw new Error(`${getPlatformName(entry.source)}未找到匹配歌曲`);
          }

          let lastError = null;
          for (const candidate of candidates) {
            try {
              return await resolveCandidate(candidate, { original: false });
            } catch (err) {
              lastError = err;
              console.warn(`[Download] mobile ${getPlatformName(entry.source)} candidate failed:`, err.message || err);
            }
          }
          throw lastError || new Error(`${getPlatformName(entry.source)}候选歌曲解析失败`);
        }));
      }

      return tasks;
    },
  };
}

async function createMobileDownloadLink(song, quality, filename, statusText, options = {}) {
  const candidateProvider = createMobileDownloadCandidateProvider(song, quality);
  let lastError = null;

  for (const url of getDownloadResolverUrlsToTry(MOBILE_DOWNLOAD_MAX_RESOLVERS)) {
    const sourceName = getResolverName(url);
    let sandboxInstance = null;
    try {
      sandboxInstance = await loadResolverForDownload(url, MOBILE_DOWNLOAD_RESOLVE_TIMEOUT_MS);
    } catch (err) {
      lastError = err;
      console.warn(`[Download] mobile resolver ${url} load failed:`, err.message || err);
      continue;
    }

    const raceState = { settled: false };
    const raceStatusText = {
      set innerText(value) {
        if (!raceState.settled) statusText.innerText = value;
      },
    };
    const resolveCandidate = (candidate) => resolveWithLoadedResolver(url, sandboxInstance, candidate, quality, raceStatusText, (resolution) => {
      return buildDownloadUrlFromResolution(resolution, quality, filename, candidate, raceStatusText, options);
    }, { resolveTimeoutMs: MOBILE_DOWNLOAD_RESOLVE_TIMEOUT_MS });

    try {
      statusText.innerText = `[${sourceName}] 正在快速匹配可下载版本...`;
      return await firstSuccessfulPromise(
        candidateProvider.createTasks(resolveCandidate),
        `[${sourceName}] 暂未解析到可下载链接`
      );
    } catch (err) {
      lastError = err?.cause || err;
      console.warn(`[Download] mobile ${sourceName} candidates failed:`, err.message || err);
    } finally {
      raceState.settled = true;
    }
  }

  throw lastError || new Error('暂未解析到可下载链接');
}

function firstSuccessfulPromise(promises, message) {
  if (!promises.length) return Promise.reject(new Error(message));

  return new Promise((resolve, reject) => {
    const errors = [];
    let pending = promises.length;
    let settled = false;

    promises.forEach((promise, index) => {
      Promise.resolve(promise).then((value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      }).catch((err) => {
        if (settled) return;
        errors[index] = err;
        pending -= 1;
        if (pending === 0) {
          const error = new Error(message);
          error.cause = errors.find(Boolean);
          error.errors = errors.filter(Boolean);
          reject(error);
        }
      });
    });
  });
}

function createPlaybackCandidateProvider(song, quality) {
  const keyword = `${song.name || ''} ${song.singer || ''}`.trim();
  const seen = new Set();
  const entries = keyword
    ? PLATFORM_IDS
      .filter(source => source !== song.source)
      .map(source => ({
        source,
        promise: fetchSourceSearch(keyword, source, 25, PLAY_FALLBACK_SEARCH_TIMEOUT_MS)
          .then(data => rankAlternativeSearchResults(song, quality, data, seen).slice(0, PLAY_RACE_CANDIDATES_PER_SOURCE))
          .catch((err) => {
            console.warn(`[Play] fallback search failed for ${source}:`, err.message || err);
            return [];
          }),
      }))
    : [];

  return {
    createTasks(resolveCandidate) {
      const tasks = [
        resolveCandidate(song, { original: true }),
      ];

      for (const entry of entries) {
        tasks.push(entry.promise.then(async (candidates) => {
          if (!candidates.length) {
            throw new Error(`${getPlatformName(entry.source)}未找到匹配歌曲`);
          }

          let lastError = null;
          for (const candidate of candidates) {
            try {
              return await resolveCandidate(candidate, { original: false });
            } catch (err) {
              lastError = err;
              console.warn(`[Play] ${getPlatformName(entry.source)} candidate failed:`, err.message || err);
            }
          }
          throw lastError || new Error(`${getPlatformName(entry.source)}候选歌曲解析失败`);
        }));
      }

      return tasks;
    },
  };
}

async function racePlaybackWithResolver(url, sandboxInstance, candidateProvider, quality, filename, statusText, options = {}) {
  const sourceName = getResolverName(url);
  const raceState = { settled: false };
  const raceStatusText = {
    set innerText(value) {
      if (!raceState.settled) statusText.innerText = value;
    },
  };

  const resolveCandidate = (candidate) => resolveWithLoadedResolver(url, sandboxInstance, candidate, quality, raceStatusText, async (resolution) => {
    const result = await buildDownloadUrlFromResolution(resolution, quality, filename, candidate, raceStatusText, options);
    await validatePlaybackResolvedDownload(result.downloadUrl, resolution.resolvedSong || candidate);
    return result;
  }, { resolveTimeoutMs: options.resolveTimeoutMs });

  try {
    return await firstSuccessfulPromise(
      candidateProvider.createTasks(resolveCandidate),
      `[${sourceName}] 所有平台均解析失败`
    );
  } finally {
    raceState.settled = true;
  }
}

async function createPlaybackLinkWithFallback(song, quality, filename, statusText, options = {}) {
  const {
    loadTimeoutMs = RESOLVE_TIMEOUT_MS,
  } = options;
  const candidateProvider = createPlaybackCandidateProvider(song, quality);
  let lastError = null;

  for (const url of getResolverUrlsToTry()) {
    const sourceName = getResolverName(url);
    let sandboxInstance = null;
    try {
      sandboxInstance = await loadResolverForDownload(url, loadTimeoutMs);
    } catch (err) {
      lastError = err;
      console.warn(`[Play] Resolver ${url} load failed:`, err.message || err);
      continue;
    }

    try {
      statusText.innerText = `[${sourceName}] 正在并发解析多个平台...`;
      return await racePlaybackWithResolver(url, sandboxInstance, candidateProvider, quality, filename, statusText, options);
    } catch (err) {
      lastError = err?.cause || err;
      console.warn(`[Play] ${sourceName} all platform candidates failed:`, err.message || err);
    }
  }

  throw lastError || new Error('所有平台和解析服务均解析失败');
}

async function createShareLink(song, options = {}) {
  const defaultExt = getDefaultExtensionForQuality('128k');
  const displayFilename = buildSongFilename(song, defaultExt);
  const statusText = {
    set innerText(val) {
      console.log('[Share Resolution]', val);
    }
  };
  const { downloadUrl, resolution, finalFilename } = await createDownloadLinkWithFallback(song, '128k', displayFilename, statusText, {
    validate: true,
    includeCover: false,
  });
  const resolvedSong = resolution?.resolvedSong || song;

  return buildSharePageUrl({
    entry: options.entry || 'share',
    song: {
      name: resolvedSong.name || song.name || '',
      singer: resolvedSong.singer || song.singer || '',
      albumName: resolvedSong.albumName || song.albumName || '',
      albumId: resolvedSong.albumId || song.albumId || '',
      interval: resolvedSong.interval || song.interval || '',
      source: resolvedSong.source || song.source || '',
      songmid: resolvedSong.songmid || song.songmid || '',
      songId: resolvedSong.songId || song.songId || '',
      hash: resolvedSong.hash || song.hash || '',
      copyrightId: resolvedSong.copyrightId || song.copyrightId || '',
      lrcUrl: resolvedSong.lrcUrl || song.lrcUrl || '',
      mrcUrl: resolvedSong.mrcUrl || song.mrcUrl || '',
      trcUrl: resolvedSong.trcUrl || song.trcUrl || '',
      img: resolvedSong.img || song.img || '',
      strMediaMid: resolvedSong.strMediaMid || song.strMediaMid || '',
      albumMid: resolvedSong.albumMid || song.albumMid || '',
      types: resolvedSong.types?.length ? resolvedSong.types : (song.types || []),
      _types: Object.keys(resolvedSong._types || {}).length ? resolvedSong._types : (song._types || {}),
      typeUrl: resolvedSong.typeUrl || song.typeUrl || {},
      cover: resolvedSong.cover || resolvedSong.img || song.cover || song.img || '',
    },
    audioUrl: toAbsoluteUrl(getPlaybackDownloadUrl(downloadUrl)),
    downloadUrl: toAbsoluteUrl(downloadUrl),
    filename: finalFilename || displayFilename,
  });
}

async function openSharePlayerPage(song, button) {
  if (button?.disabled) return;
  try {
    openInlinePlayerOverlay(song);
  } catch (err) {
    console.error('[Player Page Error]', err);
    showToast(`进入播放界面失败: ${err.message}`, 'error');
  }
}

async function getBestCoverUrl(song) {
  const existingCoverUrl = getSongCoverUrl(song);
  if (existingCoverUrl) {
    song.img = song.img || existingCoverUrl;
    return existingCoverUrl;
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
  return getSongCoverUrl(song);
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
const inPageDownloadTasks = new Map();

function closeQualityModal() {
  el.qualityModal.classList.remove('active');
  el.qualityModal.classList.add('force-hidden');
  songToDownload = null;
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  requestAnimationFrame(() => {
    el.qualityModal.classList.remove('active');
    el.qualityModal.classList.add('force-hidden');
  });
}

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
  const restoredList = restoreSearchStateSnapshot();
  restorePlaybackStateSnapshot();
  if (!restoredList) {
    void loadHomeHotChart();
  }

  // Load Custom Music Source in background
  await loadMusicSource(state.scriptUrl);
}

// Setup Event Listeners
function setupEventListeners() {
  document.addEventListener('pointerup', blurInteractiveTarget, true);
  document.addEventListener('click', blurInteractiveTarget, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) warnInPageDownloadsBackgrounded();
  });
  window.addEventListener('pagehide', warnInPageDownloadsBackgrounded);

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
    } else if (state.currentFeed === 'chart') {
      if (state.searchAbortController) {
        state.searchAbortController.abort();
        state.searchAbortController = null;
      }
      state.searchRequestId += 1;
      state.currentFeed = 'search';
      state.currentChart = '';
      state.listTitle = '';
      state.listUpdatedAt = '';
      state.currentResults = [];
      state.totalCount = 0;
      state.activeSearchKey = '';
      state.isLoading = false;
      state.loadingMode = '';
      showBottomLoadingIndicator(false);
      renderInitialEmptyState();
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
    closeQualityModal();
  });
  el.qualityModal.addEventListener('click', (event) => {
    if (event.target === el.qualityModal) closeQualityModal();
  });

  const handleQualitySelect = (event) => {
    const btn = event.target?.closest?.('.quality-btn');
    if (!btn || !el.qualityModal.classList.contains('active')) return;
    if (btn.disabled || btn.style.display === 'none') return;

    event.preventDefault();
    event.stopPropagation();

    const quality = btn.getAttribute('data-quality');
    const downloadSong = songToDownload;
    closeQualityModal();

    if (downloadSong) {
      void startDownloadTask(downloadSong, quality);
    } else {
      showToast('下载歌曲信息已失效，请重新点击下载', 'warning');
    }
  };
  el.qualityModal.addEventListener('click', handleQualitySelect, true);
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
  el.searchInput.value = '';
  updateClearSearchButton();
  void loadHomeHotChart();
  requestAnimationFrame(() => {
    el.searchInput.focus({ preventScroll: true });
  });
}

function blurInteractiveTarget(e) {
  if (e.target?.closest?.('#clearSearchBtn')) return;
  const target = e.target?.closest?.('button, .custom-select-trigger, .custom-option, .song-btn, .quality-btn, .download-progress-wrapper, .song-secondary-actions, .modal-close-btn');
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
  if (state.currentFeed !== 'chart' && !state.currentKeyword) return false;
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

async function loadHomeHotChart() {
  const chartKey = getSearchKey('', DEFAULT_HOME_CHART.source, DEFAULT_HOME_CHART.chart);
  if (state.isLoading && state.activeSearchKey === chartKey) return;

  if (state.searchAbortController) {
    state.searchAbortController.abort();
  }

  state.searchRequestId += 1;
  state.currentFeed = 'chart';
  state.currentChart = DEFAULT_HOME_CHART.chart;
  state.currentSource = DEFAULT_HOME_CHART.source;
  state.currentKeyword = '';
  state.currentResults = [];
  state.currentPage = 1;
  state.totalCount = 0;
  state.listTitle = DEFAULT_HOME_CHART.title;
  state.listUpdatedAt = '';
  state.activeSearchKey = chartKey;
  state.isLoading = false;
  state.loadingMode = '';
  el.searchInput.value = '';
  setSelectedPlatformUI(DEFAULT_HOME_CHART.source);
  updateClearSearchButton();
  showBottomLoadingIndicator(false);

  const params = getSearchParams(state.currentPage);
  await fetchPage(params, state.searchRequestId);
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
  state.currentFeed = 'search';
  state.currentChart = '';
  state.currentKeyword = keyword;
  state.currentResults = []; // Clear previous batch
  state.totalCount = 0;
  state.listTitle = '';
  state.listUpdatedAt = '';
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
  const isChart = Boolean(params.chart);
  el.songList.innerHTML = `
    <div class="empty-state">
      <div class="loading-spinner" style="width:30px; height:30px;"></div>
      <p>${isChart ? '正在加载 QQ 音乐热歌榜...' : '正在搜寻中...'}</p>
    </div>
  `;
  el.resultsCount.innerText = isChart ? '正在加载热榜...' : '正在搜索...';

  try {
    const data = await fetchSearchDataWithRetry(params, requestId, controller, { retryEmpty: true });
    if (!data) return;
    if (requestId !== state.searchRequestId) return;
    state.currentResults = data.list || [];
    
    if (params.page === 1) {
      state.totalCount = data.total || 0;
    }
    if (params.chart) {
      state.listTitle = data.titleDetail || data.title || DEFAULT_HOME_CHART.title;
      state.listUpdatedAt = data.updateTime || data.period || '';
    }
    
    renderSearchResults();
  } catch (err) {
    if (err.name === 'AbortError' || requestId !== state.searchRequestId) return;
    console.error('[Search Error]', err);
    showToast(isChart ? '热榜加载失败，请重试' : '搜索失败，请重试', 'error');
    el.songList.innerHTML = `
      <div class="empty-state">
        <p>${isChart ? '热榜加载失败，请重试' : '搜索失败了，请重试'}</p>
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
      if (params.chart) {
        state.listTitle = data.titleDetail || data.title || state.listTitle || DEFAULT_HOME_CHART.title;
        state.listUpdatedAt = data.updateTime || data.period || state.listUpdatedAt || '';
      }
      appendSearchResults(newSongs);
      renderResultCount();
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
function renderResultCount() {
  if (state.currentFeed === 'chart') {
    const title = state.listTitle || DEFAULT_HOME_CHART.title;
    const updatedAt = state.listUpdatedAt ? ` · ${state.listUpdatedAt}` : '';
    el.resultsCount.innerText = `${title}${updatedAt} · 共 ${state.totalCount} 首歌曲`;
    return;
  }
  el.resultsCount.innerText = `共 ${state.totalCount} 首歌曲`;
}

function renderSearchResults() {
  const list = state.currentResults;
  renderResultCount();

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
    item.dataset.songKey = songKey;

    const hasCover = Boolean(song.img && /^https?:\/\//i.test(song.img));

    item.innerHTML = `
      <button class="song-cover-wrapper song-cover-button" type="button" aria-label="歌曲封面">
        <span class="song-cover-placeholder" style="${hasCover ? 'display:none;' : ''}">♪</span>
        <img class="song-cover" alt="Cover" style="${hasCover ? 'display:block;' : 'display:none;'}">
        <span class="song-cover-entry-label" aria-hidden="true">进入播放页</span>
      </button>
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
        <div class="song-secondary-actions">
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
          <button class="song-btn share-btn" type="button" title="分享">
            <svg class="share-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="18" cy="5" r="3"/>
              <circle cx="6" cy="12" r="3"/>
              <circle cx="18" cy="19" r="3"/>
              <path d="M8.59 13.51l6.83 3.98M15.41 6.51 8.59 10.49"/>
            </svg>
            <svg class="share-loading-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display: none;">
              <path d="M21 12a9 9 0 1 1-2.64-6.36"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    item.querySelector('.download-progress-wrapper').addEventListener('click', (e) => {
      e.stopPropagation();
      openDownloadModal(song);
    });

    item.querySelector('.song-cover-button').addEventListener('click', (e) => {
      e.stopPropagation();
      if (isSongReadyForPlayerPage(song)) {
        openSharePlayerPage(song, e.currentTarget);
      } else {
        setSongItemExpanded({ toggle: true });
      }
    });

    item.querySelector('.share-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('loading');
      btn.querySelector('.share-icon').style.display = 'none';
      btn.querySelector('.share-loading-icon').style.display = 'block';
      try {
        const shareUrl = await createShareLink(song);
        try {
          await copyTextToClipboard(shareUrl);
          showToast('分享链接已复制', 'success');
        } catch (copyErr) {
          console.warn('[Share Copy Error]', copyErr);
          showShareLinkModal(shareUrl);
          showToast('分享链接已生成，请手动复制', 'warning');
        }
      } catch (err) {
        console.error('[Share Error]', err);
        showToast(`分享失败: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.querySelector('.share-icon').style.display = 'block';
        btn.querySelector('.share-loading-icon').style.display = 'none';
      }
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
      if (e.target.closest('button') || e.target.closest('.download-progress-wrapper') || e.target.closest('.song-secondary-actions') || e.target.closest('.play-progress-wrapper') || e.target.closest('.player-progress-container') || e.target.closest('.player-lyric-container')) {
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

    if (isSongReadyForPlayerPage(song)) {
      setPlayerPageEntryReady(item, true);
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
  if (isDownloadBusy()) {
    showDownloadBusyToast();
    return;
  }

  songToDownload = song;
  el.modalSongName.innerText = `${song.singer} - ${song.name}`;
  
  // Show/hide quality options based on actual song capabilities and active sandbox support
  const songTypes = song.types?.length ? song.types : [{ type: '128k', size: '1.2 MB' }];
  const songQualities = songTypes.map(t => t.type);
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
      const typeInfo = songTypes.find(t => t.type === q);
      if (typeInfo && sizeEl) {
        sizeEl.innerText = `约 ${typeInfo.size}`;
      }
    } else {
      btn.style.display = 'none';
    }
  });
  
  el.qualityModal.classList.remove('force-hidden');
  el.qualityModal.classList.add('active');
}

async function startDownloadTask(song, quality) {
  if (isDownloadBusy()) {
    showDownloadBusyToast();
    return;
  }

  const selectedQuality = normalizeQualityType(quality) || quality;
  const defaultExt = getDefaultExtensionForQuality(selectedQuality);
  const displayFilename = buildSongFilename(song, defaultExt);

  if (tryDownloadFromActivePlayback(song, selectedQuality)) return;

  const taskId = Date.now().toString();
  lockDownloadTask(taskId, song);

  const taskEl = createDownloadTaskElement(taskId, displayFilename);

  showToast(`开始下载任务: ${song.name}`, 'info');
  updateDownloadProgressOnCard(song.songmid, song.source, 0);

  try {
    const { statusText, sizeText, progressFill, pctText, actionEl } = getDownloadTaskUi(taskId);

    const useRawDownload = isMobileBrowser();
    const mobileDownload = isMobileBrowser();
    statusText.innerText = '正在解析链接...';
    updateDownloadProgressOnCard(song.songmid, song.source, 5);

    const downloadOptions = {
      validate: mobileDownload ? false : 'headers',
      includeCover: false,
      useExistingCover: false,
      raw: useRawDownload,
    };
    const { downloadUrl, resolution, mediaInfo, finalFilename } = mobileDownload
      ? await createMobileDownloadLink(song, quality, displayFilename, statusText, downloadOptions)
      : await createDownloadLinkWithFallback(song, quality, displayFilename, statusText, {
        ...downloadOptions,
        loadTimeoutMs: DOWNLOAD_RESOLVE_TIMEOUT_MS,
        resolveTimeoutMs: DOWNLOAD_RESOLVE_TIMEOUT_MS,
        fallbackBatchLimit: DOWNLOAD_FALLBACK_BATCH_LIMIT,
        fallbackSearchTimeoutMs: DOWNLOAD_FALLBACK_SEARCH_TIMEOUT_MS,
        resolverUrls: getDownloadResolverUrlsToTry(DOWNLOAD_MAX_RESOLVERS),
      });
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
      releaseDownloadTask(taskId);
      return;
    }

    try {
      await downloadInsidePage(downloadUrl, finalFilename, { statusText, sizeText, progressFill, pctText, actionEl }, song, { taskId });
      releaseDownloadTask(taskId);
      if (isQualityChanged) {
        showToast(`文件已生成: ${song.name} (实际下载为 ${formatQualityLabel(actualQuality)})`, 'warning');
      } else if (usedFallback) {
        showToast(`文件已生成: ${song.name} (已自动切换到${getPlatformName(resolvedSong.source)})`, 'success');
      } else {
        showToast(`文件已生成: ${song.name}`, 'success');
      }
    } catch (err) {
      console.warn('[Download] in-page download interrupted:', err);
      const reason = getReadableError(err);
      statusText.innerText = `网页内下载中断: ${reason}`;
      statusText.className = 'queue-status warning';
      sizeText.innerText = '可改用浏览器下载同一文件';
      progressFill.style.width = '100%';
      pctText.innerText = '待处理';
      updateDownloadProgressOnCard(song.songmid, song.source, 100, false, true);
      showBrowserDownloadAction({ actionEl, downloadUrl, filename: finalFilename, statusText, taskId });
      showToast('网页内下载中断，请点击“用浏览器下载”继续', 'warning');
    }

  } catch (err) {
    console.error('[Download Task Error]', err);
    releaseDownloadTask(taskId);
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
  if (!songmid || !source) return;
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
const USER_GESTURE_UNLOCK_AUDIO_SRC = 'data:audio/wav;base64,UklGRmQBAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
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
let activePlaybackContext = null;
let playbackGestureUnlocked = false;

function unlockPlaybackFromUserGesture() {
  if (playbackGestureUnlocked) return;
  if (activeSongId || audio.currentSrc || audio.getAttribute('src')) return;

  const previousVolume = audio.volume;
  const previousMuted = audio.muted;

  try {
    audio.muted = true;
    audio.preload = 'auto';
    audio.src = USER_GESTURE_UNLOCK_AUDIO_SRC;

    const cleanup = () => {
      if (audio.getAttribute('src') === USER_GESTURE_UNLOCK_AUDIO_SRC) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      audio.muted = previousMuted;
      audio.volume = previousVolume;
    };

    const playPromise = audio.play();
    if (playPromise?.then) {
      playPromise.then(() => {
        playbackGestureUnlocked = true;
        cleanup();
      }).catch((err) => {
        cleanup();
        console.warn('[Playback] mobile audio unlock failed:', err.message || err);
      });
    } else {
      cleanup();
      playbackGestureUnlocked = true;
    }
  } catch (err) {
    audio.muted = previousMuted;
    audio.volume = previousVolume;
    console.warn('[Playback] mobile audio unlock failed:', err.message || err);
  }
}

function getSongItemByKey(songKey) {
  return Array.from(document.querySelectorAll('.song-item')).find(item => item.dataset.songKey === songKey) || null;
}

function clearPlayerPageEntryReady() {
  document.querySelectorAll('.song-item.player-page-entry-ready').forEach(item => {
    item.classList.remove('player-page-entry-ready');
    const coverButton = item.querySelector('.song-cover-button');
    if (coverButton) {
      coverButton.removeAttribute('title');
      coverButton.setAttribute('aria-label', '歌曲封面');
    }
  });
}

function setPlayerPageEntryReady(itemEl, isReady) {
  if (!itemEl) return;
  if (isReady) {
    clearPlayerPageEntryReady();
    itemEl.classList.add('player-page-entry-ready');
    const coverButton = itemEl.querySelector('.song-cover-button');
    if (coverButton) {
      coverButton.title = '进入播放页';
      coverButton.setAttribute('aria-label', '进入播放页');
    }
  } else {
    itemEl.classList.remove('player-page-entry-ready');
  }
}

function isSongReadyForPlayerPage(song) {
  return Boolean(
    activeSongId &&
    activeSongId === getSongKey(song) &&
    activePlaybackContext?.audioUrl &&
    !audio.ended
  );
}

function createPlaybackStateSnapshot() {
  if (!activePlaybackContext?.audioUrl || !activePlaybackContext?.song || !activeSongId) return null;
  return {
    songKey: activeSongId,
    song: activePlaybackContext.song,
    audioUrl: audio.currentSrc || activePlaybackContext.audioUrl,
    downloadUrl: activePlaybackContext.downloadUrl || '',
    filename: activePlaybackContext.filename || '',
    quality: activePlaybackContext.quality || '128k',
    lyrics: Array.isArray(activeLyrics) ? activeLyrics.slice(0, 220) : [],
    currentTime: getFiniteSeconds(audio.currentTime),
    duration: getFiniteSeconds(audio.duration),
    paused: audio.paused,
    ended: audio.ended,
  };
}

function buildCurrentPlaybackPageUrl(song) {
  if (!isSongReadyForPlayerPage(song)) {
    throw new Error('请先播放成功后再进入播放页');
  }

  const snapshot = createPlaybackStateSnapshot();
  if (!snapshot) throw new Error('当前播放信息不可用');

  return buildSharePageUrl({
    entry: 'search',
    songKey: snapshot.songKey,
    song: snapshot.song,
    audioUrl: toAbsoluteUrl(snapshot.audioUrl),
    downloadUrl: snapshot.downloadUrl ? toAbsoluteUrl(snapshot.downloadUrl) : toAbsoluteUrl(snapshot.audioUrl),
    filename: snapshot.filename || buildSongFilename(snapshot.song, 'mp3'),
    lyrics: snapshot.lyrics,
    currentTime: snapshot.currentTime,
    duration: snapshot.duration,
    autoplay: !snapshot.paused && !snapshot.ended,
  });
}

const inlinePlayer = createPlayerPageController({
  idPrefix: 'inlinePlayer',
  overlay: true,
  rootId: 'inlinePlayerOverlay',
  rootClassName: 'inline-player-overlay',
  pageClassName: 'inline-player-page',
  panelLabel: '播放界面',
  backLabel: '返回搜索结果',
  homeLabel: '返回搜索结果',
  homeIcon: 'back',
  showTopBack: false,
  logPrefix: '[Inline Player]',
  getAudio: () => audio,
  getCurrentTime: () => audio.currentTime,
  getDuration: () => audio.duration,
  getEstimatedDuration: () => intervalToSeconds(activePlaybackContext?.song?.interval),
  getLyrics: () => activeLyrics,
  seek: (time) => {
    audio.currentTime = time;
  },
  playPause: async () => {
    if (audio.paused) {
      await audio.play();
    } else {
      audio.pause();
    }
  },
  download: () => {
    if (!activePlaybackContext?.song) return;
    openDownloadModal(activePlaybackContext.song);
  },
  back: closeInlinePlayerOverlay,
  home: closeInlinePlayerOverlay,
  lookupCover: getBestCoverUrl,
  themeTargets: ({ root, page }) => [root, page].filter(Boolean),
});

function ensureInlinePlayerOverlay() {
  inlinePlayer.ensureMounted();
  return inlinePlayer;
}

function closeInlinePlayerOverlay() {
  inlinePlayer.close();
  document.body.classList.remove('inline-player-open');
}

function setInlinePlayerPlayState(isPlaying) {
  inlinePlayer.setPlayState(isPlaying);
}

function updateInlinePlayerProgress() {
  inlinePlayer.updateProgress();
}

function syncInlinePlayerLyrics(time = audio.currentTime, duration = audio.duration) {
  inlinePlayer.syncLyrics(time, duration);
}

function stopInlinePlayerFrame() {
  inlinePlayer.stopFrame();
}

function startInlinePlayerFrame() {
  inlinePlayer.startFrame();
}

function openInlinePlayerOverlay(song) {
  if (!isSongReadyForPlayerPage(song)) {
    throw new Error('请先播放成功后再进入播放页');
  }

  ensureInlinePlayerOverlay();
  document.body.classList.add('inline-player-open');
  inlinePlayer.open({
    song: activePlaybackContext?.song || song,
    lyrics: activeLyrics,
  });
}
function restorePlaybackStateSnapshot() {
  const snapshot = readPlaybackStateSnapshot();
  if (!snapshot?.audioUrl || !snapshot?.song) return false;

  const songKey = snapshot.songKey || getSongKey(snapshot.song);
  const itemEl = getSongItemByKey(songKey);
  if (!itemEl) return false;

  activeSongId = songKey;
  activePlayBtn = itemEl.querySelector('.play-btn');
  activeProgressSlider = itemEl.querySelector('.player-progress-slider');
  activeCurrentTimeText = itemEl.querySelector('.player-current-time');
  activeTotalTimeText = itemEl.querySelector('.player-total-time');
  activeLyricContainer = itemEl.querySelector('.player-lyric-container');
  activeLyricLineEl = itemEl.querySelector('.player-lyric-line');
  activeLyrics = Array.isArray(snapshot.lyrics) ? snapshot.lyrics : [];
  lastLyricIndex = -1;
  activePlaybackContext = {
    song: snapshot.song,
    audioUrl: snapshot.audioUrl,
    downloadUrl: snapshot.downloadUrl || '',
    filename: snapshot.filename || '',
    quality: snapshot.quality || '128k',
  };

  itemEl.classList.add('expanded');
  setPlayerPageEntryReady(itemEl, true);
  if (activeCurrentTimeText) activeCurrentTimeText.innerText = formatTime(snapshot.currentTime || 0);
  if (activeTotalTimeText) activeTotalTimeText.innerText = formatTime(snapshot.duration || 0);
  if (activeProgressSlider && snapshot.duration) {
    activeProgressSlider.value = Math.max(0, Math.min(100, (Number(snapshot.currentTime || 0) / Number(snapshot.duration)) * 100));
  }

  const restoreTime = getFiniteSeconds(snapshot.currentTime);
  const shouldResume = !snapshot.paused && !snapshot.ended;

  audio.addEventListener('loadedmetadata', () => {
    if (restoreTime) {
      try {
        const duration = getFiniteSeconds(audio.duration);
        audio.currentTime = duration ? Math.min(restoreTime, Math.max(0, duration - 0.2)) : restoreTime;
      } catch (err) {
        console.warn('[Playback] failed to restore time', err);
      }
    }
    if (activeTotalTimeText) activeTotalTimeText.innerText = formatTime(audio.duration);
    triggerLyricScrollSync();
    if (shouldResume) {
      audio.play().catch((err) => {
        console.warn('[Playback] resume after return failed:', err);
      });
    }
  }, { once: true });
  audio.src = snapshot.audioUrl;

  if (!activeLyrics.length) {
    fetchLyrics(snapshot.song).then((parsedLyrics) => {
      if (activeSongId !== songKey) return;
      activeLyrics = parsedLyrics || [];
      lastLyricIndex = -1;
      triggerLyricScrollSync();
      if (!activeLyrics.length && activeLyricLineEl) activeLyricLineEl.innerText = '暂无歌词';
    }).catch(() => {
      if (activeSongId === songKey && activeLyricLineEl) activeLyricLineEl.innerText = '暂无歌词';
    });
  } else {
    triggerLyricScrollSync();
  }

  return true;
}

audio.addEventListener('timeupdate', () => {
  if (activeSongId && activeProgressSlider && activeCurrentTimeText && !isUserSeeking) {
    const pct = (audio.currentTime / audio.duration) * 100 || 0;
    activeProgressSlider.value = pct;
    activeCurrentTimeText.innerText = formatTime(audio.currentTime);
  }

  updateInlinePlayerProgress();

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
  if (!inlinePlayer.isLyricDragging()) syncInlinePlayerLyrics(audio.currentTime, audio.duration);
});

audio.addEventListener('loadedmetadata', () => {
  const loadedDuration = getFiniteSeconds(audio.duration);
  const expectedDuration = intervalToSeconds(activePlaybackContext?.song?.interval);
  if (
    activeSongId &&
    expectedDuration >= PLAYBACK_SHORT_MIN_EXPECTED_SECONDS &&
    loadedDuration > 0 &&
    loadedDuration <= PLAYBACK_INVALID_SHORT_AUDIO_SECONDS
  ) {
    showToast(`解析结果只有 ${formatTime(loadedDuration)}，疑似试听片段`, 'error');
    closeInlinePlayerOverlay();
    resetActiveSongUI();
    return;
  }

  if (activeSongId && activeTotalTimeText) {
    activeTotalTimeText.innerText = formatTime(audio.duration);
  }
  if (!inlinePlayer.isLyricDragging()) {
    updateInlinePlayerProgress();
    syncInlinePlayerLyrics(audio.currentTime, audio.duration);
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
    setPlayerPageEntryReady(activePlayBtn.closest('.song-item'), true);
  }
  setInlinePlayerPlayState(true);
  startInlinePlayerFrame();
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
  setInlinePlayerPlayState(false);
  stopInlinePlayerFrame();
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
  clearPlayerPageEntryReady();
  setInlinePlayerPlayState(false);
  updateInlinePlayerProgress();
  stopInlinePlayerFrame();
});

audio.addEventListener('error', () => {
  if (activeSongId) {
    console.error('[Audio Error]', audio.error);
    showToast('播放出错，无法加载音频流', 'error');
    closeInlinePlayerOverlay();
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
  if (inlinePlayer.isLyricDragging()) return;
  lastLyricIndex = -1;
  inlinePlayer.setLyrics(activeLyrics);
  inlinePlayer.resetLyricIndex();
  const e = new Event('timeupdate');
  audio.dispatchEvent(e);
}

function getLyricTextFromPayload(payload) {
  if (!payload) return '';
  const data = payload.data || payload;
  return data.lxlyric || data.lyric || data.lrc || data.rawLrc || data.text || '';
}

// Fetch lyrics with native sandbox first, falling back to platform APIs.
async function fetchLyrics(song) {
  const cacheKey = getLyricCacheKey(song);
  const cached = lyricCache.get(cacheKey);
  if (cached?.length) return cached;
  if (lyricInflight.has(cacheKey)) return lyricInflight.get(cacheKey);

  const loadPromise = withTimeout(
    Promise.any([
      fetchLyricsFromSandbox(song),
      fetchLyricsFromApi(song),
    ]),
    LYRIC_TOTAL_TIMEOUT_MS,
    '歌词加载超时'
  ).then((lyrics) => {
    const parsed = Array.isArray(lyrics) ? lyrics : [];
    if (parsed.length) cacheLyrics(cacheKey, parsed);
    return parsed;
  }).catch((err) => {
    console.warn('[Lyric] lyric lookup failed', err);
    return [];
  }).finally(() => {
    lyricInflight.delete(cacheKey);
  });

  lyricInflight.set(cacheKey, loadPromise);
  return loadPromise;
}

async function fetchLyricsFromSandbox(song) {
  if (!state.sandbox) throw new Error('解析源未加载');

  const attempts = [
    { label: 'new', musicInfo: toNewMusicInfo(song) },
    { label: 'old', musicInfo: toOldMusicInfo(song) },
  ];
  const errors = [];

  for (const attempt of attempts) {
    try {
      const resolved = await withTimeout(
        state.sandbox.requestUrl(song.source, 'lyric', { musicInfo: attempt.musicInfo }),
        LYRIC_NATIVE_TIMEOUT_MS,
        `解析源歌词 ${attempt.label} 超时`
      );
      const parsed = parseLrc(getLyricTextFromPayload(resolved));
      if (parsed.length) {
        console.log(`[Lyric] Successfully fetched native lyrics from sandbox (${attempt.label})`);
        return parsed;
      }
      errors.push(`${attempt.label}: empty lyric`);
    } catch (err) {
      errors.push(`${attempt.label}: ${err.message || err}`);
    }
  }

  throw new Error(errors.join('; ') || '解析源未返回歌词');
}

async function fetchLyricsFromApi(song) {
  const res = await fetchWithAbortTimeout(`/api/lyric?${buildLyricParams(song).toString()}`, {
    cache: 'no-store',
  }, LYRIC_API_TIMEOUT_MS);
  if (!res.ok) throw new Error(`歌词接口 HTTP ${res.status}`);

  const data = await res.json();
  const parsed = parseLrc(getLyricTextFromPayload(data));
  if (parsed.length) {
    console.log(`[Lyric] Successfully fetched fallback lyrics from ${data.provider || 'api'}`);
    return parsed;
  }
  throw new Error('歌词接口未返回有效歌词');
}

function parseLrc(lrcText) {
  const lines = lrcText.split('\n');
  const parsed = [];
  const timeReg = /\[(\d+):(\d+)(?:\.(\d+))?\]/g;
  const wordTimeReg = /<(-?\d+),(-?\d+)(?:,-?\d+)?>/g;
  const parenWordTimeReg = /\((-?\d+),(-?\d+)(?:,-?\d+)?\)/g;
  const parseWordTimings = (rawText) => {
    const tagReg = rawText.includes('<') ? wordTimeReg : parenWordTimeReg;
    const words = [];
    let match;
    let lastIndex = 0;
    let currentTiming = null;
    tagReg.lastIndex = 0;

    while ((match = tagReg.exec(rawText)) !== null) {
      const segment = rawText.slice(lastIndex, match.index);
      if (currentTiming && segment) {
        words.push({
          text: segment,
          start: Math.max(0, Number(currentTiming.start) / 1000),
          duration: Math.max(0.08, Number(currentTiming.duration) / 1000),
        });
      } else if (segment.replace(/\s/g, '')) {
        words.push({ text: segment, start: 0, duration: 0 });
      }
      currentTiming = {
        start: parseInt(match[1], 10),
        duration: parseInt(match[2], 10),
      };
      lastIndex = tagReg.lastIndex;
    }

    const tail = rawText.slice(lastIndex);
    if (currentTiming && tail) {
      words.push({
        text: tail,
        start: Math.max(0, Number(currentTiming.start) / 1000),
        duration: Math.max(0.08, Number(currentTiming.duration) / 1000),
      });
    } else if (tail.replace(/\s/g, '')) {
      words.push({ text: tail, start: 0, duration: 0 });
    }

    return words.filter(word => word.text);
  };
  for (const line of lines) {
    const rawText = line.replace(timeReg, '').trim();
    const text = line
      .replace(timeReg, '')
      .replace(wordTimeReg, '')
      .replace(parenWordTimeReg, '')
      .trim();
    const words = parseWordTimings(rawText);
    let match;
    timeReg.lastIndex = 0;
    while ((match = timeReg.exec(line)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].slice(0, 3).padEnd(3, '0'), 10) : 0;
      const time = min * 60 + sec + ms / 1000;
      parsed.push({ time, text, words });
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
  unlockPlaybackFromUserGesture();

  const dummyStatusText = {
    set innerText(val) {
      console.log('[Play Resolution]', val);
    }
  };

  try {
    const displayFilename = buildSongFilename(song, 'mp3');
    const { downloadUrl, resolution, finalFilename } = await createPlaybackLinkWithFallback(song, '128k', displayFilename, dummyStatusText, {
      validate: false,
      includeCover: false,
      loadTimeoutMs: 8000,
      resolveTimeoutMs: 8000,
    });
    const playbackSong = resolution?.resolvedSong || song;
    
    if (loadingSongId !== songKey) return;
    
    // Loaded URL successfully! Stop current song and switch now
    loadingSongId = null;
    clearPlayerPageEntryReady();

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
    const contextSong = {
      ...song,
      ...playbackSong,
      name: playbackSong.name || song.name || '',
      singer: playbackSong.singer || song.singer || '',
      albumName: playbackSong.albumName || song.albumName || '',
      interval: playbackSong.interval || song.interval || '',
      img: playbackSong.img || song.img || '',
      cover: playbackSong.cover || playbackSong.img || song.cover || song.img || '',
      source: playbackSong.source || song.source || '',
      songmid: playbackSong.songmid || song.songmid || '',
      types: playbackSong.types?.length ? playbackSong.types : (song.types || []),
      _types: Object.keys(playbackSong._types || {}).length ? playbackSong._types : (song._types || {}),
      typeUrl: playbackSong.typeUrl || song.typeUrl || {},
    };
    activePlaybackContext = {
      song: contextSong,
      audioUrl: getPlaybackDownloadUrl(downloadUrl),
      downloadUrl,
      filename: finalFilename || displayFilename,
      quality: '128k',
    };

    currentTimeText.innerText = '00:00';
    slider.value = 0;
    if (activeLyricLineEl) activeLyricLineEl.innerText = '歌词加载中...';

    audio.volume = 1;
    audio.src = activePlaybackContext.audioUrl;
    fetchLyrics(playbackSong).then((parsedLyrics) => {
      if (activeSongId !== songKey) return;
      activeLyrics = parsedLyrics || [];
      if (activePlaybackContext) activePlaybackContext.lyrics = activeLyrics;
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
  activePlaybackContext = null;
  lastLyricIndex = -1;
  clearPlayerPageEntryReady();
}

// Run App
window.addEventListener('DOMContentLoaded', init);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    sessionStorage.removeItem(SEARCH_STATE_STORAGE_KEY);
    restorePlaybackStateSnapshot();
  }
});
