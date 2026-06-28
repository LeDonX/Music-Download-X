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
  const sizeText = typeof size === 'string' ? size : sizeFormat(size);
  if (!sizeText) return;
  types.push({ type, size: sizeText, ...extra });
  _types[type] = { size: sizeText, ...extra };
}

function createSearchResponse(payload, headers) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers,
  });
}

async function retry(fn, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await fn(i);
      if (result) return result;
    } catch (err) {
      lastError = err;
      console.warn(`[Search Retry] attempt ${i + 1} failed:`, err);
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
export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);
  const keyword = searchParams.get("keyword") || "";
  const source = searchParams.get("source") || "wy";
  const page = parseInt(searchParams.get("page") || "1", 10);
  const limit = parseInt(searchParams.get("limit") || "30", 10);
  const responseHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
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
        const res = await fetch(url, {
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
        const types = [];
        const _types = {};
        addQuality(types, _types, "128k", song.l?.size || 1.2 * 1024 * 1024);
        addQuality(types, _types, "320k", song.h?.size);
        addQuality(types, _types, "flac", song.sq?.size);
        addQuality(types, _types, "flac24bit", song.hr?.size);
        return {
          songmid: song.id.toString(),
          name: song.name,
          singer: (song.ar || []).map((a) => a.name).join("\u3001"),
          albumName: song.al?.name || "",
          albumId: song.al?.id?.toString() || "",
          img: song.al?.picUrl || "",
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

        const res = await fetch(url, {
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
        const types = [];
        const _types = {};
        addQuality(types, _types, "128k", file.size_128mp3 || 1.2 * 1024 * 1024);
        addQuality(types, _types, "320k", file.size_320mp3);
        addQuality(types, _types, "flac", file.size_flac);
        addQuality(types, _types, "flac24bit", file.size_hires);
        return {
          songmid: item.mid || "",
          name: item.title || "",
          singer: (item.singer || []).map((s) => s.name).join("\u3001"),
          albumName: item.album?.name || "",
          albumId: albummid,
          img: albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albummid}.jpg` : "",
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
        const res = await fetch(url, {
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
              addQuality(types, _types, "flac24bit", match[4]);
              break;
            case "2000":
              addQuality(types, _types, "flac", match[4]);
              break;
            case "320":
              addQuality(types, _types, "320k", match[4]);
              break;
            case "128":
              addQuality(types, _types, "128k", match[4]);
              break;
          }
        }
        if (!types.length) {
          const formats = item.FORMATS || "";
          addQuality(types, _types, "128k", "1.2M");
          if (formats.includes("MP3320") || formats.includes("320")) addQuality(types, _types, "320k", "3.0M");
          if (formats.includes("FLAC") || formats.includes("ape")) addQuality(types, _types, "flac", "10M");
          if (formats.includes("HIRES")) addQuality(types, _types, "flac24bit", "25M");
        }
        return {
          songmid: rid,
          name: decodeHTML(item.SONGNAME),
          singer: decodeHTML(item.ARTIST).replace(/&/g, "\u3001"),
          albumName: decodeHTML(item.ALBUM || ""),
          albumId: item.ALBUMID || "",
          img: item.web_albumpic_short ? 'https://img4.kuwo.cn/wmvpic/' + item.web_albumpic_short : (item.hts_MVPIC || ''),
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
        const res = await fetch(url, {
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
      const list = rawList.map((item) => {
        const types = [];
        const _types = {};
        addQuality(types, _types, "128k", item.FileSize || 1.2 * 1024 * 1024, { hash: item.FileHash });
        addQuality(types, _types, "320k", item.HQFileSize, { hash: item.HQFileHash });
        addQuality(types, _types, "flac", item.SQFileSize, { hash: item.SQFileHash });
        addQuality(types, _types, "flac24bit", item.ResFileSize, { hash: item.ResFileHash });
        return {
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
        };
      });
      return createSearchResponse({ list, total, page, limit, allPage: Math.ceil(total / limit), source: "kg" }, responseHeaders);
    } else if (source === "mg") {
      const url = `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do?isCopyright=1&isCorrect=1&pageNo=${page}&pageSize=${limit}&searchSwitch=%7B%22song%22:1%7D&text=${encodeURIComponent(keyword)}`;
      const json = await retry(async () => {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://m.music.migu.cn/"
          }
        });
        if (!res.ok) throw new Error(`Migu search HTTP ${res.status}`);
        const body = await res.json();
        return body?.songResultData ? body : null;
      });
      const rawList = (json.songResultData?.result || []).slice(0, limit);
      const total = parseInt(json.songResultData?.totalCount || "0", 10);
      const list = rawList.map((item) => {
        const types = [];
        const _types = {};
        addQuality(types, _types, "128k", "1.2M");
        const newFormats = item.newRateFormats || [];
        newFormats.forEach((fmt) => {
          const size = fmt.size || fmt.androidSize || "";
          if (fmt.formatType === "HQ") {
            addQuality(types, _types, "320k", size || "3.0M");
          } else if (fmt.formatType === "SQ") {
            addQuality(types, _types, "flac", size || "10M");
          } else if (fmt.formatType === "ZQ") {
            addQuality(types, _types, "flac24bit", size || "25M");
          }
        });
        let img = "";
        if (item.imgItems && item.imgItems.length > 0) {
          img = item.imgItems[0].img || "";
        }
        const albumInfo = item.albums && item.albums.length > 0 ? item.albums[0] : {};
        return {
          songmid: item.songId || item.id || "",
          name: decodeHTML(item.name),
          singer: (item.singers || []).map((s) => s.name).join("\u3001"),
          albumName: decodeHTML(albumInfo.name || ""),
          albumId: albumInfo.id ? albumInfo.id.toString() : "",
          img,
          interval: null,
          source: "mg",
          copyrightId: item.copyrightId || "",
          lrcUrl: item.lyricUrl || item.lrcUrl || "",
          mrcUrl: item.mrcurl || item.mrcUrl || "",
          trcUrl: item.trcUrl || "",
          types,
          _types,
          typeUrl: {}
        };
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
