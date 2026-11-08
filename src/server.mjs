import http from 'node:http';
import tls from 'node:tls';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { Transport, HTTPError } from './transport.mjs';
import { ensureCA, CertificateStore } from './certificates.mjs';
import { MetadataService } from './metadata.mjs';
import { INTERCEPT_HOSTS, MOD_API_HOSTS, MOD_FILE_HOSTS, mirrorURL, normalizeModJSON, sanitizedHeaders } from './routing.mjs';
import { adaptModRequest, curseForgeSummaryDescription } from './mod-adapter.mjs';
import { curseForgeBulkMods } from './curseforge-bulk.mjs';
import { VERSION } from './version.mjs';

function jsonResponse(res, value, status = 200, head = false, source = 'bridge') {
  const b = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length,
    'cache-control': 'no-store', 'x-prism-bridge-source': source, 'x-content-type-options': 'nosniff' });
  res.end(head ? undefined : b);
}
async function readBody(req, limit = 8 * 1024 * 1024) {
  const values = []; let size = 0;
  for await (const b of req) { size += b.length; if (size > limit) throw new HTTPError(413, 'Request body too large'); values.push(b); }
  return Buffer.concat(values);
}
function publicHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.includes(':')) return false;
  if (net.isIPv4(host)) return !/^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|224\.|255\.)/.test(host);
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && host.includes('.');
}

export class Bridge {
  constructor(config, { transport, log = console.log } = {}) {
    this.config = config; this.log = log; this.t = transport || new Transport(config);
    this.stats = { requests: 0, errors: 0, bmcl: 0, mcim: 0, compatibilityRecipes: 0, fileFallback: 0, tunnels: 0,
      bulkModRequests: 0, bulkModBatches: 0, bulkWireBytes: 0, bulkDecodedBytes: 0, bulkJSONParseMs: 0 };
    this.meta = new MetadataService(config, this.t, source => {
      if (source === 'bmcl') this.stats.bmcl++; else if (source === 'prism-compatibility') this.stats.compatibilityRecipes++;
    });
    this.ca = ensureCA(join(config.dataDir, 'ca'));
    this.certs = new CertificateStore(this.ca, INTERCEPT_HOSTS);
    this.sockets = new Set();
    this.server = http.createServer({ maxHeaderSize: 32768, requestTimeout: 120000 }, (req, res) => this.guard(req, res, () => this.local(req, res)));
    this.server.headersTimeout = 30000;
    this.server.on('connection', socket => this.track(socket));
    this.server.on('connect', (req, socket, head) => this.connect(req, socket, head));
    this.server.on('clientError', (_e, socket) => socket.destroy());
  }
  track(socket) { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); socket.on('error', () => {}); }
  async start() {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.config.port, this.config.listen, resolve); });
    this.port = this.server.address().port;
    return this;
  }
  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise(resolve => this.server.close(resolve)); this.t.close();
  }
  async guard(req, res, fn) {
    this.stats.requests++;
    try { await fn(); }
    catch (e) {
      this.stats.errors++;
      const status = e instanceof HTTPError && e.status >= 400 && e.status <= 599 ? e.status : 502;
      // Request URLs, tokens, cookie values and upstream proxy credentials never enter logs.
      this.log(`[${new Date().toISOString()}] request failed (${status}): ${e instanceof HTTPError ? e.message : 'upstream or conversion error'}`);
      if (!res.headersSent && !res.destroyed) jsonResponse(res, { error: e instanceof HTTPError ? e.message : 'Mirror request or conversion failed. Check connectivity and component support.', status }, status);
      else res.destroy();
    }
  }
  async local(req, res) {
    if (/^https?:\/\//i.test(req.url)) {
      const url = new URL(req.url);
      if (url.protocol !== 'http:') throw new HTTPError(400, 'HTTPS requires CONNECT');
      // Qt may send even its loopback metadata request through its configured
      // application proxy. Consume requests to this exact listener locally.
      if (['127.0.0.1', 'localhost'].includes(url.hostname) && Number(url.port) === this.port && !url.username && !url.password) {
        req.url = url.pathname + url.search;
        req.headers.host = '127.0.0.1:' + this.port;
        return this.local(req, res);
      }
      if (!publicHost(url.hostname) || url.port && url.port !== '80') throw new HTTPError(403, 'Invalid proxy target');
      return this.proxy(req, res, url);
    }
    const h = req.headers.host || '';
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${this.port}$`, 'i').test(h)) throw new HTTPError(403, 'Invalid local Host header');
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    if (!['GET', 'HEAD'].includes(req.method)) throw new HTTPError(405, 'Local endpoints accept GET/HEAD only');
    if (url.pathname === '/health') return jsonResponse(res, { ok: true, version: VERSION, metaURL: `http://127.0.0.1:${this.port}/meta/v1/`,
      proxy: `127.0.0.1:${this.port}`, counts: this.stats, compatibilityRecipes: this.config.compatibilityRecipes, fileFallback: this.config.fileFallback }, 200, req.method === 'HEAD');
    if (url.pathname.startsWith('/meta/v1/')) return jsonResponse(res, await this.meta.request(url.pathname.slice(9)), 200, req.method === 'HEAD', 'bmcl-converter');
    if (url.pathname.startsWith('/assets/')) return this.relay(req, res, this.config.bmcl + url.pathname + url.search, 'bmcl');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Prism Mirror Bridge</title><style>body{max-width:760px;margin:60px auto;padding:24px;font:17px/1.8 system-ui;background:#f4f7fb;color:#203246}code{background:#e4eaf3;padding:4px 8px;border-radius:5px}a{color:#236ac5}</style><h1>Prism Mirror Bridge</h1><p>本地转换服务已启动。</p><p>元数据地址：<code>http://127.0.0.1:${this.port}/meta/v1/</code></p><p>HTTP 代理：<code>127.0.0.1:${this.port}</code></p><p>请使用接入脚本配置 Prism，并信任本次安装生成的证书。关闭服务前请先撤销 Prism 的代理设置。</p><p><a href="/health">查看运行状态</a> · <a href="/meta/v1/net.minecraft/index.json">查看 Minecraft 版本列表</a></p></html>`);
    }
    throw new HTTPError(404, 'Unknown local endpoint');
  }
  async proxy(req, res, url) {
    if (url.username || url.password || url.hash) throw new HTTPError(400, 'Invalid request URL');
    if (url.hostname === 'meta.prismlauncher.org' && url.pathname.startsWith('/v1/')) {
      if (!['GET', 'HEAD'].includes(req.method)) throw new HTTPError(405, 'Metadata is read-only');
      return jsonResponse(res, await this.meta.request(url.pathname.slice(4)), 200, req.method === 'HEAD', 'bmcl-converter');
    }
    const target = mirrorURL(url.href, this.config), modAPI = MOD_API_HOSTS.has(url.hostname);
    if (modAPI) {
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) throw new HTTPError(405, 'Only read API requests are supported');
      const provider = url.hostname === 'api.modrinth.com' ? 'modrinth' : 'curseforge';
      let value, responseSource = 'mcim';
      if (req.method === 'POST') {
        const body = adaptModRequest(provider, await readBody(req));
        if (provider === 'curseforge' && url.pathname === '/v1/mods') {
          this.stats.bulkModRequests++;
          const client = new AbortController();
          const closed = () => { if (!res.writableEnded) client.abort(new Error('Client disconnected')); };
          res.once('close', closed);
          try {
            value = await curseForgeBulkMods(this.t, target, body, this.config, { signal: client.signal,
              onBatch: () => { this.stats.bulkModBatches++; }, onMetrics: m => {
                this.stats.bulkWireBytes += m.wireBytes; this.stats.bulkDecodedBytes += m.decodedBytes; this.stats.bulkJSONParseMs += m.parseMs;
              } });
          } finally { res.removeListener('close', closed); }
        } else value = await this.t.limit.run(() => this.t.requestJSON(target, { method: 'POST', body,
          headers: { 'content-type': 'application/json', 'content-length': body.length } }));
      } else {
        try { value = await this.t.json(target); }
        catch (e) {
          const description = provider === 'curseforge' && url.pathname.match(/^\/v1\/mods\/(\d+)\/description$/);
          if (!(e instanceof HTTPError) || e.status !== 404 || !description) throw e;
          const project = await this.t.json(this.config.mcim + '/curseforge/v1/mods/' + description[1]);
          value = curseForgeSummaryDescription(project, description[1]);
          responseSource = 'mcim-project-summary';
        }
      }
      this.stats.mcim++;
      return jsonResponse(res, normalizeModJSON(value, provider, this.config.mcim), 200, req.method === 'HEAD', responseSource);
    }
    if (!['GET', 'HEAD'].includes(req.method)) throw new HTTPError(405, 'File endpoints accept GET/HEAD only');
    const mirror = target !== url.href;
    try { return await this.relay(req, res, target, mirror ? (MOD_FILE_HOSTS.has(url.hostname) ? 'mcim' : 'bmcl') : 'original'); }
    catch (e) {
      if (!this.config.fileFallback || !mirror || res.headersSent || !MOD_FILE_HOSTS.has(url.hostname)) throw e;
      this.stats.fileFallback++; return this.relay(req, res, url.href, 'original-file-fallback');
    }
  }
  async relay(req, res, target, source) {
    return this.t.limit.run(async () => {
      const headers = sanitizedHeaders(req.headers, { mirror: source !== 'original' && source !== 'original-file-fallback' });
      // The bridge owns all upstream requests' User-Agent and transfer encoding.
      delete headers['user-agent']; delete headers['accept-encoding']; delete headers['content-length'];
      const upstream = await this.t.open(target, { method: req.method, headers });
      if (upstream.statusCode >= 400) { upstream.resume(); throw new HTTPError(upstream.statusCode, `${source} returned HTTP ${upstream.statusCode}`); }
      const out = sanitizedHeaders(upstream.headers);
      delete out['set-cookie']; delete out['x-api-key']; delete out['proxy-authenticate'];
      out['x-prism-bridge-source'] = source;
      if (source === 'mcim') this.stats.mcim++;
      if (source === 'bmcl') this.stats.bmcl++;
      res.writeHead(upstream.statusCode, out);
      if (req.method === 'HEAD') { upstream.resume(); res.end(); } else await pipeline(upstream, res);
    });
  }
  async connect(req, socket, head) {
    try {
      const match = req.url.match(/^([a-zA-Z0-9.-]+):443$/);
      if (!match || !publicHost(match[1].toLowerCase())) throw new Error('CONNECT is limited to public HTTPS hosts on port 443');
      const host = match[1].toLowerCase();
      if (!INTERCEPT_HOSTS.has(host)) {
        const remote = await this.t.tunnel(host, 443); this.track(remote); this.stats.tunnels++;
        if (socket.destroyed) { remote.destroy(); return; }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) remote.write(head);
        socket.pipe(remote); remote.pipe(socket);
        socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
        return;
      }
      const context = this.certs.context(host);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.unshift(head);
      const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context, ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2' });
      this.track(secure); secure.setTimeout(this.config.timeoutMs * ((this.config.retries || 0) + 2), () => secure.destroy());
      const inner = http.createServer({ maxHeaderSize: 32768 }, (request, response) => this.guard(request, response, async () => {
        if (!request.url.startsWith('/') || request.url.startsWith('//')) throw new HTTPError(400, 'Invalid tunneled request path');
        const authority = (request.headers.host || '').toLowerCase().replace(/:443$/, '');
        if (authority !== host) throw new HTTPError(421, 'CONNECT Host mismatch');
        await this.proxy(request, response, new URL(request.url, 'https://' + host));
      }));
      inner.on('clientError', (_e, s) => s.destroy());
      inner.emit('connection', secure);
      secure.on('error', () => socket.destroy());
      secure.on('close', () => inner.close());
    } catch {
      this.stats.errors++;
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    }
  }
}
