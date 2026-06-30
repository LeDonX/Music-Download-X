const RESPONSE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Pragma': 'no-cache',
};

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const UPSTREAM_TIMEOUT_MS = 9000;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: RESPONSE_HEADERS,
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`upstream timeout after ${timeoutMs}ms`));
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

async function retry(fn, maxRetries = 2) {
  let lastError;
  for (let i = 0; i < maxRetries; i += 1) {
    try {
      const result = await fn(i);
      if (result) return result;
      lastError = new Error('empty lyric response');
    } catch (err) {
      lastError = err;
    }
    await new Promise(resolve => setTimeout(resolve, 180 * (i + 1)));
  }
  throw lastError || new Error('lyric request failed');
}

function decodeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function decodeBase64Text(value) {
  if (!value) return '';
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

function normalizeTimeLabels(lrc) {
  return String(lrc || '')
    .replace(/\[(\d{2}:\d{2}):(\d{2,3})]/g, '[$1.$2]')
    .replace(/\r/g, '');
}

function hasTimedLyric(lrc) {
  return /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?]/.test(String(lrc || ''));
}

function createLyricResult(info, provider) {
  const lyric = normalizeTimeLabels(info?.lyric || info?.lrc || '');
  const tlyric = normalizeTimeLabels(info?.tlyric || '');
  const rlyric = normalizeTimeLabels(info?.rlyric || '');
  const lxlyric = normalizeTimeLabels(info?.lxlyric || '');
  const primary = lyric || lxlyric;

  if (!hasTimedLyric(primary)) {
    throw new Error(`${provider} returned no timed lyric`);
  }

  return {
    provider,
    lyric: primary,
    tlyric,
    rlyric,
    lxlyric,
  };
}

function buildSong(searchParams) {
  return {
    source: searchParams.get('source') || '',
    songmid: searchParams.get('songmid') || '',
    songId: searchParams.get('songId') || '',
    hash: searchParams.get('hash') || '',
    copyrightId: searchParams.get('copyrightId') || '',
    name: searchParams.get('name') || '',
    singer: searchParams.get('singer') || '',
    albumName: searchParams.get('albumName') || '',
    interval: searchParams.get('interval') || '',
    lrcUrl: searchParams.get('lrcUrl') || '',
    mrcUrl: searchParams.get('mrcUrl') || '',
    trcUrl: searchParams.get('trcUrl') || '',
  };
}

function intervalToSeconds(interval) {
  if (typeof interval === 'number') return interval;
  const parts = String(interval || '').split(':').map(part => parseInt(part, 10));
  if (!parts.length || parts.some(Number.isNaN)) return 0;
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}

function formatLrcTime(secondsValue) {
  const seconds = Number(secondsValue);
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.000';
  const minutes = Math.floor(seconds / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function filterCompareText(value) {
  return String(value || '')
    .replace(/\s|'|\.|,|，|&|"|、|\(|\)|（|）|`|~|-|<|>|\||\/|\]|\[|!|！/g, '')
    .toLowerCase();
}

function rankCandidate(target, candidate) {
  const targetName = filterCompareText(target.name);
  const candidateName = filterCompareText(candidate.name);
  if (!targetName || !candidateName) return -1;

  const targetInterval = intervalToSeconds(target.interval);
  const candidateInterval = intervalToSeconds(candidate.interval);
  if (targetInterval && candidateInterval && Math.abs(targetInterval - candidateInterval) > 8) return -1;

  const targetSinger = filterCompareText(target.singer);
  const candidateSinger = filterCompareText(candidate.singer);
  const targetAlbum = filterCompareText(target.albumName);
  const candidateAlbum = filterCompareText(candidate.albumName);

  let score = 0;
  if (targetName === candidateName) score += 70;
  if (targetName.includes(candidateName) || candidateName.includes(targetName)) score += 25;
  if (targetSinger && candidateSinger && (targetSinger.includes(candidateSinger) || candidateSinger.includes(targetSinger))) score += 25;
  if (targetAlbum && candidateAlbum && targetAlbum === candidateAlbum) score += 10;
  if (targetInterval && candidateInterval && Math.abs(targetInterval - candidateInterval) <= 3) score += 15;
  return score;
}

function normalizeMiguUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `http://d.musicapp.migu.cn${url.startsWith('/') ? '' : '/'}${url}`;
}

async function getNeteaseLyric(song) {
  if (!song.songmid) throw new Error('missing NetEase song id');
  const url = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(song.songmid)}&lv=1&kv=1&tv=-1&rv=1`;
  const body = await retry(async () => {
    const res = await fetchWithTimeout(url, {
      headers: {
        ...DEFAULT_HEADERS,
        Referer: 'https://music.163.com/',
      },
    });
    if (!res.ok) throw new Error(`NetEase lyric HTTP ${res.status}`);
    const json = await res.json();
    return json?.lrc?.lyric ? json : null;
  }, 3);

  return createLyricResult({
    lyric: body.lrc?.lyric || '',
    tlyric: body.tlyric?.lyric || '',
    rlyric: body.romalrc?.lyric || '',
  }, 'wy');
}

async function getQQLyric(song) {
  if (!song.songmid) throw new Error('missing QQ song mid');
  const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(song.songmid)}&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&platform=yqq`;
  const body = await retry(async () => {
    const res = await fetchWithTimeout(url, {
      headers: {
        ...DEFAULT_HEADERS,
        Referer: 'https://y.qq.com/portal/player.html',
      },
    });
    if (!res.ok) throw new Error(`QQ lyric HTTP ${res.status}`);
    const text = await res.text();
    const jsonText = text.trim().replace(/^[^(]*\(([\s\S]*)\)\s*;?$/, '$1');
    const json = JSON.parse(jsonText);
    return json?.lyric ? json : null;
  }, 3);

  return createLyricResult({
    lyric: decodeBase64Text(body.lyric),
    tlyric: decodeBase64Text(body.trans),
  }, 'tx');
}

async function getKuwoLyric(song) {
  if (!song.songmid) throw new Error('missing Kuwo song id');
  const url = `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(song.songmid)}`;
  const body = await retry(async () => {
    const res = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS });
    if (!res.ok) throw new Error(`Kuwo lyric HTTP ${res.status}`);
    const json = await res.json();
    return json?.data?.lrclist?.length ? json : null;
  }, 3);

  const data = body.data;
  const tags = [
    `[ti:${data.songinfo?.songName || song.name || ''}]`,
    `[ar:${data.songinfo?.artist || song.singer || ''}]`,
    `[al:${data.songinfo?.album || song.albumName || ''}]`,
    '[offset:0]',
  ];
  const lyric = data.lrclist
    .map(item => `[${formatLrcTime(item.time)}]${decodeHTML(item.lineLyric || '')}`)
    .join('\n');

  return createLyricResult({ lyric: `${tags.join('\n')}\n${lyric}` }, 'kw');
}

const MIGU_DELTA = 2654435769n;
const MIGU_KEY = [
  27303562373562475n,
  18014862372307051n,
  22799692160172081n,
  34058940340699235n,
  30962724186095721n,
  27303523720101991n,
  27303523720101998n,
  31244139033526382n,
  28992395054481524n,
];
const BIGINT_MAX = 9223372036854775807n;
const BIGINT_MIN = -9223372036854775808n;

function toLong(value) {
  const num = typeof value === 'string' ? BigInt(`0x${value}`) : value;
  if (num > BIGINT_MAX) return toLong(num - (1n << 64n));
  if (num < BIGINT_MIN) return toLong(num + (1n << 64n));
  return num;
}

function toBigintArray(data) {
  const length = Math.floor(data.length / 16);
  const values = [];
  for (let i = 0; i < length; i += 1) {
    values[i] = toLong(data.substring(i * 16, (i * 16) + 16));
  }
  return values;
}

function longToBytes(value) {
  const bytes = new Uint8Array(8);
  let next = value;
  for (let i = 0; i < 8; i += 1) {
    bytes[i] = Number(next & 0xffn);
    next >>= 8n;
  }
  return bytes;
}

function longArrToString(values) {
  const bytes = new Uint8Array(values.length * 8);
  values.forEach((value, index) => {
    bytes.set(longToBytes(value), index * 8);
  });
  return new TextDecoder('utf-16le').decode(bytes).replace(/\0+$/g, '');
}

function teaDecrypt(values, key) {
  const length = values.length;
  if (length < 1) return values;

  let previous = values[0];
  let sum = toLong((6n + (52n / BigInt(length))) * MIGU_DELTA);
  while (sum !== 0n) {
    const e = toLong(3n & toLong(sum >> 2n));
    for (let i = length - 1; i > 0; i -= 1) {
      const z = values[i - 1];
      const keyIndex = Number((BigInt(i) & 3n) ^ e);
      previous = toLong(values[i] - (
        toLong(toLong(previous ^ sum) + toLong(z ^ key[keyIndex])) ^
        toLong(toLong(toLong(z >> 5n) ^ toLong(previous << 2n)) + toLong(toLong(previous >> 3n) ^ toLong(z << 4n)))
      ));
      values[i] = previous;
    }
    const z = values[length - 1];
    previous = toLong(values[0] - (
      toLong(toLong(key[Number(e)] ^ z) + toLong(previous ^ sum)) ^
      toLong(toLong(toLong(z >> 5n) ^ toLong(previous << 2n)) + toLong(toLong(previous >> 3n) ^ toLong(z << 4n)))
    ));
    values[0] = previous;
    sum = toLong(sum - MIGU_DELTA);
  }
  return values;
}

function decryptMiguMrc(data) {
  if (!data || data.length < 32) return data || '';
  return longArrToString(teaDecrypt(toBigintArray(data), MIGU_KEY));
}

function parseMiguMrc(mrcText) {
  const lines = String(mrcText || '').replace(/\r/g, '').split('\n');
  const lrcLines = [];
  const lxLines = [];

  for (const line of lines) {
    const match = /^\s*\[(\d+),\d+\]/.exec(line);
    if (!match) continue;

    const startMs = parseInt(match[1], 10);
    let seconds = startMs / 1000;
    const ms = startMs % 1000;
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    seconds %= 60;
    const s = Math.floor(seconds).toString().padStart(2, '0');
    const time = `${m}:${s}.${String(ms).padStart(3, '0')}`;
    const words = line.replace(/^\s*\[(\d+),\d+\]/, '');

    lrcLines.push(`[${time}]${words.replace(/(\(\d+,\d+\))/g, '')}`);

    const times = words.match(/(\(\d+,\d+\))/g);
    if (!times) continue;
    const wordParts = words.split(/\(\d+,\d+\)/);
    const lxWords = times.map((timeText, index) => {
      const wordMatch = /\((\d+),(\d+)\)/.exec(timeText);
      if (!wordMatch) return wordParts[index] || '';
      return `<${parseInt(wordMatch[1], 10) - startMs},${wordMatch[2]}>${wordParts[index] || ''}`;
    }).join('');
    lxLines.push(`[${time}]${lxWords}`);
  }

  return {
    lyric: lrcLines.join('\n'),
    lxlyric: lxLines.join('\n'),
  };
}

async function fetchMiguText(url) {
  const res = await fetchWithTimeout(normalizeMiguUrl(url), {
    headers: {
      ...DEFAULT_HEADERS,
      Referer: 'https://app.c.nf.migu.cn/',
      channel: '0146921',
    },
  });
  if (!res.ok) throw new Error(`Migu lyric HTTP ${res.status}`);
  return res.text();
}

async function getMiguInfo(song) {
  if (!song.copyrightId) return song;
  const res = await fetchWithTimeout('https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?resourceType=2', {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: new URLSearchParams({ resourceId: song.copyrightId }).toString(),
  });
  if (!res.ok) throw new Error(`Migu info HTTP ${res.status}`);
  const json = await res.json();
  const info = Array.isArray(json?.resource) ? json.resource[0] : null;
  if (!info) return song;
  return {
    ...song,
    lrcUrl: song.lrcUrl || info.lrcUrl || '',
    mrcUrl: song.mrcUrl || info.mrcUrl || '',
    trcUrl: song.trcUrl || info.trcUrl || '',
  };
}

async function getMiguLyric(song) {
  const info = await getMiguInfo(song);
  let lyricInfo = null;

  if (info.mrcUrl) {
    lyricInfo = parseMiguMrc(decryptMiguMrc(await fetchMiguText(info.mrcUrl)));
  } else if (info.lrcUrl) {
    lyricInfo = { lyric: await fetchMiguText(info.lrcUrl), lxlyric: '' };
  }

  if (!lyricInfo) throw new Error('missing Migu lyric url');
  if (info.trcUrl) {
    try {
      lyricInfo.tlyric = await fetchMiguText(info.trcUrl);
    } catch {
      lyricInfo.tlyric = '';
    }
  }
  return createLyricResult(lyricInfo, 'mg');
}

async function getKugouLyric(song) {
  const keyword = `${song.name || ''} ${song.singer || ''}`.trim();
  if (!keyword) throw new Error('missing Kugou lyric keyword');

  const timelength = intervalToSeconds(song.interval);
  const searchUrl = `http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(keyword)}&hash=${encodeURIComponent(song.hash || '')}&timelength=${timelength}&lrctxt=1`;
  const searchBody = await retry(async () => {
    const res = await fetchWithTimeout(searchUrl, {
      headers: {
        ...DEFAULT_HEADERS,
        'KG-RC': '1',
        'KG-THash': 'expand_search_manager.cpp:852736169:451',
        'User-Agent': 'KuGou2012-9020-ExpandSearchManager',
      },
    });
    if (!res.ok) throw new Error(`Kugou lyric search HTTP ${res.status}`);
    const json = await res.json();
    return json?.candidates?.length ? json : null;
  }, 3);

  const candidate = searchBody.candidates.find(item => song.hash && item.hash === song.hash) || searchBody.candidates[0];
  const downloadUrl = `http://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(candidate.id)}&accesskey=${encodeURIComponent(candidate.accesskey)}&fmt=lrc&charset=utf8`;
  const downloadBody = await retry(async () => {
    const res = await fetchWithTimeout(downloadUrl, {
      headers: {
        ...DEFAULT_HEADERS,
        'KG-RC': '1',
        'KG-THash': 'expand_search_manager.cpp:852736169:451',
        'User-Agent': 'KuGou2012-9020-ExpandSearchManager',
      },
    });
    if (!res.ok) throw new Error(`Kugou lyric download HTTP ${res.status}`);
    const json = await res.json();
    return json?.content ? json : null;
  }, 3);

  return createLyricResult({
    lyric: decodeBase64Text(downloadBody.content),
  }, 'kg');
}

async function getDirectLyric(song) {
  switch (song.source) {
    case 'wy':
      return getNeteaseLyric(song);
    case 'tx':
      return getQQLyric(song);
    case 'kw':
      return getKuwoLyric(song);
    case 'kg':
      return getKugouLyric(song);
    case 'mg':
      return getMiguLyric(song);
    default:
      throw new Error(`unsupported source: ${song.source}`);
  }
}

async function searchSource(origin, target, source) {
  const keyword = `${target.singer || ''} ${target.name || ''}`.trim() || target.name;
  if (!keyword) return [];
  const url = `${origin}/api/search?keyword=${encodeURIComponent(keyword)}&source=${encodeURIComponent(source)}&page=1&limit=5`;
  const res = await fetchWithTimeout(url, { headers: DEFAULT_HEADERS }, 12000);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.list) ? data.list : [];
}

async function getFallbackLyric(context, target, errors) {
  const origin = new URL(context.request.url).origin;
  const sources = ['wy', 'kw', 'kg', 'mg', 'tx'];

  for (const source of sources) {
    let candidates = [];
    try {
      candidates = await searchSource(origin, target, source);
    } catch (err) {
      errors.push(`${source}: search failed: ${err.message}`);
      continue;
    }

    const ranked = candidates
      .map(candidate => ({ candidate, score: rankCandidate(target, candidate) }))
      .filter(item => item.score >= 70)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    for (const { candidate, score } of ranked) {
      try {
        const result = await getDirectLyric(candidate);
        return {
          ...result,
          provider: `${result.provider}:fallback:${score}`,
        };
      } catch (err) {
        errors.push(`${source}: ${candidate.name || candidate.songmid}: ${err.message}`);
      }
    }
  }

  throw new Error('all fallback lyric sources failed');
}

export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);
  const song = buildSong(searchParams);
  const errors = [];

  if (!song.name && !song.songmid && !song.hash && !song.copyrightId) {
    return jsonResponse({ error: 'missing song info' }, 400);
  }

  try {
    const direct = await getDirectLyric(song);
    return jsonResponse(direct);
  } catch (err) {
    errors.push(`direct: ${err.message}`);
  }

  try {
    const fallback = await getFallbackLyric(context, song, errors);
    return jsonResponse({ ...fallback, attempts: errors });
  } catch (err) {
    errors.push(`fallback: ${err.message}`);
    return jsonResponse({ error: 'lyric not found', attempts: errors }, 404);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
