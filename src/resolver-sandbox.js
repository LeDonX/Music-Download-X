import CryptoJS from 'https://esm.sh/crypto-js@4.2.0';
import forge from 'https://esm.sh/node-forge@1.3.1';
import pako from 'https://esm.sh/pako@2.1.0';

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

function createBufferLike(data) {
  const uint8 = toUint8Array(data);
  uint8.toString = function(encoding = 'utf8') {
    if (encoding === 'hex') {
      return Array.from(this).map(b => b.toString(16).padStart(2, '0')).join('');
    } else if (encoding === 'base64') {
      let binary = '';
      for (let i = 0; i < this.length; i++) {
        binary += String.fromCharCode(this[i]);
      }
      return btoa(binary);
    } else if (encoding === 'binary') {
      let binary = '';
      for (let i = 0; i < this.length; i++) {
        binary += String.fromCharCode(this[i]);
      }
      return binary;
    }
    return new TextDecoder().decode(this);
  };
  uint8.toJSON = function() {
    return {
      type: 'Buffer',
      data: Array.from(this),
    };
  };
  return uint8;
}

function isBinaryLike(data) {
  return data instanceof ArrayBuffer || ArrayBuffer.isView(data) || Array.isArray(data);
}

// Buffer Utility Polyfill
const bufferUtils = {
  from(data, encoding) {
    if (typeof data === 'string') {
      if (encoding === 'hex') {
        const arr = [];
        for (let i = 0; i < data.length; i += 2) {
          arr.push(parseInt(data.substr(i, 2), 16));
        }
        return createBufferLike(arr);
      } else if (encoding === 'base64') {
        const binaryStr = atob(data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        return createBufferLike(bytes);
      } else {
        return createBufferLike(new TextEncoder().encode(data));
      }
    } else if (data && data.type === 'Buffer' && Array.isArray(data.data)) {
      return createBufferLike(data.data);
    } else if (isBinaryLike(data)) {
      return createBufferLike(data);
    }
    return createBufferLike([]);
  },
  bufToString(buf, format) {
    return createBufferLike(buf).toString(format);
  }
};

// WordArray helper for CryptoJS
function uint8ToWordArray(u8) {
  const words = [];
  for (let i = 0; i < u8.length; i++) {
    words[i >>> 2] |= u8[i] << (24 - (i % 4) * 8);
  }
  return CryptoJS.lib.WordArray.create(words, u8.length);
}

function wordArrayToUint8(wa) {
  const u8 = new Uint8Array(wa.sigBytes);
  for (let i = 0; i < wa.sigBytes; i++) {
    u8[i] = (wa.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return createBufferLike(u8);
}

function hasHeader(headers, name) {
  const lowerName = name.toLowerCase();
  return Object.keys(headers || {}).some(key => key.toLowerCase() === lowerName);
}

export function initResolverSandbox(scriptContent, scriptMeta = {}) {
  return new Promise((resolveInit, rejectInit) => {
    let requestHandler = null;
    let initedCallback = null;

    const lx = {
      version: '2.0.0',
      env: 'desktop',
      EVENT_NAMES: {
        inited: 'inited',
        request: 'request',
        updateAlert: 'updateAlert',
      },
      send(eventName, data) {
        console.log(`[Sandbox Send] ${eventName}`, data);
        if (eventName === 'inited') {
          if (initedCallback) {
            initedCallback(data);
          }
          resolveInit({
            sources: data.sources,
            requestUrl: async (source, action, info) => {
              if (!requestHandler) throw new Error('Request handler not registered by script');
              return requestHandler({ source, action, info });
            }
          });
        }
        return Promise.resolve();
      },
      on(eventName, handler) {
        console.log(`[Sandbox On] registered ${eventName}`);
        if (eventName === 'request') {
          requestHandler = handler;
        }
        return Promise.resolve();
      },
      request(url, options = {}, callback) {
        console.log(`[Sandbox Request] URL: ${url}`, options);
        
        const requestHeaders = { ...(options.headers || {}) };
        let bodyToSend = options.body;
        let isBodyBase64 = false;
        
        if (options.body != null) {
          if (isBinaryLike(options.body) || options.body?.type === 'Buffer') {
            const bytes = bufferUtils.from(options.body);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            bodyToSend = btoa(binary);
            isBodyBase64 = true;
          } else if (typeof options.body === 'object') {
            bodyToSend = JSON.stringify(options.body);
            if (!hasHeader(requestHeaders, 'content-type')) {
              requestHeaders['Content-Type'] = 'application/json';
            }
          }
        }

        const controller = new AbortController();
        const timeoutMs = typeof options.timeout === 'number' && options.timeout > 0
          ? Math.min(options.timeout, 60000)
          : 60000;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        // Call our serverless proxy
        fetch('/api/proxy', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url,
            method: options.method || 'GET',
            headers: requestHeaders,
            body: bodyToSend,
            isBodyBase64,
            form: options.form,
            formData: options.formData
          })
        })
        .then(async res => {
          const arrayBuffer = await res.arrayBuffer();
          const uint8 = createBufferLike(arrayBuffer);

          let parsedBody;
          const rawString = new TextDecoder().decode(uint8);
          try {
            parsedBody = JSON.parse(rawString);
          } catch(e) {
            parsedBody = rawString;
          }

          const headers = {};
          res.headers.forEach((val, key) => {
            headers[key] = val;
          });

          const resp = {
            statusCode: res.status,
            statusMessage: res.statusText,
            headers,
            bytes: uint8.byteLength,
            raw: uint8,
            body: parsedBody
          };

          callback(null, resp, parsedBody);
        })
        .catch(err => {
          console.error('[Sandbox Request Error]', err);
          callback(err, null, null);
        })
        .finally(() => {
          clearTimeout(timeoutId);
        });

        // Return cancel/abort callback
        return () => {
          controller.abort();
          console.log('[Sandbox Request] Cancelled');
        };
      },
      currentScriptInfo: {
        name: scriptMeta.name || 'Custom API Source',
        description: scriptMeta.description || '',
        version: scriptMeta.version || '1.0.0',
        author: scriptMeta.author || '',
        homepage: scriptMeta.homepage || '',
        rawScript: scriptContent,
      },
      utils: {
        crypto: {
          aesEncrypt(buffer, mode, key, iv) {
            const waData = uint8ToWordArray(buffer);
            const waKey = uint8ToWordArray(key);
            const waIv = iv ? uint8ToWordArray(iv) : null;
            
            let cjsMode = CryptoJS.mode.CBC;
            let cjsPadding = CryptoJS.pad.Pkcs7;
            if (mode.toLowerCase().includes('ecb')) {
              cjsMode = CryptoJS.mode.ECB;
            }
            
            const encrypted = CryptoJS.AES.encrypt(waData, waKey, {
              iv: waIv,
              mode: cjsMode,
              padding: cjsPadding
            });
            
            return wordArrayToUint8(encrypted.ciphertext);
          },
          rsaEncrypt(buffer, keyStr) {
            try {
              // Convert to Uint8Array and pad to 128 bytes with leading zeros
              const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
              let padded;
              if (uint8.length < 128) {
                padded = new Uint8Array(128);
                padded.set(uint8, 128 - uint8.length);
              } else {
                padded = uint8;
              }

              const publicKey = forge.pki.publicKeyFromPem(keyStr);
              const dataHex = bufferUtils.bufToString(padded, 'hex');
              const bytes = forge.util.hexToBytes(dataHex);
              const encrypted = publicKey.encrypt(bytes, 'RAW');
              const encryptedHex = forge.util.bytesToHex(encrypted);
              return bufferUtils.from(encryptedHex, 'hex');
            } catch (err) {
              console.error('[RSA Error]', err);
              throw err;
            }
          },
          randomBytes(size) {
            const arr = new Uint8Array(size);
            window.crypto.getRandomValues(arr);
            return createBufferLike(arr);
          },
          md5(str) {
            return CryptoJS.MD5(str).toString();
          },
        },
        buffer: bufferUtils,
        zlib: {
          inflate(buf) {
            return Promise.resolve(createBufferLike(pako.inflate(buf)));
          },
          deflate(data) {
            return Promise.resolve(createBufferLike(pako.deflate(data)));
          },
        },
      }
    };

    // Attach to global window object
    window.lx = lx;

    // Run the script
    try {
      const runner = new Function('window', 'lx', 'console', `
        ${scriptContent}
      `);
      runner(window, lx, console);
    } catch (err) {
      console.error('[Sandbox Run Error]', err);
      rejectInit(err);
    }
  });
}
