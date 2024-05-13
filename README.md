# Discord CDN Proxy

Starting December 2023 all Discord CDN attachment links have following format:  
`https://cdn.discordapp.com/attachments/channel/message/filename.ext?ex=EXPIRES&is=ISSUED&hm=CODE`  
Query parameters values `EXPIRES` and `ISSUED` are timestamps in [unix/epoch hex format](https://www.epochconverter.io/hex-timestamp-converter), `CODE` is encoded checksum used to verify `EXPIRES` and `ISSUED` values.  
Attempt to retrieve Discord CDN attachments URL without above query parameters or with `EXPIRES` past current time will result in 404 `This content is no longer available.` response, see [example](https://cdn.discordapp.com/attachments/1239264794394234985/1239266735992078447/vault_boy.png).  
In practical terms this means that you can no longer link attachments from Discord on your website, share them on Reddit, Facebook.  

This article provides you with effective solution to continue sharing your Discord CDN content publicly without incurring any costs.  

The Discord CND proxy especially handy for users of [Midjourney API](https://useapi.net/docs/api-v2), [Pika API](https://useapi.net/docs/api-pika-v1) or [InsightFaceSwap API](https://useapi.net/docs/api-faceswap-v1).

Once your public proxy deployed you can use public image links using `https://your-discord-cdn-proxy-url/?https://cdn.discordapp.com/attachments/channel/message/filename.ext` format.   
These links can be shared publicly, published on your website, etc.  
The proxy will refresh the links provided after the `?` and redirect the browser to the refreshed Discord CDN link.  
You can include original Discord attachment link query parameters as well `?ex=EXPIRES&is=ISSUED&hm=CODE`, the proxy will check if the link has expired, and may return the original URL immediately if it is not expired.  

When responding with [HTTP 302](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/302) the proxy will set response headers [Expires](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Expires) with link expiration time.  
Custom response header `x-discord-cdn-proxy` will be set to one of following values:
* `original` - provided link query parameters `?ex=EXPIRES&is=ISSUED&hm=CODE` indicate that link is still "fresh"
* `refreshed` - call to `https://discord.com/api/v9/attachments/refresh-urls` Discord API was made to retrieve refreshed link
* `memory` - refreshed link returned from the memory cache
* `bucket` - refreshed link returned from the R2 bucket cache 

![](https://useapi.net/assets/images/articles/discord-cdn-proxy.svg)

Original Discord CDN link [open](https://cdn.discordapp.com/attachments/1239264794394234985/1239266735992078447/vault_boy.png?ex=66424c96&is=6640fb16&hm=0b3d3210b4ea0916d5c8c0b2d998a4f4b64f5b95b79cdb9b58ff96b8287dace4&) (`404: This content is no longer available.`)  
Discord CDN link using proxy [open](https://demo.useapi.net/discord-cdn-proxy/?https://cdn.discordapp.com/attachments/1239264794394234985/1239266735992078447/vault_boy.png?ex=66424c96&is=6640fb16&hm=0b3d3210b4ea0916d5c8c0b2d998a4f4b64f5b95b79cdb9b58ff96b8287dace4&)   
Discord CDN link using proxy (without query parameters) [open](https://demo.useapi.net/discord-cdn-proxy/?https://cdn.discordapp.com/attachments/1239264794394234985/1239266735992078447/vault_boy.png)  

Two deployment options covered in the article: 
- Cloudflare Worker [proceed](#deploy-cloudflare-worker).  
  100K requests per day are included in the free tier account [link](https://developers.cloudflare.com/workers/platform/pricing/).  
  Cloudflare **does not** require the entering of payment information.    
- Google App Engine [proceed](#deploy-google-app-engine).    
  F1 instance is free to run 24/7/365 [link](https://cloud.google.com/appengine/docs/standard/quotas#Instances).    
  Google **asks** for a credit card or other payment method when you sign up for the Free Trial/Free Tier [link](https://cloud.google.com/free/docs/free-cloud-features#why-credit-card).    

You can choose either option based on your preferences.  

## Deploy Cloudflare Worker

Assuming you have free Cloudflare account [setup](https://developers.cloudflare.com/fundamentals/setup/account/create-account/) completed  and installed [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

Clone git repository [discord-cdn-proxy](https://github.com/useapi/discord-cdn-proxy?tab=readme-ov-file).  
Navigate to `./cloudflare-web-worker` folder and install npm packages:
```bash
npm install
```

If you are familiar with Cloudflare Workers, you can adjust the deployment configuration in the `wrangler.toml` file.   
You can fine-tune it later at any time once you have acquired some initial experience.  

Deploy Worker: 
```bash
wrangler deploy --keep-vars 
```

Notice deployment url which will look like `https://discord-cdn-proxy.your-user-name.workers.dev`    
You can use that url to test by adding Discord link at the end after  `?`  
Example: `https://your-discord-cdn-proxy-url/?https://cdn.discordapp.com/attachments/channel/message/filename.ext`    

Create `.secrets` file with following JSON: 
```json
{
    "DISCORD_TOKEN": "discord token",
    "CHANNELS": "['channel id', 'another channel id', 'channel id etc']"
}
```
How to [extract discord token](https://useapi.net/docs/start-here/setup-midjourney#obtain-discord-token).  
Optional array `CHANNELS` defines which Discord channels should be proxied.  
You can remove it but it is strongly not recommended for public proxies.  

Deploy secrets from local file `.secrets`: 
```bash
wrangler secret:bulk .secrets
```

Now you can test deployed proxy.  
Example (adjust to include actual values): `https://your-discord-cdn-proxy-url/?https://cdn.discordapp.com/attachments/channel/message/filename.ext`  

### Debugging locally

Create `.dev.vars` file with following text: 
```javascript
DISCORD_TOKEN="discord token"
CHANNELS=["channel id", "another channel id", "channel id etc"]
```

Run local development using `.dev.var` secrets:
```bash
wrangler dev  
```

### Refreshing Discord links using an R2 bucket for caching

This allows you to store refreshed Discord links in a Cloudflare R2 bucket to minimize the number of calls to the Discord API. 

To create an R2 bucket, execute:
```bash
wrangler r2 bucket create discord-cdn-proxy-cache
wrangler r2 bucket list
```

Uncomment `r2_buckets` configuration in `wrangler.toml` file.

Redeploy Worker:
```bash
wrangler deploy --keep-vars 
```

## Deploy Google App Engine

Assuming you have Google Cloud [account](https://cloud.google.com/) and installed [gcloud CLI](https://cloud.google.com/sdk/docs/install).

Clone git repository [discord-cdn-proxy](https://github.com/useapi/discord-cdn-proxy?tab=readme-ov-file).  
Navigate to `./google-app-engine` folder and install npm packages:
```bash
npm install
```

You can follow along the official Google App Engine deployment steps for [Node.js](https://cloud.google.com/appengine/docs/standard).

Log in to your Google Cloud account:
```bash
gcloud auth login
```

Create new project:
```bash
gcloud projects create discord-cdn-proxy
```

Select created project:
```bash
gcloud config set project discord-cdn-proxy
```

Find created project on your Google Cloud Dashboard and link billing account to the project.  

Create App Engine project:
```bash
gcloud app create
```

Create `.env.yaml` file with following yaml: 
```yaml
env_variables:
  DISCORD_TOKEN: "discord token"
  CHANNELS: "['channel id', 'another channel id', 'channel id etc']"
```
How to [extract discord token](https://useapi.net/docs/start-here/setup-midjourney#obtain-discord-token).  
Optional array `CHANNELS` defines which Discord channels should be proxied.  
You can remove it but it is strongly not recommended for public proxies.  

Deploy App Engine project:
```bash
gcloud app deploy
```
You may have to run the above command a few times, as it often fails on the first run.

Notice the name of the deployed service, which will look like:
`Deployed service [default] to [https://discord-cdn-proxy.it.r.appspot.com]` 

Update `.env.yaml` file and add DISCORD_CDN_PROXY_URL with value from deployed service: 
```yaml
env_variables:
  DISCORD_TOKEN: "discord token"
  CHANNELS: "['channel id', 'another channel id', 'channel id etc']"
  DISCORD_CDN_PROXY_URL: "https://discord-cdn-proxy.it.r.appspot.com"
```

Deploy App Engine project with updated configuration:
```bash
gcloud app deploy
```

Now you can test deployed proxy.  
Example (adjust to include actual values): `https://discord-cdn-proxy.it.r.appspot.com/?https://cdn.discordapp.com/attachments/channel/message/filename.ext`    

### Debugging locally

Update DISCORD_TOKEN value in your `package.json` file: 
```json
{
  "name": "discord-cdn-proxy",
  "version": "1.0.0",
  "description": "Discord CDN proxy",
  "main": "server.js",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "debug": "DISCORD_TOKEN='discord token' DISCORD_CDN_PROXY_URL='http://localhost:8090/' node server.js"
  },
  "author": "useapi.net",
  "license": "ISC",
  "dependencies": {
    "express": "^4.19.2"
  }
}
```

Execute script with npm:
```bash
npm run debug
```