/// <reference lib="deno.unstable" />
// deno-lint-ignore-file no-explicit-any
interface RefreshedResponse {
    refreshed_urls?: [{ original?: string; refreshed?: string }];
  }
  
  interface CachedURL {
    href: string;
    expires: Date;
  }
  
  const cache = new Map<string, CachedURL>();
  
  function parseValidURL(str: string): URL | false {
    try {
      return new URL(str);
    } catch (_) {
      return false;
    }
  }
  
  function handleOptions(request: Request): Response {
    const methods = "GET, OPTIONS";
  
    if (
      request.headers.get("Origin") !== null &&
      request.headers.get("Access-Control-Request-Method") &&
      request.headers.get("Access-Control-Request-Headers") !== null
    ) {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": request.headers.get("Origin") ?? "",
          "Access-Control-Allow-Methods": methods,
          "Access-Control-Allow-Headers": request.headers.get(
            "Access-Control-Request-Headers",
          ) ?? "",
          "Access-Control-Max-Age": "86400",
        },
      });
    } else {
      return new Response(null, {
        headers: {
          "Allow": methods,
        },
      });
    }
  }
  
  function withCORS(request: Request, response: Response): Response {
    if (request.headers.get("Origin")) {
      response.headers.set(
        "Access-Control-Allow-Origin",
        request.headers.get("Origin") ?? "",
      );
    }
    return response;
  }
  
  function redirectResponse(
    request: Request,
    href: string,
    expires: Date,
    custom: "original" | "refreshed" | "memory" | "bucket",
  ): Response {
    const response = new Response("", {
      status: 302,
      statusText: "Found",
    });
    response.headers.set("Location", href);
    response.headers.set("Expires", expires.toUTCString());
    response.headers.set("x-discord-cdn-proxy", custom);
  
    return withCORS(request, response);
  }
  
  Deno.serve(async (request: Request) => {
    try {
      if (request.method === "OPTIONS") {
        return handleOptions(request);
      }
  
      if (!Deno.env.get("DISCORD_TOKEN")) {
        return withCORS(
          request,
          new Response(
            "DISCORD_TOKEN is not configured",
            { status: 400 },
          ),
        );
      }
  
      const decoded = decodeURIComponent(request.url);
      const urlStart = decoded.indexOf("?");
      const attachmentURL = parseValidURL(decoded.substring(urlStart + 1));
  
      if (urlStart < 0 || attachmentURL === false) {
        return withCORS(
          request,
          new Response(
            "Provide Discord CDN url after ?. Example: https://your-web-site.com/?https://cdn.discordapp.com/attachments/channel/message/filename.ext",
            {
              status: 400,
            },
          ),
        );
      }
  
      const channel = attachmentURL.pathname.split("/")[2];
  
      // If CHANNELS are defined, ensure that provided channel is allowed.
      if (
        Deno.env.get("CHANNELS") && Deno.env.get("CHANNELS")?.includes(channel)
      ) {
        return withCORS(
          request,
          new Response("Provided channel is not allowed.", {
            status: 403,
          }),
        );
      }
  
      const params = new URLSearchParams(attachmentURL.search);
  
      if (params.get("ex") && params.get("is") && params.get("hm")) {
        const expr = new Date(parseInt(params.get("ex") ?? "", 16) * 1000);
        if (expr.getTime() > Date.now()) {
          return redirectResponse(request, attachmentURL.href, expr, "original");
        }
      }
  
      const fileName = attachmentURL.pathname.split("/").pop() ?? "";
  
      // check in-memory cache first
      const cachedURL = cache.get(fileName);
  
      if (cachedURL && cachedURL.expires.getTime() > Date.now()) {
        return redirectResponse(
          request,
          cachedURL.href,
          cachedURL.expires,
          "memory",
        );
      }
  
      // Check Deno KV (if configured)
      // TODO: We could reconfigure this to work for Supabase Edge functions
      // which could make this truly cross-platform like Deno functions usually are.
      if (Deno.env.get("DISCORD_CDN_PROXY_BUCKET")) {
        const kv = await Deno.openKv();
  
        // check if kv has our object anywhere
        const object = await kv.get<CachedURL>([`${channel}-${fileName}`]);
  
        if (object.value !== null) {
          const cachedURL: CachedURL = object.value!;
          cachedURL.expires = new Date(cachedURL.expires);
  
          if (cachedURL.expires.getTime() > Date.now()) {
            // save the memory cache too
            cache.set(`${channel}-${fileName}`, cachedURL);
            return redirectResponse(
              request,
              cachedURL.href,
              cachedURL.expires,
              "bucket",
            );
          }
        }
      }
  
      const payload = {
        method: "POST",
        headers: {
          "Authorization": `${Deno.env.get("DISCORD_TOKEN")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ attachment_urls: [attachmentURL.href] }),
      };
  
      const response = await fetch(
        "https://discord.com/api/v9/attachments/refresh-urls",
        payload,
      );
  
      // if failed, return original Discord API response back
      if (response.status !== 200) {
        return withCORS(request, response);
      }
  
      const json: RefreshedResponse = await response.json();
  
      if (
        Array.isArray(json?.refreshed_urls) && json?.refreshed_urls[0].refreshed
      ) {
        const refreshedURL = new URL(json.refreshed_urls[0].refreshed);
        const params = new URLSearchParams(refreshedURL.search);
        const expires = new Date(parseInt(params.get("ex") ?? "", 16) * 1000);
  
        const cachedURL: CachedURL = { href: refreshedURL.href, expires };
  
        // save to memory cache, then save on backing storage, if set
        cache.set(`${channel}-${fileName}`, cachedURL);
  
        if (Deno.env.get("DISCORD_CDN_PROXY_BUCKET")) {
          const kv = await Deno.openKv();
          await kv.set([`${channel}-${fileName}`], cachedURL, {
            expireIn: expires.getTime(),
          });
        }
  
        return redirectResponse(request, refreshedURL.href, expires, "refreshed");
      }
  
      return withCORS(request, Response.json(json, { status: 400 }));
    } catch (e: any) {
      console.error(`Exception: ${e}`);
      return withCORS(request, new Response(e, { status: 500 }));
    }
  });
  