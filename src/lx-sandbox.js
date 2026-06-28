import CryptoJS from 'https://esm.sh/crypto-js@4.2.0';
import forge from 'https://esm.sh/node-forge@1.3.1';
import pako from 'https://esm.sh/pako@2.1.0';

// Buffer Utility Polyfill
const bufferUtils = {
  from(data, encoding) {
    if (typeof data === 'string') {
      if (encoding === 'hex') {
        const arr = [];
        for (let i = 0; i < data.length; i += 2) {
          arr.push(parseInt(data.substr(i, 2), 16));
        }
        return new Uint8Array(arr);
      } else if (encoding === 'base64') {
        const binaryStr = atob(data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        return bytes;
      } else {
        return new TextEncoder().encode(data);
      }
    } else if (Array.isArray(data) || data instanceof Uint8Array || data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    return new Uint8Array();
  },
  bufToString(buf, format) {
    const uint8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (format === 'hex') {
      return Array.from(uint8).map(b => b.toString(16).padStart(2, '0')).join('');
    } else if (format === 'base64') {
      let binary = '';
      const len = uint8.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(uint8[i]);
      }
      return btoa(binary);
    } else if (format === 'binary') {
      let binary = '';
      const len = uint8.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(uint8[i]);
      }
      return binary;
    } else {
      return new TextDecoder().decode(uint8);
    }
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
  return u8;
}

export function initLxSandbox(scriptContent, scriptMeta = {}) {
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
      request(url, options, callback) {
        console.log(`[Sandbox Request] URL: ${url}`, options);
        
        let bodyToSend = options.body;
        let isBodyBase64 = false;
        
        if (options.body && (options.body instanceof Uint8Array || typeof options.body === 'object')) {
          // Check if it is a Buffer-like object or has bytes
          const isBuffer = options.body.constructor?.name === 'Buffer' || Array.isArray(options.body) || options.body.buffer;
          if (isBuffer) {
            const bytes = new Uint8Array(options.body);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            bodyToSend = btoa(binary);
            isBodyBase64 = true;
          }
        }

        // Call our serverless proxy
        fetch('/api/proxy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url,
            method: options.method || 'GET',
            headers: options.headers || {},
            body: bodyToSend,
            isBodyBase64,
            form: options.form
          })
        })
        .then(async res => {
          const arrayBuffer = await res.arrayBuffer();
          const uint8 = new Uint8Array(arrayBuffer);
          
          // Attach a Buffer-like toString method to raw Uint8Array
          uint8.toString = function(encoding) {
            if (encoding === 'hex') {
              return Array.from(this).map(b => b.toString(16).padStart(2, '0')).join('');
            } else if (encoding === 'base64') {
              let binary = '';
              for (let i = 0; i < this.length; i++) {
                binary += String.fromCharCode(this[i]);
              }
              return btoa(binary);
            } else {
              return new TextDecoder().decode(this);
            }
          };

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
        });

        // Return cancel/abort callback
        return () => {
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
            return arr;
          },
          md5(str) {
            return CryptoJS.MD5(str).toString();
          },
        },
        buffer: bufferUtils,
        zlib: {
          inflate(buf) {
            return Promise.resolve(pako.inflate(buf));
          },
          deflate(data) {
            return Promise.resolve(pako.deflate(data));
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
