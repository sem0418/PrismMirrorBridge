import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { Transport, Semaphore, HTTPError } from '../src/transport.mjs';
import { Bridge } from '../src/server.mjs';
import { viaProxy } from '../scripts/test-client.mjs';

async function fixture(handler, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-bulk-test-'));
  const state = { requests: [], active: 0, maxActive: 0, timers: new Set() };
  const upstream = http.createServer(async (req, res) => {
    const pieces = []; for await (const part of req) pieces.push(part);
    const raw = Buffer.concat(pieces); const body = raw.length ? JSON.parse(raw) : {};
    state.requests.push({ path: req.url, body, headers: req.headers });
    state.active++; state.maxActive = Math.max(state.maxActive, state.active);
    res.once('close', () => { state.active--; });
    const send = (status, value, { wait = 0, encoding = 'gzip', streamDelay = 0 } = {}) => {
      const plain = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      const buffer = encoding === 'gzip' ? gzipSync(plain) : encoding === 'deflate' ? deflateSync(plain) : encoding === 'br' ? brotliCompressSync(plain) : plain;
      const timer = setTimeout(() => {
        state.timers.delete(timer); if (res.destroyed) return;
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': buffer.length, ...(encoding === 'identity' ? {} : { 'content-encoding': encoding }) });
        if (!streamDelay) return res.end(buffer);
        let offset = 0;
        const stream = setInterval(() => { if (res.destroyed) { clearInterval(stream); state.timers.delete(stream); return; }
          res.write(buffer.subarray(offset, offset += 1024)); if (offset >= buffer.length) { clearInterval(stream); state.timers.delete(stream); res.end(); }
        }, streamDelay); state.timers.add(stream);
      }, wait); state.timers.add(timer);
    };
    try { await handler(req, res, body, send, state); } catch (e) { res.destroy(e); }
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const config = { listen: '127.0.0.1', port: 0, dataDir: directory, mcim: base, bmcl: base, upstreamProxy: '',
    timeoutMs: 1000, retries: 0, concurrency: 4, cacheSeconds: 60, compatibilityRecipes: false, fileFallback: false,
    bulkBatchSize: 50, bulkConcurrency: 3, bulkTimeoutMs: 4000, ...overrides };
  const bridge = await new Bridge(config, { log: () => {} }).start();
  return { state, bridge, base, config,
    request: (ids, extra = {}, path = '/v1/mods') => {
      const body = Buffer.from(JSON.stringify({ modIds: ids, ...extra }));
      return viaProxy(bridge.port, 'https://api.curseforge.com' + path, { ca: bridge.ca.cert, method: 'POST', body, timeout: 7000,
        headers: { 'content-type': 'application/json', 'content-length': body.length, authorization: 'test-token', cookie: 'test-cookie', 'x-api-key': 'test-key' } });
    },
    async close() { await bridge.close(); for (const timer of state.timers) { clearTimeout(timer); clearInterval(timer); }
      upstream.closeAllConnections(); await new Promise(done => upstream.close(done)); await rm(directory, { recursive: true, force: true }); },
  };
}
const project = id => ({ id, name: 'Mod ' + id, summary: 'a real field', latestFiles: [{ fileName: 'mod.jar', markers: 'x'.repeat(16000) }], sync_at: 'cache-date' });
function missing(ids) { return { code: 404, error: 'Not Found', detail: 'Mods not found: No mods found for the provided modIds: ' + JSON.stringify(ids) }; }

test('498 string IDs finish as complete JSON through gzip, batches and bounded concurrency with a slow upstream', async () => {
  const f = await fixture((_req, _res, body, send) => send(200, { data: body.modIds.map(project) }, { wait: 120, streamDelay: 15 }));
  try {
    const ids = Array.from({ length: 498 }, (_, i) => String(i + 100)); const start = Date.now();
    const r = await f.request(ids, { filterPcOnly: true }); const value = JSON.parse(r.body);
    assert.equal(r.status, 200); assert.equal(value.data.length, 498); assert.deepEqual(value.data.map(m => m.id), ids.map(Number));
    assert(value.data.every(m => !('sync_at' in m) && m.latestFiles[0].markers.length === 16000));
    assert.equal(f.state.requests.length, 10); assert(f.state.maxActive >= 2 && f.state.maxActive <= 3);
    assert(Date.now() - start < f.config.bulkTimeoutMs, 'Must finish before the request budget');
    for (const request of f.state.requests) {
      assert(request.body.modIds.length <= 50); assert(request.body.modIds.every(Number.isInteger)); assert.equal(request.body.filterPcOnly, true);
      assert.equal(request.headers['accept-encoding'], 'gzip');
      for (const h of ['authorization', 'cookie', 'x-api-key']) assert.equal(request.headers[h], undefined);
    }
    assert(f.bridge.stats.bulkDecodedBytes > 7 * 1024 * 1024); assert(f.bridge.stats.bulkWireBytes < f.bridge.stats.bulkDecodedBytes / 10);
  } finally { await f.close(); }
});
test('a necessary failed batch returns its HTTP error and never a partial success', async () => {
  const f = await fixture((_req, _res, body, send) => body.modIds.includes(51) ? send(503, { error: 'busy' }, { wait: 40 }) : send(200, { data: body.modIds.map(project) }, { wait: body.modIds[0] === 1 ? 20 : 250 }));
  try {
    const r = await f.request(Array.from({ length: 250 }, (_, i) => String(i + 1)));
    assert.equal(r.status, 503); const value = JSON.parse(r.body); assert.equal(value.status, 503); assert.equal(value.data, undefined);
    assert(f.state.requests.length <= 4, 'Failure must cancel remaining work instead of running every batch');
    await new Promise(done => setTimeout(done, 50)); assert.equal(f.bridge.t.limit.active, 0); assert.equal(f.bridge.t.limit.queue.length, 0);
  } finally { await f.close(); }
});
test('continuous slow progress still respects the overall bulk deadline and returns 504 before the client times out', async () => {
  const f = await fixture((_req, _res, body, send) => send(200, { data: body.modIds.map(project) }, { encoding: 'identity', streamDelay: 20 }), { bulkTimeoutMs: 600 });
  try {
    const start = Date.now(); const r = await f.request(Array.from({ length: 498 }, (_, i) => String(i + 1)));
    assert.equal(r.status, 504); assert(Date.now() - start < 3000); assert.equal(JSON.parse(r.body).data, undefined);
    await new Promise(done => setTimeout(done, 50)); assert.equal(f.bridge.t.limit.active, 0); assert.equal(f.bridge.t.limit.queue.length, 0);
  } finally { await f.close(); }
});
test('missing IDs and duplicate input IDs preserve MCIM set semantics across batches', async () => {
  const f = await fixture((_req, _res, body, send) => {
    const found = body.modIds.filter(id => id >= 51 && id !== 77);
    send(found.length ? 200 : 404, found.length ? { data: found.map(project), schema: 'same', sync_at: 'cache' } : missing(body.modIds));
  });
  try {
    const ids = Array.from({ length: 130 }, (_, i) => String(i + 1)); ids.push('80', '100');
    const r = await f.request(ids); assert.equal(r.status, 200); const value = JSON.parse(r.body);
    assert.deepEqual(value.data.map(m => m.id), Array.from({ length: 80 }, (_, i) => i + 51).filter(n => n !== 77));
    assert.equal(value.schema, 'same'); assert(!('sync_at' in value)); assert.equal(f.state.requests.length, 3);
  } finally { await f.close(); }
});
test('all IDs absent stays 404; an empty input keeps the upstream 400', async () => {
  const f = await fixture((_req, _res, body, send) => send(body.modIds.length ? 404 : 400, body.modIds.length ? missing(body.modIds) : { error: 'ModIds cannot be empty' }));
  try {
    assert.equal((await f.request(Array.from({ length: 120 }, (_, i) => String(i + 1)))).status, 404);
    assert.equal((await f.request([])).status, 400);
  } finally { await f.close(); }
});
test('an arbitrary 404 is not mistaken for a successful missing-ID batch', async () => {
  const f = await fixture((_req, _res, body, send) => body.modIds[0] === 51 ? send(404, { code: 404, error: 'Not Found', detail: 'endpoint missing' }) : send(200, { data: body.modIds.map(project) }));
  try { const r = await f.request(Array.from({ length: 120 }, (_, i) => String(i + 1))); assert.equal(r.status, 404); assert.equal(JSON.parse(r.body).data, undefined); }
  finally { await f.close(); }
});
test('invalid JSON, unexpected project IDs, and inconsistent envelopes each fail the entire lookup', async () => {
  for (const fault of ['invalid-json', 'wrong-id', 'envelope']) {
    const f = await fixture((_req, _res, body, send) => {
      const broken = body.modIds[0] === 51;
      send(200, fault === 'invalid-json' && broken ? '<not JSON>' : {
        data: (fault === 'wrong-id' && broken ? [999999] : body.modIds).map(project), schema: fault === 'envelope' && broken ? 'changed' : 'same' });
    });
    try { const r = await f.request(Array.from({ length: 120 }, (_, i) => String(i + 1))); assert.equal(r.status, 502, fault); assert.equal(JSON.parse(r.body).data, undefined); }
    finally { await f.close(); }
  }
});
test('/v1/mods/files keeps one request and the original fileIds payload', async () => {
  const f = await fixture((req, _res, body, send) => { assert.equal(req.url, '/curseforge/v1/mods/files'); send(200, { data: body.fileIds.map(id => ({ id, modId: 238222 })) }); });
  try {
    const fileIds = Array.from({ length: 498 }, (_, i) => String(i + 1)); const body = Buffer.from(JSON.stringify({ fileIds }));
    const r = await viaProxy(f.bridge.port, 'https://api.curseforge.com/v1/mods/files', { ca: f.bridge.ca.cert, method: 'POST', body,
      headers: { 'content-type': 'application/json', 'content-length': body.length } });
    assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).data.length, 498); assert.equal(f.state.requests.length, 1);
    assert.deepEqual(f.state.requests[0].body, { fileIds: fileIds.map(Number) }); assert.equal(f.bridge.stats.bulkModBatches, 0);
  } finally { await f.close(); }
});
test('queued work can be cancelled without consuming or leaking a semaphore slot', async () => {
  const gate = new Semaphore(1); let release;
  const first = gate.run(() => new Promise(done => { release = done; })); const controller = new AbortController();
  const queued = gate.run(() => { throw Error('Cancelled work must never start'); }, { signal: controller.signal });
  const reason = new HTTPError(504, 'deadline'); controller.abort(reason); await assert.rejects(queued, e => e === reason);
  assert.equal(gate.queue.length, 0); release(); await first; assert.equal(gate.active, 0);
});
test('compressed API decoding supports gzip, deflate, br and identity and bounds expanded output', async () => {
  for (const encoding of ['gzip', 'deflate', 'br', 'identity']) {
    const f = await fixture((_req, _res, _body, send) => send(200, { value: 'x'.repeat(10000) }, { encoding }));
    const t = new Transport(f.config);
    try {
      assert.equal((await t.requestJSON(f.base + '/json')).value.length, 10000);
      await assert.rejects(() => t.requestJSON(f.base + '/json', { maxBytes: 5000 }), /exceeds limit/);
    } finally { t.close(); await f.close(); }
  }
});
