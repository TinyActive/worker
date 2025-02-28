// Yêu cầu: Một KV Namespace phải được bind với worker script này bằng biến EDGE_CACHE.

// Default cookie prefixes for bypass
const DEFAULT_BYPASS_COOKIES = ['wp-', 'wordpress', 'comment_', 'woocommerce_'];

/**
 * Main worker entry point.
 */
addEventListener('fetch', event => {
	const request = event.request;
	let upstreamCache = request.headers.get('x-HTML-Edge-Cache');

	// Chỉ xử lý request khi đã bind KV (EDGE_CACHE) và không có HTML edge cache ở phía trước worker
	const configured = (typeof EDGE_CACHE !== 'undefined');

	// Bỏ qua xử lý các request ảnh (ngoại trừ Firefox không dùng image/*)
	const accept = request.headers.get('Accept');
	let isImage = false;
	if (accept && accept.indexOf('image/*') !== -1) {
		isImage = true;
	}

	if (configured && !isImage && upstreamCache === null) {
		event.passThroughOnException();
		event.respondWith(processRequest(request, event));
	}
});

/**
 * Process every request coming through to add the edge-cache header,
 * watch for purge responses and possibly cache HTML GET requests.
 *
 * @param {Request} originalRequest - Original request
 * @param {Event} event - Original event (for additional async waiting)
 */
async function processRequest(originalRequest, event) {
	let cfCacheStatus = null;
	const accept = originalRequest.headers.get('Accept');
	const isHTML = accept && accept.indexOf('text/html') >= 0;
	let { response, cacheVer, status, bypassCache } = await getCachedResponse(originalRequest);

	if (response === null) {
		// Clone the request, add the edge-cache header and send it through.
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
		// Nếu origin không gửi header điều khiển, ta gửi cached response nhưng cập nhật cache bất đồng bộ (stale-while-revalidate).
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
		response = new Response(response.body, response);
		response.headers.set('x-HTML-Edge-Cache-Status', status);
		if (cacheVer !== null) {
			response.headers.set('x-HTML-Edge-Cache-Version', cacheVer.toString());
		}
		if (cfCacheStatus) {
			response.headers.set('CF-Cache-Status', cfCacheStatus);
		}
		// Thêm header để kiểm tra trạng thái worker
		response.headers.set('x-worker-health', 'active');
	}

	return response;
}

/**
 * Determine if the cache should be bypassed for the given request/response pair.
 * Specifically, if the request includes a cookie that the response flags for bypass.
 * @param {Request} request - Request
 * @param {Response} response - Response
 * @returns {bool} true if the cache should be bypassed
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
				// Kiểm tra xem cookie có bắt đầu với bất kỳ prefix nào không
				for (let prefix of bypassCookies) {
					if (cookie.trim().startsWith(prefix)) {
						bypassCache = true;
						break;
					}
				}
				if (bypassCache) {
					break;
				}
			}
		}
	}

	return bypassCache;
}

const CACHE_HEADERS = ['Cache-Control', 'Expires', 'Pragma'];

/**
 * Check for cached HTML GET requests.
 *
 * @param {Request} request - Original request
 */
async function getCachedResponse(request) {
	let response = null;
	let cacheVer = null;
	let bypassCache = false;
	let status = 'Miss';

	// Chỉ check các HTML GET request và khi không có header cache-control trên request
	const accept = request.headers.get('Accept');
	const cacheControl = request.headers.get('Cache-Control');
	let noCache = false;
	if (cacheControl && cacheControl.indexOf('no-cache') !== -1) {
		noCache = true;
		status = 'Bypass for Reload';
	}
	if (!noCache && request.method === 'GET' && accept && accept.indexOf('text/html') >= 0) {
		// Build the versioned URL cho việc kiểm tra cache
		cacheVer = await GetCurrentCacheVersion(cacheVer);
		const cacheKeyRequest = GenerateCacheRequest(request, cacheVer);

		// Kiểm tra xem có request nào trùng trong cache không
		try {
			let cache = caches.default;
			let cachedResponse = await cache.match(cacheKeyRequest);
			if (cachedResponse) {
				// Clone Response để có thể chỉnh sửa header.
				cachedResponse = new Response(cachedResponse.body, cachedResponse);

				// Kiểm tra xem response có cần bypass cache do cookie hay không
				bypassCache = shouldBypassEdgeCache(request, cachedResponse);

				// Copy các header cache ban đầu và loại bỏ các header điều khiển
				if (bypassCache) {
					status = 'Bypass Cookie';
				} else {
					status = 'Hit';
					cachedResponse.headers.delete('Cache-Control');
					cachedResponse.headers.delete('x-HTML-Edge-Cache-Status');
					for (header of CACHE_HEADERS) {
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
			// Ghi lỗi ra header để debug
			status = 'Cache Read Exception: ' + err.message;
		}
	}

	return { response, cacheVer, status, bypassCache };
}

/**
 * Asynchronously purge the HTML cache.
 * @param {Int} cacheVer - Current cache version (if retrieved)
 * @param {Event} event - Original event
 */
async function purgeCache(cacheVer, event) {
	if (typeof EDGE_CACHE !== 'undefined') {
		// Purge KV cache bằng cách tăng version number
		cacheVer = await GetCurrentCacheVersion(cacheVer);
		cacheVer++;
		event.waitUntil(EDGE_CACHE.put('html_cache_version', cacheVer.toString()));
	}
}

/**
 * Update the cached copy of the given page
 * @param {Request} originalRequest - Original Request
 * @param {String} cacheVer - Cache Version
 * @param {EVent} event - Original event
 */
async function updateCache(originalRequest, cacheVer, event) {
	// Clone request, thêm header và gửi đi.
	let request = new Request(originalRequest);
	request.headers.set('x-HTML-Edge-Cache', 'supports=cache|purgeall|bypass-cookies');
	let response = await fetch(request);

	if (response) {
		let status = ': Fetched';
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
 * Cache the returned content (but only if it was a successful GET request)
 *
 * @param {Int} cacheVer - Current cache version (if already retrieved)
 * @param {Request} request - Original Request
 * @param {Response} originalResponse - Response to (maybe) cache
 * @param {Event} event - Original event
 * @returns {bool} true if the response was cached
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
			let cache = caches.default;
			let clonedResponse = originalResponse.clone();
			let response = new Response(clonedResponse.body, clonedResponse);
			for (header of CACHE_HEADERS) {
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
			// Có thể thêm log lỗi nếu cần: err.message
		}
	}
	return status;
}

/******************************************************************************
 * Utility Functions
 *****************************************************************************/

/**
 * Parse the commands from the x-HTML-Edge-Cache response header.
 * @param {Response} response - HTTP response from the origin.
 * @returns {*} Parsed commands
 */
function getResponseOptions(response) {
	let options = null;
	let header = response.headers.get('x-HTML-Edge-Cache');
	if (header) {
		options = {
			purge: false,
			cache: false,
			bypassCookies: [],
		};
		let commands = header.split(',');
		for (let command of commands) {
			if (command.trim() === 'purgeall') {
				options.purge = true;
			} else if (command.trim() === 'cache') {
				options.cache = true;
			} else if (command.trim().startsWith('bypass-cookies')) {
				let separator = command.indexOf('=');
				if (separator >= 0) {
					let cookies = command.substr(separator + 1).split('|');
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
 * Retrieve the current cache version from KV
 * @param {Int} cacheVer - Current cache version value if set.
 * @returns {Int} The current cache version.
 */
async function GetCurrentCacheVersion(cacheVer) {
	if (cacheVer === null) {
		if (typeof EDGE_CACHE !== 'undefined') {
			cacheVer = await EDGE_CACHE.get('html_cache_version');
			if (cacheVer === null) {
				// Lần đầu khởi tạo, set version mặc định
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
 * Generate the versioned Request object to use for cache operations.
 * @param {Request} request - Base request
 * @param {Int} cacheVer - Current Cache version (must be set)
 * @returns {Request} Versioned request object
 */
function GenerateCacheRequest(request, cacheVer) {
	let cacheUrl = request.url;
	if (cacheUrl.indexOf('?') >= 0) {
		cacheUrl += '&';
	} else {
		cacheUrl += '?';
	}
	cacheUrl += 'cf_edge_cache_ver=' + cacheVer;
	return new Request(cacheUrl);
}
