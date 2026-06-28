export async function onRequestPost(context) {
  try {
    const requestData = await context.request.json();
    const { url, method = 'GET', headers = {}, body, isBodyBase64, form, formData } = requestData;

    if (!url) {
      return new Response(JSON.stringify({ error: 'Missing target URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Clean up headers
    const forwardHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      // Block host header to let fetch set it automatically
      if (lowerKey === 'host' || lowerKey === 'content-length') continue;
      forwardHeaders[key] = value;
    }

    // Set default User-Agent if not present
    if (!forwardHeaders['User-Agent'] && !forwardHeaders['user-agent']) {
      forwardHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36';
    }

    let fetchBody = body;
    if (isBodyBase64 && typeof body === 'string') {
      const binaryStr = atob(body);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      fetchBody = bytes;
    } else if (form) {
      fetchBody = new URLSearchParams(form).toString();
      forwardHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (formData) {
      const fd = new FormData();
      for (const [key, value] of Object.entries(formData)) {
        fd.append(key, value);
      }
      fetchBody = fd;
    }

    const fetchOptions = {
      method: method.toUpperCase(),
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : fetchBody,
      redirect: 'follow',
    };

    console.log(`[Proxy] Requesting: ${method} ${url}`);
    const response = await fetch(url, fetchOptions);
    const responseHeaders = {};
    
    // Copy response headers (avoid setting restricted headers)
    for (const [key, value] of response.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'content-encoding' || lowerKey === 'content-length' || lowerKey === 'transfer-encoding') continue;
      responseHeaders[key] = value;
    }
    
    // Add CORS headers for our frontend client
    responseHeaders['Access-Control-Allow-Origin'] = '*';
    responseHeaders['Access-Control-Allow-Headers'] = '*';

    // Read the body as ArrayBuffer to handle binary responses (like images/zlib/etc)
    const arrayBuffer = await response.arrayBuffer();

    return new Response(arrayBuffer, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error('[Proxy Error]', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

// Handle CORS preflight request
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Request-Key',
    },
  });
}
