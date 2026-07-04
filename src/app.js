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
const RESOLUTION_HEADER_TIMEOUT_MS = 7000;
const RESOLUTION_METADATA_TIMEOUT_MS = 12000;
const LYRIC_NATIVE_TIMEOUT_MS = 4200;
const LYRIC_API_TIMEOUT_MS = 8500;
const LYRIC_TOTAL_TIMEOUT_MS = 9500;
const LYRIC_CACHE_LIMIT = 80;
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function rgbToCss(rgb) {
  return rgb.map(value => Math.round(clamp(value, 0, 255))).join(', ');
}

function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return [h, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) {
    const value = l * 255;
    return [value, value, value];
  }

  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hue2rgb(p, q, h + 1 / 3) * 255,
    hue2rgb(p, q, h) * 255,
    hue2rgb(p, q, h - 1 / 3) * 255,
  ];
}

function buildThemeFromColor(rgb) {
  const [h, s, l] = rgbToHsl(rgb);
  const saturation = clamp(s, 0.28, 0.78);

  return {
    main: hslToRgb([h, saturation, clamp(l, 0.32, 0.46)]),
    dark: hslToRgb([h, clamp(saturation * 0.86, 0.22, 0.64), 0.08]),
    soft: hslToRgb([h, clamp(saturation * 0.92, 0.38, 0.82), 0.68]),
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('封面图片加载失败'));
    img.src = src;
  });
}

function getDominantColorFromImage(img) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('当前浏览器不支持封面取色');

  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const buckets = new Map();
  let fallback = [0, 0, 0];
  let fallbackWeight = 0;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 180) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    const saturation = max === 0 ? 0 : (max - min) / max;

    if (lightness < 10 || lightness > 246) continue;

    const fallbackScore = 1 + saturation;
    fallback[0] += r * fallbackScore;
    fallback[1] += g * fallbackScore;
    fallback[2] += b * fallbackScore;
    fallbackWeight += fallbackScore;

    if (saturation < 0.08 || lightness < 28 || lightness > 232) continue;

    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const vividness = saturation * 1.7;
    const midTone = 1 - Math.min(1, Math.abs(lightness - 128) / 128);
    const score = 1 + vividness + midTone;
    const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, weight: 0, count: 0 };
    bucket.r += r * score;
    bucket.g += g * score;
    bucket.b += b * score;
    bucket.weight += score;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  let best = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.weight > best.weight) best = bucket;
  }

  if (best?.weight) return [best.r / best.weight, best.g / best.weight, best.b / best.weight];
  if (fallbackWeight) return fallback.map(value => value / fallbackWeight);
  throw new Error('封面没有可用于取色的像素');
}

function applyThemeToInlinePlayer(theme) {
  if (!inlinePlayer.root) return;
  const page = inlinePlayer.root.querySelector('.share-page');
  for (const target of [inlinePlayer.root, page].filter(Boolean)) {
    target.style.setProperty('--share-theme-rgb', rgbToCss(theme.main));
    target.style.setProperty('--share-theme-dark-rgb', rgbToCss(theme.dark));
    target.style.setProperty('--share-theme-soft-rgb', rgbToCss(theme.soft));
  }
}

function clearInlinePlayerTheme() {
  if (!inlinePlayer.root) return;
  const page = inlinePlayer.root.querySelector('.share-page');
  for (const target of [inlinePlayer.root, page].filter(Boolean)) {
    target.style.removeProperty('--share-theme-rgb');
    target.style.removeProperty('--share-theme-dark-rgb');
    target.style.removeProperty('--share-theme-soft-rgb');
  }
}

async function applyInlineThemeFromCover(coverUrl, metadataToken = inlinePlayer.metadataToken) {
  const proxyUrl = getImageProxyUrl(coverUrl);
  if (!proxyUrl) return;

  try {
    const img = await loadImage(proxyUrl);
    if (metadataToken !== inlinePlayer.metadataToken) return;
    const dominantColor = getDominantColorFromImage(img);
    if (metadataToken !== inlinePlayer.metadataToken) return;
    applyThemeToInlinePlayer(buildThemeFromColor(dominantColor));
  } catch (err) {
    console.warn('[Inline Player] cover theme extraction failed:', err);
  }
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
      currentKeyword: state.currentKeyword || el.searchInput.value.trim(),
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

  setSelectedPlatformUI(snapshot.currentSource || 'tx');
  state.currentKeyword = restoredKeyword;
  state.currentResults = restoredResults;
  state.currentPage = Number(snapshot.currentPage || 1);
  state.totalCount = Number(snapshot.totalCount || restoredResults.length || 0);
  state.activeSearchKey = snapshot.activeSearchKey || getSearchKey(restoredKeyword, state.currentSource);
  state.isLoading = false;
  state.loadingMode = '';
  state.searchAbortController = null;
  el.searchInput.value = restoredKeyword;
  updateClearSearchButton();
  showBottomLoadingIndicator(false);

  if (restoredKeyword && restoredResults.length) {
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

function probeAudioMetadata(playbackUrl) {
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
    }, RESOLUTION_METADATA_TIMEOUT_MS);

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
}

function showReleaseDownloadAction({ actionEl, taskId, statusText }) {
  if (!actionEl) return;

  const button = document.createElement('button');
  button.className = 'queue-save-btn secondary';
  button.type = 'button';
  button.textContent = '下载完成，允许下一首';
  actionEl.innerHTML = '';
  actionEl.appendChild(button);

  button.addEventListener('click', () => {
    releaseDownloadTask(taskId);
    button.disabled = true;
    statusText.innerText = '已允许下载下一首';
    statusText.className = 'queue-status completed';
    showToast('可以开始下一首下载了', 'success');
  });
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

function getResolverUrlsToTry() {
  return [state.scriptUrl, ...SOURCE_URLS.filter(u => u !== state.scriptUrl)];
}

async function loadResolverForDownload(url) {
  const sourceName = getResolverName(url);
  return withTimeout(
    getOrLoadSandbox(url),
    RESOLVE_TIMEOUT_MS,
    `${sourceName}加载超时`
  );
}

async function resolveWithLoadedResolver(url, sandboxInstance, song, quality, statusText, validateResolution) {
  const sourceName = getResolverName(url);
  statusText.innerText = `正在用${sourceName}解析 ${getPlatformName(song.source)}...`;
  console.log(`[Download] Trying resolution with resolver: ${url}, source: ${song.source}`);

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

  throw new Error('解析服务未返回有效链接');
}

async function resolveWithScripts(song, quality, statusText, validateResolution) {
  let lastError = null;

  for (const url of getResolverUrlsToTry()) {
    try {
      const sandboxInstance = await loadResolverForDownload(url);
      return await resolveWithLoadedResolver(url, sandboxInstance, song, quality, statusText, validateResolution);
    } catch (err) {
      lastError = err;
      console.warn(`[Download] Resolver ${url} failed for ${song.source}:`, err.message);
    }
  }

  if (lastError) throw lastError;
  throw new Error('解析服务未返回有效链接');
}

function buildDownloadProxyUrl(resolution, finalFilename, metadataSong, finalExt, coverUrl = '') {
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
  return `/api/download?${params.toString()}`;
}

async function buildDownloadUrlFromResolution(resolution, quality, filename, song, statusText, options = {}) {
  const { validate = true, includeCover = true } = options;
  const sourceName = getResolverName(resolution.successfulUrl);

  const mediaInfo = getDownloadMediaInfo('', quality, resolution.resolvedQuality, resolution.audioUrl);
  const finalExt = mediaInfo.actualExt || getDefaultExtensionForQuality(mediaInfo.actualQuality || quality);
  const finalFilename = buildSongFilename(song, finalExt);
  const metadataSong = resolution.resolvedSong || song;
  const preliminaryDownloadUrl = buildDownloadProxyUrl(resolution, finalFilename, metadataSong, finalExt);
  if (validate) {
    await validateResolvedDownload(preliminaryDownloadUrl, metadataSong, statusText, resolution);
  }

  statusText.innerText = `[${sourceName}] 正在准备带封面和歌手信息的下载...`;
  const coverUrl = includeCover ? await getBestCoverUrl(metadataSong) : (metadataSong.img || '');
  const downloadUrl = buildDownloadProxyUrl(resolution, finalFilename, metadataSong, finalExt, coverUrl);

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
  });
}

async function createDownloadLinkWithFallback(song, quality, filename, statusText, options = {}) {
  let lastError = null;
  let alternativesPromise = null;

  const getAlternatives = (sourceName) => {
    if (!alternativesPromise) {
      statusText.innerText = `[${sourceName}] 原平台不可用，正在匹配其它平台...`;
      alternativesPromise = findAlternativeSongs(song, quality);
    }
    return alternativesPromise;
  };

  for (const url of getResolverUrlsToTry()) {
    const sourceName = getResolverName(url);
    let sandboxInstance = null;
    try {
      sandboxInstance = await loadResolverForDownload(url);
    } catch (err) {
      lastError = err;
      console.warn(`[Download] Resolver ${url} load failed:`, err.message);
      continue;
    }

    try {
      return await resolveWithLoadedResolver(url, sandboxInstance, song, quality, statusText, (resolution) => {
        return buildDownloadUrlFromResolution(resolution, quality, filename, song, statusText, options);
      });
    } catch (err) {
      lastError = err;
      console.warn(`[Download] ${sourceName} original ${song.source} failed:`, err.message);
    }

    const alternatives = await getAlternatives(sourceName);
    if (!alternatives.length) {
      console.warn('[Download] no fallback platform candidates found');
      continue;
    }

    for (const candidate of alternatives) {
      try {
        statusText.innerText = `[${sourceName}] 正在尝试 ${getPlatformName(candidate.source)}...`;
        return await resolveWithLoadedResolver(url, sandboxInstance, candidate, quality, statusText, (resolution) => {
          return buildDownloadUrlFromResolution(resolution, quality, filename, candidate, statusText, options);
        });
      } catch (err) {
        lastError = err;
        console.warn(`[Download] ${sourceName} fallback ${candidate.source} failed:`, err.message);
      }
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
  const { downloadUrl, resolution, finalFilename } = await createDownloadLinkWithFallback(song, '128k', displayFilename, statusText);
  const resolvedSong = resolution.resolvedSong || song;
  const coverUrl = await getBestCoverUrl(resolvedSong);
  let lyrics = [];
  try {
    lyrics = await fetchLyrics(resolvedSong);
  } catch (err) {
    console.warn('[Share] lyric preload failed:', err);
  }

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
      cover: coverUrl || '',
    },
    audioUrl: toAbsoluteUrl(getPlaybackDownloadUrl(downloadUrl)),
    downloadUrl: toAbsoluteUrl(downloadUrl),
    filename: finalFilename || displayFilename,
    lyrics: Array.isArray(lyrics) ? lyrics.slice(0, 180) : [],
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
  restoreSearchStateSnapshot();
  restorePlaybackStateSnapshot();

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
  const handleQualitySelect = (event) => {
    const btn = event.target?.closest?.('.quality-btn');
    if (!btn || !el.qualityModal.classList.contains('active')) return;
    if (btn.disabled || btn.style.display === 'none') return;

    event.preventDefault();
    event.stopPropagation();

    const quality = btn.getAttribute('data-quality');
    const downloadSong = songToDownload;
    songToDownload = null;
    el.qualityModal.classList.remove('active');

    if (downloadSong) {
      void startDownloadTask(downloadSong, quality);
    } else {
      showToast('下载歌曲信息已失效，请重新点击下载', 'warning');
    }
  };
  el.qualityModal.addEventListener('pointerdown', handleQualitySelect, true);
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
      if (e.currentTarget.classList.contains('downloading')) return;
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
  const taskId = Date.now().toString();
  lockDownloadTask(taskId, song);

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
      releaseDownloadTask(taskId);
      return;
    }

    if (useInPageDownload) {
      try {
        await downloadInsidePage(downloadUrl, finalFilename, { statusText, sizeText, progressFill, pctText, actionEl }, song);
        releaseDownloadTask(taskId);
        if (isQualityChanged) {
          showToast(`文件已生成: ${song.name} (实际下载为 ${formatQualityLabel(actualQuality)})`, 'warning');
        } else if (usedFallback) {
          showToast(`文件已生成: ${song.name} (已自动切换到${getPlatformName(resolvedSong.source)})`, 'success');
        } else {
          showToast('文件已生成，点击保存文件即可存到手机', 'success');
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
      return;
    }

    triggerBrowserDownload(downloadUrl, finalFilename);

    statusText.innerText = '已创建浏览器下载任务' + qualityWarnText;
    statusText.className = 'queue-status completed';
    sizeText.innerText = '请在浏览器下载栏查看进度';
    progressFill.style.width = '100%';
    pctText.innerText = '已创建';
    updateDownloadProgressOnCard(song.songmid, song.source, 100, false, true);
    releaseDownloadTask(taskId);
    
    if (isQualityChanged) {
      showToast(`已创建下载任务: ${song.name} (实际下载为 ${formatQualityLabel(actualQuality)})`, 'warning');
    } else if (usedFallback) {
      showToast(`已创建下载任务: ${song.name} (已自动切换到${getPlatformName(resolvedSong.source)})`, 'success');
    } else {
      showToast(`已创建下载任务: ${song.name}`, 'success');
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
let activePlaybackContext = null;

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

const inlinePlayer = {
  root: null,
  active: false,
  isSeeking: false,
  frameId: 0,
  lyricIndex: -1,
  lyricDrag: null,
  metadataToken: 0,
  els: {},
};

function ensureInlinePlayerOverlay() {
  if (inlinePlayer.root) return inlinePlayer;

  const root = document.createElement('div');
  root.id = 'inlinePlayerOverlay';
  root.className = 'inline-player-overlay';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <main class="share-page inline-player-page">
      <img id="inlinePlayerBgCover" class="share-bg-cover" alt="" aria-hidden="true">
      <div class="share-bg-layer" aria-hidden="true"></div>
      <button id="inlinePlayerBackBtn" class="share-back-btn" type="button" title="返回搜索结果" aria-label="返回搜索结果">
        <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M19 12H5"/>
          <path d="m12 19-7-7 7-7"/>
        </svg>
      </button>

      <section class="share-cover-stage" aria-label="歌曲封面">
        <div class="share-cover-frame">
          <div id="inlinePlayerCoverPlaceholder" class="share-cover-placeholder">♪</div>
          <img id="inlinePlayerCover" class="share-cover" alt="歌曲封面">
        </div>
      </section>

      <section class="share-player-panel" aria-label="播放界面">
        <div class="share-song-info">
          <h1 id="inlinePlayerTitle" class="share-title">歌曲</h1>
          <div id="inlinePlayerArtist" class="share-artist">歌手</div>
          <div id="inlinePlayerLyricList" class="share-lyric-list">
            <div class="share-lyric-row previous"><span class="share-lyric-text"></span><span class="share-lyric-fill" aria-hidden="true"></span></div>
            <div class="share-lyric-row active"><span class="share-lyric-text">歌词加载中...</span><span class="share-lyric-fill" aria-hidden="true">歌词加载中...</span></div>
            <div class="share-lyric-row next"><span class="share-lyric-text"></span><span class="share-lyric-fill" aria-hidden="true"></span></div>
          </div>
        </div>

        <div class="share-progress-wrap">
          <div class="share-progress-times">
            <span id="inlinePlayerCurrentTime">00:00</span>
            <span id="inlinePlayerDuration">00:00</span>
          </div>
          <input id="inlinePlayerProgressSlider" class="share-progress-slider" type="range" min="0" max="100" value="0" step="0.1" aria-label="播放进度">
        </div>
        <div class="share-control-row">
          <button id="inlinePlayerHomeBtn" class="share-panel-icon-btn" type="button" title="返回搜索结果" aria-label="返回搜索结果">
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M19 12H5"/>
              <path d="m12 19-7-7 7-7"/>
            </svg>
          </button>
          <button id="inlinePlayerPlayBtn" class="share-play-toggle" type="button" title="播放" aria-label="播放">
            <svg class="share-play-icon" width="34" height="34" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            <svg class="share-pause-icon" width="34" height="34" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
            </svg>
          </button>
          <button id="inlinePlayerDownloadBtn" class="share-panel-icon-btn" type="button" title="下载" aria-label="下载">
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <path d="M7 10l5 5 5-5"/>
              <path d="M12 15V3"/>
            </svg>
          </button>
        </div>
        <p id="inlinePlayerHint" class="share-hint"></p>
      </section>
    </main>
  `;

  document.body.appendChild(root);
  inlinePlayer.root = root;
  inlinePlayer.els = {
    bgCover: root.querySelector('#inlinePlayerBgCover'),
    cover: root.querySelector('#inlinePlayerCover'),
    coverPlaceholder: root.querySelector('#inlinePlayerCoverPlaceholder'),
    backBtn: root.querySelector('#inlinePlayerBackBtn'),
    homeBtn: root.querySelector('#inlinePlayerHomeBtn'),
    playBtn: root.querySelector('#inlinePlayerPlayBtn'),
    downloadBtn: root.querySelector('#inlinePlayerDownloadBtn'),
    title: root.querySelector('#inlinePlayerTitle'),
    artist: root.querySelector('#inlinePlayerArtist'),
    lyricList: root.querySelector('#inlinePlayerLyricList'),
    slider: root.querySelector('#inlinePlayerProgressSlider'),
    currentTime: root.querySelector('#inlinePlayerCurrentTime'),
    duration: root.querySelector('#inlinePlayerDuration'),
    hint: root.querySelector('#inlinePlayerHint'),
  };

  inlinePlayer.els.backBtn?.addEventListener('click', closeInlinePlayerOverlay);
  inlinePlayer.els.homeBtn?.addEventListener('click', closeInlinePlayerOverlay);
  inlinePlayer.els.playBtn?.addEventListener('click', async () => {
    try {
      if (audio.paused) {
        await audio.play();
      } else {
        audio.pause();
      }
    } catch (err) {
      if (inlinePlayer.els.hint) inlinePlayer.els.hint.textContent = `播放失败: ${err.message}`;
    }
  });
  inlinePlayer.els.downloadBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!activePlaybackContext?.song) return;
    openDownloadModal(activePlaybackContext.song);
  });

  inlinePlayer.els.slider?.addEventListener('input', () => {
    inlinePlayer.isSeeking = true;
    stopInlinePlayerFrame();
    const percent = Number(inlinePlayer.els.slider.value || 0);
    inlinePlayer.els.slider.style.setProperty('--share-progress', `${percent}%`);
    const duration = getFiniteSeconds(audio.duration);
    const seekTime = duration ? (percent / 100) * duration : 0;
    if (inlinePlayer.els.currentTime && duration) inlinePlayer.els.currentTime.textContent = formatTime(seekTime);
    syncInlinePlayerLyrics(seekTime, duration);
  });

  const commitInlineSeek = () => {
    const duration = getFiniteSeconds(audio.duration);
    if (duration) audio.currentTime = (Number(inlinePlayer.els.slider.value || 0) / 100) * duration;
    inlinePlayer.isSeeking = false;
    updateInlinePlayerProgress();
    syncInlinePlayerLyrics(audio.currentTime, audio.duration);
    if (!audio.paused && !audio.ended) startInlinePlayerFrame();
  };
  inlinePlayer.els.slider?.addEventListener('change', commitInlineSeek);
  inlinePlayer.els.slider?.addEventListener('pointerup', commitInlineSeek);
  inlinePlayer.els.slider?.addEventListener('touchend', commitInlineSeek);
  inlinePlayer.els.lyricList?.addEventListener('pointerdown', startInlineLyricDrag);
  inlinePlayer.els.lyricList?.addEventListener('pointermove', moveInlineLyricDrag);
  inlinePlayer.els.lyricList?.addEventListener('pointerup', commitInlineLyricDrag);
  inlinePlayer.els.lyricList?.addEventListener('pointercancel', cancelInlineLyricDrag);
  window.addEventListener('resize', () => {
    if (inlinePlayer.active) syncInlinePlayerLyrics(audio.currentTime, audio.duration);
  });
  window.visualViewport?.addEventListener('resize', () => {
    if (inlinePlayer.active) syncInlinePlayerLyrics(audio.currentTime, audio.duration);
  });

  return inlinePlayer;
}

function closeInlinePlayerOverlay() {
  if (!inlinePlayer.root) return;
  finishInlineLyricDrag({ commit: false });
  inlinePlayer.active = false;
  inlinePlayer.isSeeking = false;
  inlinePlayer.root.classList.remove('active');
  inlinePlayer.root.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('inline-player-open');
  stopInlinePlayerFrame();
}

function setInlinePlayerPlayState(isPlaying) {
  inlinePlayer.els.playBtn?.classList.toggle('playing', Boolean(isPlaying));
}

function updateInlinePlayerMetadata() {
  if (!inlinePlayer.root || !activePlaybackContext?.song) return;
  const song = activePlaybackContext.song;
  const metadataToken = ++inlinePlayer.metadataToken;
  inlinePlayer.els.title.textContent = song.name || '未知歌曲';
  inlinePlayer.els.artist.textContent = song.singer || '未知歌手';

  const applyCover = (coverUrl) => {
    if (metadataToken !== inlinePlayer.metadataToken) return;
    if (!coverUrl || !/^https?:\/\//i.test(coverUrl)) return;

    const proxiedCover = getImageProxyUrl(coverUrl);
    const displayCover = proxiedCover || coverUrl;
    song.cover = coverUrl;
    song.img = song.img || coverUrl;

    inlinePlayer.els.cover.src = displayCover;
    inlinePlayer.els.cover.style.display = 'block';
    inlinePlayer.els.coverPlaceholder.style.display = 'none';
    inlinePlayer.els.cover.onerror = () => {
      if (metadataToken !== inlinePlayer.metadataToken) return;
      if (displayCover !== coverUrl && inlinePlayer.els.cover.src !== coverUrl) {
        inlinePlayer.els.cover.src = coverUrl;
        return;
      }
      inlinePlayer.els.cover.style.display = 'none';
      inlinePlayer.els.coverPlaceholder.style.display = 'flex';
    };

    let bgUsingFallback = false;
    inlinePlayer.els.bgCover.src = displayCover;
    inlinePlayer.els.bgCover.onload = () => {
      if (metadataToken === inlinePlayer.metadataToken) inlinePlayer.els.bgCover.classList.add('loaded');
    };
    inlinePlayer.els.bgCover.onerror = () => {
      if (metadataToken !== inlinePlayer.metadataToken) return;
      if (!bgUsingFallback && displayCover !== coverUrl) {
        bgUsingFallback = true;
        inlinePlayer.els.bgCover.src = coverUrl;
        return;
      }
      if (metadataToken === inlinePlayer.metadataToken) inlinePlayer.els.bgCover.classList.remove('loaded');
    };
    applyInlineThemeFromCover(coverUrl, metadataToken);
  };

  const coverUrl = getSongCoverUrl(song);
  inlinePlayer.els.cover.classList.remove('loaded');
  inlinePlayer.els.bgCover.classList.remove('loaded');

  if (coverUrl) {
    applyCover(coverUrl);
  } else {
    inlinePlayer.els.cover.removeAttribute('src');
    inlinePlayer.els.bgCover.removeAttribute('src');
    inlinePlayer.els.cover.style.display = 'none';
    inlinePlayer.els.coverPlaceholder.style.display = 'flex';
  }

  getBestCoverUrl(song).then((bestCoverUrl) => {
    if (metadataToken !== inlinePlayer.metadataToken) return;
    const resolvedCoverUrl = bestCoverUrl || getSongCoverUrl(song);
    if (resolvedCoverUrl && resolvedCoverUrl !== coverUrl) {
      song.cover = resolvedCoverUrl;
      song.img = resolvedCoverUrl;
      applyCover(resolvedCoverUrl);
    } else if (!coverUrl) {
      clearInlinePlayerTheme();
    }
  }).catch((err) => {
    console.warn('[Inline Player] cover lookup failed:', err.message);
    if (metadataToken === inlinePlayer.metadataToken && !coverUrl) clearInlinePlayerTheme();
  });
}

function updateInlinePlayerProgress() {
  if (!inlinePlayer.active || inlinePlayer.isSeeking) return;
  const duration = getFiniteSeconds(audio.duration);
  const currentTime = getFiniteSeconds(audio.currentTime);
  const percent = duration ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
  if (inlinePlayer.els.slider) {
    inlinePlayer.els.slider.value = percent;
    inlinePlayer.els.slider.style.setProperty('--share-progress', `${percent}%`);
  }
  if (inlinePlayer.els.currentTime) inlinePlayer.els.currentTime.textContent = formatTime(currentTime);
  if (inlinePlayer.els.duration) inlinePlayer.els.duration.textContent = formatTime(duration);
}

function getInlineLyricIndexAtTime(time) {
  if (!activeLyrics.length) return -1;
  let index = activeLyrics.findIndex(line => line.time > time);
  return index === -1 ? activeLyrics.length - 1 : Math.max(0, index - 1);
}

function getInlineLyricWindow(time, duration) {
  if (!activeLyrics.length) return null;
  const index = getInlineLyricIndexAtTime(time);
  const start = activeLyrics[index]?.time ?? 0;
  const end = activeLyrics[index + 1]?.time ?? duration;
  const lineDuration = Math.max(0.8, (Number.isFinite(end) ? end : start + 4) - start);
  return {
    index,
    progress: Math.max(0, Math.min(1, (time - start) / lineDuration)),
  };
}

const INLINE_LYRIC_SLIDE_DURATION_MS = 460;

function clearInlineLyricSlide(list) {
  if (list?._lyricSlideTimer) {
    window.clearTimeout(list._lyricSlideTimer);
    list._lyricSlideTimer = 0;
  }
  list?.classList.remove('is-sliding');
}

function ensureInlineLyricParts(row) {
  let text = row.querySelector('.share-lyric-text');
  if (!text) {
    text = document.createElement('span');
    text.className = 'share-lyric-text';
    row.appendChild(text);
  }

  let fill = row.querySelector('.share-lyric-fill');
  if (!fill) {
    fill = document.createElement('span');
    fill.className = 'share-lyric-fill';
    fill.setAttribute('aria-hidden', 'true');
    row.appendChild(fill);
  }

  return { text, fill };
}

function createInlineLyricRow() {
  const row = document.createElement('div');
  row.className = 'share-lyric-row';
  row.innerHTML = '<span class="share-lyric-text"></span><span class="share-lyric-fill" aria-hidden="true"></span>';
  ensureInlineLyricParts(row);
  return row;
}

function ensureInlineLyricRows(list, count) {
  const rows = Array.from(list.querySelectorAll('.share-lyric-row'));
  while (rows.length < count) {
    const row = createInlineLyricRow();
    list.appendChild(row);
    rows.push(row);
  }
  return rows;
}

function getInlineLyricSlotMetrics() {
  const list = inlinePlayer.els.lyricList;
  if (!list) return null;
  const styles = window.getComputedStyle(list);
  const gap = parseFloat(styles.rowGap || '0') || 0;
  const rowHeight = Math.max(1, (list.clientHeight - gap * 2) / 3);
  const step = rowHeight + gap;
  list.style.setProperty('--lyric-row-height', `${rowHeight}px`);
  return { step };
}

function getInlineLyricDragPixelsPerLine(metrics) {
  const list = inlinePlayer.els.lyricList;
  const viewportHeight = Math.max(1, list?.clientHeight || metrics.step * 3);
  const lyricCount = activeLyrics.length || 1;
  const duration = getFiniteSeconds(audio.duration) || intervalToSeconds(activePlaybackContext?.song?.interval);
  const linesByCount = Math.round(lyricCount / 8);
  const linesByDuration = duration ? Math.round(duration / 20) : 0;
  const linesPerViewport = clamp(Math.max(5, linesByCount, linesByDuration), 5, 30);
  return Math.max(4, viewportHeight / linesPerViewport);
}

function setInlineLyricSlot(row, slot, metrics) {
  row.dataset.slot = String(slot);
  row.style.setProperty('--lyric-y', `${slot * metrics.step}px`);
}

function setInlineLyricRole(row, role) {
  row.classList.remove('previous', 'active', 'next');
  row.classList.add(role);
  row.dataset.role = role;
}

function setInlineLyricContent(row, line, lineIndex, progress = 0) {
  const { text, fill } = ensureInlineLyricParts(row);
  const lineText = line?.text || '';
  text.textContent = lineText;
  fill.textContent = lineText;
  row.dataset.lineIndex = String(lineIndex);
  row.style.setProperty('--karaoke-progress', `${Math.min(1, Math.max(0, progress)) * 100}%`);
}

function setInlineKaraokeProgress(progress) {
  const activeRow = inlinePlayer.els.lyricList?.querySelector('.share-lyric-row.active');
  if (!activeRow) return;
  const safeProgress = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  activeRow.style.setProperty('--karaoke-progress', `${safeProgress * 100}%`);
}

function getInlineLyricSeekTime(index) {
  if (!activeLyrics.length) return 0;
  const safeIndex = Math.max(0, Math.min(activeLyrics.length - 1, index));
  const targetTime = Number(activeLyrics[safeIndex]?.time || 0);
  const duration = getFiniteSeconds(audio.duration);
  return duration ? Math.min(Math.max(0, targetTime), Math.max(0, duration - 0.05)) : Math.max(0, targetTime);
}

function previewInlineLyricSeek(index) {
  if (!inlinePlayer.active || !activeLyrics.length) return;
  const targetIndex = Math.max(0, Math.min(activeLyrics.length - 1, index));
  inlinePlayer.lyricIndex = targetIndex;
  clearInlineLyricSlide(inlinePlayer.els.lyricList);
  renderInlineLyricWindowNow(inlinePlayer.els.lyricList, activeLyrics, targetIndex, 0);

  const targetTime = getInlineLyricSeekTime(targetIndex);
  const duration = getFiniteSeconds(audio.duration);
  const percent = duration ? Math.max(0, Math.min(100, (targetTime / duration) * 100)) : 0;
  if (inlinePlayer.els.slider) {
    inlinePlayer.els.slider.value = percent;
    inlinePlayer.els.slider.style.setProperty('--share-progress', `${percent}%`);
  }
  if (inlinePlayer.els.currentTime) inlinePlayer.els.currentTime.textContent = formatTime(targetTime);
}

function startInlineLyricDrag(event) {
  if (!inlinePlayer.active || !activeLyrics.length || event.button > 0) return;
  const metrics = getInlineLyricSlotMetrics();
  if (!metrics?.step) return;

  event.preventDefault();
  inlinePlayer.els.lyricList.setPointerCapture?.(event.pointerId);
  inlinePlayer.isSeeking = true;
  stopInlinePlayerFrame();
  clearInlineLyricSlide(inlinePlayer.els.lyricList);

  const currentIndex = Math.max(0, getInlineLyricIndexAtTime(audio.currentTime));
  inlinePlayer.lyricDrag = {
    pointerId: event.pointerId,
    startY: event.clientY,
    startIndex: currentIndex,
    targetIndex: currentIndex,
    pixelsPerLine: getInlineLyricDragPixelsPerLine(metrics),
  };
  inlinePlayer.els.lyricList.classList.add('is-dragging');
  previewInlineLyricSeek(currentIndex);
}

function moveInlineLyricDrag(event) {
  const drag = inlinePlayer.lyricDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;

  event.preventDefault();
  const offsetRows = Math.round((drag.startY - event.clientY) / drag.pixelsPerLine);
  const targetIndex = Math.max(0, Math.min(activeLyrics.length - 1, drag.startIndex + offsetRows));
  if (targetIndex === drag.targetIndex) return;

  drag.targetIndex = targetIndex;
  previewInlineLyricSeek(targetIndex);
}

function finishInlineLyricDrag({ commit = false, pointerId } = {}) {
  const drag = inlinePlayer.lyricDrag;
  if (!drag) return;
  if (pointerId != null && drag.pointerId !== pointerId) return;

  try {
    inlinePlayer.els.lyricList?.releasePointerCapture?.(drag.pointerId);
  } catch (_) {
    // Pointer capture may already be released by the browser.
  }
  inlinePlayer.els.lyricList?.classList.remove('is-dragging');
  inlinePlayer.lyricDrag = null;
  inlinePlayer.isSeeking = false;

  if (commit) {
    audio.currentTime = getInlineLyricSeekTime(drag.targetIndex);
  }

  updateInlinePlayerProgress();
  syncInlinePlayerLyrics(audio.currentTime, audio.duration);
  if (!audio.paused && !audio.ended) startInlinePlayerFrame();
}

function commitInlineLyricDrag(event) {
  event.preventDefault();
  finishInlineLyricDrag({ commit: true, pointerId: event.pointerId });
}

function cancelInlineLyricDrag(event) {
  finishInlineLyricDrag({ commit: false, pointerId: event.pointerId });
}

function renderInlineLyricWindowNow(list, lyrics, index, progress) {
  const rows = ensureInlineLyricRows(list, 3);
  rows.slice(3).forEach(row => row.remove());

  const metrics = getInlineLyricSlotMetrics();
  if (!metrics) return;

  const roles = ['previous', 'active', 'next'];
  const lineIndices = index < 0 ? [-2, -1, 0] : [index - 1, index, index + 1];
  const lines = index < 0
    ? [null, { text: '暂无歌词' }, null]
    : lineIndices.map(lineIndex => lyrics[lineIndex] || null);

  rows.slice(0, 3).forEach((row, rowIndex) => {
    row.classList.remove('is-moving', 'is-exiting', 'no-motion');
    setInlineLyricRole(row, roles[rowIndex]);
    setInlineLyricContent(row, lines[rowIndex], lineIndices[rowIndex], rowIndex === 1 ? progress : 0);
    setInlineLyricSlot(row, rowIndex, metrics);
  });

  list.dataset.lyricIndex = String(index);
  setInlineKaraokeProgress(progress);
}

function slideInlineLyricWindow(list, lyrics, previousIndex, index, progress) {
  const direction = index > previousIndex ? 1 : -1;
  const metrics = getInlineLyricSlotMetrics();
  const previousRow = list.querySelector('.share-lyric-row.previous');
  const activeRow = list.querySelector('.share-lyric-row.active');
  const nextRow = list.querySelector('.share-lyric-row.next');

  if (!metrics || !previousRow || !activeRow || !nextRow) {
    renderInlineLyricWindowNow(list, lyrics, index, progress);
    return;
  }

  clearInlineLyricSlide(list);
  list.classList.add('is-sliding');

  [previousRow, activeRow, nextRow].forEach((row, slot) => {
    row.classList.remove('is-moving', 'is-exiting', 'no-motion');
    setInlineLyricSlot(row, slot, metrics);
  });

  const enteringRow = createInlineLyricRow();
  enteringRow.classList.add('no-motion');
  list.appendChild(enteringRow);

  if (direction > 0) {
    setInlineLyricRole(enteringRow, 'next');
    setInlineLyricContent(enteringRow, lyrics[index + 1] || null, index + 1, 0);
    setInlineLyricSlot(enteringRow, 3, metrics);
  } else {
    setInlineLyricRole(enteringRow, 'previous');
    setInlineLyricContent(enteringRow, lyrics[index - 1] || null, index - 1, 0);
    setInlineLyricSlot(enteringRow, -1, metrics);
  }

  void list.offsetHeight;
  [previousRow, activeRow, nextRow, enteringRow].forEach(row => {
    row.classList.remove('no-motion');
    row.classList.add('is-moving');
  });

  if (direction > 0) {
    previousRow.classList.add('is-exiting');
    setInlineLyricRole(previousRow, 'previous');
    setInlineLyricSlot(previousRow, -1, metrics);

    setInlineLyricRole(activeRow, 'previous');
    setInlineLyricContent(activeRow, lyrics[index - 1] || null, index - 1, 0);
    setInlineLyricSlot(activeRow, 0, metrics);

    setInlineLyricRole(nextRow, 'active');
    setInlineLyricContent(nextRow, lyrics[index] || null, index, progress);
    setInlineLyricSlot(nextRow, 1, metrics);

    setInlineLyricRole(enteringRow, 'next');
    setInlineLyricSlot(enteringRow, 2, metrics);
  } else {
    nextRow.classList.add('is-exiting');
    setInlineLyricRole(nextRow, 'next');
    setInlineLyricSlot(nextRow, 3, metrics);

    setInlineLyricRole(activeRow, 'next');
    setInlineLyricContent(activeRow, lyrics[index + 1] || null, index + 1, 0);
    setInlineLyricSlot(activeRow, 2, metrics);

    setInlineLyricRole(previousRow, 'active');
    setInlineLyricContent(previousRow, lyrics[index] || null, index, progress);
    setInlineLyricSlot(previousRow, 1, metrics);

    setInlineLyricRole(enteringRow, 'previous');
    setInlineLyricSlot(enteringRow, 0, metrics);
  }

  list.dataset.lyricIndex = String(index);
  setInlineKaraokeProgress(progress);

  list._lyricSlideTimer = window.setTimeout(() => {
    const rows = direction > 0
      ? [activeRow, nextRow, enteringRow]
      : [enteringRow, previousRow, activeRow];
    const exitRow = direction > 0 ? previousRow : nextRow;
    const nextMetrics = getInlineLyricSlotMetrics();

    exitRow.remove();
    rows.forEach((row, slot) => {
      row.classList.remove('is-moving', 'is-exiting', 'no-motion');
      setInlineLyricRole(row, ['previous', 'active', 'next'][slot]);
      if (nextMetrics) setInlineLyricSlot(row, slot, nextMetrics);
    });

    list.classList.remove('is-sliding');
    list._lyricSlideTimer = 0;
  }, INLINE_LYRIC_SLIDE_DURATION_MS);
}

function updateInlineLyricWindow(lyrics, index, initialProgress = 0) {
  const list = inlinePlayer.els.lyricList;
  if (!list) return;

  const progress = Number.isFinite(initialProgress) ? Math.min(1, Math.max(0, initialProgress)) : 0;
  if (!lyrics.length || index < 0) {
    clearInlineLyricSlide(list);
    renderInlineLyricWindowNow(list, [], -1, 0);
    return;
  }

  const previousIndex = Number(list.dataset.lyricIndex);
  const isAdjacentMove = Number.isFinite(previousIndex) && Math.abs(index - previousIndex) === 1;
  const canSlide = isAdjacentMove
    && !list.classList.contains('is-sliding')
    && list.querySelectorAll('.share-lyric-row').length === 3;

  if (canSlide) {
    slideInlineLyricWindow(list, lyrics, previousIndex, index, progress);
  } else {
    clearInlineLyricSlide(list);
    renderInlineLyricWindowNow(list, lyrics, index, progress);
  }
}

function syncInlinePlayerLyrics(time = audio.currentTime, duration = audio.duration) {
  if (inlinePlayer.lyricDrag) return;
  if (!inlinePlayer.active || !inlinePlayer.els.lyricList) return;
  if (!activeLyrics.length) {
    updateInlineLyricWindow([], -1, 0);
    return;
  }

  const lyric = getInlineLyricWindow(time, duration);
  if (!lyric) return;
  if (lyric.index !== inlinePlayer.lyricIndex) {
    inlinePlayer.lyricIndex = lyric.index;
    updateInlineLyricWindow(activeLyrics, lyric.index, lyric.progress);
  } else {
    setInlineKaraokeProgress(lyric.progress);
  }
}

function stopInlinePlayerFrame() {
  if (!inlinePlayer.frameId) return;
  cancelAnimationFrame(inlinePlayer.frameId);
  inlinePlayer.frameId = 0;
}

function startInlinePlayerFrame() {
  if (!inlinePlayer.active) return;
  stopInlinePlayerFrame();
  const tick = () => {
    if (!inlinePlayer.lyricDrag) {
      updateInlinePlayerProgress();
      syncInlinePlayerLyrics(audio.currentTime, audio.duration);
    }
    if (inlinePlayer.active && !audio.paused && !audio.ended) {
      inlinePlayer.frameId = requestAnimationFrame(tick);
    }
  };
  inlinePlayer.frameId = requestAnimationFrame(tick);
}

function openInlinePlayerOverlay(song) {
  if (!isSongReadyForPlayerPage(song)) {
    throw new Error('请先播放成功后再进入播放页');
  }

  ensureInlinePlayerOverlay();
  inlinePlayer.active = true;
  inlinePlayer.lyricIndex = -1;
  inlinePlayer.root.classList.add('active');
  inlinePlayer.root.setAttribute('aria-hidden', 'false');
  document.body.classList.add('inline-player-open');
  updateInlinePlayerMetadata();
  if (!inlinePlayer.lyricDrag) updateInlinePlayerProgress();
  setInlinePlayerPlayState(!audio.paused && !audio.ended);
  syncInlinePlayerLyrics(audio.currentTime, audio.duration);
  if (!audio.paused && !audio.ended) startInlinePlayerFrame();
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
  if (!inlinePlayer.lyricDrag) syncInlinePlayerLyrics(audio.currentTime, audio.duration);
});

audio.addEventListener('loadedmetadata', () => {
  if (activeSongId && activeTotalTimeText) {
    activeTotalTimeText.innerText = formatTime(audio.duration);
  }
  if (!inlinePlayer.lyricDrag) {
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
  if (inlinePlayer.lyricDrag) return;
  lastLyricIndex = -1;
  inlinePlayer.lyricIndex = -1;
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

  const dummyStatusText = {
    set innerText(val) {
      console.log('[Play Resolution]', val);
    }
  };

  try {
    const displayFilename = buildSongFilename(song, 'mp3');
    const { downloadUrl, resolution, finalFilename } = await createDownloadLinkWithFallback(song, '128k', displayFilename, dummyStatusText, {
      validate: false,
      includeCover: false,
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
    };

    currentTimeText.innerText = '00:00';
    slider.value = 0;
    if (activeLyricLineEl) activeLyricLineEl.innerText = '歌词加载中...';

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
