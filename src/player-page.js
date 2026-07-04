const LYRIC_SLIDE_DURATION_MS = 460;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getFiniteSeconds(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getImageProxyUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  return `/api/image?url=${encodeURIComponent(url)}`;
}

function getSongCoverUrl(song) {
  const coverUrl = song?.cover || song?.img || '';
  return /^https?:\/\//i.test(coverUrl) ? coverUrl : '';
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
  let bestScore = 0;
  for (const bucket of buckets.values()) {
    const score = bucket.weight * Math.sqrt(bucket.count);
    if (score > bestScore) {
      best = bucket;
      bestScore = score;
    }
  }

  if (best?.weight) return [best.r / best.weight, best.g / best.weight, best.b / best.weight];
  if (fallbackWeight) return fallback.map(value => value / fallbackWeight);
  throw new Error('封面没有可用于取色的像素');
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function normalizeLyrics(lyrics) {
  return Array.isArray(lyrics)
    ? lyrics
        .map(line => ({
          ...line,
          time: Number(line.time),
          text: String(line.text || '').trim(),
        }))
        .filter(line => Number.isFinite(line.time) && line.text)
        .sort((a, b) => a.time - b.time)
    : [];
}

function iconSvg(icon) {
  if (icon === 'home') {
    return `
      <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <path d="m3 12 9-9 9 9"/>
        <path d="M5 10v10h14V10"/>
      </svg>
    `;
  }

  if (icon === 'download') {
    return `
      <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <path d="M7 10l5 5 5-5"/>
        <path d="M12 15V3"/>
      </svg>
    `;
  }

  return `
    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
      <path d="M19 12H5"/>
      <path d="m12 19-7-7 7-7"/>
    </svg>
  `;
}

function createPlayerMarkup({
  idPrefix,
  pageClassName = '',
  panelLabel = '播放界面',
  backLabel = '返回搜索结果',
  homeLabel = '回到主页',
  homeIcon = 'home',
  showTopBack = true,
}) {
  const pageClasses = ['share-page', pageClassName].filter(Boolean).join(' ');
  return `
    <main class="${pageClasses}">
      <img id="${idPrefix}BgCover" class="share-bg-cover" alt="" aria-hidden="true">
      <div class="share-bg-layer" aria-hidden="true"></div>
      ${showTopBack ? `
        <button id="${idPrefix}BackBtn" class="share-back-btn" type="button" title="${backLabel}" aria-label="${backLabel}">
          ${iconSvg('back')}
        </button>
      ` : ''}

      <section class="share-cover-stage" aria-label="歌曲封面">
        <div class="share-cover-frame">
          <div id="${idPrefix}CoverPlaceholder" class="share-cover-placeholder">♪</div>
          <img id="${idPrefix}Cover" class="share-cover" alt="歌曲封面">
        </div>
      </section>

      <section class="share-player-panel" aria-label="${panelLabel}">
        <div class="share-song-info">
          <h1 id="${idPrefix}Title" class="share-title">歌曲</h1>
          <div id="${idPrefix}Artist" class="share-artist">歌手</div>
          <div id="${idPrefix}LyricList" class="share-lyric-list">
            <div class="share-lyric-row previous"><span class="share-lyric-text"></span><span class="share-lyric-fill" aria-hidden="true"></span></div>
            <div class="share-lyric-row active"><span class="share-lyric-text">歌词加载中...</span><span class="share-lyric-fill" aria-hidden="true">歌词加载中...</span></div>
            <div class="share-lyric-row next"><span class="share-lyric-text"></span><span class="share-lyric-fill" aria-hidden="true"></span></div>
          </div>
        </div>

        <div class="share-progress-wrap">
          <div class="share-progress-times">
            <span id="${idPrefix}CurrentTime">00:00</span>
            <span id="${idPrefix}Duration">00:00</span>
          </div>
          <input id="${idPrefix}ProgressSlider" class="share-progress-slider" type="range" min="0" max="100" value="0" step="0.1" aria-label="播放进度">
        </div>
        <div class="share-control-row">
          <button id="${idPrefix}HomeBtn" class="share-panel-icon-btn" type="button" title="${homeLabel}" aria-label="${homeLabel}">
            ${iconSvg(homeIcon)}
          </button>
          <button id="${idPrefix}PlayBtn" class="share-play-toggle" type="button" title="播放" aria-label="播放">
            <svg class="share-play-icon" width="34" height="34" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            <svg class="share-pause-icon" width="34" height="34" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
            </svg>
          </button>
          <button id="${idPrefix}DownloadBtn" class="share-panel-icon-btn" type="button" title="下载" aria-label="下载">
            ${iconSvg('download')}
          </button>
        </div>
        <p id="${idPrefix}Hint" class="share-hint"></p>
      </section>
    </main>
  `;
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
  row.style.setProperty('--karaoke-progress', `${clamp(progress, 0, 1) * 100}%`);
}

export function createPlayerPageController(options = {}) {
  const idPrefix = options.idPrefix || 'share';
  const overlay = Boolean(options.overlay);
  const lyricLeadSeconds = Number.isFinite(options.lyricLeadSeconds) ? options.lyricLeadSeconds : 0;
  let root = options.root || null;
  let page = null;
  let bound = false;
  let active = !overlay;
  let isSeeking = false;
  let frameId = 0;
  let lyricIndex = -1;
  let lyricDrag = null;
  let metadataToken = 0;
  let currentSong = null;
  let lyrics = [];
  const els = {};

  const readAudio = () => options.getAudio?.() || null;
  const readCurrentTime = () => getFiniteSeconds(options.getCurrentTime?.() ?? readAudio()?.currentTime);
  const readDuration = () => getFiniteSeconds(options.getDuration?.() ?? readAudio()?.duration);
  const readEstimatedDuration = () => getFiniteSeconds(options.getEstimatedDuration?.());
  const isPlaying = () => {
    const audio = readAudio();
    return Boolean(audio && !audio.paused && !audio.ended);
  };

  function query(id) {
    return root?.querySelector?.(`#${idPrefix}${id}`) || document.getElementById(`${idPrefix}${id}`);
  }

  function ensureMounted() {
    if (!root) {
      root = document.createElement('div');
      root.id = options.rootId || `${idPrefix}Overlay`;
      root.className = options.rootClassName || '';
      if (overlay) root.setAttribute('aria-hidden', 'true');
      root.innerHTML = createPlayerMarkup({
        idPrefix,
        pageClassName: options.pageClassName || '',
        panelLabel: options.panelLabel || '播放界面',
        backLabel: options.backLabel || '返回搜索结果',
        homeLabel: options.homeLabel || '回到主页',
        homeIcon: options.homeIcon || 'home',
        showTopBack: options.showTopBack !== false,
      });
      (options.mount || document.body).appendChild(root);
    }

    page = root.classList?.contains('share-page') ? root : root.querySelector('.share-page');
    Object.assign(els, {
      bgCover: query('BgCover'),
      cover: query('Cover'),
      coverPlaceholder: query('CoverPlaceholder'),
      backBtn: query('BackBtn'),
      homeBtn: query('HomeBtn'),
      playBtn: query('PlayBtn'),
      downloadBtn: query('DownloadBtn'),
      title: query('Title'),
      artist: query('Artist'),
      lyricList: query('LyricList'),
      slider: query('ProgressSlider'),
      currentTime: query('CurrentTime'),
      duration: query('Duration'),
      hint: query('Hint'),
    });

    if (!bound) bindEvents();
    return root;
  }

  function bindEvents() {
    bound = true;

    if (typeof options.back === 'function') {
      els.backBtn?.addEventListener('click', (event) => {
        options.back(event);
      });
    }
    if (typeof options.home === 'function') {
      els.homeBtn?.addEventListener('click', (event) => {
        options.home(event);
      });
    }
    els.playBtn?.addEventListener('click', async (event) => {
      try {
        await options.playPause?.(event);
      } catch (err) {
        setHint(`播放失败: ${err.message}`);
      }
    });
    els.downloadBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.download?.(event);
    });

    els.slider?.addEventListener('input', () => {
      isSeeking = true;
      stopFrame();
      const percent = Number(els.slider.value || 0);
      els.slider.style.setProperty('--share-progress', `${percent}%`);
      const duration = readDuration();
      const seekTime = duration ? (percent / 100) * duration : 0;
      if (els.currentTime && duration) els.currentTime.textContent = formatTime(seekTime);
      syncLyricsToTime(seekTime, duration);
    });

    const commitProgressSeek = () => {
      const duration = readDuration();
      if (duration) options.seek?.((Number(els.slider?.value || 0) / 100) * duration);
      isSeeking = false;
      updateProgress({ force: true });
      syncLyricsToTime(readCurrentTime(), readDuration());
      if (isPlaying()) startFrame();
    };
    els.slider?.addEventListener('change', commitProgressSeek);
    els.slider?.addEventListener('pointerup', commitProgressSeek);
    els.slider?.addEventListener('touchend', commitProgressSeek);

    els.lyricList?.addEventListener('pointerdown', startLyricDrag);
    els.lyricList?.addEventListener('pointermove', moveLyricDrag);
    els.lyricList?.addEventListener('pointerup', (event) => {
      event.preventDefault();
      finishLyricDrag({ commit: true, pointerId: event.pointerId });
    });
    els.lyricList?.addEventListener('pointercancel', (event) => {
      finishLyricDrag({ commit: false, pointerId: event.pointerId });
    });

    window.addEventListener('resize', handleResize);
    window.visualViewport?.addEventListener('resize', handleResize);
  }

  function handleResize() {
    if (active && !lyricDrag) syncLyricsToTime(readCurrentTime(), readDuration());
  }

  function getThemeTargets() {
    if (typeof options.themeTargets === 'function') {
      return options.themeTargets({ root, page }).filter(Boolean);
    }
    return [page].filter(Boolean);
  }

  function applyTheme(theme) {
    for (const target of getThemeTargets()) {
      target.style.setProperty('--share-theme-rgb', rgbToCss(theme.main));
      target.style.setProperty('--share-theme-dark-rgb', rgbToCss(theme.dark));
      target.style.setProperty('--share-theme-soft-rgb', rgbToCss(theme.soft));
    }
  }

  function clearTheme() {
    for (const target of getThemeTargets()) {
      target.style.removeProperty('--share-theme-rgb');
      target.style.removeProperty('--share-theme-dark-rgb');
      target.style.removeProperty('--share-theme-soft-rgb');
    }
  }

  async function applyThemeFromCover(coverUrl, token) {
    const proxyUrl = getImageProxyUrl(coverUrl);
    if (!proxyUrl) return;

    try {
      const img = await loadImage(proxyUrl);
      if (token !== metadataToken) return;
      const dominantColor = getDominantColorFromImage(img);
      if (token !== metadataToken) return;
      applyTheme(buildThemeFromColor(dominantColor));
    } catch (err) {
      console.warn(`${options.logPrefix || '[Player Page]'} cover theme extraction failed:`, err);
    }
  }

  function showCoverPlaceholder() {
    els.cover?.removeAttribute('src');
    els.bgCover?.removeAttribute('src');
    els.cover?.classList.remove('loaded');
    els.bgCover?.classList.remove('loaded');
    if (els.cover) els.cover.style.display = 'none';
    if (els.coverPlaceholder) els.coverPlaceholder.style.display = 'flex';
  }

  function applyCover(coverUrl, token = metadataToken) {
    if (token !== metadataToken || !coverUrl || !/^https?:\/\//i.test(coverUrl)) return false;
    const proxiedCover = getImageProxyUrl(coverUrl);
    const displayCover = proxiedCover || coverUrl;

    if (els.cover) {
      els.cover.classList.remove('loaded');
      els.cover.onload = () => {
        if (token === metadataToken) els.cover.classList.add('loaded');
      };
      els.cover.onerror = () => {
        if (token !== metadataToken) return;
        if (displayCover !== coverUrl && els.cover.src !== coverUrl) {
          els.cover.src = coverUrl;
          return;
        }
        els.cover.style.display = 'none';
        if (els.coverPlaceholder) els.coverPlaceholder.style.display = 'flex';
      };
      els.cover.src = displayCover;
      els.cover.style.display = 'block';
    }
    if (els.coverPlaceholder) els.coverPlaceholder.style.display = 'none';

    if (els.bgCover) {
      let bgUsingFallback = false;
      els.bgCover.classList.remove('loaded');
      els.bgCover.onload = () => {
        if (token === metadataToken) els.bgCover.classList.add('loaded');
      };
      els.bgCover.onerror = () => {
        if (token !== metadataToken) return;
        if (!bgUsingFallback && displayCover !== coverUrl) {
          bgUsingFallback = true;
          els.bgCover.src = coverUrl;
          return;
        }
        els.bgCover.classList.remove('loaded');
      };
      els.bgCover.src = displayCover;
    }

    applyThemeFromCover(coverUrl, token);
    return true;
  }

  function setSong(song) {
    ensureMounted();
    currentSong = song || {};
    const token = ++metadataToken;
    if (els.title) els.title.textContent = currentSong.name || '未知歌曲';
    if (els.artist) els.artist.textContent = currentSong.singer || '未知歌手';

    const coverUrl = getSongCoverUrl(currentSong);
    if (coverUrl) {
      applyCover(coverUrl, token);
    } else {
      showCoverPlaceholder();
    }

    if (typeof options.lookupCover === 'function') {
      Promise.resolve(options.lookupCover(currentSong)).then((bestCoverUrl) => {
        if (token !== metadataToken) return;
        const resolvedCoverUrl = bestCoverUrl || getSongCoverUrl(currentSong);
        if (resolvedCoverUrl && resolvedCoverUrl !== coverUrl) {
          currentSong.cover = resolvedCoverUrl;
          currentSong.img = currentSong.img || resolvedCoverUrl;
          applyCover(resolvedCoverUrl, token);
        } else if (!coverUrl) {
          clearTheme();
        }
      }).catch((err) => {
        console.warn(`${options.logPrefix || '[Player Page]'} cover lookup failed:`, err.message || err);
        if (token === metadataToken && !coverUrl) clearTheme();
      });
    } else if (!coverUrl) {
      clearTheme();
    }
  }

  function setHint(text = '') {
    ensureMounted();
    if (els.hint) els.hint.textContent = text;
  }

  function setControlsDisabled(disabled = {}) {
    ensureMounted();
    if (Object.prototype.hasOwnProperty.call(disabled, 'play') && els.playBtn) {
      els.playBtn.disabled = Boolean(disabled.play);
    }
    if (Object.prototype.hasOwnProperty.call(disabled, 'download') && els.downloadBtn) {
      els.downloadBtn.disabled = Boolean(disabled.download);
    }
  }

  function setPlayState(nextPlaying) {
    if (!root && overlay && !active) return;
    ensureMounted();
    if (!els.playBtn) return;
    els.playBtn.classList.toggle('playing', Boolean(nextPlaying));
    els.playBtn.title = nextPlaying ? '暂停' : '播放';
    els.playBtn.setAttribute('aria-label', nextPlaying ? '暂停' : '播放');
  }

  function updateProgress({ force = false, time = readCurrentTime(), duration = readDuration() } = {}) {
    if (!root && overlay && !active && !force) return;
    ensureMounted();
    if (!active && !force) return;
    if (isSeeking && !force) return;
    const safeDuration = getFiniteSeconds(duration);
    const currentTime = getFiniteSeconds(time);
    const percent = safeDuration ? clamp((currentTime / safeDuration) * 100, 0, 100) : 0;

    if (els.slider) {
      els.slider.value = String(percent);
      els.slider.style.setProperty('--share-progress', `${percent}%`);
    }
    if (els.currentTime) els.currentTime.textContent = formatTime(currentTime);
    if (els.duration) els.duration.textContent = safeDuration ? formatTime(safeDuration) : '00:00';
  }

  function clearLyricSlide(list = els.lyricList) {
    if (list?._lyricSlideTimer) {
      window.clearTimeout(list._lyricSlideTimer);
      list._lyricSlideTimer = 0;
    }
    list?.classList.remove('is-sliding');
  }

  function setKaraokeProgress(progress) {
    const activeRow = els.lyricList?.querySelector('.share-lyric-row.active');
    if (!activeRow) return;
    activeRow.style.setProperty('--karaoke-progress', `${clamp(Number(progress) || 0, 0, 1) * 100}%`);
  }

  function renderLyricWindowNow(list, nextLyrics, index, progress) {
    const rows = ensureLyricRows(list, 3);
    rows.slice(3).forEach(row => row.remove());

    const metrics = getLyricSlotMetrics(list);
    const roles = ['previous', 'active', 'next'];
    const lineIndices = index < 0 ? [-2, -1, 0] : [index - 1, index, index + 1];
    const lines = index < 0
      ? [null, { text: '暂无歌词' }, null]
      : lineIndices.map(lineIndex => nextLyrics[lineIndex] || null);

    rows.slice(0, 3).forEach((row, rowIndex) => {
      row.classList.remove('is-moving', 'is-exiting', 'no-motion');
      setLyricRole(row, roles[rowIndex]);
      setLyricContent(row, lines[rowIndex], lineIndices[rowIndex], rowIndex === 1 ? progress : 0);
      setLyricSlot(row, rowIndex, metrics);
    });

    list.dataset.lyricIndex = String(index);
    setKaraokeProgress(progress);
  }

  function slideLyricWindow(list, nextLyrics, previousIndex, index, progress) {
    const direction = index > previousIndex ? 1 : -1;
    const metrics = getLyricSlotMetrics(list);
    const previousRow = list.querySelector('.share-lyric-row.previous');
    const activeRow = list.querySelector('.share-lyric-row.active');
    const nextRow = list.querySelector('.share-lyric-row.next');

    if (!previousRow || !activeRow || !nextRow) {
      renderLyricWindowNow(list, nextLyrics, index, progress);
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
      setLyricContent(enteringRow, nextLyrics[index + 1] || null, index + 1, 0);
      setLyricSlot(enteringRow, 3, metrics);
    } else {
      setLyricRole(enteringRow, 'previous');
      setLyricContent(enteringRow, nextLyrics[index - 1] || null, index - 1, 0);
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
      setLyricContent(activeRow, nextLyrics[index - 1] || null, index - 1, 0);
      setLyricSlot(activeRow, 0, metrics);

      setLyricRole(nextRow, 'active');
      setLyricContent(nextRow, nextLyrics[index] || null, index, progress);
      setLyricSlot(nextRow, 1, metrics);

      setLyricRole(enteringRow, 'next');
      setLyricSlot(enteringRow, 2, metrics);
    } else {
      nextRow.classList.add('is-exiting');
      setLyricRole(nextRow, 'next');
      setLyricSlot(nextRow, 3, metrics);

      setLyricRole(activeRow, 'next');
      setLyricContent(activeRow, nextLyrics[index + 1] || null, index + 1, 0);
      setLyricSlot(activeRow, 2, metrics);

      setLyricRole(previousRow, 'active');
      setLyricContent(previousRow, nextLyrics[index] || null, index, progress);
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

  function updateLyricWindow(nextLyrics, index, initialProgress = 0) {
    ensureMounted();
    const list = els.lyricList;
    if (!list) return;

    const progress = Number.isFinite(initialProgress) ? clamp(initialProgress, 0, 1) : 0;
    if (!nextLyrics.length || index < 0) {
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
      slideLyricWindow(list, nextLyrics, previousIndex, index, progress);
    } else {
      clearLyricSlide(list);
      renderLyricWindowNow(list, nextLyrics, index, progress);
    }
  }

  function getLyricIndexAtTime(time) {
    if (!lyrics.length) return -1;
    const lyricTime = Math.max(0, time + lyricLeadSeconds);
    let index = lyrics.findIndex(line => line.time > lyricTime);
    return index === -1 ? lyrics.length - 1 : Math.max(0, index - 1);
  }

  function getLyricWindow(time, duration) {
    if (!lyrics.length) return null;
    const lyricTime = Math.max(0, time + lyricLeadSeconds);
    const index = getLyricIndexAtTime(time);
    const start = lyrics[index]?.time ?? 0;
    const end = lyrics[index + 1]?.time ?? duration;
    const lineDuration = Math.max(0.8, (Number.isFinite(end) ? end : start + 4) - start);
    return {
      index,
      progress: clamp((lyricTime - start) / lineDuration, 0, 1),
    };
  }

  function syncLyricsToTime(time = readCurrentTime(), duration = readDuration()) {
    if (!root && overlay && !active) return;
    ensureMounted();
    if (lyricDrag) return;
    if (!active || !els.lyricList) return;
    if (!lyrics.length) {
      lyricIndex = -1;
      updateLyricWindow([], -1, 0);
      return;
    }

    const lyric = getLyricWindow(getFiniteSeconds(time), getFiniteSeconds(duration));
    if (!lyric) return;
    if (lyric.index !== lyricIndex) {
      lyricIndex = lyric.index;
      updateLyricWindow(lyrics, lyric.index, lyric.progress);
    } else {
      setKaraokeProgress(lyric.progress);
    }
  }

  function setLyrics(nextLyrics) {
    lyrics = normalizeLyrics(nextLyrics);
    lyricIndex = -1;
    if (root) {
      if (lyrics.length) {
        syncLyricsToTime(readCurrentTime(), readDuration());
        if (lyricIndex < 0) updateLyricWindow(lyrics, 0, 0);
      } else {
        updateLyricWindow([], -1, 0);
      }
    }
    return lyrics;
  }

  function getLyricDragPixelsPerLine(metrics) {
    const viewportHeight = Math.max(1, els.lyricList?.clientHeight || metrics.step * 3);
    const duration = readDuration() || readEstimatedDuration();
    const linesByCount = Math.round((lyrics.length || 1) / 8);
    const linesByDuration = duration ? Math.round(duration / 20) : 0;
    const linesPerViewport = clamp(Math.max(5, linesByCount, linesByDuration), 5, 30);
    return Math.max(4, viewportHeight / linesPerViewport);
  }

  function getLyricSeekTime(index) {
    if (!lyrics.length) return 0;
    const safeIndex = clamp(index, 0, lyrics.length - 1);
    const targetTime = Number(lyrics[safeIndex]?.time || 0);
    const duration = readDuration();
    return duration ? Math.min(Math.max(0, targetTime), Math.max(0, duration - 0.05)) : Math.max(0, targetTime);
  }

  function previewLyricSeek(index) {
    if (!active || !lyrics.length || !els.lyricList) return;
    const targetIndex = clamp(index, 0, lyrics.length - 1);
    lyricIndex = targetIndex;
    clearLyricSlide(els.lyricList);
    renderLyricWindowNow(els.lyricList, lyrics, targetIndex, 0);

    const targetTime = getLyricSeekTime(targetIndex);
    const duration = readDuration();
    const percent = duration ? clamp((targetTime / duration) * 100, 0, 100) : 0;
    if (els.slider) {
      els.slider.value = String(percent);
      els.slider.style.setProperty('--share-progress', `${percent}%`);
    }
    if (els.currentTime) els.currentTime.textContent = formatTime(targetTime);
  }

  function startLyricDrag(event) {
    if (!active || !lyrics.length || event.button > 0) return;
    ensureMounted();
    if (!els.lyricList) return;
    const metrics = getLyricSlotMetrics(els.lyricList);
    if (!metrics?.step) return;

    event.preventDefault();
    els.lyricList.setPointerCapture?.(event.pointerId);
    isSeeking = true;
    stopFrame();
    clearLyricSlide(els.lyricList);

    const currentIndex = Math.max(0, getLyricIndexAtTime(readCurrentTime()));
    lyricDrag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startIndex: currentIndex,
      targetIndex: currentIndex,
      pixelsPerLine: getLyricDragPixelsPerLine(metrics),
    };
    els.lyricList.classList.add('is-dragging');
    previewLyricSeek(currentIndex);
  }

  function moveLyricDrag(event) {
    if (!lyricDrag || lyricDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const offsetRows = Math.round((lyricDrag.startY - event.clientY) / lyricDrag.pixelsPerLine);
    const targetIndex = clamp(lyricDrag.startIndex + offsetRows, 0, lyrics.length - 1);
    if (targetIndex === lyricDrag.targetIndex) return;
    lyricDrag.targetIndex = targetIndex;
    previewLyricSeek(targetIndex);
  }

  function finishLyricDrag({ commit = false, pointerId } = {}) {
    if (!lyricDrag) return;
    if (pointerId != null && lyricDrag.pointerId !== pointerId) return;

    try {
      els.lyricList?.releasePointerCapture?.(lyricDrag.pointerId);
    } catch (_) {
      // Pointer capture may already be released by the browser.
    }
    els.lyricList?.classList.remove('is-dragging');

    const targetIndex = lyricDrag.targetIndex;
    lyricDrag = null;
    isSeeking = false;

    if (commit) options.seek?.(getLyricSeekTime(targetIndex));
    updateProgress({ force: true });
    syncLyricsToTime(readCurrentTime(), readDuration());
    if (isPlaying()) startFrame();
  }

  function stopFrame() {
    if (!frameId) return;
    cancelAnimationFrame(frameId);
    frameId = 0;
  }

  function startFrame() {
    if (!active) return;
    stopFrame();
    const tick = () => {
      if (!lyricDrag) {
        updateProgress();
        syncLyricsToTime(readCurrentTime(), readDuration());
      }
      if (active && isPlaying()) {
        frameId = requestAnimationFrame(tick);
      }
    };
    frameId = requestAnimationFrame(tick);
  }

  function open({ song = currentSong, lyrics: nextLyrics = options.getLyrics?.() } = {}) {
    ensureMounted();
    active = true;
    if (overlay) {
      root.classList.add('active');
      root.setAttribute('aria-hidden', 'false');
    }
    if (song) setSong(song);
    if (nextLyrics) setLyrics(nextLyrics);
    updateProgress({ force: true });
    setPlayState(isPlaying());
    syncLyricsToTime(readCurrentTime(), readDuration());
    if (isPlaying()) startFrame();
  }

  function close() {
    if (!root) return;
    finishLyricDrag({ commit: false });
    if (overlay) {
      active = false;
      root.classList.remove('active');
      root.setAttribute('aria-hidden', 'true');
    }
    isSeeking = false;
    stopFrame();
  }

  function cancelInteractions() {
    finishLyricDrag({ commit: false });
    isSeeking = false;
  }

  function handleTimeUpdate() {
    if (!isSeeking && !lyricDrag) updateProgress();
    const audio = readAudio();
    if (!lyricDrag && (!audio || audio.paused || audio.ended)) {
      syncLyricsToTime(readCurrentTime(), readDuration());
    }
  }

  function handleLoadedMetadata() {
    if (!lyricDrag) {
      updateProgress({ force: true });
      syncLyricsToTime(readCurrentTime(), readDuration());
    }
  }

  function handlePlaying() {
    setPlayState(true);
    startFrame();
  }

  function handlePause() {
    setPlayState(false);
    stopFrame();
    if (!lyricDrag) syncLyricsToTime(readCurrentTime(), readDuration());
  }

  function handleEnded() {
    setPlayState(false);
    stopFrame();
    if (!lyricDrag) {
      updateProgress({ force: true });
      syncLyricsToTime(readCurrentTime(), readDuration());
    }
  }

  function handleError() {
    setPlayState(false);
    stopFrame();
  }

  function resetLyricIndex() {
    lyricIndex = -1;
  }

  return {
    get root() {
      return root;
    },
    get page() {
      return page;
    },
    get elements() {
      ensureMounted();
      return els;
    },
    ensureMounted,
    open,
    close,
    setSong,
    setHint,
    setControlsDisabled,
    setPlayState,
    setLyrics,
    updateProgress,
    syncLyrics: syncLyricsToTime,
    startFrame,
    stopFrame,
    cancelInteractions,
    handleTimeUpdate,
    handleLoadedMetadata,
    handlePlaying,
    handlePause,
    handleEnded,
    handleError,
    resetLyricIndex,
    isLyricDragging: () => Boolean(lyricDrag),
    isSeeking: () => Boolean(isSeeking),
  };
}
