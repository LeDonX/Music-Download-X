export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);
  const url = searchParams.get('url') || '';
  const filename = searchParams.get('filename') || 'music.mp3';
  return handleDownload(url, filename, {});
}

export async function onRequestPost(context) {
  try {
    const { url, filename, headers } = await context.request.json();
    return handleDownload(url, filename, headers || {});
  } catch (err) {
    return new Response(err.message, {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
  }
}

async function handleDownload(url, filename, headers) {
  if (!url) {
    return new Response('Missing URL parameter', {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };

    // Apply specific Referers to bypass CDN protections
    if (url.includes('qqmusic') || url.includes('qq.com') || url.includes('qpic.cn')) {
      fetchHeaders['Referer'] = 'https://y.qq.com/';
    } else if (url.includes('126.net') || url.includes('163.com') || url.includes('127.net')) {
      fetchHeaders['Referer'] = 'https://music.163.com/';
    } else if (url.includes('kuwo.cn')) {
      fetchHeaders['Referer'] = 'http://www.kuwo.cn/';
    } else if (url.includes('migu.cn')) {
      fetchHeaders['Referer'] = 'https://music.migu.cn/';
    }

    // Merge custom headers from the script
    if (headers) {
      Object.assign(fetchHeaders, headers);
    }

    console.log(`[Download Proxy] Streaming from: ${url}`);
    const res = await fetch(url, { headers: fetchHeaders });
    
    if (!res.ok) {
      return new Response(`Failed to fetch media file: ${res.statusText}`, {
        status: res.status,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    const responseHeaders = new Headers();
    
    // Copy content-length if available
    const contentLength = res.headers.get('content-length');
    if (contentLength) {
      responseHeaders.set('Content-Length', contentLength);
      responseHeaders.set('X-Content-Length', contentLength);
    }
    
    // Set attachment headers for downloading
    responseHeaders.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    const originalType = res.headers.get('content-type');
    if (originalType) {
      responseHeaders.set('Content-Type', originalType);
    } else {
      responseHeaders.set('Content-Type', 'application/octet-stream');
    }
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    responseHeaders.set('Access-Control-Expose-Headers', 'Content-Length, X-Content-Length');

    // Pipe the response body stream directly to save memory
    return new Response(res.body, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error('[Download Proxy Error]', err);
    return new Response(err.message, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
  }
}
