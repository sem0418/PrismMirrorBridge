import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import tls from 'node:tls';
import net from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { Bridge } from '../src/server.mjs';
import { Transport } from '../src/transport.mjs';
import { ensureCA, CertificateStore } from '../src/certificates.mjs';
import { viaProxy } from '../scripts/test-client.mjs';
import { USER_AGENT } from '../src/version.mjs';

let bridge, upstream, dir, config, upstreamURL, observed = [], raw, failFiles = false, failPrimaryMetadata = false, transient = 0;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'prism-bridge-test-'));
  raw = JSON.parse(readFileSync(new URL('./fixtures/bmcl-vanilla.json', import.meta.url)));
  upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks).toString();
    observed.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (req.url.startsWith('/mc/game/')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ latest: { release: '1.20.1' }, versions: [{ id: '1.20.1', type: 'release', releaseTime: raw.releaseTime, url: 'https://piston-meta.mojang.com/v1/packages/test/1.20.1.json' }] })); }
    if (req.url === '/version/1.20.1/json') {
      if (failPrimaryMetadata) { res.writeHead(503); return res.end('busy'); }
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(raw));
    }
    if (req.url === '/v1/packages/test/1.20.1.json') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(raw)); }
    if (req.url.startsWith('/modrinth/v2/search')) { res.setHeader('content-type', 'application/json'); return res.end('{"hits":[{"project_id":"AANobbMI","title":"Sodium"}],"offset":0,"limit":1,"total_hits":1}'); }
    if (req.url === '/curseforge/v1/mods') { res.setHeader('content-type', 'application/json'); return res.end('{"data":[{"id":238222,"name":"JEI","sync_at":"date"}]}'); }
    if (req.url === '/curseforge/v1/mods/238222') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: { id: 238222, summary: 'Items <script>alert(1)</script> & recipes\nLine two' } })); }
    if (req.url.startsWith('/data/')) {
      if (failFiles) { res.writeHead(503); return res.end('mirror unavailable'); }
      const value = Buffer.from('0123456789');
      if (req.headers.range) { res.writeHead(206, { 'content-length': 4, 'content-range': 'bytes 2-5/10' }); return res.end(value.subarray(2, 6)); }
      res.setHeader('content-length', 10); return res.end(value);
    }
    if (req.url === '/invalid-json') return res.end('<html>not json</html>');
    if (req.url === '/transient') {
      if (transient++ === 0) { res.writeHead(503, { 'retry-after': '0' }); return res.end('busy'); }
      res.setHeader('content-type', 'application/json'); return res.end('{"ok":true}');
    }
    if (req.url === '/slow-stream') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.flushHeaders();
      let count = 0; const timer = setInterval(() => { res.write('a'); if (++count === 8) { clearInterval(timer); res.end(); } }, 250);
      res.once('close', () => clearInterval(timer)); return;
    }
    if (req.url === '/stalled-headers') { const timer = setTimeout(() => res.end('late'), 500); res.once('close', () => clearTimeout(timer)); return; }
    res.writeHead(404); res.end('missing');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
  config = { listen: '127.0.0.1', port: 0, dataDir: dir, bmcl: upstreamURL, mcim: upstreamURL,
    prismRecipes: upstreamURL + '/v1/', compatibilityRecipes: false, fileFallback: false, upstreamProxy: '',
    timeoutMs: 1000, concurrency: 4, cacheSeconds: 60 };
  bridge = await new Bridge(config, { log: () => {} }).start();
});
after(async () => { await bridge?.close(); await new Promise(resolve => upstream.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
test('health endpoint and generated root/version indices are valid Prism JSON without stale hashes', async () => {
  const root = `http://127.0.0.1:${bridge.port}`;
  const health = await (await fetch(root + '/health')).json(); assert(health.ok);
  const r = await (await fetch(root + '/meta/v1/index.json')).json(); assert(r.packages.some(p => p.uid === 'net.minecraft')); assert(r.packages.every(p => !p.sha256));
  const list = await (await fetch(root + '/meta/v1/net.minecraft/index.json')).json(); assert.equal(list.versions[0].version, '1.20.1'); assert(!list.versions[0].sha256);
  const mc = await (await fetch(root + '/meta/v1/net.minecraft/1.20.1.json')).json(); assert.equal(mc.version, '1.20.1');
  const lwjgl = await (await fetch(root + '/meta/v1/org.lwjgl3/bridge-1.20.1.json')).json(); assert(lwjgl.libraries.length > 10);
});
test('CONNECT TLS certificate is valid for the API host and trusted only by this installation CA', async () => {
  const response = await viaProxy(bridge.port, 'https://api.modrinth.com/v2/search?query=sodium&limit=1', { ca: bridge.ca.cert });
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).hits[0].project_id, 'AANobbMI');
  assert.equal(response.peer.subject.CN, 'api.modrinth.com');
  assert(new X509Certificate(response.peer.raw).checkHost('api.modrinth.com'));
});
test('Qt loopback metadata requests also work in absolute HTTP proxy form', async () => {
  const r = await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: bridge.port, path: `http://127.0.0.1:${bridge.port}/meta/v1/net.minecraft/index.json`,
      headers: { host: '127.0.0.1:' + bridge.port }, agent: false }, response => {
      const chunks = []; response.on('data', b => chunks.push(b)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    }); request.on('error', reject);
  });
  assert.equal(r.status, 200); assert.equal(r.body.uid, 'net.minecraft');
});
test('existing Prism LWJGL 3.3.1 component selection can be served from BMCL without official recipes', async () => {
  const value = await (await fetch(`http://127.0.0.1:${bridge.port}/meta/v1/org.lwjgl3/3.3.1.json`)).json();
  assert.equal(value.version, '3.3.1'); assert.equal(value.uid, 'org.lwjgl3'); assert(value.libraries.length > 0);
  assert.equal(bridge.stats.compatibilityRecipes, 0);
});
test('Prism CurseForge bulk POST request is converted end to end and credentials are not forwarded', async () => {
  const body = Buffer.from('{"modIds":["238222"]}');
  const r = await viaProxy(bridge.port, 'https://api.curseforge.com/v1/mods', { ca: bridge.ca.cert, method: 'POST', body,
    headers: { 'content-type': 'application/json', 'content-length': body.length, 'x-api-key': 'test-secret', authorization: 'test-token', cookie: 'test-cookie' } });
  assert.equal(r.status, 200); const v = JSON.parse(r.body); assert.equal(v.data[0].id, 238222); assert(!('sync_at' in v.data[0]));
  const request = observed.findLast(r => r.url === '/curseforge/v1/mods'); assert.deepEqual(JSON.parse(request.body), { modIds: [238222] });
  assert.equal(request.headers['x-api-key'], undefined); assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
  assert.equal(request.headers['user-agent'], USER_AGENT);
});
test('binary downloads stream through MCIM and retain Range/206 semantics', async () => {
  const r = await viaProxy(bridge.port, 'https://cdn.modrinth.com/data/AA/versions/BB/mod.jar', { ca: bridge.ca.cert, headers: { range: 'bytes=2-5' } });
  assert.equal(r.status, 206); assert.equal(r.body.toString(), '2345'); assert.equal(r.headers['content-range'], 'bytes 2-5/10'); assert.equal(r.headers['x-prism-bridge-source'], 'mcim');
});
test('missing CurseForge descriptions use a disclosed, HTML-escaped MCIM summary; unrelated 404s remain errors', async () => {
  const r = await viaProxy(bridge.port, 'https://api.curseforge.com/v1/mods/238222/description', { ca: bridge.ca.cert });
  assert.equal(r.status, 200); assert.equal(r.headers['x-prism-bridge-source'], 'mcim-project-summary');
  const value = JSON.parse(r.body).data; assert(value.includes('Project summary only'));
  assert(value.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; recipes<br>Line two')); assert(!value.includes('<script>'));
  for (const path of ['238223/description', '238222/files/123/changelog']) {
    const missing = await viaProxy(bridge.port, 'https://api.curseforge.com/v1/mods/' + path, { ca: bridge.ca.cert });
    assert.equal(missing.status, 404);
  }
});
test('HEAD preserves file length and sends no response body', async () => {
  const r = await viaProxy(bridge.port, 'https://cdn.modrinth.com/data/AA/versions/BB/mod.jar', { ca: bridge.ca.cert, method: 'HEAD' });
  assert.equal(r.status, 200); assert.equal(r.headers['content-length'], '10'); assert.equal(r.body.length, 0);
});
test('strict mode reports mirror file failures without silently using the original CDN', async () => {
  failFiles = true;
  try {
    const r = await viaProxy(bridge.port, 'https://cdn.modrinth.com/data/AA/versions/BB/mod.jar', { ca: bridge.ca.cert });
    assert.equal(r.status, 503); assert.equal(bridge.stats.fileFallback, 0);
  } finally { failFiles = false; }
});
test('CONNECT Host mismatch is rejected inside a valid TLS connection', async () => {
  const r = await viaProxy(bridge.port, 'https://api.modrinth.com/v2/search', { ca: bridge.ca.cert, headers: { host: 'api.curseforge.com' } });
  assert.equal(r.status, 421);
});
test('write requests and invalid metadata/Host paths are rejected', async () => {
  const r = await viaProxy(bridge.port, 'https://cdn.modrinth.com/data/mod.jar', { ca: bridge.ca.cert, method: 'DELETE' }); assert.equal(r.status, 405);
  const bad = await fetch(`http://127.0.0.1:${bridge.port}/meta/v1/net.minecraft/bad%2fpath.json`); assert.equal(bad.status, 404);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: bridge.port, path: '/health', headers: { host: 'evil.example' }, agent: false }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(hostStatus, 403);
});
test('Microsoft HTTPS remains end-to-end encrypted without bridge certificate substitution', async () => {
  const ca = ensureCA(join(dir, 'auth-test-ca')), store = new CertificateStore(ca, ['login.microsoftonline.com']);
  const server = tls.createServer({ SNICallback: (_host, callback) => callback(null, store.context('login.microsoftonline.com')) });
  server.on('secureConnection', socket => socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nauth')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = bridge.t.tunnel;
  bridge.t.tunnel = () => new Promise((resolve, reject) => {
    const s = net.connect(server.address().port, '127.0.0.1', () => resolve(s)); s.on('error', reject);
  });
  try {
    const r = await viaProxy(bridge.port, 'https://login.microsoftonline.com/common/test', { ca: ca.cert });
    assert.equal(r.body.toString(), 'auth'); assert.equal(r.peer.issuer.CN, ca.subject); assert.notEqual(r.peer.issuer.CN, bridge.ca.subject);
  } finally { bridge.t.tunnel = original; await new Promise(resolve => server.close(resolve)); }
});
test('concurrent identical metadata requests are coalesced and invalid JSON is not cached', async () => {
  const t = new Transport({ ...config, dataDir: join(dir, 'cache-test') });
  try {
    const before = observed.filter(x => x.url.startsWith('/mc/game/')).length;
    await Promise.all(Array.from({ length: 8 }, () => t.json(upstreamURL + '/mc/game/version_manifest_v2.json')));
    assert.equal(observed.filter(x => x.url.startsWith('/mc/game/')).length - before, 1);
    await assert.rejects(() => t.json(upstreamURL + '/invalid-json'), /invalid JSON/);
    await assert.rejects(() => t.json(upstreamURL + '/invalid-json'), /invalid JSON/);
    assert.equal(observed.filter(x => x.url === '/invalid-json').length, 2);
  } finally { t.close(); }
});
test('temporary mirror HTTP failures retry within the configured limit', async () => {
  const t = new Transport({ ...config, dataDir: join(dir, 'retry-test'), retries: 1 });
  try { assert.deepEqual(await t.json(upstreamURL + '/transient'), { ok: true }); assert.equal(transient, 2); }
  finally { t.close(); }
});
test('untrusted interception certificates fail TLS validation', async () => {
  await assert.rejects(() => viaProxy(bridge.port, 'https://api.modrinth.com/v2/search'), /certificate|issuer|self.signed/i);
});
test('certificate issuance is limited to configured mirror hosts', () => {
  assert.throws(() => bridge.certs.context('login.microsoftonline.com'), /non-mirror/);
  assert.throws(() => bridge.certs.context('api.modrinth.com.attacker.example'), /non-mirror/);
  assert.throws(() => bridge.certs.context('dist.creeper.host'), /non-mirror/);
});
test('long downloads with continuing progress are not aborted by a total-duration timer', async () => {
  const t = new Transport({ ...config, timeoutMs: 1000, retries: 0 });
  try { const start = Date.now(); const body = await t.bytes(upstreamURL + '/slow-stream'); assert.equal(body.toString(), 'aaaaaaaa'); assert(Date.now() - start > 1000); }
  finally { t.close(); }
});
test('connections that never return headers are bounded by a timeout', async () => {
  const t = new Transport({ ...config, timeoutMs: 80, retries: 0 });
  try { await assert.rejects(() => t.bytes(upstreamURL + '/stalled-headers'), /timeout/i); }
  finally { t.close(); }
});
test('a failing BMCL version endpoint can use its mirrored package URL while staying at BMCL', async () => {
  const t = new Transport({ ...config, dataDir: join(dir, 'alternate-meta') });
  const { MetadataService } = await import('../src/metadata.mjs');
  const m = new MetadataService(config, t); failPrimaryMetadata = true;
  try {
    const value = await m.component('net.minecraft', '1.20.1');
    assert.equal(value.version, '1.20.1');
    assert(observed.some(v => v.url === '/v1/packages/test/1.20.1.json'));
  } finally { failPrimaryMetadata = false; t.close(); }
});
