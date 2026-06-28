// Helper to format play time from seconds to mm:ss
function formatPlayTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// Helper to decode basic HTML entities
function decodeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function sizeFormat(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)}G`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${n}B`;
}

function addQuality(types, _types, type, size, extra = {}) {
  if (size == null || size === '') return;
  if (typeof size === 'number' && size <= 0) return;
  if (typeof size === 'string' && size.trim() === '0') return;
  const cleanSize = typeof size === 'string' ? size.trim() : size;
  const sizeText = typeof cleanSize === 'string'
    ? (/^\d+$/.test(cleanSize) ? sizeFormat(Number(cleanSize)) || cleanSize : cleanSize)
    : sizeFormat(cleanSize);
  if (!sizeText) return;
  types.push({ type, size: sizeText, ...extra });
  _types[type] = { size: sizeText, ...extra };
}

function formatSingerName(list, key = 'name') {
  if (!Array.isArray(list)) return '';
  return list
    .map(item => typeof item === 'string' ? item : item?.[key])
    .filter(Boolean)
    .join('\u3001');
}

function createSearchResponse(payload, headers) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers,
  });
}

function normalizePicUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  return url.replace(/\.webp(?=($|[?#]))/i, '.jpg');
}

const UPSTREAM_SEARCH_TIMEOUT_MS = 3000;

async function fetchWithTimeout(url, options = {}, timeoutMs = UPSTREAM_SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const parentSignal = options.signal;
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`upstream timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  const abortFromParent = () => controller.abort(parentSignal.reason);

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

async function retry(fn, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    const startedAt = Date.now();
    try {
      const result = await fn(i);
      if (result) return result;
      lastError = new Error('empty upstream search response');
    } catch (err) {
      lastError = err;
      console.warn(`[Search Retry] attempt ${i + 1}/${maxRetries} failed after ${Date.now() - startedAt}ms:`, err?.message || err);
    }
    await new Promise(resolve => setTimeout(resolve, 80 * (i + 1)));
  }
  if (lastError) throw lastError;
  return null;
}

const PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19];
const PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5];
const SCRAMBLE_VALUES = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];
async function hashSHA1(text) {
  const msgUint8 = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-1", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
function pickHashByIdx(hash, indexes) {
  return indexes.map((idx) => hash[idx]).join("");
}
function base64Encode(dataBytes) {
  let binary = "";
  for (let i = 0; i < dataBytes.length; i++) {
    binary += String.fromCharCode(dataBytes[i]);
  }
  return btoa(binary).replace(/[\/+=]/g, "");
}
async function zzcSign(text) {
  const hash = await hashSHA1(text);
  const part1 = pickHashByIdx(hash, PART_1_INDEXES);
  const part2 = pickHashByIdx(hash, PART_2_INDEXES);
  const part3 = SCRAMBLE_VALUES.map((value, i) => value ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16));
  const b64Part = base64Encode(part3);
  return `zzc${part1}${b64Part}${part2}`.toLowerCase();
}

function md5(input) {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const word = view.getUint32(offset + g * 4, true);
      const sum = (a + f + constants[i] + word) >>> 0;
      const rotated = ((sum << shifts[i]) | (sum >>> (32 - shifts[i]))) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotated) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const output = new Uint8Array(16);
  const outputView = new DataView(output.buffer);
  outputView.setUint32(0, a0, true);
  outputView.setUint32(4, b0, true);
  outputView.setUint32(8, c0, true);
  outputView.setUint32(12, d0, true);
  return Array.from(output).map(b => b.toString(16).padStart(2, '0')).join('');
}

function createMiguSignature(time, keyword) {
  const deviceId = '963B7AA0D21511ED807EE5846EC87D20';
  const signatureMd5 = '6cdc72a439cef99a3418d2a78aa28c73';
  const sign = md5(`${keyword}${signatureMd5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`);
  return { sign, deviceId };
}

function addNeteaseQuality(types, _types, type, fileInfo, songmid, fallbackSize = "") {
  const size = fileInfo?.size || fallbackSize;
  if (!size) return;
  addQuality(types, _types, type, size, { hash: songmid });
}

function addNeteaseQualities(types, _types, song, songmid) {
  const privilege = song.privilege || {};
  const maxbr = Number(privilege.maxbr || privilege.playMaxbr || privilege.pl || 0);

  if (privilege.maxBrLevel === "hires") {
    addNeteaseQuality(types, _types, "flac24bit", song.hr, songmid, "25M");
  }

  switch (maxbr) {
    case 999000:
      addNeteaseQuality(types, _types, "flac", song.sq, songmid, "10M");
    case 320000:
      addNeteaseQuality(types, _types, "320k", song.h, songmid, "3.0M");
    case 192000:
    case 128000:
      addNeteaseQuality(types, _types, "128k", song.l, songmid, 1.2 * 1024 * 1024);
      break;
    default:
      if (song.l) addNeteaseQuality(types, _types, "128k", song.l, songmid);
      break;
  }

  types.reverse();
}

export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);
  const keyword = searchParams.get("keyword") || "";
  const source = searchParams.get("source") || "wy";
  const page = parseInt(searchParams.get("page") || "1", 10);
  const limit = parseInt(searchParams.get("limit") || "30", 10);
  const responseHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, max-age=0",
    "CDN-Cache-Control": "no-store",
    "Pragma": "no-cache"
  };
  if (!keyword) {
    return new Response(JSON.stringify({ list: [], total: 0, page, limit }), {
      status: 200,
      headers: responseHeaders
    });
  }
  try {
    if (source === "wy") {
      const url = `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(keyword)}&type=1&offset=${(page - 1) * limit}&limit=${limit}`;
      const json = await retry(async () => {
        const res = await fetchWithTimeout(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://music.163.com/"
          }
        });
        if (!res.ok) throw new Error(`NetEase search HTTP ${res.status}`);
        const body = await res.json();
        return body?.result ? body : null;
      });
      const rawList = json.result?.songs || [];
      const total = json.result?.songCount || 0;
      const list = rawList.map((song) => {
        const songmid = song.id.toString();
        const types = [];
        const _types = {};
        addNeteaseQualities(types, _types, song, songmid);
        if (!types.length) {
          addQuality(types, _types, "128k", song.l?.size || 1.2 * 1024 * 1024, { hash: songmid });
        }
        return {
          songmid,
          name: song.name,
          singer: (song.ar || []).map((a) => a.name).join("\u3001"),
          albumName: song.al?.name || "",
          albumId: song.al?.id?.toString() || "",
          img: song.al?.picUrl ? `${song.al.picUrl}${song.al.picUrl.includes('?') ? '&' : '?'}param=500y500` : "",
          interval: formatPlayTime(song.dt / 1e3),
          source: "wy",
          types,
          _types,
          typeUrl: {}
        };
      });
      return createSearchResponse({ list, total, page, limit, allPage: Math.ceil(total / limit), source: "wy" }, responseHeaders);
    } else if (source === "tx") {
      const json = await retry(async () => {
        const searchid = Math.random().toString().slice(2);
        const requestPayload = {
          comm: {
            ct: "11",
            cv: "14090508",
            v: "14090508",
            tmeAppID: "qqmusic",
            phonetype: "EBG-AN10",
            deviceScore: "553.47",
            devicelevel: "50",
            newdevicelevel: "20",
            rom: "HuaWei/EMOTION/EmotionUI_14.2.0",
            os_ver: "12",
            OpenUDID: "0",
            OpenUDID2: "0",
            QIMEI36: "0",
            udid: "0",
            chid: "0",
            aid: "0",
            oaid: "0",
            taid: "0",
            tid: "0",
            wid: "0",
            uid: "0",
            sid: "0",
            modeSwitch: "6",
            teenMode: "0",
            ui_mode: "2",
            nettype: "1020",
            v4ip: ""
          },
          req: {
            module: "music.search.SearchCgiService",
            method: "DoSearchForQQMusicMobile",
            param: {
              search_type: 0,
              searchid: searchid,
              query: keyword,
              page_num: page,
              num_per_page: limit,
              highlight: 0,
              nqc_flag: 0,
              multi_zhida: 0,
              cat: 2,
              grp: 1,
              sin: (page - 1) * limit,
              sem: 0
            }
          }
        };

        const payloadStr = JSON.stringify(requestPayload);
        const sign = await zzcSign(payloadStr);
        const url = `https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`;

        const res = await fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "User-Agent": "QQMusic 14090508(android 12)",
            "Content-Type": "application/json"
          },
          body: payloadStr
        });
        if (!res.ok) throw new Error(`QQ Music search HTTP ${res.status}`);
        const body = await res.json();
        return body?.code === 0 && body?.req?.code === 0 ? body : null;
      }, 5);

      const rawList = json?.req?.data?.body?.item_song || json?.req?.data?.item_song || [];
      const total = json?.req?.data?.body?.meta?.estimate_sum || json?.req?.data?.meta?.estimate_sum || 0;
      const list = rawList.filter(item => item.file?.media_mid).map((item) => {
        const albummid = item.album?.mid || "";
        const file = item.file || {};
        const songmid = item.mid || "";
        const types = [];
        const _types = {};
        addQuality(types, _types, "128k", file.size_128mp3 || 1.2 * 1024 * 1024, { hash: songmid });
        addQuality(types, _types, "320k", file.size_320mp3, { hash: songmid });
        addQuality(types, _types, "flac", file.size_flac, { hash: songmid });
        addQuality(types, _types, "flac24bit", file.size_hires, { hash: songmid });
        return {
          songmid,
          name: item.title || "",
          singer: (item.singer || []).map((s) => s.name).join("\u3001"),
          albumName: item.album?.name || "",
          albumId: albummid,
          img: albummid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albummid}.jpg` : "",
          interval: formatPlayTime(item.interval),
          source: "tx",
          strMediaMid: file.media_mid || "",
          albumMid: albummid,
          songId: item.id?.toString() || "",
          types,
          _types,
          typeUrl: {}
        };
      });
      return createSearchResponse({ list, total, page, limit, allPage: Math.ceil(total / limit), source: "tx" }, responseHeaders);
    } else if (source === "kw") {
      const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(keyword)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;
      const json = await retry(async () => {
        const res = await fetchWithTimeout(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          }
        });
        if (!res.ok) throw new Error(`Kuwo search HTTP ${res.status}`);
        const text = await res.text();
        const body = JSON.parse(text);
        if (body.TOTAL !== "0" && body.SHOW === "0") return null;
        return body;
      }, 3);
      const rawList = json.abslist || [];
      const total = parseInt(json.TOTAL || "0", 10);
      const list = rawList.map((item) => {
        const rid = (item.MUSICRID || "").replace("MUSIC_", "");
        const types = [];
        const _types = {};
        const minfo = item.N_MINFO || "";
        const minfoItems = minfo.split(";");
        for (const infoText of minfoItems) {
          const match = infoText.match(/level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/);
          if (!match) continue;
          switch (match[2]) {
            case "4000":
              addQuality(types, _types, "flac24bit", match[4], { hash: rid });
              break;
            case "2000":
              addQuality(types, _types, "flac", match[4], { hash: rid });
              break;
            case "320":
              addQuality(types, _types, "320k", match[4], { hash: rid });
              break;
            case "128":
              addQuality(types, _types, "128k", match[4], { hash: rid });
              break;
          }
        }
        if (!types.length) {
          const formats = item.FORMATS || "";
          addQuality(types, _types, "128k", "1.2M", { hash: rid });
          if (formats.includes("MP3320") || formats.includes("320")) addQuality(types, _types, "320k", "3.0M", { hash: rid });
          if (formats.includes("FLAC") || formats.includes("ape")) addQuality(types, _types, "flac", "10M", { hash: rid });
          if (formats.includes("HIRES")) addQuality(types, _types, "flac24bit", "25M", { hash: rid });
        }
        return {
          songmid: rid,
          name: decodeHTML(item.SONGNAME),
          singer: decodeHTML(item.ARTIST).replace(/&/g, "\u3001"),
          albumName: decodeHTML(item.ALBUM || ""),
          albumId: item.ALBUMID || "",
          img: "",
          interval: formatPlayTime(parseInt(item.DURATION, 10) || 0),
          source: "kw",
          types: types.reverse(),
          _types,
          typeUrl: {}
        };
      });
      return createSearchResponse({ list, total, page, limit, allPage: Math.ceil(total / limit), source: "kw" }, responseHeaders);
    } else if (source === "kg") {
      const url = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`;
      const json = await retry(async () => {
        const res = await fetchWithTimeout(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          }
        });
        if (!res.ok) throw new Error(`Kugou search HTTP ${res.status}`);
        const body = await res.json();
        return body?.error_code === 0 ? body : null;
      }, 3);
      const rawList = json.data?.lists || [];
      const total = json.data?.total || 0;
      const seen = new Set();
      const list = [];
      const addKugouItem = (item) => {
        if (!item) return;
        const itemKey = `${item.Audioid || ""}_${item.FileHash || ""}`;
        if (seen.has(itemKey)) return;
        seen.add(itemKey);
        const types = [];
        const _types = {};
        addQuality(types, _types, "128k", item.FileSize || 1.2 * 1024 * 1024, { hash: item.FileHash });
        addQuality(types, _types, "320k", item.HQFileSize, { hash: item.HQFileHash });
        addQuality(types, _types, "flac", item.SQFileSize, { hash: item.SQFileHash });
        addQuality(types, _types, "flac24bit", item.ResFileSize, { hash: item.ResFileHash });
        list.push({
          songmid: item.Audioid ? item.Audioid.toString() : item.FileHash,
          name: decodeHTML(item.SongName.replace(/<em>|<\/em>/g, "")),
          singer: decodeHTML(item.SingerName.replace(/<em>|<\/em>/g, "")),
          albumName: decodeHTML(item.AlbumName || ""),
          albumId: item.AlbumID ? item.AlbumID.toString() : "",
          img: "",
          interval: formatPlayTime(item.Duration || 0),
          source: "kg",
          hash: item.FileHash,
          types,
          _types,
          typeUrl: {}
        });
      };
      rawList.forEach((item) => {
        addKugouItem(item);
        (item.Grp || []).forEach(addKugouItem);
      });
      return createSearchResponse({ list, total, page, limit, allPage: Math.ceil(total / limit), source: "kg" }, responseHeaders);
    } else if (source === "mg") {
      const time = Date.now().toString();
      const signData = createMiguSignature(time, keyword);
      const url = `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(keyword)}&pageNo=${page}&sort=0&sid=USS`;
      const json = await retry(async () => {
        const res = await fetchWithTimeout(url, {
          headers: {
            "uiVersion": "A_music_3.6.1",
            "deviceId": signData.deviceId,
            "timestamp": time,
            "sign": signData.sign,
            "channel": "0146921",
            "User-Agent": "Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30"
          }
        });
        if (!res.ok) throw new Error(`Migu search HTTP ${res.status}`);
        const body = await res.json();
        return body?.code === "000000" && body?.songResultData ? body : null;
      });
      const rawList = json.songResultData?.resultList || [];
      const total = parseInt(json.songResultData?.totalCount || "0", 10);
      const ids = new Set();
      const list = [];
      rawList.forEach((group) => {
        if (!Array.isArray(group)) return;
        group.forEach((item) => {
          if (!item.songId || !item.copyrightId || ids.has(item.copyrightId)) return;
          ids.add(item.copyrightId);

          const songmid = item.songId;
          const copyrightId = item.copyrightId;
          const types = [];
          const _types = {};
          (item.audioFormats || []).forEach((fmt) => {
            const size = fmt.asize || fmt.isize || "";
            switch (fmt.formatType) {
              case "PQ":
                addQuality(types, _types, "128k", size || "1.2M", { hash: copyrightId });
                break;
              case "HQ":
                addQuality(types, _types, "320k", size || "3.0M", { hash: copyrightId });
                break;
              case "SQ":
                addQuality(types, _types, "flac", size || "10M", { hash: copyrightId });
                break;
              case "ZQ24":
                addQuality(types, _types, "flac24bit", size || "25M", { hash: copyrightId });
                break;
            }
          });
          if (!types.length) {
            addQuality(types, _types, "128k", "1.2M", { hash: copyrightId });
          }

          let img = item.img3 || item.img2 || item.img1 || "";
          if (img && !/^https?:/i.test(img)) img = `http://d.musicapp.migu.cn${img}`;
          img = normalizePicUrl(img);

          list.push({
            songmid,
            name: decodeHTML(item.name || ""),
            singer: formatSingerName(item.singerList),
            albumName: decodeHTML(item.album || ""),
            albumId: item.albumId ? item.albumId.toString() : "",
            img,
            interval: formatPlayTime(item.duration || 0),
            source: "mg",
            copyrightId,
            lrcUrl: item.lrcUrl || "",
            mrcUrl: item.mrcurl || "",
            trcUrl: item.trcUrl || "",
            types,
            _types,
            typeUrl: {}
          });
        });
      });
      return createSearchResponse({ list, total, page, limit, allPage: Math.ceil(total / limit), source: "mg" }, responseHeaders);
    }
    return new Response(JSON.stringify({ error: "Unsupported source" }), {
      status: 400,
      headers: responseHeaders
    });
  } catch (err) {
    console.error("[Search Error]", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...responseHeaders, "Content-Type": "application/json" }
    });
  }
}
