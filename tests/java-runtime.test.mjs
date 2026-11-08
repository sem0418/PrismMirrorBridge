import test from 'node:test';
import assert from 'node:assert/strict';
import { convertWindowsJava, restoreJavaManifest, JAVA_MANIFEST_PATH } from '../src/java-runtime.mjs';
import { MetadataService } from '../src/metadata.mjs';
import { HTTPError } from '../src/transport.mjs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = { bmcl: 'https://bmcl.example', cacheSeconds: 60, compatibilityRecipes: false };
const entry = (name, hash = 'a'.repeat(40)) => ({ version: { name, released: '2026-01-01T00:00:00Z' },
  manifest: { url: `https://piston-meta.mojang.com/v1/packages/${hash}/manifest.json`, sha1: hash, size: 100 } });
const fixture = () => ({ 'windows-x64': { 'jre-legacy': [entry('8u51-cacert462b08')],
  'java-runtime-alpha': [entry('16.0.1.9.1')], 'java-runtime-beta': [entry('17.0.15')],
  'java-runtime-gamma': [entry('17.0.15')], 'java-runtime-delta': [entry('21.0.7')],
  'java-runtime-epsilon': [entry('25.0.1')], 'minecraft-java-exe': [entry('14')], 'java-runtime-empty': [] },
  linux: { 'java-runtime-delta': [entry('21.0.7')] }, 'windows-arm64': { 'java-runtime-delta': [entry('21.0.7')] } });

test('BMCL Windows runtime lists convert Java 8, 16, 17, 21 and 25 without launcher helpers or other platforms', () => {
  const result = convertWindowsJava(fixture(), config);
  assert.deepEqual(result.index.versions.map(v => v.version), ['java8', 'java16', 'java17', 'java21', 'java25']);
  assert.equal(result.components.get('java17').runtimes.length, 2);
  const legacy = result.components.get('java8').runtimes[0];
  assert.deepEqual(legacy.version, { major: 8, minor: 0, security: 51, name: '8u51-cacert462b08', buildstr: 'cacert462b08' });
  assert.equal(result.components.get('java16').runtimes[0].version.build, 9);
  for (const component of result.components.values()) for (const r of component.runtimes) {
    assert.equal(r.runtimeOS, 'windows-x64'); assert.equal(r.downloadType, 'manifest');
    assert.equal(r.vendor, 'mojang'); assert.equal(r.checksum.hash, 'a'.repeat(40));
    assert.equal(r.url, 'https://bmcl.example/v1/packages/' + 'a'.repeat(40) + '/manifest.json');
  }
});
test('runtime routing works with compatibility disabled, caches the converted list and never requests Prism metadata', async () => {
  const calls = [];
  const directory = await mkdtemp(join(tmpdir(), 'java-runtime-test-'));
  const bytes = Buffer.from('{"files":{"bin":{"type":"directory"}}}');
  const hash = createHash('sha1').update(bytes).digest('hex');
  const raw = fixture(); raw['windows-x64']['java-runtime-delta'][0].manifest = {
    url: 'https://piston-meta.mojang.com/v1/packages/' + hash + '/manifest.json', sha1: hash, size: bytes.length };
  const service = new MetadataService({ ...config, port: 17643, dataDir: directory }, {
    json: async url => { calls.push(url); return raw; }, bytes: async () => bytes, limit: { run: fn => fn() },
  });
  try {
  const root = await service.request('index.json');
  assert.equal(root.packages.filter(p => p.uid === 'net.minecraft.java').length, 1);
  const index = await service.request('net.minecraft.java/index.json');
  const component = await service.request('net.minecraft.java/java21.json');
  assert(index.versions.some(v => v.version === component.version));
  assert.equal(component.runtimes[0].name, 'java-runtime-delta');
  assert.deepEqual(calls, [config.bmcl + JAVA_MANIFEST_PATH]);
  component.runtimes[0].checksum.hash = 'changed';
  assert.equal((await service.request('net.minecraft.java/java21.json')).runtimes[0].checksum.hash, hash);
  assert.equal((await service.request('net.minecraft.java/java21.json')).runtimes[0].url, `http://127.0.0.1:17643/runtime/${hash}.json`);
  await assert.rejects(() => service.request('net.minecraft.java/java999.json'), e => e instanceof HTTPError && e.status === 404);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('unsupported third-party Java providers and manual LWJGL versions retain explicit 501 errors with component context', async () => {
  const service = new MetadataService(config, {});
  for (const path of ['com.azul.java/index.json', 'net.adoptium.java/index.json', 'org.lwjgl3/3.3.999.json'])
    await assert.rejects(() => service.request(path), e => e instanceof HTTPError && e.status === 501 && e.message.includes(path));
});
test('compacted BMCL manifest is restored only when its exact bytes match the advertised Mojang SHA1 and size', () => {
  const original = Buffer.from('{"files": {"bin": {"type": "directory"}}}');
  const compact = Buffer.from('{"files":{"bin":{"type":"directory"}}}');
  const expected = { sha1: createHash('sha1').update(original).digest('hex'), size: original.length };
  assert.notEqual(createHash('sha1').update(compact).digest('hex'), expected.sha1);
  assert.deepEqual(restoreJavaManifest(compact, expected), original);
  assert.deepEqual(restoreJavaManifest(original, expected), original);
  for (const bytes of [Buffer.from('{"files":{"other":{"type":"directory"}}}'), Buffer.from('invalid JSON')])
    assert.throws(() => restoreJavaManifest(bytes, expected), e => e instanceof HTTPError && e.status === 502);
  assert.throws(() => restoreJavaManifest(compact, { ...expected, size: expected.size + 1 }), e => e.status === 502);
});
test('unsafe manifest paths, file checksums and download URLs fail before being made available to Prism', () => {
  for (const raw of [
    { files: { '../bad': { type: 'directory' } } },
    { files: { 'C:/bad': { type: 'directory' } } },
    { files: { bin: { type: 'link', target: '..' } } },
    { files: { 'bin/java.exe': { type: 'file', downloads: { raw: { size: 4, sha1: 'bad', url: 'https://example.com/file' } } } } },
    { files: { 'bin/java.exe': { type: 'file', downloads: { raw: { size: 4, sha1: 'b'.repeat(40), url: 'https://127.0.0.1/file' } } } } },
  ]) {
    const bytes = Buffer.from(JSON.stringify(raw)), expected = { sha1: createHash('sha1').update(bytes).digest('hex'), size: bytes.length };
    assert.throws(() => restoreJavaManifest(bytes, expected), e => e.status === 502);
  }
});
test('any malformed necessary runtime fails the complete response rather than returning a partial list', () => {
  for (const mutate of [
    v => { delete v['windows-x64']; },
    v => { v['windows-x64']['java-runtime-delta'] = {}; },
    v => { v['windows-x64']['java-runtime-delta'][0].manifest.sha1 = 'bad'; },
    v => { v['windows-x64']['java-runtime-delta'][0].manifest.size = -1; },
    v => { v['windows-x64']['java-runtime-delta'][0].version.name = 'bad'; },
    v => { v['windows-x64']['java-runtime-delta'][0].version.released = 'bad'; },
    v => { v['windows-x64']['java-runtime-delta'][0].manifest.url = 'https://127.0.0.1/manifest.json'; },
    v => { v['windows-x64']['java-runtime-delta'][0].manifest.url = 'http://piston-meta.mojang.com/v1/packages/' + 'a'.repeat(40) + '/manifest.json'; },
    v => { v['windows-x64']['java-runtime-delta'][0].manifest.url += '?token=secret'; },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => convertWindowsJava(value, config), e => e instanceof HTTPError && e.status === 502);
  }
});
test('Java upstream failures keep their status and are not silently replaced by official compatibility recipes', async () => {
  const configWithCompatibility = { ...config, compatibilityRecipes: true };
  const service = new MetadataService(configWithCompatibility, { json: async () => { throw new HTTPError(503, 'upstream unavailable'); } });
  await assert.rejects(() => service.request('net.minecraft.java/index.json'), e => e instanceof HTTPError && e.status === 503);
});
