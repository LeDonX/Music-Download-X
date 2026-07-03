import http from 'node:http';
import { Readable } from 'node:stream';

const HOST = process.env.API_HOST || '127.0.0.1';
const PORT = Number(process.env.API_PORT || 5174);

const routes = new Map([
  ['/api/download', await import('../functions/api/download.js')],
  ['/api/image', await import('../functions/api/image.js')],
  ['/api/lyric', await import('../functions/api/lyric.js')],
  ['/api/pic', await import('../functions/api/pic.js')],
  ['/api/proxy', await import('../functions/api/proxy.js')],
  ['/api/search', await import('../functions/api/search.js')],
]);

function normalizePath(pathname) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function getHandler(module, method) {
  const suffix = method[0] + method.slice(1).toLowerCase();
  return module[`onRequest${suffix}`] || module.onRequest;
}

function buildHeaders(source) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value != null) {
      headers.set(key, value);
    }
  }
  return headers;
}

function buildRequest(req) {
  const protocol = req.socket.encrypted ? 'https' : 'http';
  const host = req.headers.host || `${HOST}:${PORT}`;
  const url = new URL(req.url || '/', `${protocol}://${host}`);
  const init = {
    method: req.method,
    headers: buildHeaders(req.headers),
  };

  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    init.body = req;
    init.duplex = 'half';
  }

  return new Request(url, init);
}

function writeHeaders(res, response) {
  res.statusCode = response.status;
  res.statusMessage = response.statusText || res.statusMessage;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
}

async function sendResponse(req, res, response) {
  writeHeaders(res, response);
  if (req.method === 'HEAD' || !response.body) {
    res.end();
    return;
  }

  Readable.fromWeb(response.body).pipe(res);
}

function defaultOptionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Request-Key',
    },
  });
}

async function handleRequest(req, res) {
  const request = buildRequest(req);
  const path = normalizePath(new URL(request.url).pathname);
  const module = routes.get(path);

  if (!module) {
    await sendResponse(req, res, new Response('Not found', { status: 404 }));
    return;
  }

  const handler = getHandler(module, request.method);
  if (!handler) {
    if (request.method === 'OPTIONS') {
      await sendResponse(req, res, defaultOptionsResponse());
      return;
    }

    await sendResponse(req, res, new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, POST, OPTIONS' },
    }));
    return;
  }

  const waitUntilTasks = [];
  const context = {
    request,
    env: process.env,
    params: {},
    data: {},
    waitUntil: task => waitUntilTasks.push(Promise.resolve(task)),
  };

  const response = await handler(context);
  await sendResponse(req, res, response);

  if (waitUntilTasks.length) {
    await Promise.allSettled(waitUntilTasks);
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(async error => {
    console.error('[local-api]', error);
    if (!res.headersSent) {
      await sendResponse(req, res, new Response(error.message || 'Internal server error', {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
      }));
    } else {
      res.destroy(error);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[local-api] listening on http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
