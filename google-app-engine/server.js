import express from 'express';
const app = express();

const cache = new Map();

const const_heartbeat = "heartbeat";

const stats = {
    started: new Date(),
    calls: 0,
    original: 0,
    refreshed: 0,
    memory: 0,
    heartbeats: 0,
    exceptions: 0,
    cache_size: 0
};

function parseValidURL(str) {
    try { return new URL(str); }
    catch (_) { return false; }
}

function handleOPTIONS(request) {
    const methods = "GET, OPTIONS";

    if (request.headers["Origin"] !== null &&
        request.headers["Access-Control-Request-Method"] !== null &&
        request.headers["Access-Control-Request-Headers"] !== null) {

        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": request.headers["Origin"] || '',
                "Access-Control-Allow-Methods": methods,
                "Access-Control-Allow-Headers": request.headers["Access-Control-Request-Headers"] || '',
                "Access-Control-Max-Age": "86400",
            }
        });
    } else {
        return new Response(null, {
            headers: {
                "Allow": methods,
            }
        })
    }
}

function withCORS(request, response) {
    if (request.headers["Origin"])
        response.headers.set("Access-Control-Allow-Origin", request.headers["Origin"] || '');
    return response;
}

function redirectResponse(request, href, expires, custom) {
    const response = new Response('', { status: 302, statusText: 'Found' });
    response.headers.set('Location', href);
    response.headers.set('Expires', expires.toUTCString());
    response.headers.set('x-discord-cdn-proxy', custom);
    return withCORS(request, response);
}

async function refreshURL(request) {
    try {
        if (request.method === 'OPTIONS')
            return handleOPTIONS(request)

        stats.calls++;

        if (!process.env.DISCORD_TOKEN)
            return withCORS(request, new Response(JSON.stringify({ message: `DISCORD_TOKEN is not configured` }), { status: 400 }));

        const urlStart = request.url.indexOf('?');

        const url = request.url.substring(urlStart + 1);

        // Check for heart beat request
        if (url == const_heartbeat) {
            stats.cache_size = cache.size;
            console.log(const_heartbeat, stats);
            return withCORS(request, Response.json(stats, { status: 200 }));
        }

        const attachment_url = parseValidURL(url);
        if (urlStart < 0 || attachment_url === false)
            return withCORS(request, Response.json(`Provide Discord CDN url after ?. Example: https://your-web-site.com/discord-cdn-proxy?https://cdn.discordapp.com/attachments/channel/message/filename.ext`, { status: 400 }));

        const channel = attachment_url.pathname.split('/')[2];

        if (process.env.CHANNELS && !process.env.CHANNELS.includes(channel))
            return withCORS(request, new Response(JSON.stringify({ message: `Channel ${channel} is not allowed` }), { status: 400 }));

        const params = new URLSearchParams(attachment_url.search);
        if (params.get('ex') && params.get('is') && params.get('hm')) {
            const expires = new Date(parseInt(params.get('ex') || '', 16) * 1000);
            if (expires.getTime() > Date.now()) {
                stats.original++;
                return redirectResponse(request, attachment_url.href, expires, 'original');
            }
        }

        const file_name = attachment_url.pathname.split('/').pop() || '';

        const cached_url = cache.get(file_name);

        if (cached_url && cached_url.expires.getTime() > Date.now()) {
            stats.memory++;
            return redirectResponse(request, cached_url.href, cached_url.expires, 'memory');
        }

        const payload = {
            method: 'POST',
            headers: {
                'Authorization': `${process.env.DISCORD_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ attachment_urls: [attachment_url.href] })
        };

        const response = await fetch('https://discord.com/api/v9/attachments/refresh-urls', payload);

        if (response.status != 200)
            return withCORS(request, response);

        const json = await response.json();

        if (Array.isArray(json.refreshed_urls) && json.refreshed_urls[0].refreshed) {
            const refreshed_url = new URL(json.refreshed_urls[0].refreshed);
            const params = new URLSearchParams(refreshed_url.search);
            const expires = new Date(parseInt(params.get('ex') || '', 16) * 1000);

            const cached_url = { href: refreshed_url.href, expires };

            cache.set(file_name, cached_url);

            stats.refreshed++;

            return redirectResponse(request, refreshed_url.href, expires, 'refreshed');
        }

        return withCORS(request, new Response(JSON.stringify(json), { status: 400 }));
    } catch (ex) {
        stats.exceptions++;
        console.error(`Exception`, ex);
        return withCORS(request, new Response(ex.toString(), { status: 500 }));
    }
}

app.get('/', async (req, res) => {
    const response = await refreshURL(req);

    for (const pair of response.headers.entries())
        res.setHeader(pair[0], pair[1]);

    res.status(response.status).send(await response.text());
});

const PORT = process.env.PORT || 8090;
app.listen(PORT, () => {
    console.log(`Discord CDN proxy on port ${PORT}...`);
});

// We can configure the service to call itself to ensure it stays active 24/7 and retain cached values.
if (process.env.DISCORD_CDN_PROXY_URL) {
    console.log(`Discord CDN proxy URL`, process.env.DISCORD_CDN_PROXY_URL);

    stats.DISCORD_CDN_PROXY_URL = process.env.DISCORD_CDN_PROXY_URL;

    if (process.env.DISCORD_TOKEN)
        stats.DISCORD_TOKEN = process.env.DISCORD_TOKEN.substring(0, 3) + '…' + process.env.DISCORD_TOKEN.substring(process.env.DISCORD_TOKEN.length - 3);

    if (process.env.CHANNELS)
        stats.CHANNELS = process.env.CHANNELS;

    // Execute self-call ever 10 minutes to keep instance in memory
    setInterval(() => {
        stats.heartbeats++;
        fetch(`${process.env.DISCORD_CDN_PROXY_URL}/?${const_heartbeat}`);
    }, 10 * 60 * 1000);
}