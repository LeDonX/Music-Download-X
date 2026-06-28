function getReferer(targetUrl) {
  const { hostname } = targetUrl;
  if (hostname.includes('qqmusic') || hostname.includes('qq.com') || hostname.includes('qpic.cn')) return 'https://y.qq.com/';
  if (hostname.includes('126.net') || hostname.includes('163.com') || hostname.includes('127.net')) return 'https://music.163.com/';
  if (hostname.includes('kuwo.cn')) return 'http://www.kuwo.cn/';
  if (hostname.includes('migu.cn')) return 'https://music.migu.cn/';
  if (hostname.includes('kugou.com')) return 'https://www.kugou.com/';
  return '';
}

function concatUint8Arrays(arrays) {
  const total = arrays.reduce((sum, item) => sum + item.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const item of arrays) {
    output.set(item, offset);
    offset += item.length;
  }
  return output;
}

function uint32be(size) {
  return [
    (size >> 24) & 0xff,
    (size >> 16) & 0xff,
    (size >> 8) & 0xff,
    size & 0xff,
  ];
}

function uint24be(size) {
  return [
    (size >> 16) & 0xff,
    (size >> 8) & 0xff,
    size & 0xff,
  ];
}

function syncsafe(size) {
  return [
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
  ];
}

function stringToUtf16LeBytes(text) {
  const value = String(text || '').trim();
  const payload = new Uint8Array(value.length * 2 + 2);
  payload[0] = 0xff;
  payload[1] = 0xfe;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    payload[i * 2 + 2] = code & 0xff;
    payload[i * 2 + 3] = code >> 8;
  }
  return payload;
}

function stringToLatin1Bytes(text) {
  const value = String(text || '');
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    bytes[i] = value.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function createTextFrame(id, text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const content = concatUint8Arrays([
    new Uint8Array([0x01]),
    stringToUtf16LeBytes(value),
  ]);
  return concatUint8Arrays([
    new TextEncoder().encode(id),
    new Uint8Array(uint32be(content.length)),
    new Uint8Array([0, 0]),
    content,
  ]);
}

function createApicFrame(cover) {
  if (!cover?.bytes?.length || !cover.mimeType) return null;
  const mime = new TextEncoder().encode(cover.mimeType);
  const content = concatUint8Arrays([
    new Uint8Array([0x00]),
    mime,
    new Uint8Array([0x00, 0x03]),
    new Uint8Array([0x00]),
    cover.bytes,
  ]);
  return concatUint8Arrays([
    new TextEncoder().encode('APIC'),
    new Uint8Array(uint32be(content.length)),
    new Uint8Array([0, 0]),
    content,
  ]);
}

function createId3Tag(meta, cover) {
  const frames = [
    createTextFrame('TIT2', meta.title),
    createTextFrame('TPE1', String(meta.artist || '').replace(/、/g, ';')),
    createTextFrame('TALB', meta.album),
    createApicFrame(cover),
  ].filter(Boolean);
  if (!frames.length) return null;

  const frameBytes = concatUint8Arrays(frames);
  return concatUint8Arrays([
    new TextEncoder().encode('ID3'),
    new Uint8Array([0x03, 0x00, 0x00]),
    new Uint8Array(syncsafe(frameBytes.length)),
    frameBytes,
  ]);
}

function createFlacPictureBlock(cover, isLast = true) {
  if (!cover?.bytes?.length || !cover.mimeType) return null;
  const mimeBytes = stringToLatin1Bytes(cover.mimeType);
  const body = concatUint8Arrays([
    new Uint8Array(uint32be(3)),
    new Uint8Array(uint32be(mimeBytes.length)),
    mimeBytes,
    new Uint8Array(uint32be(0)),
    new Uint8Array(uint32be(0)),
    new Uint8Array(uint32be(0)),
    new Uint8Array(uint32be(0)),
    new Uint8Array(uint32be(0)),
    new Uint8Array(uint32be(cover.bytes.length)),
    cover.bytes,
  ]);

  return concatUint8Arrays([
    new Uint8Array([(isLast ? 0x80 : 0x00) | 0x06, ...uint24be(body.length)]),
    body,
  ]);
}

async function fetchCoverBytes(coverUrl) {
  if (!coverUrl || !/^https?:\/\//i.test(coverUrl)) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('cover timeout')), 3000);

  try {
    const targetUrl = new URL(coverUrl);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    };
    const referer = getReferer(targetUrl);
    if (referer) headers.Referer = referer;

    const res = await fetch(targetUrl.toString(), {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].toLowerCase();
    if (!['image/jpeg', 'image/jpg', 'image/png'].includes(mimeType)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) return null;
    return {
      bytes,
      mimeType: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType,
    };
  } catch (err) {
    console.warn('[Download Proxy] cover fetch failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function enqueueBytes(controller, bytes) {
  if (bytes?.length) controller.enqueue(bytes);
}

function streamMp3WithId3(sourceStream, id3Tag) {
  const reader = sourceStream.getReader();
  return new ReadableStream({
    async start(controller) {
      const chunks = [];
      let total = 0;

      try {
        while (total < 10) {
          const { done, value } = await reader.read();
          if (done) {
            enqueueBytes(controller, id3Tag);
            enqueueBytes(controller, concatUint8Arrays(chunks));
            controller.close();
            return;
          }
          chunks.push(value);
          total += value.length;
        }

        let buffered = concatUint8Arrays(chunks);
        let stripSize = 0;
        if (
          buffered[0] === 0x49 &&
          buffered[1] === 0x44 &&
          buffered[2] === 0x33
        ) {
          stripSize = 10 + ((buffered[6] << 21) | (buffered[7] << 14) | (buffered[8] << 7) | buffered[9]);
          while (total < stripSize) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.length;
          }
          buffered = concatUint8Arrays(chunks);
        }

        enqueueBytes(controller, id3Tag);
        enqueueBytes(controller, buffered.slice(stripSize));

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          enqueueBytes(controller, value);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function streamFlacWithPicture(sourceStream, pictureBlock) {
  const reader = sourceStream.getReader();
  return new ReadableStream({
    async start(controller) {
      const chunks = [];
      let total = 0;

      const readUntil = async(size) => {
        while (total < size) {
          const { done, value } = await reader.read();
          if (done) return false;
          chunks.push(value);
          total += value.length;
        }
        return true;
      };

      try {
        if (!await readUntil(4)) {
          enqueueBytes(controller, concatUint8Arrays(chunks));
          controller.close();
          return;
        }

        let buffered = concatUint8Arrays(chunks);
        if (
          buffered[0] !== 0x66 ||
          buffered[1] !== 0x4c ||
          buffered[2] !== 0x61 ||
          buffered[3] !== 0x43
        ) {
          enqueueBytes(controller, buffered);
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            enqueueBytes(controller, value);
          }
          controller.close();
          return;
        }

        let offset = 4;
        let lastHeaderOffset = -1;
        while (true) {
          if (!await readUntil(offset + 4)) break;
          buffered = concatUint8Arrays(chunks);
          const isLast = (buffered[offset] & 0x80) !== 0;
          const length = (buffered[offset + 1] << 16) | (buffered[offset + 2] << 8) | buffered[offset + 3];
          lastHeaderOffset = offset;
          offset += 4 + length;
          if (!await readUntil(offset)) break;
          if (isLast) break;
        }

        buffered = concatUint8Arrays(chunks);
        if (lastHeaderOffset >= 0 && offset <= buffered.length) {
          buffered[lastHeaderOffset] &= 0x7f;
          enqueueBytes(controller, buffered.slice(0, offset));
          enqueueBytes(controller, pictureBlock);
          enqueueBytes(controller, buffered.slice(offset));
        } else {
          enqueueBytes(controller, buffered);
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          enqueueBytes(controller, value);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function getDownloadHeaders(url, customHeaders = {}) {
  const targetUrl = new URL(url);
  const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Range': 'bytes=0-',
  };
  const referer = getReferer(targetUrl);
  if (referer) {
    fetchHeaders.Referer = referer;
    fetchHeaders.Origin = referer.replace(/\/$/, '');
  }

  for (const [key, value] of Object.entries(customHeaders || {})) {
    if (value == null) continue;
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'host' || lowerKey === 'content-length') continue;
    fetchHeaders[key] = value;
  }

  return fetchHeaders;
}

function getExt(filename, metaExt, contentType) {
  const ext = String(metaExt || '').toLowerCase();
  if (['mp3', 'flac'].includes(ext)) return ext;
  const fileExt = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  if (['mp3', 'flac'].includes(fileExt)) return fileExt;
  const type = String(contentType || '').toLowerCase();
  if (type.includes('flac')) return 'flac';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  return '';
}

async function handleDownload(url, filename, headers, meta = {}) {
  if (!url) {
    return new Response('Missing URL parameter', {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  let targetUrl;
  try {
    targetUrl = new URL(url);
  } catch (_) {
    return new Response('Invalid URL parameter', {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return new Response('Unsupported URL protocol', {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const coverPromise = fetchCoverBytes(meta.cover || '');
    const res = await fetch(targetUrl.toString(), {
      headers: getDownloadHeaders(targetUrl.toString(), headers),
      redirect: 'follow',
    });

    if (!res.ok) {
      return new Response(`Failed to fetch media file: ${res.status} ${res.statusText}`, {
        status: res.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    const originalType = res.headers.get('content-type') || '';
    if (/text\/html|application\/json/i.test(originalType)) {
      const preview = (await res.text()).slice(0, 300);
      return new Response(`Media URL returned ${originalType || 'non-audio'} content: ${preview}`, {
        status: 502,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    const responseHeaders = new Headers();
    const contentLength = res.headers.get('content-length');
    const ext = getExt(filename, meta.ext, originalType);
    let body = res.body;
    let transformed = false;

    if (body && ext === 'mp3') {
      const cover = await coverPromise;
      const id3Tag = createId3Tag(meta, cover);
      if (id3Tag) {
        body = streamMp3WithId3(body, id3Tag);
        transformed = true;
      }
    } else if (body && ext === 'flac') {
      const cover = await coverPromise;
      const pictureBlock = createFlacPictureBlock(cover, true);
      if (pictureBlock) {
        body = streamFlacWithPicture(body, pictureBlock);
        transformed = true;
      }
    }

    if (contentLength && !transformed) {
      responseHeaders.set('Content-Length', contentLength);
      responseHeaders.set('X-Content-Length', contentLength);
    }
    responseHeaders.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename || 'music.mp3')}`);
    responseHeaders.set('Content-Type', originalType || 'application/octet-stream');
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    responseHeaders.set('Access-Control-Expose-Headers', 'Content-Length, X-Content-Length');

    return new Response(body, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error('[Download Proxy Error]', err);
    return new Response(err.message, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}

export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);
  const url = searchParams.get('url') || '';
  const filename = searchParams.get('filename') || 'music.mp3';
  const headersText = searchParams.get('headers') || '';
  let headers = {};
  if (headersText) {
    try {
      headers = JSON.parse(headersText);
    } catch (_) {
      headers = {};
    }
  }
  return handleDownload(url, filename, headers, {
    title: searchParams.get('title') || '',
    artist: searchParams.get('artist') || '',
    album: searchParams.get('album') || '',
    cover: searchParams.get('cover') || '',
    ext: searchParams.get('ext') || '',
  });
}

export async function onRequestPost(context) {
  try {
    const { url, filename, headers, meta } = await context.request.json();
    return handleDownload(url, filename, headers || {}, meta || {});
  } catch (err) {
    return new Response(err.message, {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}
