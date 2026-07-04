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
const PLATFORM_NAMES = {
  kw: '酷我',
  kg: '酷狗',
  tx: 'QQ',
  wy: '网易',
  mg: '咪咕',
};
const RESOLVE_TIMEOUT_MS = 22000;
const loadedSandboxes = {};

const SEARCH_STATE_STORAGE_KEY = 'music_download_x_search_state';
const PLAYBACK_STATE_STORAGE_KEY = 'music_download_x_playback_state';
let skipPlaybackStateSave = false;

function getSharePayload() {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  const params = new URLSearchParams(hash || window.location.search);
  const encoded = params.get('data') || '';
  if (!encoded) return null;
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    console.error('[Share] failed to parse payload', err);
    return null;
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || '';
}

function startDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'music';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function toAbsoluteUrl(url) {
  return new URL(url, window.location.href).toString();
}

function getPlaybackDownloadUrl(downloadUrl) {
  return `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}play=1`;
}

function getDefaultExtensionForQuality(quality) {
  return String(quality || '').startsWith('flac') ? 'flac' : 'mp3';
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

function buildQualityMap(song) {
  const qualityMap = { ...(song?._types || {}) };
  for (const typeInfo of song?.types || []) {
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

  switch (song?.source) {
    case 'kg':
      return song.hash || qualityMap['128k']?.hash || song.songmid || '';
    case 'mg':
      return song.copyrightId || song.songmid || '';
    default:
      return song?.songmid || song?.hash || '';
  }
}

function withResolverHashes(song, qualityMap) {
  const next = { ...qualityMap };
  for (const typeInfo of song?.types || []) {
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
    picUrl: song.img || song.cover || '',
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
    img: song.img || song.cover || '',
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
    typeUrl: song.typeUrl || {},
  };
}

function getResolvedUrlPayload(resolved) {
  return {
    finalUrl: typeof resolved === 'string' ? resolved : resolved?.url || resolved?.data?.url,
    finalHeaders: typeof resolved === 'string' ? {} : resolved?.headers || resolved?.data?.headers || {},
  };
}

function getResolverName(url) {
  const key = url.split('/').slice(-2, -1)[0] || '';
  return key === 'lx' ? '默认解析服务' : '备用解析服务';
}

function getResolverUrlsToTry(payload) {
  const preferred = payload?.resolverScriptUrl || localStorage.getItem('resolver_script_url') || SOURCE_URLS[0];
  return [preferred, ...SOURCE_URLS.filter(url => url !== preferred)];
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function getOrLoadSandbox(url) {
  if (loadedSandboxes[url]) return loadedSandboxes[url];

  let scriptContent = '';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error();
    scriptContent = await res.text();
  } catch (_) {
    const proxyRes = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, method: 'GET' }),
    });
    if (!proxyRes.ok) throw new Error(`HTTP ${proxyRes.status} from proxy`);
    scriptContent = await proxyRes.text();
  }

  const sandbox = await initResolverSandbox(scriptContent, {
    name: getResolverName(url),
    version: '4',
    description: '音乐解析服务',
  });
  loadedSandboxes[url] = sandbox;
  return sandbox;
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
      console.warn(`[Share] ${attempt.label} musicInfo resolve failed:`, err.message);
    }
  }

  if (lastError) throw lastError;
  throw new Error('解析服务未返回有效链接');
}

function buildDownloadProxyUrl(resolution, filename, song, ext, coverUrl = '') {
  const params = new URLSearchParams({
    url: resolution.audioUrl,
    filename,
    headers: JSON.stringify(resolution.audioHeaders || {}),
    title: song.name || '',
    artist: song.singer || '',
    album: song.albumName || '',
    cover: coverUrl || '',
    ext,
  });
  return `/api/download?${params.toString()}`;
}

async function resolveSharedPlayback(payload, song, quality = '128k') {
  let lastError = null;
  const filename = payload.filename || buildSongFilename(song, getDefaultExtensionForQuality(quality));
  const ext = getDefaultExtensionForQuality(quality);

  for (const url of getResolverUrlsToTry(payload)) {
    try {
      const sandbox = await withTimeout(getOrLoadSandbox(url), RESOLVE_TIMEOUT_MS, `${getResolverName(url)}加载超时`);
      const resolved = await withTimeout(resolveMusicUrl(sandbox, song, quality), RESOLVE_TIMEOUT_MS, `${getResolverName(url)}解析超时`);
      const resolution = {
        audioUrl: resolved.finalUrl,
        audioHeaders: resolved.finalHeaders,
      };
      const coverUrl = song.cover || song.img || '';
      const downloadUrl = buildDownloadProxyUrl(resolution, filename, song, ext, coverUrl);
      return {
        audioUrl: toAbsoluteUrl(getPlaybackDownloadUrl(downloadUrl)),
        downloadUrl: toAbsoluteUrl(downloadUrl),
        filename,
      };
    } catch (err) {
      lastError = err;
      console.warn(`[Share] Resolver ${url} failed:`, err.message);
    }
  }

  throw lastError || new Error('所有解析服务均解析失败');
}

function isSearchEntry(payload) {
  return payload?.entry === 'search';
}

function goBackToSearchOrHome() {
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  window.location.href = '/';
}

function setupReturnButtons(payload) {
  const isFromSearch = isSearchEntry(payload);
  const label = isFromSearch ? '返回搜索结果' : '回到主页';
  const backBtn = document.getElementById('shareBackBtn');
  const homeBtn = document.getElementById('shareHomeBtn');
  const backHandler = () => {
    if (isFromSearch) {
      goBackToSearchOrHome();
    } else {
      window.location.href = '/';
    }
  };

  if (backBtn) {
    backBtn.title = label;
    backBtn.setAttribute('aria-label', label);
    backBtn.addEventListener('click', backHandler);
  }

  if (homeBtn) {
    homeBtn.title = '回到主页';
    homeBtn.setAttribute('aria-label', '回到主页');
    homeBtn.addEventListener('click', () => {
      skipPlaybackStateSave = true;
      sessionStorage.removeItem(SEARCH_STATE_STORAGE_KEY);
      sessionStorage.removeItem(PLAYBACK_STATE_STORAGE_KEY);
      window.location.href = '/';
    });
  }
}

const LYRIC_LEAD_SECONDS = 0.08;

function getLyricsFromPayload(payload) {
  if (Array.isArray(payload?.lyrics)) {
    return payload.lyrics
      .map(line => ({
        time: Number(line.time),
        text: String(line.text || '').trim(),
        words: Array.isArray(line.words)
          ? line.words.map(word => ({
              text: String(word.text || ''),
              start: Number(word.start),
              duration: Number(word.duration),
            })).filter(word => word.text && Number.isFinite(word.start) && Number.isFinite(word.duration))
          : [],
      }))
      .filter(line => Number.isFinite(line.time) && line.text)
      .sort((a, b) => a.time - b.time);
  }

  const rawLyric = payload?.lyric || payload?.lrc || payload?.rawLrc || payload?.lxlyric || payload?.song?.lyric || payload?.song?.lrc || '';
  return parseLrc(rawLyric);
}

function buildLyricParams(song) {
  const params = new URLSearchParams({
    source: song.source || '',
    songmid: song.songmid || '',
    songId: song.songId || '',
    hash: song.hash || '',
    copyrightId: song.copyrightId || '',
    name: song.name || '',
    singer: song.singer || '',
    albumName: song.albumName || '',
    albumId: song.albumId || '',
    strMediaMid: song.strMediaMid || '',
    albumMid: song.albumMid || '',
    img: song.img || song.cover || '',
    interval: song.interval || '',
    lrcUrl: song.lrcUrl || '',
    mrcUrl: song.mrcUrl || '',
    trcUrl: song.trcUrl || '',
  });

  for (const [key, value] of [...params.entries()]) {
    if (!value) params.delete(key);
  }
  return params;
}

function buildPicParams(song) {
  return new URLSearchParams({
    source: song.source || '',
    songmid: song.songmid || '',
    albumId: song.albumId || '',
    hash: song.hash || '',
    name: song.name || '',
    singer: song.singer || '',
    img: song.img || song.cover || '',
  });
}

async function getBestCoverUrl(song) {
  const existing = song.cover || song.img || '';
  if (/^https?:\/\//i.test(existing)) return existing;

  try {
    const res = await fetch(`/api/pic?${buildPicParams(song).toString()}`, { cache: 'force-cache' });
    if (!res.ok) return '';
    const data = await res.json();
    if (data.img && /^https?:\/\//i.test(data.img)) {
      song.img = data.img;
      song.cover = data.img;
      return data.img;
    }
  } catch (err) {
    console.warn('[Share] cover lookup failed:', err);
  }

  return '';
}

function getLyricTextFromPayload(payload) {
  if (!payload) return '';
  const data = payload.data || payload;
  return data.lxlyric || data.lyric || data.lrc || data.rawLrc || data.text || '';
}

const WORD_TIME_TAG_REG = /<(-?\d+),(-?\d+)(?:,-?\d+)?>/g;
const PAREN_WORD_TIME_TAG_REG = /\((-?\d+),(-?\d+)(?:,-?\d+)?\)/g;

function parseLrc(lrcText) {
  const lines = String(lrcText || '').split('\n');
  const parsed = [];
  const timeReg = /\[(\d+):(\d+)(?:\.(\d+))?\]/g;

  for (const line of lines) {
    const rawText = line.replace(timeReg, '').trim();
    const text = rawText
      .replace(WORD_TIME_TAG_REG, '')
      .replace(PAREN_WORD_TIME_TAG_REG, '')
      .trim();
    const words = parseWordTimings(rawText);
    let match;
    timeReg.lastIndex = 0;
    while ((match = timeReg.exec(line)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].slice(0, 3).padEnd(3, '0'), 10) : 0;
      parsed.push({ time: min * 60 + sec + ms / 1000, text, words });
    }
  }

  return parsed.sort((a, b) => a.time - b.time);
}

function parseWordTimings(rawText) {
  const text = String(rawText || '');
  const tagReg = text.includes('<') ? WORD_TIME_TAG_REG : PAREN_WORD_TIME_TAG_REG;
  const words = [];
  let match;
  let lastIndex = 0;
  let currentTiming = null;
  tagReg.lastIndex = 0;

  while ((match = tagReg.exec(text)) !== null) {
    const segment = text.slice(lastIndex, match.index);
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

  const tail = text.slice(lastIndex);
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
}

async function fetchLyrics(song) {
  const res = await fetch(`/api/lyric?${buildLyricParams(song).toString()}`, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = await res.json();
  return parseLrc(getLyricTextFromPayload(data));
}

function init() {
  const payload = getSharePayload();
  const playBtn = document.getElementById('sharePlayBtn');
  const downloadBtn = document.getElementById('shareDownloadBtn');

  if (!payload?.audioUrl && !payload?.resolveOnOpen) {
    setText('shareTitle', '分享链接无效');
    setText('shareArtist', '请回到主页重新分享');
    if (playBtn) playBtn.disabled = true;
    if (downloadBtn) downloadBtn.disabled = true;
    const hint = document.getElementById('shareHint');
    if (hint) hint.textContent = '链接缺少播放信息。';
    setupReturnButtons(payload);
    return;
  }

  setupReturnButtons(payload);

  const song = payload.song || {};
  let lyrics = [];
  const audio = new Audio(payload.audioUrl || '');
  const initialTime = Math.max(0, Number(payload.currentTime || 0));
  let initialSeekPending = initialTime > 0;
  let autoplayPending = Boolean(payload.autoplay);

  const playerPage = createPlayerPageController({
    idPrefix: 'share',
    root: document.querySelector('.share-page'),
    overlay: false,
    panelLabel: '分享播放',
    lyricLeadSeconds: LYRIC_LEAD_SECONDS,
    logPrefix: '[Share]',
    getAudio: () => audio,
    getCurrentTime: () => audio.currentTime,
    getDuration: () => audio.duration,
    getEstimatedDuration: () => Number(payload.duration || 0),
    getLyrics: () => lyrics,
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
      startDownload(payload.downloadUrl || payload.audioUrl, payload.filename || `${song.singer || 'music'} - ${song.name || 'song'}`);
    },
    lookupCover: getBestCoverUrl,
    themeTargets: ({ page }) => [document.documentElement, document.body, page].filter(Boolean),
  });

  playerPage.ensureMounted();
  playerPage.open({ song });
  playerPage.setControlsDisabled({
    play: !payload.audioUrl,
    download: !payload.downloadUrl && !payload.audioUrl,
  });
  if (payload.resolveOnOpen && !payload.audioUrl) {
    playerPage.setHint('正在解析播放链接...');
  }

  const savePlaybackState = () => {
    if (skipPlaybackStateSave) return;
    if (!isSearchEntry(payload)) return;
    try {
      sessionStorage.setItem(PLAYBACK_STATE_STORAGE_KEY, JSON.stringify({
        savedAt: Date.now(),
        songKey: payload.songKey || '',
        song,
        audioUrl: payload.audioUrl,
        downloadUrl: payload.downloadUrl || '',
        filename: payload.filename || '',
        lyrics: Array.isArray(lyrics) ? lyrics.slice(0, 220) : [],
        currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : initialTime,
        duration: Number.isFinite(audio.duration) ? audio.duration : Number(payload.duration || 0),
        paused: audio.paused,
        ended: audio.ended,
      }));
    } catch (err) {
      console.warn('[Share] failed to save playback state', err);
    }
  };

  function setLyrics(nextLyrics) {
    lyrics = playerPage.setLyrics(nextLyrics);
    playerPage.syncLyrics(audio.currentTime, audio.duration);
  }

  function applyResolvedPlayback(resolved) {
    payload.audioUrl = resolved.audioUrl;
    payload.downloadUrl = resolved.downloadUrl;
    payload.filename = resolved.filename || payload.filename;
    audio.src = payload.audioUrl;
    playerPage.setControlsDisabled({ play: false, download: false });
    playerPage.setHint('');
  }

  const payloadLyrics = getLyricsFromPayload(payload);
  if (payloadLyrics.length) {
    setLyrics(payloadLyrics);
  } else {
    fetchLyrics(song).then((nextLyrics) => {
      setLyrics(nextLyrics);
    }).catch((err) => {
      console.warn('[Share] lyric lookup failed:', err);
      setLyrics([]);
      playerPage.setHint('歌词加载失败');
    });
  }

  if (!payload.audioUrl && payload.resolveOnOpen) {
    resolveSharedPlayback(payload, song).then((resolved) => {
      applyResolvedPlayback(resolved);
    }).catch((err) => {
      console.error('[Share] playback resolve failed:', err);
      playerPage.setHint(`解析失败: ${err.message}`);
      playerPage.setControlsDisabled({ play: true, download: true });
    });
  }

  audio.addEventListener('loadedmetadata', () => {
    if (initialSeekPending) {
      initialSeekPending = false;
      try {
        const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
        audio.currentTime = duration ? Math.min(initialTime, Math.max(0, duration - 0.2)) : initialTime;
      } catch (err) {
        console.warn('[Share] failed to restore playback time', err);
      }
    }
    playerPage.handleLoadedMetadata();
    if (autoplayPending) {
      autoplayPending = false;
      audio.play().catch((err) => {
        playerPage.setHint(`播放失败: ${err.message}`);
      });
    }
  });

  audio.addEventListener('timeupdate', () => {
    playerPage.handleTimeUpdate();
  });

  audio.addEventListener('playing', () => {
    playerPage.handlePlaying();
  });

  audio.addEventListener('pause', () => {
    playerPage.handlePause();
  });

  audio.addEventListener('ended', () => {
    playerPage.handleEnded();
  });

  audio.addEventListener('error', () => {
    playerPage.setHint('播放失败，请尝试下载后播放。');
    playerPage.handleError();
  });

  window.addEventListener('pagehide', () => {
    playerPage.cancelInteractions();
    savePlaybackState();
  });
}
window.addEventListener('DOMContentLoaded', init);
