import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convertMinecraft, convertFabric, convertForge, mavenPath, gameArguments, timestamp } from '../src/converters.mjs';
import { mirrorURL, rewriteGameURLs, normalizeModJSON, sanitizedHeaders } from '../src/routing.mjs';
import { adaptModRequest } from '../src/mod-adapter.mjs';
import { zipJSON } from '../src/zip.mjs';
import { forgeMavenEntry, neoMinecraftVersion } from '../src/metadata.mjs';
const fixture = name => JSON.parse(readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url)));
const config = { bmcl: 'https://bmcl.example', mcim: 'https://mcim.example' };

function componentSchema(value) {
  assert.equal(value.formatVersion, 1); assert.equal(typeof value.uid, 'string'); assert.equal(typeof value.version, 'string');
  assert(Number.isFinite(Date.parse(value.releaseTime))); assert(Number.isInteger(value.order));
  for (const lib of [...(value.libraries || []), ...(value.mavenFiles || []), ...(value.mainJar ? [value.mainJar] : [])]) {
    assert.equal(typeof lib.name, 'string'); assert(lib.name.split(':').length >= 3);
    for (const a of [lib.downloads?.artifact, ...Object.values(lib.downloads?.classifiers || {})]) if (a) {
      assert.equal(typeof a.sha1, 'string'); assert.equal(typeof a.url, 'string'); assert(Number.isInteger(a.size));
    }
  }
}
test('real BMCL Minecraft 1.20.1 converts to Prism components and preserves checksums', () => {
  const raw = fixture('bmcl-vanilla'), { minecraft: mc, graphics } = convertMinecraft(raw, config);
  componentSchema(mc); componentSchema(graphics);
  assert.equal(mc.mainClass, 'net.minecraft.client.main.Main'); assert.deepEqual(mc.compatibleJavaMajors, [17]);
  assert.equal(mc.mainJar.downloads.artifact.sha1, raw.downloads.client.sha1);
  assert.equal(mc.mainJar.downloads.artifact.size, raw.downloads.client.size);
  assert.match(mc.mainJar.downloads.artifact.url, /^https:\/\/bmcl\.example\//);
  assert.equal(mc.assetIndex.sha1, raw.assetIndex.sha1); assert.equal(mc.requires[0].suggests, 'bridge-1.20.1');
  assert.equal(graphics.version, 'bridge-1.20.1'); assert.equal(graphics.uid, 'org.lwjgl3');
  assert(mc['+traits'].includes('FirstThreadOnMacOS')); assert(mc['+traits'].includes('feature:is_quick_play_multiplayer'));
  assert(!mc.minecraftArguments.includes('--clientId')); assert(!mc.minecraftArguments.includes('--xuid')); assert(!mc.minecraftArguments.includes('[object Object]'));
  assert(!mc.libraries.some(l => l.name.startsWith('org.lwjgl:')));
  const windows = graphics.libraries.filter(l => /natives-windows/.test(l.name)); assert(windows.length > 0);
  assert(graphics.libraries.some(l => /natives-macos-arm64/.test(l.name) && l.rules.some(r => r.os?.name === 'osx-arm64')));
});
test('real BMCL Minecraft 1.5.2 retains legacy launch traits and LWJGL 2', () => {
  const { minecraft, graphics } = convertMinecraft(fixture('bmcl-old'), config);
  componentSchema(minecraft); componentSchema(graphics);
  assert(minecraft['+traits'].includes('legacyLaunch')); assert(minecraft['+traits'].includes('texturepacks'));
  assert.equal(graphics.uid, 'org.lwjgl'); assert.equal(minecraft.requires[0].uid, 'org.lwjgl');
});
test('upstream Linux GLFW compatibility fix is applied after split-native artifact naming', () => {
  const { graphics } = convertMinecraft(fixture('bmcl-vanilla'), config);
  const fixed = graphics.libraries.find(l => l.name === 'org.lwjgl:lwjgl-glfw-natives-linux:3.3.2-lwjgl.1');
  assert(fixed, 'The GLFW stack-smashing fix must survive the conversion');
  assert.equal(fixed.downloads.artifact.sha1, '0766bb0e8e829598b1c8052fd8173c62af741c52');
  assert.equal(fixed.downloads.artifact.size, 115553);
  assert(!graphics.libraries.some(l => l.name === 'org.lwjgl:lwjgl-glfw-natives-linux:3.3.1'));
});
test('Fabric installer metadata converts libraries and preserves intermediary dependency', () => {
  const value = convertFabric(fixture('fabric-details'), '0.16.14', config);
  componentSchema(value); assert.equal(value.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
  assert.deepEqual(value.requires, [{ uid: 'net.fabricmc.intermediary' }]);
  assert(value.libraries.some(l => l.name === 'net.fabricmc:fabric-loader:0.16.14'));
  const asm = value.libraries.find(l => l.name === 'org.ow2.asm:asm:9.8'); assert.equal(asm.downloads.artifact.size, 126113);
  assert(asm.downloads.artifact.url.startsWith(config.bmcl + '/maven/'));
});
test('real Quilt installer uses Quilt main class and Fabric mappings', () => {
  const value = convertFabric(fixture('quilt-installer'), '0.23.0', config, true);
  componentSchema(value); assert.match(value.mainClass, /quiltmc/);
  assert.deepEqual(value.requires, [{ uid: 'net.fabricmc.intermediary' }]);
  assert(value.libraries.some(l => l.name === 'org.quiltmc:quilt-loader:0.23.0'));
});
test('Forge installer preserves processor libraries and supplies ForgeWrapper', () => {
  const profile = fixture('forge-installer-profile'), v = fixture('forge-installer-version');
  const value = convertForge({ profile, versionManifest: v, installer: Buffer.from('installer test bytes'), installerURL: config.bmcl + '/installer.jar',
    version: '47.3.0', minecraft: '1.20.1', fullVersion: '1.20.1-47.3.0' }, config);
  componentSchema(value); assert.match(value.mainClass, /forgewrapper/); assert.match(value.minecraftArguments, /--launchTarget forgeclient/);
  assert(value.mavenFiles.length >= profile.libraries.length); assert(value.mavenFiles[0].downloads.artifact.sha1.length === 40);
  assert(!value.libraries.some(l => l.downloads?.artifact?.url === ''));
  assert.deepEqual(value.requires, [{ uid: 'net.minecraft', equals: '1.20.1' }]);
});
test('NeoForge installer produces a Prism patch with the matching game version', () => {
  const value = convertForge({ profile: fixture('neo-installer-profile'), versionManifest: fixture('neo-installer-version'),
    installer: Buffer.from('neo installer'), installerURL: config.bmcl + '/neo.jar', version: '21.1.1', minecraft: '1.21.1', fullVersion: '21.1.1', neo: true }, config);
  componentSchema(value); assert.equal(value.uid, 'net.neoforged'); assert.equal(value.mavenFiles[0].name, 'net.neoforged:neoforge:21.1.1:installer');
  assert(value.minecraftArguments.includes('--fml.neoForgeVersion 21.1.1')); assert.match(value.releaseTime, /Z$/);
});
test('Forge 1.12.2 modernized installer maps its empty artifact URL to the universal JAR', () => {
  const value = convertForge({ profile: fixture('forge-old-profile'), versionManifest: fixture('forge-old-version'),
    installer: Buffer.from('old installer'), installerURL: config.bmcl + '/old.jar', version: '14.23.5.2860', minecraft: '1.12.2', fullVersion: '1.12.2-14.23.5.2860' }, config);
  componentSchema(value);
  const forge = value.libraries.find(l => l.name.startsWith('net.minecraftforge:forge:'));
  assert.equal(forge.name, 'net.minecraftforge:forge:1.12.2-14.23.5.2860:universal');
  assert(forge.downloads.artifact.url.endsWith('-universal.jar')); assert(forge.downloads.artifact.url.startsWith(config.bmcl));
  assert.equal(forge.downloads.artifact.sha1, '029250575d3aa2cf80b56dffb66238a1eeaea2ac');
  assert.deepEqual(value['+tweakers'], ['net.minecraftforge.fml.common.launcher.FMLTweaker']);
  assert.equal(value.minecraftArguments, undefined);
});
test('unsupported future compliance levels fail explicitly', () => {
  const raw = fixture('bmcl-vanilla'); raw.complianceLevel = 99; assert.throws(() => convertMinecraft(raw, config), /complianceLevel/);
});
test('conditional game arguments become supported Prism traits, not unconditional flags', () => {
  const value = gameArguments(fixture('bmcl-vanilla'));
  assert(!value.args.includes('--demo')); assert(!value.args.includes('--quickPlaySingleplayer')); assert(value.traits.includes('feature:is_quick_play_singleplayer'));
});
test('URL routing uses complete hostnames and MCIM mediafilez exception', () => {
  const cases = [
    ['https://piston-data.mojang.com/v1/objects/a/client.jar', config.bmcl + '/v1/objects/a/client.jar'],
    ['https://resources.download.minecraft.net/ab/abc', config.bmcl + '/assets/ab/abc'],
    ['https://maven.neoforged.net/releases/net/n/a.jar', config.bmcl + '/maven/net/n/a.jar'],
    ['https://maven.quiltmc.org/repository/release/org/q/a.jar', config.bmcl + '/maven/org/q/a.jar'],
    ['https://api.modrinth.com/v2/search?query=a%2Bb', config.mcim + '/modrinth/v2/search?query=a%2Bb'],
    ['https://edge.forgecdn.net/files/12/34/a.jar', config.mcim + '/files/12/34/a.jar'],
    ['https://media.forgecdn.net/avatars/thumbnails/29/69/256/256/logo.jpeg', config.mcim + '/avatars/thumbnails/29/69/256/256/logo.jpeg'],
    ['https://mediafilez.forgecdn.net/files/12/34/a.jar', 'https://mediafilez.forgecdn.net/files/12/34/a.jar'],
    ['https://api.modrinth.com.evil.example/v2/a', 'https://api.modrinth.com.evil.example/v2/a'],
    ['https://login.microsoftonline.com/a?token=secret', 'https://login.microsoftonline.com/a?token=secret'],
  ];
  for (const [input, expected] of cases) assert.equal(mirrorURL(input, config), expected);
});
test('MCIM Modrinth file URLs retain the canonical identity required by Prism', () => {
  const v = normalizeModJSON({ files: [{ url: config.mcim + '/data/AA/versions/BB/file.jar', hashes: { sha1: 'abc' } }], sync_at: 'date' }, 'modrinth', config.mcim);
  assert.equal(v.files[0].url, 'https://cdn.modrinth.com/data/AA/versions/BB/file.jar'); assert.equal(v.files[0].hashes.sha1, 'abc'); assert(!('sync_at' in v));
});
test('Prism CurseForge string IDs become MCIM integer arrays without modifying Modrinth hashes', () => {
  const body = Buffer.from('{"modIds":["238222",306612],"filterPcOnly":true}');
  assert.deepEqual(JSON.parse(adaptModRequest('curseforge', body)), { modIds: [238222, 306612], filterPcOnly: true });
  assert.deepEqual(JSON.parse(adaptModRequest('curseforge', Buffer.from('{"fileIds":["123"]}'))), { fileIds: [123] });
  assert.deepEqual(JSON.parse(adaptModRequest('modrinth', Buffer.from('{"hashes":["001122"]}'))), { hashes: ['001122'] });
});
test('invalid bulk IDs and invalid JSON are rejected', () => {
  for (const payload of ['{"fileIds":["2x"]}', '{"fileIds":[null]}', '{"modIds":[2147483648]}', '{', '[]'])
    assert.throws(() => adaptModRequest('curseforge', Buffer.from(payload)));
});
test('mirror request headers exclude credentials and HTTP hop headers', () => {
  const out = sanitizedHeaders({ host: 'x', authorization: 'token', cookie: 'session', 'x-api-key': 'secret', 'proxy-authorization': 'secret',
    connection: 'X-Hop', 'x-hop': '1', range: 'bytes=0-9', 'if-range': 'etag' }, { mirror: true });
  assert.deepEqual(out, { range: 'bytes=0-9', 'if-range': 'etag' });
});
test('Maven coordinate paths and timestamp normalization', () => {
  assert.equal(mavenPath('net.minecraftforge:forge:1.20.1-47.3.0:installer'), 'net/minecraftforge/forge/1.20.1-47.3.0/forge-1.20.1-47.3.0-installer.jar');
  assert.throws(() => mavenPath('a:b:../bad'));
  assert.equal(timestamp('2024-08-08T18:12:09.387636363'), '2024-08-08T18:12:09.387Z');
});
test('ZIP parser rejects truncated/untrusted input', () => {
  assert.throws(() => zipJSON(Buffer.from('not a jar'), 'install_profile.json'), /ZIP/);
});
test('legacy Forge branch coordinates retain plain Prism component version IDs', () => {
  const v = forgeMavenEntry('1.7.10-10.13.4.1614-1.7.10');
  assert.equal(v.version, '10.13.4.1614'); assert.equal(v.fullVersion, '1.7.10-10.13.4.1614-1.7.10'); assert.equal(v.minecraft, '1.7.10');
  assert.equal(forgeMavenEntry('1.7.10_pre4-10.12.2.1149-prerelease').minecraft, '1.7.10-pre4');
});
test('NeoForge 26.x coordinates resolve Minecraft release, snapshot and prerelease names', () => {
  for (const [version, expected] of [['21.1.1', '1.21.1'], ['20.2.42-beta', '1.20.2'], ['26.1.2.126', '26.1.2'],
    ['26.3.0.101', '26.3'], ['26.1.0.0-alpha.1+snapshot-1', '26.1-snapshot-1'], ['26.1.0.0-alpha.15+pre-3', '26.1-pre-3']])
    assert.equal(neoMinecraftVersion(version), expected);
});
