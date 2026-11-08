import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { Bridge } from '../src/server.mjs';
import { viaProxy } from './test-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(join(root, 'config.json'));
const dir = await mkdtemp(join(tmpdir(), 'prism-bridge-live-'));
config.dataDir = dir; config.port = 0; config.compatibilityRecipes = false; config.fileFallback = false;
const bridge = await new Bridge(config, { log: message => process.stderr.write(message + '\n') }).start();
const local = `http://127.0.0.1:${bridge.port}`;
const report = { startedAt: new Date().toISOString(), node: process.versions.node, tests: [], authenticationLoginTested: false, fullGameLaunchTested: false, windowsTrustTested: false };
let vanilla, graphics, versions, cfFile;
async function check(name, fn) {
  const start = Date.now();
  try {
    const details = await fn(); report.tests.push({ name, passed: true, durationMs: Date.now() - start, details }); console.log('PASS ' + name + (details ? ' ' + JSON.stringify(details) : ''));
  } catch (e) {
    report.tests.push({ name, passed: false, durationMs: Date.now() - start, error: e.message }); console.log('FAIL ' + name + ': ' + e.message);
  }
}
async function metadata(path) {
  const r = await fetch(local + '/meta/v1/' + path, { signal: AbortSignal.timeout(110000) });
  const v = await r.json(); assert.equal(r.status, 200, JSON.stringify(v)); assert.equal(v.formatVersion, 1); return v;
}
async function api(url, options = {}) {
  const r = await viaProxy(bridge.port, url, { ca: bridge.ca.cert, ...options });
  assert.equal(r.status, 200, r.body.toString().slice(0, 300)); return JSON.parse(r.body);
}
try {
  await check('Prism component index', async () => {
    const v = await metadata('index.json'); assert(v.packages.some(p => p.uid === 'net.minecraft')); return { packages: v.packages.length };
  });
  await check('BMCL Minecraft version list', async () => {
    const v = await metadata('net.minecraft/index.json'); assert(v.versions.length > 500); return { versions: v.versions.length };
  });
  await check('BMCL Minecraft 1.20.1 conversion', async () => {
    vanilla = await metadata('net.minecraft/1.20.1.json'); assert(vanilla.mainJar.downloads.artifact.sha1.length === 40); assert.deepEqual(vanilla.compatibleJavaMajors, [17]);
    return { uid: vanilla.uid, java: vanilla.compatibleJavaMajors, mainJarSha1: vanilla.mainJar.downloads.artifact.sha1 };
  });
  await check('BMCL LWJGL 3 native component', async () => {
    graphics = await metadata('org.lwjgl3/bridge-1.20.1.json'); assert(graphics.libraries.some(l => /natives-windows/.test(l.name))); return { libraries: graphics.libraries.length };
  });
  for (const version of ['1.12.2', '1.5.2', '26.3', '3D Shareware v1.34']) await check('BMCL Minecraft ' + version, async () => {
    const v = await metadata('net.minecraft/' + encodeURIComponent(version) + '.json'); assert(v.mainJar.downloads.artifact.sha1.length === 40); return { java: v.compatibleJavaMajors, traits: v['+traits'] };
  });
  for (const [uid, version] of [['net.fabricmc.fabric-loader', '0.16.14'], ['net.fabricmc.intermediary', '1.20.1'], ['org.quiltmc.quilt-loader', '0.23.0'], ['net.minecraftforge', '10.13.4.1614'], ['net.minecraftforge', '14.23.5.2860'], ['net.minecraftforge', '47.3.0'], ['net.neoforged', '21.1.1'], ['net.neoforged', '26.3.0.101']]) {
    await check('BMCL component ' + uid + '/' + version, async () => {
      const v = await metadata(uid + '/' + version + '.json'); assert(v.libraries.length > 0); return { libraries: v.libraries.length, mavenFiles: v.mavenFiles?.length || 0, mainClass: v.mainClass };
    });
  }
  await check('MCIM Modrinth search over CONNECT/TLS', async () => {
    const v = await api('https://api.modrinth.com/v2/search?query=sodium&limit=1'); assert(v.hits.some(h => h.project_id === 'AANobbMI')); return { title: v.hits[0].title };
  });
  await check('MCIM Modrinth version filtering', async () => {
    versions = await api('https://api.modrinth.com/v2/project/AANobbMI/version?game_versions=%5B%221.20.1%22%5D&loaders=%5B%22fabric%22%5D');
    assert(versions.length > 0); assert(versions.every(v => v.game_versions.includes('1.20.1'))); return { versions: versions.length };
  });
  await check('MCIM CurseForge file metadata', async () => {
    const v = await api('https://api.curseforge.com/v1/mods/238222/files?pageSize=2&gameVersion=1.20.1');
    assert(v.data.length > 0); cfFile = v.data[0]; return { modId: cfFile.modId, fileId: cfFile.id, filename: cfFile.fileName, downloadHost: cfFile.downloadUrl && new URL(cfFile.downloadUrl).hostname };
  });
  await check('Prism string IDs to MCIM CurseForge bulk integers', async () => {
    const body = Buffer.from('{"modIds":["238222"]}');
    const v = await api('https://api.curseforge.com/v1/mods', { method: 'POST', body, headers: { 'content-type': 'application/json', 'content-length': body.length } });
    assert(v.data.some(v => v.id === 238222)); return { projects: v.data.length };
  });
  await check('MCIM CurseForge bulk file IDs', async () => {
    assert(cfFile); const body = Buffer.from(JSON.stringify({ fileIds: [String(cfFile.id)] }));
    const v = await api('https://api.curseforge.com/v1/mods/files', { method: 'POST', body, headers: { 'content-type': 'application/json', 'content-length': body.length } });
    assert(v.data.some(v => v.id === cfFile.id)); return { files: v.data.length };
  });
  await check('CurseForge description adapts a real MCIM project summary', async () => {
    const r = await viaProxy(bridge.port, 'https://api.curseforge.com/v1/mods/238222/description', { ca: bridge.ca.cert });
    assert.equal(r.status, 200); const value = JSON.parse(r.body); assert.equal(typeof value.data, 'string');
    if (r.headers['x-prism-bridge-source'] === 'mcim-project-summary') assert(value.data.includes('Project summary only'));
    return { source: r.headers['x-prism-bridge-source'], characters: value.data.length };
  });
  await check('MCIM CurseForge thumbnail via verified CONNECT TLS', async () => {
    const r = await viaProxy(bridge.port, 'https://media.forgecdn.net/avatars/thumbnails/29/69/256/256/635838945588716414.jpeg', { ca: bridge.ca.cert });
    assert.equal(r.status, 200); assert.equal(r.headers['x-prism-bridge-source'], 'mcim');
    assert(r.body.length > 100); assert(r.body.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) || r.body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
    return { bytes: r.body.length, sha256: createHash('sha256').update(r.body).digest('hex') };
  });
  await check('MCIM Modrinth JAR download and SHA512/SHA1', async () => {
    assert(versions?.length); const file = versions[0].files.find(f => f.primary) || versions[0].files[0];
    const r = await viaProxy(bridge.port, file.url, { ca: bridge.ca.cert }); assert.equal(r.status, 200, r.body.toString().slice(0, 100));
    assert.equal(r.headers['x-prism-bridge-source'], 'mcim');
    assert.equal(createHash('sha512').update(r.body).digest('hex'), file.hashes.sha512);
    assert.equal(createHash('sha1').update(r.body).digest('hex'), file.hashes.sha1);
    return { filename: file.filename, bytes: r.body.length, sha1: file.hashes.sha1 };
  });
  await check('MCIM CurseForge JAR download and SHA1', async () => {
    assert(cfFile?.downloadUrl); const url = new URL(cfFile.downloadUrl);
    assert.equal(url.hostname, 'edge.forgecdn.net', 'Chosen test file must use the documented MCIM edge CDN route');
    const r = await viaProxy(bridge.port, url.href, { ca: bridge.ca.cert }); assert.equal(r.status, 200, r.body.toString().slice(0, 100));
    const expected = cfFile.hashes.find(h => h.algo === 1).value;
    assert.equal(createHash('sha1').update(r.body).digest('hex'), expected); assert.equal(r.body.length, cfFile.fileLength);
    assert.equal(r.headers['x-prism-bridge-source'], 'mcim'); return { filename: cfFile.fileName, bytes: r.body.length, sha1: expected };
  });
  await check('BMCL Windows native JAR and SHA1', async () => {
    assert(graphics); const lib = graphics.libraries.find(l => /natives-windows:/.test(l.name) && l.downloads?.artifact?.url.startsWith(config.bmcl));
    assert(lib); const file = lib.downloads.artifact; const body = await bridge.t.bytes(file.url);
    assert.equal(createHash('sha1').update(body).digest('hex'), file.sha1); assert.equal(body.length, file.size);
    return { library: lib.name, bytes: body.length, sha1: file.sha1 };
  });
  await check('Prism Linux GLFW compatibility JAR and SHA1', async () => {
    assert(graphics); const file = graphics.libraries.find(l => l.name === 'org.lwjgl:lwjgl-glfw-natives-linux:3.3.2-lwjgl.1')?.downloads?.artifact;
    assert(file, 'Required native compatibility replacement is missing');
    const body = await bridge.t.bytes(file.url); assert.equal(createHash('sha1').update(body).digest('hex'), file.sha1); assert.equal(body.length, file.size);
    return { library: 'org.lwjgl:lwjgl-glfw-natives-linux:3.3.2-lwjgl.1', bytes: body.length, sha1: file.sha1 };
  });
  await check('BMCL asset index and asset content SHA1', async () => {
    assert(vanilla); const info = vanilla.assetIndex, data = await bridge.t.bytes(info.url);
    assert.equal(createHash('sha1').update(data).digest('hex'), info.sha1);
    const entries = Object.entries(JSON.parse(data).objects), [name, entry] = entries.find(([, v]) => v.size > 0 && v.size < 16384);
    const r = await viaProxy(bridge.port, 'https://resources.download.minecraft.net/' + entry.hash.slice(0, 2) + '/' + entry.hash, { ca: bridge.ca.cert });
    assert.equal(r.status, 200); assert.equal(createHash('sha1').update(r.body).digest('hex'), entry.hash);
    return { asset: name, bytes: r.body.length, sha1: entry.hash };
  });
  if (!process.argv.includes('--quick')) await check('BMCL Minecraft client JAR download and SHA1', async () => {
    assert(vanilla); const info = vanilla.mainJar.downloads.artifact, body = await bridge.t.bytes(info.url, { maxBytes: 64 * 1024 * 1024 });
    assert.equal(createHash('sha1').update(body).digest('hex'), info.sha1); assert.equal(body.length, info.size);
    return { bytes: body.length, sha1: info.sha1 };
  });
  await check('Mainstream components do not use Prism metadata recipes', async () => { assert.equal(bridge.stats.compatibilityRecipes, 0); return { compatibilityRequests: bridge.stats.compatibilityRecipes }; });
} finally {
  report.counts = { ...bridge.stats }; report.finishedAt = new Date().toISOString(); report.passed = report.tests.every(t => t.passed);
  await bridge.close(); await rm(dir, { recursive: true, force: true });
  await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(join(root, 'test-results/live-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.tests.filter(t => t.passed).length}/${report.tests.length} live checks passed.`);
  if (!report.passed) process.exitCode = 1;
}
