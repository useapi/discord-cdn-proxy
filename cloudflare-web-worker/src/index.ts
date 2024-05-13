interface Env { DISCORD_TOKEN: string, CHANNELS?: [string], DISCORD_CDN_PROXY_BUCKET?: any }

interface RefreshedResponse { refreshed_urls?: [{ original?: string, refreshed?: string }] }

interface CachedURL { href: string, expires: Date };

// There's a high chance that the instance will not be recycled between calls, especially under heavy load.
// We can extract previously saved results from the global cache object below.
const cache = new Map<string, CachedURL>();

function parseValidURL(str: string): URL | false {
	try { return new URL(str); }
	catch (_) { return false; }
}

function handleOPTIONS(request: Request) {
	// Adjust as desired: GET, POST, PATCH, DELETE, HEAD, OPTIONS
	const methods = "GET, OPTIONS";
	if (request.headers.get("Origin") !== null &&
		request.headers.get("Access-Control-Request-Method") !== null &&
		request.headers.get("Access-Control-Request-Headers") !== null) {
		// Handle CORS pre-flight request.
		return new Response(null, {
			headers: {
				"Access-Control-Allow-Origin": request.headers.get("Origin") ?? '',
				"Access-Control-Allow-Methods": methods,
				"Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") ?? '',
				"Access-Control-Max-Age": "86400",
			}
		})
	} else {
		// Handle standard OPTIONS request.
		return new Response(null, {
			headers: {
				"Allow": methods,
			}
		})
	}
}

function withCORS(request: Request, response: Response): Response {
	if (request.headers.get("Origin"))
		response.headers.set("Access-Control-Allow-Origin", request.headers.get("Origin") ?? '');
	return response;
}

function redirectResponse(request: Request, href: string, expires: Date, custom: 'original' | 'refreshed' | 'memory' | 'bucket') {
	// 302 Found https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/302
	const response = new Response('', { status: 302, statusText: 'Found' });
	response.headers.set('Location', href);
	response.headers.set('Expires', expires.toUTCString());
	response.headers.set('x-discord-cdn-proxy', custom);
	return withCORS(request, response);
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext
	): Promise<Response> {
		try {
			if (request.method === 'OPTIONS')
				return handleOPTIONS(request)

			if (!env.DISCORD_TOKEN)
				return withCORS(request, Response.json(`DISCORD_TOKEN is not configured`, { status: 400 }));

			const decoded = decodeURIComponent(request.url);
			const urlStart = decoded.indexOf('?');
			const attachment_url = parseValidURL(decoded.substring(urlStart + 1));
			if (urlStart < 0 || attachment_url === false)
				return withCORS(request, Response.json(`Provide Discord CDN url after ?. Example: https://your-web-site.com/discord-cdn-proxy?https://cdn.discordapp.com/attachments/channel/message/filename.ext`, { status: 400 }));

			// https://cdn.discordapp.com/attachments/channel/message/filename.ext?ex=expires&is=issued&hm=code
			const channel = attachment_url.pathname.split('/')[2];

			// If CHANNELS defined ensure we that provided channel is allowed
			if (env.CHANNELS && !env.CHANNELS.includes(channel))
				return withCORS(request, Response.json(`Channel ${channel} is not allowed`, { status: 400 }));

			const params = new URLSearchParams(attachment_url.search);
			if (params.get('ex') && params.get('is') && params.get('hm')) {
				const expires = new Date(parseInt(params.get('ex') ?? '', 16) * 1000);
				if (expires.getTime() > Date.now())
					return redirectResponse(request, attachment_url.href, expires, 'original');
			}

			const file_name = attachment_url.pathname.split('/').pop() ?? '';

			// Check memory cache first
			const cached_url = cache.get(file_name);

			if (cached_url && cached_url.expires.getTime() > Date.now())
				return redirectResponse(request, cached_url.href, cached_url.expires, 'memory');

			// Check r2 bucket (if configured)
			if (env.DISCORD_CDN_PROXY_BUCKET) {
				const object = await env.DISCORD_CDN_PROXY_BUCKET.get(file_name);

				if (object) {
					const cached_url: CachedURL = await object.json();
					cached_url.expires = new Date(cached_url.expires);
					if (cached_url.expires.getTime() > Date.now()) {
						// Save to memory cache
						cache.set(file_name, cached_url);
						return redirectResponse(request, cached_url.href, cached_url.expires, 'bucket');
					}
				}
			}

			const payload = {
				method: 'POST',
				headers: {
					'Authorization': `${env.DISCORD_TOKEN}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ attachment_urls: [attachment_url.href] })
			};

			const response = await fetch('https://discord.com/api/v9/attachments/refresh-urls', payload);

			// If failed return original Discord API response back
			if (response.status != 200)
				return withCORS(request, response);

			const json = await response.json<RefreshedResponse>();

			if (Array.isArray(json?.refreshed_urls) && json.refreshed_urls[0].refreshed) {
				const refreshed_url = new URL(json.refreshed_urls[0].refreshed);
				const params = new URLSearchParams(refreshed_url.search);
				// Convert from hex and add seconds
				const expires = new Date(parseInt(params.get('ex') ?? '', 16) * 1000);

				const cached_url: CachedURL = { href: refreshed_url.href, expires };

				// Save to memory cache
				cache.set(file_name, cached_url);

				// Save to r2 bucket (if configured)
				if (env.DISCORD_CDN_PROXY_BUCKET)
					ctx.waitUntil(env.DISCORD_CDN_PROXY_BUCKET.put(file_name, JSON.stringify(cached_url),
						{
							httpMetadata: {
								expires: expires
							}
						}));

				return redirectResponse(request, refreshed_url.href, expires, 'refreshed');
			}

			// Return Discord API json which does not have expected data
			return withCORS(request, Response.json(json, { status: 400 }));
		} catch (ex: any) {
			console.error(`Exception`, ex);
			return withCORS(request, new Response(ex, { status: 500 }));
		}
	}
};