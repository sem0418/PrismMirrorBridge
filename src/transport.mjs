import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createUnzip, createBrotliDecompress } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { USER_AGENT } from './version.mjs';

export class HTTPError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  async run(fn, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.active >= this.limit) await new Promise((resolve, reject) => {
      const next = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { const i = this.queue.indexOf(next); if (i >= 0) this.queue.splice(i, 1); reject(signal.reason); };
      this.queue.push(next); signal?.addEventListener('abort', abort, { once: true });
    }); else this.active++;
    try { signal?.throwIfAborted(); return await fn(); }
    finally { const next = this.queue.shift(); if (next) next(); else this.active--; }
  }
}

export function proxyEnvironment(config) {
  if (config.upstreamProxy === 'environment') return { ...process.env };
  if (!config.upstreamProxy) return {};
  const u = new URL(config.upstreamProxy);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('upstreamProxy must be an HTTP(S) proxy.');
  return { HTTP_PROXY: u.href, HTTPS_PROXY: u.href, NO_PROXY: 'localhost,127.0.0.1,::1' };
}

export class Transport {
  constructor(config) {
    this.config = config;
    this.env = proxyEnvironment(config);
    this.httpAgent = new http.Agent({ keepAlive: true, proxyEnv: this.env });
    this.httpsAgent = new https.Agent({ keepAlive: true, proxyEnv: this.env });
    this.limit = new Semaphore(config.concurrency);
    this.pending = new Map();
    this.cacheDir = join(config.dataDir, 'cache');
  }
  close() { this.httpAgent.destroy(); this.httpsAgent.destroy(); }
  async open(url, { method = 'GET', headers = {}, body, redirects = 0, attempt = 0, signal } = {}) {
    signal?.throwIfAborted();
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new HTTPError(400, 'Invalid upstream URL');
    const h = { 'user-agent': USER_AGENT, 'accept-encoding': 'identity', ...headers };
    let response;
    try { response = await new Promise((resolve, reject) => {
      let watchdog;
      const req = (u.protocol === 'https:' ? https : http).request(u, {
        method, headers: h, signal, agent: u.protocol === 'https:' ? this.httpsAgent : this.httpAgent,
      }, response => { clearTimeout(watchdog); resolve(response); });
      // Bound DNS/connect/headers separately. Once streaming starts, the
      // inactivity timeout below resets on traffic, allowing large modpacks.
      watchdog = setTimeout(() => req.destroy(new Error('Upstream timeout')), this.config.timeoutMs);
      req.on('error', error => { clearTimeout(watchdog); reject(error); });
      req.once('close', () => clearTimeout(watchdog));
      req.setTimeout(this.config.timeoutMs, () => req.destroy(new Error('Upstream timeout')));
      if (body) req.write(body);
      req.end();
    }); } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const retryable = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ABORT_ERR'].includes(error.code) || error.message === 'Upstream timeout';
      if (!retryable || !['GET', 'HEAD'].includes(method) || attempt >= (this.config.retries || 0)) throw error;
      await delay(500 * 2 ** attempt, undefined, { signal });
      return this.open(url, { method, headers, body, redirects, attempt: attempt + 1, signal });
    }
    if ([429, 500, 502, 503, 504].includes(response.statusCode) && ['GET', 'HEAD'].includes(method) && attempt < (this.config.retries || 0)) {
      const after = response.headers['retry-after'];
      const retryDelay = after ? (/^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now()) : 500 * 2 ** attempt;
      if (Number.isFinite(retryDelay) && retryDelay <= 5000) {
        response.resume();
        await delay(Math.max(0, retryDelay), undefined, { signal });
        return this.open(url, { method, headers, body, redirects, attempt: attempt + 1, signal });
      }
    }
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
      response.resume();
      if (redirects >= 8) throw new HTTPError(502, 'Too many upstream redirects');
      const next = new URL(response.headers.location, u);
      if (next.protocol !== 'https:' && u.protocol === 'https:') throw new HTTPError(502, 'Refusing HTTPS downgrade');
      const nextHeaders = { ...h };
      if (next.origin !== u.origin) {
        for (const k of Object.keys(nextHeaders)) if (/^(authorization|cookie|x-api-key|proxy-authorization)$/i.test(k)) delete nextHeaders[k];
      }
      const nextMethod = response.statusCode === 303 && method !== 'HEAD' ? 'GET' : method;
      if (nextMethod !== method) { delete nextHeaders['content-length']; delete nextHeaders['content-type']; }
      return this.open(next, { method: nextMethod, headers: nextHeaders, body: nextMethod === method ? body : undefined, redirects: redirects + 1, signal });
    }
    return response;
  }
  async bytes(url, { maxBytes = 32 * 1024 * 1024, decompress = false, onMetrics, ...options } = {}) {
    const started = performance.now();
    if (decompress) options.headers = { ...options.headers, 'accept-encoding': 'gzip' };
    const r = await this.open(url, options), chunks = []; let size = 0, wireBytes = 0;
    const headersMs = performance.now() - started;
    const encoding = (r.headers['content-encoding'] || 'identity').trim().toLowerCase();
    let decoder;
    if (decompress && encoding !== 'identity') {
      if (['gzip', 'deflate'].includes(encoding)) decoder = createUnzip();
      else if (encoding === 'br') decoder = createBrotliDecompress();
      else { r.destroy(); throw new HTTPError(502, 'Unsupported API content encoding'); }
    }
    r.on('data', c => { wireBytes += c.length; if (wireBytes > maxBytes) r.destroy(new HTTPError(502, 'Upstream response exceeds limit')); });
    try {
      await pipeline(r, ...(decoder ? [decoder] : []), async source => {
        for await (const c of source) {
          size += c.length;
          if (size > maxBytes) throw new HTTPError(502, 'Decoded upstream response exceeds limit');
          chunks.push(c);
        }
      }, { signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (decoder && !(error instanceof HTTPError) && /^Z_|^ERR_PADDING|^ERR__/.test(error.code || '')) throw new HTTPError(502, 'MCIM returned invalid compressed JSON');
      throw error;
    }
    const body = Buffer.concat(chunks);
    onMetrics?.({ wireBytes, decodedBytes: size, contentEncoding: encoding, headersMs: Math.round(headersMs), durationMs: Math.round(performance.now() - started) });
    if (r.statusCode >= 400) {
      const error = new HTTPError(r.statusCode, `Upstream HTTP ${r.statusCode} from ${new URL(url).hostname}`);
      // Internal evidence for MCIM's documented all-missing-ID 404. Never logged
      // or sent to the client; arbitrary 404s remain failures.
      if (body.length <= 65536) error.upstreamBody = body;
      throw error;
    }
    if (r.statusCode < 200 || r.statusCode >= 300) throw new HTTPError(502, 'Unexpected upstream status');
    return body;
  }
  async requestJSON(url, { onMetrics, ...options } = {}) {
    let metrics;
    const body = await this.bytes(url, { ...options, decompress: true, onMetrics: value => { metrics = value; } });
    const start = performance.now(); let value;
    try { value = JSON.parse(body.toString('utf8')); }
    catch { throw new HTTPError(502, 'MCIM returned invalid JSON'); }
    options.signal?.throwIfAborted();
    onMetrics?.({ ...metrics, parseMs: Math.round((performance.now() - start) * 100) / 100 });
    return value;
  }
  async cached(url, type = 'json', ttl = this.config.cacheSeconds) {
    const key = createHash('sha256').update(type + ':' + url).digest('hex');
    if (this.pending.has(key)) return structuredClone(await this.pending.get(key));
    const job = (async () => {
      const file = join(this.cacheDir, key + '.json');
      try {
        const value = JSON.parse(await readFile(file, 'utf8'));
        if (Date.now() - value.time < ttl * 1000) return value.data;
      } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
      const b = await this.limit.run(() => this.bytes(url));
      let data;
      try { data = type === 'json' ? JSON.parse(b.toString('utf8')) : b.toString('utf8'); }
      catch { throw new HTTPError(502, 'Mirror returned invalid JSON'); }
      await mkdir(this.cacheDir, { recursive: true });
      const tmp = file + '.' + randomBytes(6).toString('hex');
      await writeFile(tmp, JSON.stringify({ time: Date.now(), data }), { mode: 0o600 });
      await rename(tmp, file);
      return data;
    })();
    this.pending.set(key, job);
    try { return structuredClone(await job); } finally { this.pending.delete(key); }
  }
  json(url, ttl) { return this.cached(url, 'json', ttl); }
  text(url, ttl) { return this.cached(url, 'text', ttl); }

  // Unselected CONNECT targets stay end-to-end encrypted, including Microsoft login.
  tunnel(host, port) {
    const proxy = this.env.HTTPS_PROXY || this.env.https_proxy || this.env.HTTP_PROXY || this.env.http_proxy;
    if (!proxy) return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port }); socket.once('connect', () => resolve(socket)); socket.once('error', reject);
      socket.setTimeout(this.config.timeoutMs, () => socket.destroy(new Error('Tunnel timeout')));
    });
    const p = new URL(proxy);
    return new Promise((resolve, reject) => {
      const headers = { host: host + ':' + port };
      if (p.username || p.password) headers['proxy-authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password)).toString('base64');
      const req = (p.protocol === 'https:' ? https : http).request({ hostname: p.hostname, port: p.port || (p.protocol === 'https:' ? 443 : 80),
        method: 'CONNECT', path: host + ':' + port, headers, agent: false });
      req.once('error', reject); req.setTimeout(this.config.timeoutMs, () => req.destroy(new Error('Proxy CONNECT timeout')));
      req.once('connect', (res, socket, head) => {
        if (res.statusCode !== 200) { socket.destroy(); reject(new HTTPError(502, 'Upstream proxy rejected CONNECT')); }
        else { if (head.length) socket.unshift(head); socket.setTimeout(this.config.timeoutMs, () => socket.destroy()); resolve(socket); }
      }); req.end();
    });
  }
}
