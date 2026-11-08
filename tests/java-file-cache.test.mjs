import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { JavaFileCache } from '../src/java-file-cache.mjs';
import { HTTPError } from '../src/transport.mjs';
const bytes = Buffer.from('licence data'), sha1 = createHash('sha1').update(bytes).digest('hex');
const url = `https://piston-data.mojang.com/v1/objects/${sha1}/LICENSE`;
const manifest = Buffer.from(JSON.stringify({ files: { 'legal/LICENSE': { type: 'file', downloads: { raw: { url, size: bytes.length, sha1 } } } } }));
test('verified small Java file cache survives reconstruction, and corrupted disk bytes fail without being served or silently replaced', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'java-object-cache-'));
  let requests = 0;
  const transport = { bytes: async () => { requests++; return bytes; }, limit: { run: fn => fn() } };
  const config = { dataDir: directory, bmcl: 'https://bmcl.example' };
  try {
    const first = new JavaFileCache(config, transport); first.registerVerifiedManifest(manifest);
    assert.deepEqual(await first.bytes(first.lookup(url)), bytes);
    const restarted = new JavaFileCache(config, transport); restarted.registerVerifiedManifest(manifest);
    assert.deepEqual(await restarted.bytes(restarted.lookup(url)), bytes); assert.equal(requests, 1);
    await writeFile(join(directory, 'java-files', sha1), 'corrupt');
    await assert.rejects(() => restarted.bytes(restarted.lookup(url)), e => e instanceof HTTPError && e.status === 502);
    assert.equal(requests, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('all coalesced callers receive the upstream error and can retry after that failed request completes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'java-object-fail-')); let requests = 0, fail = true;
  const cache = new JavaFileCache({ dataDir: directory, bmcl: 'https://bmcl.example' }, { limit: { run: fn => fn() }, bytes: async () => {
    requests++; await delay(20); if (fail) throw new HTTPError(503, 'unavailable'); return bytes;
  } }); cache.registerVerifiedManifest(manifest);
  try {
    const results = await Promise.allSettled(Array.from({ length: 69 }, () => cache.bytes(cache.lookup(url))));
    assert.equal(requests, 1); assert(results.every(r => r.status === 'rejected' && r.reason.status === 503));
    fail = false; assert.deepEqual(await cache.bytes(cache.lookup(url)), bytes); assert.equal(requests, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('a successful upstream status with a corrupt Java body never becomes a cached successful response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'java-object-hash-')); let valid = false;
  const cache = new JavaFileCache({ dataDir: directory, bmcl: 'https://bmcl.example' }, { limit: { run: fn => fn() }, bytes: async () => valid ? bytes : Buffer.from('invalid body') });
  cache.registerVerifiedManifest(manifest);
  try {
    await assert.rejects(() => cache.bytes(cache.lookup(url)), e => e.status === 502);
    valid = true; assert.deepEqual(await cache.bytes(cache.lookup(url)), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
