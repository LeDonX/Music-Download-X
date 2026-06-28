function getReferer(url) {
  const { hostname } = url;
  if (hostname.includes('qqmusic') || hostname.includes('qq.com') || hostname.includes('qpic.cn')) return 'https://y.qq.com/';
  if (hostname.includes('126.net') || hostname.includes('163.com') || hostname.includes('127.net')) return 'https://music.163.com/';
  if (hostname.includes('kuwo.cn')) return 'http://www.kuwo.cn/';
  if (hostname.includes('migu.cn')) return 'https://music.migu.cn/';
  if (hostname.includes('kugou.com') || hostname.includes('kgimg.com')) return 'https://www.kugou.com/';
  return '';
}

export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);
  const url = searchParams.get('url') || '';
  const responseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=86400',
  };

  if (!url) {
    return new Response('Missing URL parameter', {
      status: 400,
      headers: responseHeaders,
    });
  }

  let targetUrl;
  try {
    targetUrl = new URL(url);
  } catch (_) {
    return new Response('Invalid URL parameter', {
      status: 400,
      headers: responseHeaders,
    });
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return new Response('Unsupported URL protocol', {
      status: 400,
      headers: responseHeaders,
    });
  }

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    };
    const referer = getReferer(targetUrl);
    if (referer) headers.Referer = referer;

    const res = await fetch(targetUrl.toString(), {
      headers,
      redirect: 'follow',
    });
    if (!res.ok) {
      return new Response(`Image fetch failed: ${res.status} ${res.statusText}`, {
        status: res.status,
        headers: responseHeaders,
      });
    }

    const contentType = res.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(contentType)) {
      return new Response('Target URL did not return image content', {
        status: 502,
        headers: responseHeaders,
      });
    }

    return new Response(res.body, {
      status: 200,
      headers: {
        ...responseHeaders,
        'Content-Type': contentType,
      },
    });
  } catch (err) {
    return new Response(err.message, {
      status: 500,
      headers: responseHeaders,
    });
  }
}
