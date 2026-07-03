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

function getImageProxyUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  return `/api/image?url=${encodeURIComponent(url)}`;
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

function applyShareTheme(theme) {
  const page = document.querySelector('.share-page');
  const targets = [document.documentElement, document.body, page].filter(Boolean);
  for (const target of targets) {
    target.style.setProperty('--share-theme-rgb', rgbToCss(theme.main));
    target.style.setProperty('--share-theme-dark-rgb', rgbToCss(theme.dark));
    target.style.setProperty('--share-theme-soft-rgb', rgbToCss(theme.soft));
  }
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
  let bestScore = 0;
  for (const bucket of buckets.values()) {
    const score = bucket.weight * Math.sqrt(bucket.count);
    if (score > bestScore) {
      best = bucket;
      bestScore = score;
    }
  }

  if (best?.weight) {
    return [best.r / best.weight, best.g / best.weight, best.b / best.weight];
  }

  if (fallbackWeight) {
    return fallback.map(value => value / fallbackWeight);
  }

  throw new Error('封面没有可用于取色的像素');
}

async function applyThemeFromCover(coverUrl) {
  const proxyUrl = getImageProxyUrl(coverUrl);
  if (!proxyUrl) return;

  try {
    const img = await loadImage(proxyUrl);
    const dominantColor = getDominantColorFromImage(img);
    applyShareTheme(buildThemeFromColor(dominantColor));
  } catch (err) {
    console.warn('[Share] cover theme extraction failed:', err);
  }
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function setPlayState(isPlaying) {
  const playBtn = document.getElementById('sharePlayBtn');
  if (!playBtn) return;
  playBtn.classList.toggle('playing', isPlaying);
  playBtn.title = isPlaying ? '暂停' : '播放';
  playBtn.setAttribute('aria-label', isPlaying ? '暂停' : '播放');
}

function updateProgressUI(audio, slider, currentEl, durationEl) {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const percent = duration ? Math.min(100, Math.max(0, (current / duration) * 100)) : 0;

  if (slider) {
    slider.value = String(percent);
    slider.style.setProperty('--share-progress', `${percent}%`);
  }
  if (currentEl) currentEl.textContent = formatTime(current);
  if (durationEl) durationEl.textContent = duration ? formatTime(duration) : '00:00';
}

function setKaraokeProgress(progress) {
  const activeRow = document.querySelector('.share-lyric-row.active');
  if (!activeRow) return;
  const safeProgress = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  activeRow.style.setProperty('--karaoke-progress', `${safeProgress * 100}%`);
}

const LYRIC_LEAD_SECONDS = 0.08;

function renderLyrics(lyrics) {
  const list = document.getElementById('shareLyricList');
  if (!list) return [];
  const safeLyrics = Array.isArray(lyrics)
    ? lyrics.filter(line => Number.isFinite(line.time) && String(line.text || '').trim())
    : [];

  if (!safeLyrics.length) {
    updateLyricWindow([], -1);
    return [];
  }

  updateLyricWindow(safeLyrics, 0);
  return safeLyrics;
}

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

const LYRIC_SLIDE_DURATION_MS = 460;

function updateLyricWindow(lyrics, index, initialProgress = 0) {
  const list = document.getElementById('shareLyricList');
  if (!list) return;

  const safeInitialProgress = Number.isFinite(initialProgress)
    ? Math.min(1, Math.max(0, initialProgress))
    : 0;

  if (!lyrics.length || index < 0) {
    clearLyricSlide(list);
    renderLyricWindowNow(list, [], -1, 0);
    return;
  }

  const previousIndex = Number(list.dataset.lyricIndex);
  const isAdjacentMove = Number.isFinite(previousIndex) && Math.abs(index - previousIndex) === 1;
  const canSlide = isAdjacentMove
    && !list.classList.contains('is-sliding')
    && list.querySelectorAll('.share-lyric-row').length === 3;

  if (canSlide) {
    slideLyricWindow(list, lyrics, previousIndex, index, safeInitialProgress);
  } else {
    clearLyricSlide(list);
    renderLyricWindowNow(list, lyrics, index, safeInitialProgress);
  }
}

function clearLyricSlide(list) {
  if (list._lyricSlideTimer) {
    window.clearTimeout(list._lyricSlideTimer);
    list._lyricSlideTimer = 0;
  }
  list.classList.remove('is-sliding');
}

function ensureLyricParts(row) {
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

function createLyricRow() {
  const row = document.createElement('div');
  row.className = 'share-lyric-row';
  row.innerHTML = '<span class="share-lyric-text"></span><span class="share-lyric-fill" aria-hidden="true"></span>';
  ensureLyricParts(row);
  return row;
}

function ensureLyricRows(list, count) {
  const rows = Array.from(list.querySelectorAll('.share-lyric-row'));
  while (rows.length < count) {
    const row = createLyricRow();
    list.appendChild(row);
    rows.push(row);
  }
  return rows;
}

function getLyricSlotMetrics(list) {
  const styles = window.getComputedStyle(list);
  const gap = parseFloat(styles.rowGap || '0') || 0;
  const rowHeight = Math.max(1, (list.clientHeight - gap * 2) / 3);
  const step = rowHeight + gap;
  list.style.setProperty('--lyric-row-height', `${rowHeight}px`);
  return { step };
}

function setLyricSlot(row, slot, metrics) {
  row.dataset.slot = String(slot);
  row.style.setProperty('--lyric-y', `${slot * metrics.step}px`);
}

function setLyricRole(row, role) {
  row.classList.remove('previous', 'active', 'next');
  row.classList.add(role);
  row.dataset.role = role;
}

function setLyricContent(row, line, lineIndex, progress = 0) {
  const { text, fill } = ensureLyricParts(row);
  const lineText = line?.text || '';
  text.textContent = lineText;
  fill.textContent = lineText;
  row.dataset.lineIndex = String(lineIndex);
  row.style.setProperty('--karaoke-progress', `${Math.min(1, Math.max(0, progress)) * 100}%`);
}

function renderLyricWindowNow(list, lyrics, index, progress) {
  const rows = ensureLyricRows(list, 3);
  rows.slice(3).forEach(row => row.remove());

  const metrics = getLyricSlotMetrics(list);
  const roles = ['previous', 'active', 'next'];
  const lineIndices = index < 0 ? [-2, -1, 0] : [index - 1, index, index + 1];
  const lines = index < 0
    ? [null, { text: '暂无歌词' }, null]
    : lineIndices.map(lineIndex => lyrics[lineIndex] || null);

  rows.slice(0, 3).forEach((row, rowIndex) => {
    row.classList.remove('is-moving', 'is-exiting', 'no-motion');
    setLyricRole(row, roles[rowIndex]);
    setLyricContent(row, lines[rowIndex], lineIndices[rowIndex], rowIndex === 1 ? progress : 0);
    setLyricSlot(row, rowIndex, metrics);
  });

  list.dataset.lyricIndex = String(index);
  setKaraokeProgress(progress);
}

function slideLyricWindow(list, lyrics, previousIndex, index, progress) {
  const direction = index > previousIndex ? 1 : -1;
  const metrics = getLyricSlotMetrics(list);
  const previousRow = list.querySelector('.share-lyric-row.previous');
  const activeRow = list.querySelector('.share-lyric-row.active');
  const nextRow = list.querySelector('.share-lyric-row.next');

  if (!previousRow || !activeRow || !nextRow) {
    renderLyricWindowNow(list, lyrics, index, progress);
    return;
  }

  clearLyricSlide(list);
  list.classList.add('is-sliding');

  [previousRow, activeRow, nextRow].forEach((row, slot) => {
    row.classList.remove('is-moving', 'is-exiting', 'no-motion');
    setLyricSlot(row, slot, metrics);
  });

  const enteringRow = createLyricRow();
  enteringRow.classList.add('no-motion');
  list.appendChild(enteringRow);

  if (direction > 0) {
    setLyricRole(enteringRow, 'next');
    setLyricContent(enteringRow, lyrics[index + 1] || null, index + 1, 0);
    setLyricSlot(enteringRow, 3, metrics);
  } else {
    setLyricRole(enteringRow, 'previous');
    setLyricContent(enteringRow, lyrics[index - 1] || null, index - 1, 0);
    setLyricSlot(enteringRow, -1, metrics);
  }

  void list.offsetHeight;
  [previousRow, activeRow, nextRow, enteringRow].forEach(row => {
    row.classList.remove('no-motion');
    row.classList.add('is-moving');
  });

  if (direction > 0) {
    previousRow.classList.add('is-exiting');
    setLyricRole(previousRow, 'previous');
    setLyricSlot(previousRow, -1, metrics);

    setLyricRole(activeRow, 'previous');
    setLyricContent(activeRow, lyrics[index - 1] || null, index - 1, 0);
    setLyricSlot(activeRow, 0, metrics);

    setLyricRole(nextRow, 'active');
    setLyricContent(nextRow, lyrics[index] || null, index, progress);
    setLyricSlot(nextRow, 1, metrics);

    setLyricRole(enteringRow, 'next');
    setLyricSlot(enteringRow, 2, metrics);
  } else {
    nextRow.classList.add('is-exiting');
    setLyricRole(nextRow, 'next');
    setLyricSlot(nextRow, 3, metrics);

    setLyricRole(activeRow, 'next');
    setLyricContent(activeRow, lyrics[index + 1] || null, index + 1, 0);
    setLyricSlot(activeRow, 2, metrics);

    setLyricRole(previousRow, 'active');
    setLyricContent(previousRow, lyrics[index] || null, index, progress);
    setLyricSlot(previousRow, 1, metrics);

    setLyricRole(enteringRow, 'previous');
    setLyricSlot(enteringRow, 0, metrics);
  }

  list.dataset.lyricIndex = String(index);
  setKaraokeProgress(progress);

  list._lyricSlideTimer = window.setTimeout(() => {
    const rows = direction > 0
      ? [activeRow, nextRow, enteringRow]
      : [enteringRow, previousRow, activeRow];
    const exitRow = direction > 0 ? previousRow : nextRow;
    const nextMetrics = getLyricSlotMetrics(list);

    exitRow.remove();
    rows.forEach((row, slot) => {
      row.classList.remove('is-moving', 'is-exiting', 'no-motion');
      setLyricRole(row, ['previous', 'active', 'next'][slot]);
      setLyricSlot(row, slot, nextMetrics);
    });

    list.classList.remove('is-sliding');
    list._lyricSlideTimer = 0;
  }, LYRIC_SLIDE_DURATION_MS);
}

function init() {
  const payload = getSharePayload();
  const playBtn = document.getElementById('sharePlayBtn');
  const downloadBtn = document.getElementById('shareDownloadBtn');
  const homeBtn = document.getElementById('shareHomeBtn');
  const cover = document.getElementById('shareCover');
  const bgCover = document.getElementById('shareBgCover');
  const coverPlaceholder = document.getElementById('shareCoverPlaceholder');
  const hint = document.getElementById('shareHint');
  const progressSlider = document.getElementById('shareProgressSlider');
  const currentTimeEl = document.getElementById('shareCurrentTime');
  const durationEl = document.getElementById('shareDuration');

  if (!payload?.audioUrl) {
    setText('shareTitle', '分享链接无效');
    setText('shareArtist', '请回到主页重新分享');
    if (playBtn) playBtn.disabled = true;
    if (downloadBtn) downloadBtn.disabled = true;
    if (hint) hint.textContent = '链接缺少播放信息。';
    homeBtn?.addEventListener('click', () => {
      window.location.href = '/';
    });
    return;
  }

  const song = payload.song || {};
  setText('shareTitle', song.name || '未知歌曲');
  setText('shareArtist', song.singer || '未知歌手');

  const coverUrl = song.cover || song.img || '';
  if (coverUrl && /^https?:\/\//i.test(coverUrl)) {
    const proxiedCover = getImageProxyUrl(coverUrl);
    cover.src = coverUrl;
    cover.style.display = 'block';
    if (bgCover) {
      bgCover.src = proxiedCover || coverUrl;
      bgCover.addEventListener('load', () => {
        bgCover.classList.add('loaded');
      }, { once: true });
      bgCover.addEventListener('error', () => {
        if (bgCover.src !== coverUrl) {
          bgCover.src = coverUrl;
          return;
        }
        bgCover.classList.remove('loaded');
      });
    }
    coverPlaceholder.style.display = 'none';
    cover.addEventListener('error', () => {
      if (proxiedCover && cover.src !== proxiedCover) {
        cover.src = proxiedCover;
        return;
      }
      cover.style.display = 'none';
      coverPlaceholder.style.display = 'flex';
    });
    applyThemeFromCover(coverUrl);
  }

  let lyrics = [];
  const audio = new Audio(payload.audioUrl);
  let activeIndex = -1;
  let isSeeking = false;
  let lyricFrameId = 0;

  function syncLyricsToTime(time, duration) {
    if (!lyrics.length) return;
    const lyricTime = Math.max(0, time + LYRIC_LEAD_SECONDS);
    let index = lyrics.findIndex(line => line.time > lyricTime);
    index = index === -1 ? lyrics.length - 1 : Math.max(0, index - 1);
    const start = lyrics[index]?.time ?? 0;
    const end = lyrics[index + 1]?.time ?? duration;
    const lineDuration = Math.max(0.8, (Number.isFinite(end) ? end : start + 4) - start);
    const lineProgress = (lyricTime - start) / lineDuration;
    if (index !== activeIndex) {
      activeIndex = index;
      updateLyricWindow(lyrics, index, lineProgress);
    } else {
      setKaraokeProgress(lineProgress);
    }
  }

  function stopLyricFrame() {
    if (lyricFrameId) {
      cancelAnimationFrame(lyricFrameId);
      lyricFrameId = 0;
    }
  }

  function startLyricFrame() {
    stopLyricFrame();
    const tick = () => {
      syncLyricsToTime(audio.currentTime, audio.duration);
      if (!audio.paused && !audio.ended) {
        lyricFrameId = requestAnimationFrame(tick);
      }
    };
    lyricFrameId = requestAnimationFrame(tick);
  }

  function setLyrics(nextLyrics) {
    lyrics = renderLyrics(nextLyrics);
    activeIndex = -1;
    syncLyricsToTime(audio.currentTime, audio.duration);
  }

  const payloadLyrics = getLyricsFromPayload(payload);
  if (payloadLyrics.length) {
    setLyrics(payloadLyrics);
  } else {
    fetchLyrics(song).then((nextLyrics) => {
      setLyrics(nextLyrics);
      if (!lyrics.length && hint) hint.textContent = '暂无歌词';
    }).catch((err) => {
      console.warn('[Share] lyric lookup failed:', err);
      setLyrics([]);
      if (hint) hint.textContent = '歌词加载失败';
    });
  }

  audio.addEventListener('loadedmetadata', () => {
    updateProgressUI(audio, progressSlider, currentTimeEl, durationEl);
    syncLyricsToTime(audio.currentTime, audio.duration);
  });

  audio.addEventListener('timeupdate', () => {
    if (!isSeeking) {
      updateProgressUI(audio, progressSlider, currentTimeEl, durationEl);
    }
    if (audio.paused || audio.ended) syncLyricsToTime(audio.currentTime, audio.duration);
  });

  audio.addEventListener('playing', () => {
    setPlayState(true);
    startLyricFrame();
  });

  audio.addEventListener('pause', () => {
    setPlayState(false);
    stopLyricFrame();
    syncLyricsToTime(audio.currentTime, audio.duration);
  });

  audio.addEventListener('ended', () => {
    setPlayState(false);
    stopLyricFrame();
    updateProgressUI(audio, progressSlider, currentTimeEl, durationEl);
    syncLyricsToTime(audio.currentTime, audio.duration);
  });

  audio.addEventListener('error', () => {
    if (hint) hint.textContent = '播放失败，请尝试下载后播放。';
    setPlayState(false);
    stopLyricFrame();
  });

  progressSlider?.addEventListener('input', () => {
    isSeeking = true;
    stopLyricFrame();
    const percent = Number(progressSlider.value || 0);
    progressSlider.style.setProperty('--share-progress', `${percent}%`);
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    if (currentTimeEl && duration) currentTimeEl.textContent = formatTime((percent / 100) * duration);
    if (duration && lyrics.length) {
      const seekTime = (percent / 100) * duration;
      syncLyricsToTime(seekTime, duration);
    }
  });

  progressSlider?.addEventListener('change', () => {
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    if (duration) {
      audio.currentTime = (Number(progressSlider.value || 0) / 100) * duration;
    }
    isSeeking = false;
    updateProgressUI(audio, progressSlider, currentTimeEl, durationEl);
    syncLyricsToTime(audio.currentTime, audio.duration);
    if (!audio.paused && !audio.ended) startLyricFrame();
  });

  playBtn?.addEventListener('click', async () => {
    if (audio.paused) {
      try {
        await audio.play();
      } catch (err) {
        if (hint) hint.textContent = `播放失败: ${err.message}`;
      }
    } else {
      audio.pause();
    }
  });

  downloadBtn?.addEventListener('click', () => {
    startDownload(payload.downloadUrl || payload.audioUrl, payload.filename || `${song.singer || 'music'} - ${song.name || 'song'}`);
  });

  homeBtn?.addEventListener('click', () => {
    window.location.href = '/';
  });
}

window.addEventListener('DOMContentLoaded', init);
