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
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://music.163.com/"
        }
      });
      const json = await res.json();
      const rawList = json.result?.songs || [];
      const total = json.result?.songCount || 0;
      const list = rawList.map((song) => {
        const types = [{ type: "128k", size: song.l ? `${(song.l.size / 1024 / 1024).toFixed(1)}M` : "1.2M" }];
        if (song.h) types.push({ type: "320k", size: `${(song.h.size / 1024 / 1024).toFixed(1)}M` });
        if (song.sq) types.push({ type: "flac", size: `${(song.sq.size / 1024 / 1024).toFixed(1)}M` });
        if (song.hr) types.push({ type: "flac24bit", size: `${(song.hr.size / 1024 / 1024).toFixed(1)}M` });
        return {
          songmid: song.id.toString(),
          name: song.name,
          singer: (song.ar || []).map((a) => a.name).join("\u3001"),
          albumName: song.al?.name || "",
          albumId: song.al?.id?.toString() || "",
          img: song.al?.picUrl || "",
          interval: formatPlayTime(song.dt / 1e3),
          source: "wy",
          types
        };
      });
      return new Response(JSON.stringify({ list, total, page, limit, source: "wy" }), {
        status: 200,
        headers: responseHeaders
      });
    } else if (source === "tx") {
      let json = null;
      let retries = 0;
      const maxRetries = 5;
      
      while (retries < maxRetries) {
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

        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "User-Agent": "QQMusic 14090508(android 12)",
              "Content-Type": "application/json"
            },
            body: payloadStr
          });
          json = await res.json();
          if (json && json.code === 0 && json.req && json.req.code === 0) {
            break; // Succeeded!
          }
        } catch (e) {
          console.warn(`QQ Music Search try ${retries} failed:`, e);
        }
        retries++;
        await new Promise(r => setTimeout(r, 50)); // Small delay between retries
      }

      const rawList = json?.req?.data?.body?.item_song || json?.req?.data?.item_song || [];
      const total = json?.req?.data?.body?.meta?.estimate_sum || json?.req?.data?.meta?.estimate_sum || 0;
      const list = rawList.map((item) => {
        const albummid = item.album?.mid || "";
        const file = item.file || {};
        const types = [];
        if (file.size_128mp3) types.push({ type: "128k", size: `${(file.size_128mp3 / 1024 / 1024).toFixed(1)}M` });
        else types.push({ type: "128k", size: "1.2M" });
        if (file.size_320mp3) types.push({ type: "320k", size: `${(file.size_320mp3 / 1024 / 1024).toFixed(1)}M` });
        if (file.size_flac) types.push({ type: "flac", size: `${(file.size_flac / 1024 / 1024).toFixed(1)}M` });
        if (file.size_hires) types.push({ type: "flac24bit", size: `${(file.size_hires / 1024 / 1024).toFixed(1)}M` });
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
          types
        };
      });
      return new Response(JSON.stringify({ list, total, page, limit, source: "tx" }), {
        status: 200,
        headers: responseHeaders
      });
    } else if (source === "kw") {
      const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(keyword)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      const text = await res.text();
      let json = {};
      try {
        json = JSON.parse(text);
      } catch (err) {
        console.error("Failed to parse Kuwo response:", err);
      }
      const rawList = json.abslist || [];
      const total = parseInt(json.TOTAL || "0", 10);
      const list = rawList.map((item) => {
        const rid = (item.MUSICRID || "").replace("MUSIC_", "");
        const formats = item.FORMATS || "";
        const types = [{ type: "128k", size: "1.2M" }];
        if (formats.includes("MP3320") || formats.includes("320")) {
          types.push({ type: "320k", size: "3.0M" });
        }
        if (formats.includes("FLAC") || formats.includes("ape")) {
          types.push({ type: "flac", size: "10M" });
        }
        if (formats.includes("HIRES")) {
          types.push({ type: "flac24bit", size: "25M" });
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
          types
        };
      });
      return new Response(JSON.stringify({ list, total, page, limit, source: "kw" }), {
        status: 200,
        headers: responseHeaders
      });
    } else if (source === "kg") {
      const url = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}&userid=-1&clientver=&platform=WebFilter&tag=em&filter=2&iscorrect=1&privilege_filter=0`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      const json = await res.json();
      const rawList = json.data?.lists || [];
      const total = json.data?.total || 0;
      const list = rawList.map((item) => {
        const types = [{ type: "128k", size: item.FileSize ? `${(item.FileSize / 1024 / 1024).toFixed(1)}M` : "1.2M" }];
        if (item.HQFileSize) types.push({ type: "320k", size: `${(item.HQFileSize / 1024 / 1024).toFixed(1)}M` });
        if (item.SQFileSize) types.push({ type: "flac", size: `${(item.SQFileSize / 1024 / 1024).toFixed(1)}M` });
        if (item.ResFileSize) types.push({ type: "flac24bit", size: `${(item.ResFileSize / 1024 / 1024).toFixed(1)}M` });
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
          types
        };
      });
      return new Response(JSON.stringify({ list, total, page, limit, source: "kg" }), {
        status: 200,
        headers: responseHeaders
      });
    } else if (source === "mg") {
      const url = `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do?isCopyright=1&isCorrect=1&pageNo=${page}&pageSize=${limit}&searchSwitch=%7B%22song%22:1%7D&text=${encodeURIComponent(keyword)}`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://m.music.migu.cn/"
        }
      });
      const json = await res.json();
      const rawList = json.songResultData?.result || [];
      const total = parseInt(json.songResultData?.totalCount || "0", 10);
      const list = rawList.map((item) => {
        const types = [{ type: "128k", size: "1.2M" }];
        const newFormats = item.newRateFormats || [];
        newFormats.forEach((fmt) => {
          const sizeStr = fmt.size ? `${(fmt.size / 1024 / 1024).toFixed(1)}M` : "";
          if (fmt.formatType === "HQ") {
            types.push({ type: "320k", size: sizeStr || "3.0M" });
          } else if (fmt.formatType === "SQ") {
            types.push({ type: "flac", size: sizeStr || "10M" });
          } else if (fmt.formatType === "ZQ") {
            types.push({ type: "flac24bit", size: sizeStr || "25M" });
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
          types
        };
      });
      return new Response(JSON.stringify({ list, total, page, limit, source: "mg" }), {
        status: 200,
        headers: responseHeaders
      });
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
