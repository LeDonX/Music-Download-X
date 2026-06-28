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
    let targetUrl;
    try {
      targetUrl = new URL(url);
    } catch (_) {
      return new Response('Invalid URL parameter', {
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Range': 'bytes=0-',
    };

    // Apply specific Referers to bypass CDN protections
    if (targetUrl.hostname.includes('qqmusic') || targetUrl.hostname.includes('qq.com') || targetUrl.hostname.includes('qpic.cn')) {
      fetchHeaders['Referer'] = 'https://y.qq.com/';
      fetchHeaders['Origin'] = 'https://y.qq.com';
    } else if (targetUrl.hostname.includes('126.net') || targetUrl.hostname.includes('163.com') || targetUrl.hostname.includes('127.net')) {
      fetchHeaders['Referer'] = 'https://music.163.com/';
      fetchHeaders['Origin'] = 'https://music.163.com';
    } else if (targetUrl.hostname.includes('kuwo.cn')) {
      fetchHeaders['Referer'] = 'http://www.kuwo.cn/';
      fetchHeaders['Origin'] = 'http://www.kuwo.cn';
    } else if (targetUrl.hostname.includes('migu.cn')) {
      fetchHeaders['Referer'] = 'https://music.migu.cn/';
      fetchHeaders['Origin'] = 'https://music.migu.cn';
    } else if (targetUrl.hostname.includes('kugou.com')) {
      fetchHeaders['Referer'] = 'https://www.kugou.com/';
      fetchHeaders['Origin'] = 'https://www.kugou.com';
    }

    // Merge custom headers from the script
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        if (value == null) continue;
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'host' || lowerKey === 'content-length') continue;
        fetchHeaders[key] = value;
      }
    }

    console.log(`[Download Proxy] Streaming from: ${url}`);
    const res = await fetch(url, { headers: fetchHeaders });
    
    if (!res.ok) {
      return new Response(`Failed to fetch media file: ${res.status} ${res.statusText}`, {
        status: res.status,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    const originalType = res.headers.get('content-type') || '';
    if (/text\/html|application\/json/i.test(originalType)) {
      const preview = (await res.text()).slice(0, 300);
      return new Response(`Media URL returned ${originalType || 'non-audio'} content: ${preview}`, {
        status: 502,
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
