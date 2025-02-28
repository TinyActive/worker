// IMPORTANT: Bind một KV Namespace cho script này với tên biến EDGE_CACHE.
// KV cho phép purge chỉ phần HTML thay vì toàn bộ cache.

const DEFAULT_BYPASS_COOKIES = ['wp-', 'nodejs', 'comment_', 'shop_'];
const CACHE_HEADERS = ['Cache-Control', 'Expires', 'Pragma'];

/**
 * Entry point của Worker.
 * Với mọi request, nếu là GET HTML thì dùng logic cache; ngược lại, chỉ fetch.
 * Sau cùng, mọi response đều được bổ sung header "X-Worker-Status: Active".
 */
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event));
});

async function handleRequest(event) {
  const request = event.request;
  let response;
  const accept = request.headers.get('Accept') || '';
  
  // Nếu là GET và có "text/html" thì dùng logic cache của Worker
  if (request.method === 'GET' && accept.includes('text/html')) {
    response = await processRequest(request, event);
  } else {
    // Với các request khác, chỉ fetch từ origin
    response = await fetch(request);
  }
  
  // Sau khi có response, tạo bản sao để chỉnh sửa header
  response = new Response(response.body, response);
  response.headers.set('X-Worker-Status', 'Active');
  return response;
}

/**
 * Xử lý request HTML: thêm header edge-cache, theo dõi purge và cache HTML GET requests.
 * (Logic này chỉ áp dụng cho request GET HTML.)
 */
async function processRequest(originalRequest, event) {
  let cfCacheStatus = null;
  const accept = originalRequest.headers.get('Accept');
  const isHTML = accept && accept.indexOf('text/html') >= 0;
  let { response, cacheVer, status, bypassCache } = await getCachedResponse(originalRequest);

  if (response === null) {
    // Clone request, thêm header chỉ thị xử lý cache, sau đó fetch từ origin
    let request = new Request(originalRequest);
    request.headers.set('x-HTML-Edge-Cache', 'supports=cache|purgeall|bypass-cookies');
    response = await fetch(request);

    if (response) {
      const options = getResponseOptions(response);
      if (options && options.purge) {
        await purgeCache(cacheVer, event);
        status += ', Purged';
      }
      bypassCache = bypassCache || shouldBypassEdgeCache(request, response);
      if (
        (!options || options.cache) &&
        isHTML &&
        originalRequest.method === 'GET' &&
        response.status === 200 &&
        !bypassCache
      ) {
        status += await cacheResponse(cacheVer, originalRequest, response, event);
      }
    }
  } else {
    // Nếu đã có cached response
    cfCacheStatus = 'HIT';
    if (originalRequest.method === 'GET' && response.status === 200 && isHTML) {
      bypassCache = bypassCache || shouldBypassEdgeCache(originalRequest, response);
      if (!bypassCache) {
        const options = getResponseOptions(response);
        if (!options) {
          status += ', Refreshed';
          event.waitUntil(updateCache(originalRequest, cacheVer, event));
        }
      }
    }
  }

  if (
    response &&
    status !== null &&
    originalRequest.method === 'GET' &&
    response.status === 200 &&
    isHTML
  ) {
    // Tạo mới response để cập nhật header liên quan đến cache
    response = new Response(response.body, response);
    response.headers.set('x-HTML-Edge-Cache-Status', status);
    if (cacheVer !== null) {
      response.headers.set('x-HTML-Edge-Cache-Version', cacheVer.toString());
    }
    if (cfCacheStatus) {
      response.headers.set('CF-Cache-Status', cfCacheStatus);
    }
  }

  return response;
}

/**
 * Kiểm tra xem có nên bypass cache dựa vào cookie không.
 */
function shouldBypassEdgeCache(request, response) {
  let bypassCache = false;
  if (request && response) {
    const options = getResponseOptions(response);
    const cookieHeader = request.headers.get('cookie');
    let bypassCookies = DEFAULT_BYPASS_COOKIES;
    if (options) {
      bypassCookies = options.bypassCookies;
    }
    if (cookieHeader && cookieHeader.length && bypassCookies.length) {
      const cookies = cookieHeader.split(';');
      for (let cookie of cookies) {
        for (let prefix of bypassCookies) {
          if (cookie.trim().startsWith(prefix)) {
            bypassCache = true;
            break;
          }
        }
        if (bypassCache) break;
      }
    }
  }
  return bypassCache;
}

/**
 * Kiểm tra cache cho HTML GET requests.
 * Trả về đối tượng { response, cacheVer, status, bypassCache }.
 */
async function getCachedResponse(request) {
  let response = null;
  let cacheVer = null;
  let bypassCache = false;
  let status = 'Miss';

  const accept = request.headers.get('Accept');
  const cacheControl = request.headers.get('Cache-Control');
  let noCache = false;
  if (cacheControl && cacheControl.indexOf('no-cache') !== -1) {
    noCache = true;
    status = 'Bypass for Reload';
  }
  if (!noCache && request.method === 'GET' && accept && accept.indexOf('text/html') >= 0) {
    cacheVer = await GetCurrentCacheVersion(cacheVer);
    const cacheKeyRequest = GenerateCacheRequest(request, cacheVer);
    try {
      const cache = caches.default;
      let cachedResponse = await cache.match(cacheKeyRequest);
      if (cachedResponse) {
        cachedResponse = new Response(cachedResponse.body, cachedResponse);
        bypassCache = shouldBypassEdgeCache(request, cachedResponse);
        if (bypassCache) {
          status = 'Bypass Cookie';
        } else {
          status = 'Hit';
          cachedResponse.headers.delete('Cache-Control');
          cachedResponse.headers.delete('x-HTML-Edge-Cache-Status');
          for (const header of CACHE_HEADERS) {
            let value = cachedResponse.headers.get('x-HTML-Edge-Cache-Header-' + header);
            if (value) {
              cachedResponse.headers.delete('x-HTML-Edge-Cache-Header-' + header);
              cachedResponse.headers.set(header, value);
            }
          }
          response = cachedResponse;
        }
      } else {
        status = 'Miss';
      }
    } catch (err) {
      status = 'Cache Read Exception: ' + err.message;
    }
  }
  return { response, cacheVer, status, bypassCache };
}

/**
 * Purge cache HTML bất đồng bộ thông qua KV.
 */
async function purgeCache(cacheVer, event) {
  if (typeof EDGE_CACHE !== 'undefined') {
    cacheVer = await GetCurrentCacheVersion(cacheVer);
    cacheVer++;
    event.waitUntil(EDGE_CACHE.put('html_cache_version', cacheVer.toString()));
  }
}

/**
 * Cập nhật cache bất đồng bộ cho request.
 */
async function updateCache(originalRequest, cacheVer, event) {
  let request = new Request(originalRequest);
  request.headers.set('x-HTML-Edge-Cache', 'supports=cache|purgeall|bypass-cookies');
  let response = await fetch(request);
  if (response) {
    const options = getResponseOptions(response);
    if (options && options.purge) {
      await purgeCache(cacheVer, event);
    }
    let bypassCache = shouldBypassEdgeCache(request, response);
    if ((!options || options.cache) && !bypassCache) {
      await cacheResponse(cacheVer, originalRequest, response, event);
    }
  }
}

/**
 * Cache nội dung trả về nếu request GET HTML thành công.
 * Trả về chuỗi status để ghi nhận trạng thái cache.
 */
async function cacheResponse(cacheVer, request, originalResponse, event) {
  let status = '';
  const accept = request.headers.get('Accept');
  if (
    request.method === 'GET' &&
    originalResponse.status === 200 &&
    accept &&
    accept.indexOf('text/html') >= 0
  ) {
    cacheVer = await GetCurrentCacheVersion(cacheVer);
    const cacheKeyRequest = GenerateCacheRequest(request, cacheVer);
    try {
      const cache = caches.default;
      const clonedResponse = originalResponse.clone();
      let response = new Response(clonedResponse.body, clonedResponse);
      for (const header of CACHE_HEADERS) {
        let value = response.headers.get(header);
        if (value) {
          response.headers.delete(header);
          response.headers.set('x-HTML-Edge-Cache-Header-' + header, value);
        }
      }
      response.headers.delete('Set-Cookie');
      response.headers.set('Cache-Control', 'public; max-age=315360000');
      event.waitUntil(cache.put(cacheKeyRequest, response));
      status = ', Cached';
    } catch (err) {
      // Có thể ghi log lỗi nếu cần: err.message
    }
  }
  return status;
}

/**
 * Phân tích các lệnh từ header "x-HTML-Edge-Cache" của response.
 */
function getResponseOptions(response) {
  let options = null;
  const header = response.headers.get('x-HTML-Edge-Cache');
  if (header) {
    options = {
      purge: false,
      cache: false,
      bypassCookies: [],
    };
    const commands = header.split(',');
    for (let command of commands) {
      if (command.trim() === 'purgeall') {
        options.purge = true;
      } else if (command.trim() === 'cache') {
        options.cache = true;
      } else if (command.trim().startsWith('bypass-cookies')) {
        const separator = command.indexOf('=');
        if (separator >= 0) {
          const cookies = command.substr(separator + 1).split('|');
          for (let cookie of cookies) {
            cookie = cookie.trim();
            if (cookie.length) {
              options.bypassCookies.push(cookie);
            }
          }
        }
      }
    }
  }
  return options;
}

/**
 * Lấy phiên bản cache hiện tại từ KV.
 */
async function GetCurrentCacheVersion(cacheVer) {
  if (cacheVer === null) {
    if (typeof EDGE_CACHE !== 'undefined') {
      cacheVer = await EDGE_CACHE.get('html_cache_version');
      if (cacheVer === null) {
        cacheVer = 0;
        await EDGE_CACHE.put('html_cache_version', cacheVer.toString());
      } else {
        cacheVer = parseInt(cacheVer);
      }
    } else {
      cacheVer = -1;
    }
  }
  return cacheVer;
}

/**
 * Sinh ra Request đã được version hoá dựa vào URL và phiên bản cache.
 */
function GenerateCacheRequest(request, cacheVer) {
  let cacheUrl = request.url;
  cacheUrl += cacheUrl.indexOf('?') >= 0 ? '&' : '?';
  cacheUrl += 'cf_edge_cache_ver=' + cacheVer;
  return new Request(cacheUrl);
}
