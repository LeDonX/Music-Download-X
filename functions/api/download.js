function getReferer(targetUrl) {
  const { hostname } = targetUrl;
  if (hostname.includes('qqmusic') || hostname.includes('qq.com') || hostname.includes('qpic.cn') || hostname.includes('gtimg.cn')) return 'https://y.qq.com/';
  if (hostname.includes('126.net') || hostname.includes('163.com') || hostname.includes('127.net')) return 'https://music.163.com/';
  if (hostname.includes('kuwo.cn')) return 'http://www.kuwo.cn/';
  if (hostname.includes('migu.cn')) return 'https://music.migu.cn/';
  if (hostname.includes('kugou.com') || hostname.includes('kgimg.com')) return 'https://www.kugou.com/';
  return '';
}

const COVER_FETCH_TIMEOUT_MS = 8000;
const COVER_MAX_BYTES = 3 * 1024 * 1024;
const FLAC_VENDOR = 'Music Download X';

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

function stringToUtf8Bytes(text) {
  return new TextEncoder().encode(String(text || ''));
}

function uint32le(size) {
  return [
    size & 0xff,
    (size >> 8) & 0xff,
    (size >> 16) & 0xff,
    (size >> 24) & 0xff,
  ];
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
  if (!['image/jpeg', 'image/png'].includes(cover.mimeType)) return null;
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
  if (!['image/jpeg', 'image/png'].includes(cover.mimeType)) return null;
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

function createFlacVorbisCommentBlock(meta, isLast = false) {
  const comments = [
    ['TITLE', meta.title],
    ['ARTIST', meta.artist],
    ['ALBUM', meta.album],
  ]
    .map(([key, value]) => `${key}=${String(value || '').trim()}`)
    .filter((comment) => !comment.endsWith('='));

  if (!comments.length) return null;

  const vendorBytes = stringToUtf8Bytes(FLAC_VENDOR);
  const commentParts = comments.flatMap((comment) => {
    const bytes = stringToUtf8Bytes(comment);
    return [new Uint8Array(uint32le(bytes.length)), bytes];
  });

  const body = concatUint8Arrays([
    new Uint8Array(uint32le(vendorBytes.length)),
    vendorBytes,
    new Uint8Array(uint32le(comments.length)),
    ...commentParts,
  ]);

  return concatUint8Arrays([
    new Uint8Array([(isLast ? 0x80 : 0x00) | 0x04, ...uint24be(body.length)]),
    body,
  ]);
}

function addUniqueCandidate(candidates, url) {
  if (url && /^https?:\/\//i.test(url) && !candidates.includes(url)) {
    candidates.push(url);
  }
}

function prependUniqueCandidate(candidates, url) {
  if (url && /^https?:\/\//i.test(url) && !candidates.includes(url)) {
    candidates.unshift(url);
  }
}

function getCoverCandidates(coverUrl) {
  const candidates = [];
  addUniqueCandidate(candidates, coverUrl);

  try {
    const url = new URL(coverUrl);
    const hostname = url.hostname.toLowerCase();

    if (hostname.includes('music.126.net') || hostname.includes('127.net')) {
      const sizedUrl = new URL(url.toString());
      if (!sizedUrl.searchParams.has('param')) {
        sizedUrl.searchParams.set('param', '500y500');
        addUniqueCandidate(candidates, sizedUrl.toString());
      }
    }

    if (hostname === 'y.qq.com' && url.pathname.includes('/music/photo_new/')) {
      const gtimgUrl = new URL(url.toString());
      gtimgUrl.hostname = 'y.gtimg.cn';
      addUniqueCandidate(candidates, gtimgUrl.toString());
    }

    if (coverUrl.includes('{size}')) {
      addUniqueCandidate(candidates, coverUrl.replace('{size}', '500'));
      addUniqueCandidate(candidates, coverUrl.replace('{size}', '480'));
    }

    if (url.pathname.toLowerCase().endsWith('.webp')) {
      const jpgUrl = new URL(url.toString());
      jpgUrl.pathname = jpgUrl.pathname.replace(/\.webp$/i, '.jpg');
      prependUniqueCandidate(candidates, jpgUrl.toString());
    }
  } catch (_) {
    // Ignore malformed candidates; the main URL validation handles invalid input.
  }

  return candidates;
}

function detectCoverMime(bytes, contentType) {
  if (!bytes?.length) return '';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  const mimeType = String(contentType || '').split(';')[0].toLowerCase();
  if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mimeType)) {
    return mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;
  }
  return '';
}

async function fetchCoverCandidate(coverUrl, baseUrl = '') {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('cover timeout')), COVER_FETCH_TIMEOUT_MS);

  try {
    const targetUrl = baseUrl ? new URL(coverUrl, baseUrl) : new URL(coverUrl);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5',
    };
    const referer = getReferer(targetUrl);
    if (referer) headers.Referer = referer;

    const res = await fetch(targetUrl.toString(), {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > COVER_MAX_BYTES) return null;

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > COVER_MAX_BYTES) return null;

    const mimeType = detectCoverMime(bytes, res.headers.get('content-type'));
    if (!mimeType) return null;
    return { bytes, mimeType };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchCoverBytes(coverUrl, baseUrl = '') {
  if (!coverUrl || !/^https?:\/\//i.test(coverUrl)) return null;

  try {
    const candidates = getCoverCandidates(coverUrl);
    for (const candidateUrl of candidates) {
      let cover = null;
      try {
        cover = await fetchCoverCandidate(candidateUrl, baseUrl);
      } catch (err) {
        console.warn('[Download Proxy] cover candidate failed:', err?.message || err);
        continue;
      }
      if (!cover) continue;
      if (cover.mimeType === 'image/jpeg' || cover.mimeType === 'image/png') return cover;
    }

    if (baseUrl) {
      const proxiedCover = await fetchCoverCandidate(`/api/image?url=${encodeURIComponent(coverUrl)}`, baseUrl);
      if (proxiedCover?.mimeType === 'image/jpeg' || proxiedCover?.mimeType === 'image/png') {
        return proxiedCover;
      }
    }
    return null;
  } catch (err) {
    console.warn('[Download Proxy] cover fetch failed:', err?.message || err);
    return null;
  }
}

function enqueueBytes(controller, bytes) {
  if (bytes?.length) controller.enqueue(bytes);
}

function createFixedLengthBody(body, expectedLength) {
  if (!body || !expectedLength || typeof FixedLengthStream !== 'function') {
    return null;
  }

  const fixedStream = new FixedLengthStream(expectedLength);
  body.pipeTo(fixedStream.writable).catch((err) => {
    console.error('[Download Proxy] fixed length stream failed:', err);
  });
  return fixedStream.readable;
}

async function prepareMp3StreamWithId3(sourceStream, id3Tag) {
  const reader = sourceStream.getReader();
  const chunks = [];
  let total = 0;
  let stripSize = 0;

  while (total < 10) {
    const { done, value } = await reader.read();
    if (done) {
      const buffered = concatUint8Arrays(chunks);
      return {
        body: new ReadableStream({
          start(controller) {
            enqueueBytes(controller, id3Tag);
            enqueueBytes(controller, buffered);
            controller.close();
          },
        }),
        removedBytes: 0,
      };
    }
    chunks.push(value);
    total += value.length;
  }

  let buffered = concatUint8Arrays(chunks);
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

  return {
    body: new ReadableStream({
      async start(controller) {
        try {
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
    }),
    removedBytes: Math.min(stripSize, buffered.length),
  };
}

function streamFlacWithMetadata(sourceStream, metadataBlocks) {
  const reader = sourceStream.getReader();
  const blocks = metadataBlocks.filter(Boolean);
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
          for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            if (i === blocks.length - 1) block[0] |= 0x80;
            enqueueBytes(controller, block);
          }
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

function getDownloadHeaders(url, customHeaders = {}, range = 'bytes=0-') {
  const targetUrl = new URL(url);
  const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
  };
  if (range) fetchHeaders.Range = range;
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

async function handleDownload(url, filename, headers, meta = {}, requestUrl = '', requestHeaders = new Headers()) {
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

  try {
    const isPlayback = meta.play === '1';
    const requestRange = requestHeaders.get('range') || '';
    const coverPromise = isPlayback ? Promise.resolve(null) : fetchCoverBytes(meta.cover || '', requestUrl);
    const res = await fetch(targetUrl.toString(), {
      headers: getDownloadHeaders(targetUrl.toString(), headers, isPlayback ? (requestRange || 'bytes=0-') : 'bytes=0-'),
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
    let expectedLength = Number(contentLength || 0);
    const ext = getExt(filename, meta.ext, originalType);
    let body = res.body;
    let transformed = false;
    let coverEmbedded = false;
    const canTransform = !isPlayback;

    if (body && canTransform && ext === 'mp3') {
      const cover = await coverPromise;
      const id3Tag = createId3Tag(meta, cover);
      if (id3Tag) {
        const prepared = await prepareMp3StreamWithId3(body, id3Tag);
        body = prepared.body;
        transformed = true;
        coverEmbedded = Boolean(cover);
        if (expectedLength > 0) expectedLength += id3Tag.length - prepared.removedBytes;
      }
    } else if (body && canTransform && ext === 'flac') {
      const cover = await coverPromise;
      const vorbisBlock = createFlacVorbisCommentBlock(meta);
      const pictureBlock = cover ? createFlacPictureBlock(cover, true) : null;
      const flacBlocks = [vorbisBlock, pictureBlock].filter(Boolean);
      if (flacBlocks.length) {
        body = streamFlacWithMetadata(body, flacBlocks);
        transformed = true;
        coverEmbedded = Boolean(pictureBlock);
        if (expectedLength > 0) expectedLength += flacBlocks.reduce((sum, block) => sum + block.length, 0);
      }
    }

    if (expectedLength > 0) {
      responseHeaders.set('Content-Length', String(expectedLength));
      responseHeaders.set('X-Content-Length', String(expectedLength));
    }
    if (isPlayback) {
      responseHeaders.set('Content-Disposition', 'inline');
    } else {
      responseHeaders.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename || 'music.mp3')}`);
    }
    responseHeaders.set('Content-Type', originalType || 'application/octet-stream');
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    responseHeaders.set('Accept-Ranges', res.headers.get('accept-ranges') || 'bytes');
    if (res.headers.get('content-range')) responseHeaders.set('Content-Range', res.headers.get('content-range'));
    responseHeaders.set('Access-Control-Expose-Headers', 'Content-Length, X-Content-Length, X-Cover-Embedded, Content-Range, Accept-Ranges');
    responseHeaders.set('X-Cover-Embedded', coverEmbedded ? '1' : '0');

    const fixedLengthBody = transformed ? createFixedLengthBody(body, expectedLength) : null;

    return new Response(fixedLengthBody || body, {
      status: isPlayback && res.status === 206 ? 206 : 200,
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
    play: searchParams.get('play') || '',
  }, context.request.url, context.request.headers);
}

export async function onRequestPost(context) {
  try {
    const { url, filename, headers, meta } = await context.request.json();
    return handleDownload(url, filename, headers || {}, meta || {}, context.request.url, context.request.headers);
  } catch (err) {
    return new Response(err.message, {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}
