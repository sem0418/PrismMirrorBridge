import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/server.mjs';
import { JAVA_MANIFEST_PATH } from '../src/java-runtime.mjs';

const hash = bytes => createHash('sha1').update(bytes).digest('hex');
const manifests = [Buffer.from('{"files": {"bin": {"type": "directory"}}}'), Buffer.from('{"files": {"lib": {"type": "directory"}}}')];
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'java-wire-'));
  const state = { failSecond: false, calls: [] };
  const upstream = http.createServer((req, res) => {
    state.calls.push(req.url);
    if (req.url === JAVA_MANIFEST_PATH) return res.end(JSON.stringify({ 'windows-x64': Object.fromEntries(['java-runtime-beta', 'java-runtime-gamma'].map((name, i) => [name, [{
      version: { name: '17.0.15', released: '2025-05-19T00:00:00Z' },
      manifest: { url: 'https://piston-meta.mojang.com/v1/packages/' + hash(manifests[i]) + '/manifest.json', sha1: hash(manifests[i]), size: manifests[i].length },
    }]])) }));
    const index = manifests.findIndex(bytes => req.url === '/v1/packages/' + hash(bytes) + '/manifest.json');
    if (index >= 0) {
      if (index === 1 && state.failSecond) { res.writeHead(503); return res.end('unavailable'); }
      return res.end(JSON.stringify(JSON.parse(manifests[index])));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const config = { listen: '127.0.0.1', port: 0, dataDir: dir, bmcl: `http://127.0.0.1:${upstream.address().port}`,
    compatibilityRecipes: false, upstreamProxy: '', timeoutMs: 1000, retries: 0, concurrency: 4, cacheSeconds: 60 };
  let bridge = await new Bridge(config, { log: () => {} }).start();
  return { state, config, dir, get bridge() { return bridge; },
    async restart() { const port = bridge.port; await bridge.close(); config.port = port; bridge = await new Bridge(config, { log: () => {} }).start(); },
    async close() { await bridge.close(); await new Promise(done => upstream.close(done)); await rm(dir, { recursive: true, force: true }); },
  };
}
test('verified runtime manifests survive a bridge restart and corrupt cached bytes are rejected', async () => {
  const app = await setup();
  try {
    const base = `http://127.0.0.1:${app.bridge.port}`;
    const response = await fetch(base + '/meta/v1/net.minecraft.java/java17.json'); assert.equal(response.status, 200);
    const component = await response.json(); assert.equal(component.runtimes.length, 2);
    await app.restart(); const calls = app.state.calls.length;
    for (const [i, runtime] of component.runtimes.entries()) {
      const downloaded = await fetch(runtime.url); assert.equal(downloaded.status, 200);
      const bytes = Buffer.from(await downloaded.arrayBuffer()); assert.deepEqual(bytes, manifests[i]);
      assert.equal(hash(bytes), runtime.checksum.hash);
    }
    assert.equal(app.state.calls.length, calls, 'Restart must not need upstream when verified files are cached');
    await writeFile(join(app.dir, 'java-manifests', hash(manifests[0]) + '.json'), 'corrupt');
    const corrupt = await fetch(component.runtimes[0].url); assert.equal(corrupt.status, 502);
    assert.equal((await corrupt.json()).status, 502);
  } finally { await app.close(); }
});
test('failure of any required Java manifest returns the original error, with no partially successful component', async () => {
  const app = await setup();
  try {
    app.state.failSecond = true;
    const url = `http://127.0.0.1:${app.bridge.port}/meta/v1/net.minecraft.java/java17.json`;
    const response = await fetch(url); assert.equal(response.status, 503);
    const body = await response.json(); assert.equal(body.status, 503); assert.equal(body.runtimes, undefined);
    app.state.failSecond = false;
    const retried = await fetch(url); assert.equal(retried.status, 200); assert.equal((await retried.json()).runtimes.length, 2);
  } finally { await app.close(); }
});
