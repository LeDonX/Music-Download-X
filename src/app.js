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
  kw: '酷我音乐',
  kg: '酷狗音乐',
  tx: 'QQ音乐',
  wy: '网易云音乐',
  mg: '咪咕音乐',
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
  isLoading: false,
  searchRequestId: 0,
  searchAbortController: null,
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
  return {
    finalUrl,
    finalHeaders,
  };
}

function getResolverName(url) {
  const key = url.split('/').slice(-2, -1)[0] || '';
  return key === 'lx' ? '默认解析服务' : '备用解析服务';
}

function getPlatformName(source) {
  return PLATFORM_NAMES[source] || source || '未知平台';
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

async function resolveWithScripts(song, quality, statusText) {
  const urlsToTry = [state.scriptUrl, ...SOURCE_URLS.filter(u => u !== state.scriptUrl)];
  let lastError = null;

  for (const url of urlsToTry) {
    try {
      const sourceName = getResolverName(url);
      statusText.innerText = `正在用${sourceName}解析 ${getPlatformName(song.source)}...`;
      console.log(`[Download] Trying resolution with resolver: ${url}`);

      const sandboxInstance = await getOrLoadSandbox(url);
      const { finalUrl, finalHeaders } = await resolveMusicUrl(sandboxInstance, song, quality);
      if (finalUrl && finalUrl.startsWith('http')) {
        return {
          audioUrl: finalUrl,
          audioHeaders: finalHeaders,
          successfulUrl: url,
          resolvedSong: song,
        };
      }
    } catch (err) {
      lastError = err;
      console.warn(`[Download] Resolver ${url} failed:`, err.message);
    }
  }

  if (lastError) throw lastError;
  throw new Error('解析服务未返回有效链接');
}

async function createDownloadResponse(song, quality, filename, statusText) {
  const resolution = await resolveWithScripts(song, quality, statusText);
  const sourceName = getResolverName(resolution.successfulUrl);
  statusText.innerText = `[${sourceName}] 正在建立连接...`;

  const response = await fetch('/api/download', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url: resolution.audioUrl,
      filename,
      headers: resolution.audioHeaders
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `流式代理连接失败 (${response.status})`);
  }

  return { response, resolution };
}

async function createDownloadResponseWithFallback(song, quality, filename, statusText) {
  let lastError = null;
  try {
    return await createDownloadResponse(song, quality, filename, statusText);
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
      return await createDownloadResponse(candidate, quality, filename, statusText);
    } catch (err) {
      lastError = err;
      console.warn(`[Download] fallback ${candidate.source} failed:`, err.message);
    }
  }

  throw lastError || new Error('所有平台均解析失败');
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
  // Search actions
  el.searchBtn.addEventListener('click', performSearch);
  el.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') performSearch();
  });

  // Toggle custom dropdown menu
  el.customSelect.addEventListener('click', (e) => {
    e.stopPropagation();
    el.customSelect.classList.toggle('open');
  });

  // Handle custom option selection
  const options = el.customSelect.querySelectorAll('.custom-option');
  options.forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation();
      const value = option.getAttribute('data-value');
      const text = option.innerText;
      
      // Update state
      state.currentSource = value;
      el.selectedPlatform.innerText = text;
      
      // Update active styling
      options.forEach(opt => opt.classList.remove('active'));
      option.classList.add('active');
      
      // Close menu
      el.customSelect.classList.remove('open');
      
      // Fire search if search input has keyword
      if (el.searchInput.value.trim()) {
        performSearch();
      }
    });
  });

  // Close custom dropdown when clicking outside
  document.addEventListener('click', () => {
    el.customSelect.classList.remove('open');
  });

  // Intersection Observer for waterfall lazy loading (infinite scroll)
  const scrollAnchor = document.getElementById('scrollAnchor');
  if (scrollAnchor) {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        if (state.isLoading) return;
        if (!state.currentKeyword) return;

        const totalLoaded = state.currentResults.length;
        if (totalLoaded >= state.totalCount) return;

        loadNextPage();
      }
    }, {
      rootMargin: '150px', // Trigger when anchor is within 150px of the viewport bottom
    });
    observer.observe(scrollAnchor);
  }

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

  if (state.searchAbortController) {
    state.searchAbortController.abort();
  }
  state.searchRequestId += 1;
  state.currentPage = 1;
  state.currentKeyword = keyword;
  state.currentResults = []; // Clear previous batch
  state.totalCount = 0;
  await fetchPage(state.currentPage, state.searchRequestId);
}

// Fetch Search Results for Specific Page (Waterfall Initial Page)
async function fetchPage(page, requestId = state.searchRequestId) {
  state.isLoading = true;
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
    const searchUrl = `/api/search?keyword=${encodeURIComponent(state.currentKeyword)}&source=${state.currentSource}&page=${page}&limit=${state.limit}`;
    const res = await fetch(searchUrl, { signal: controller.signal });
    if (!res.ok) throw new Error('Search request failed');
    
    const data = await res.json();
    if (requestId !== state.searchRequestId) return;
    state.currentResults = data.list || [];
    
    if (page === 1) {
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
  state.currentPage += 1;
  
  showBottomLoadingIndicator(true);

  try {
    const searchUrl = `/api/search?keyword=${encodeURIComponent(state.currentKeyword)}&source=${state.currentSource}&page=${state.currentPage}&limit=${state.limit}`;
    const res = await fetch(searchUrl);
    if (!res.ok) throw new Error('Search request failed');
    
    const data = await res.json();
    if (requestId !== state.searchRequestId) return;
    const newSongs = data.list || [];
    
    if (newSongs.length === 0) {
      state.totalCount = state.currentResults.length; // Lock at current
    } else {
      state.currentResults = [...state.currentResults, ...newSongs];
      appendSearchResults(newSongs);
    }
  } catch (err) {
    if (requestId !== state.searchRequestId) return;
    console.error('[Lazy Load Error]', err);
    state.currentPage -= 1;
    showToast('获取更多歌曲失败', 'error');
  } finally {
    if (requestId === state.searchRequestId) {
      state.isLoading = false;
      showBottomLoadingIndicator(false);
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
      indicator.innerHTML = `
        <div class="loading-spinner" style="width:20px; height:20px; margin: 0 auto;"></div>
        <span style="font-size:0.8rem; color:var(--text-muted); margin-top:5px;">正在加载更多...</span>
      `;
      el.songList.after(indicator);
    }
  } else {
    if (indicator) {
      indicator.remove();
    }
  }
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

    const isKuwo = song.source === 'kw';

    item.innerHTML = `
      <div class="song-cover-wrapper">
        <div class="song-cover-placeholder">♪</div>
        <img class="song-cover" src="${song.img || ''}" alt="Cover" style="${song.img ? 'display:block;' : 'display:none;'}">
      </div>
      <div class="song-info">
        <div class="song-title">${escapeHtml(song.name)}</div>
        <div class="song-artist">${escapeHtml(song.singer)}</div>
      </div>
      <div class="song-album">${escapeHtml(song.albumName || '未知专辑')}</div>
      <div class="song-duration">${song.interval || '00:00'}</div>
      <div class="song-actions">
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

    item.querySelector('.download-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openDownloadModal(song);
    });

    el.songList.appendChild(item);

    // If Kuwo, lazy load cover image
    if (isKuwo && !song.img) {
      lazyLoadKuwoCover(song.songmid, item.querySelector('.song-cover'), item.querySelector('.song-cover-placeholder'), globalIdx);
    }
  });
}

// Lazy Load Kuwo Covers
async function lazyLoadKuwoCover(songmid, imgEl, placeholderEl, idx) {
  try {
    const coverQueryUrl = `http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic&pictype=500&size=500&rid=${songmid}`;
    const res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: coverQueryUrl, method: 'GET' }),
    });
    if (!res.ok) return;
    const bodyText = await res.text();
    if (bodyText && bodyText.startsWith('http')) {
      imgEl.src = bodyText;
      imgEl.style.display = 'block';
      placeholderEl.style.display = 'none';
      state.currentResults[idx].img = bodyText;
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
  
  // Intersect them
  const supported = songQualities.filter(q => scriptSupportedQualities.includes(q));
  
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
  const defaultExt = quality.startsWith('flac') ? 'flac' : 'mp3';
  const displayFilename = `${song.singer} - ${song.name} [${quality.toUpperCase()}].${defaultExt}`;
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

    statusText.innerText = '正在解析链接...';
    updateDownloadProgressOnCard(song.songmid, song.source, 5);

    const { response, resolution } = await createDownloadResponseWithFallback(song, quality, displayFilename, statusText);
    const resolvedSong = resolution.resolvedSong;
    const usedFallback = resolvedSong.source !== song.source || resolvedSong.songmid !== song.songmid;

    const contentType = response.headers.get('Content-Type') || '';
    const contentLengthHeader = response.headers.get('X-Content-Length') || response.headers.get('Content-Length');
    const contentLength = parseInt(contentLengthHeader || '0', 10);
    
    // Determine dynamic extension based on actual response content-type
    let actualExt = defaultExt;
    if (quality.startsWith('flac')) {
      if (contentType.includes('mpeg') || contentType.includes('mp3')) actualExt = 'mp3';
      else if (contentType.includes('m4a') || contentType.includes('mp4') || contentType.includes('aac')) actualExt = 'm4a';
      else actualExt = 'flac';
    } else {
      if (contentType.includes('flac')) actualExt = 'flac';
      else if (contentType.includes('mpeg') || contentType.includes('mp3')) actualExt = 'mp3';
      else if (contentType.includes('ogg')) actualExt = 'ogg';
      else if (contentType.includes('wav')) actualExt = 'wav';
      else if (contentType.includes('m4a') || contentType.includes('mp4') || contentType.includes('aac')) actualExt = 'm4a';
    }

    // Build the finalized file name
    const finalFilename = `${song.singer} - ${song.name} [${quality.toUpperCase()}].${actualExt}`;
    const nameEl = taskEl.querySelector('.queue-name');
    if (nameEl) {
      nameEl.innerText = finalFilename;
      nameEl.title = finalFilename;
    }

    if (contentLength) {
      sizeText.innerText = formatBytes(contentLength);
    } else {
      sizeText.innerText = '未知大小';
    }

    statusText.innerText = '正在下载...';
    
    // Read Binary Stream with progress updating
    const reader = response.body.getReader();
    let receivedLength = 0;
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      receivedLength += value.length;

      if (contentLength) {
        const pct = Math.round((receivedLength / contentLength) * 100);
        progressFill.style.width = `${pct}%`;
        pctText.innerText = `${pct}%`;
        updateDownloadProgressOnCard(song.songmid, song.source, pct);
      } else {
        pctText.innerText = formatBytes(receivedLength);
        updateDownloadProgressOnCard(song.songmid, song.source, 50);
      }
    }

    if (contentLength && receivedLength < contentLength) {
      throw new Error(`下载中断，仅接收了 ${formatBytes(receivedLength)} / ${formatBytes(contentLength)}`);
    }

    // Detect if quality was downgraded by the source server
    let qualityWarnText = '';
    let isDowngraded = false;
    const isClearlyLossy = /mpeg|mp3|mp4|m4a|aac/i.test(contentType);
    if (quality.startsWith('flac') && isClearlyLossy) {
      qualityWarnText = ' (已降级为高品质MP3)';
      isDowngraded = true;
    }

    statusText.innerText = '正在写入本地磁盘...';
    statusText.className = 'queue-status completed';
    
    const blob = new Blob(chunks, { type: contentType || 'application/octet-stream' });
    const blobUrl = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = finalFilename;
    document.body.appendChild(a);
    a.click();
    
    // Cleanup
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);

    statusText.innerText = '下载完成' + qualityWarnText;
    progressFill.style.width = '100%';
    pctText.innerText = '100%';
    updateDownloadProgressOnCard(song.songmid, song.source, 100, false, true);
    
    if (isDowngraded) {
      showToast(`下载成功: ${song.name} (已自动降级为高品质MP3，源无损接口限制)`, 'warning');
    } else if (usedFallback) {
      showToast(`下载成功: ${song.name} (已自动切换到${getPlatformName(resolvedSong.source)})`, 'success');
    } else {
      showToast(`下载成功: ${song.name}`, 'success');
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

// Utility Helpers
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
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
    toast.style.transform = 'translateY(-10px)';
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

// Run App
window.addEventListener('DOMContentLoaded', init);
