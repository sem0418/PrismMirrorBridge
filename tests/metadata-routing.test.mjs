import test from 'node:test';
import assert from 'node:assert/strict';
import { MetadataService } from '../src/metadata.mjs';
import { INTERCEPT_HOSTS, mirrorURL } from '../src/routing.mjs';
import { readFile } from 'node:fs/promises';
function service() {
  const s = new MetadataService({ cacheSeconds: 60 }, {});
  s.component = async (uid, version) => ({ uid, version }); return s;
}
test('Prism metadata protocol accepts encoded Mojang version IDs containing spaces', async () => {
  const s = service();
  assert.deepEqual(await s.request('net.minecraft/3D%20Shareware%20v1.34.json'), { uid: 'net.minecraft', version: '3D Shareware v1.34' });
  assert.deepEqual(await s.request('net.minecraft/1.14%20Pre-Release%205.json'), { uid: 'net.minecraft', version: '1.14 Pre-Release 5' });
});
test('encoded separators, control bytes and nested escapes never become upstream metadata paths', async () => {
  const s = service();
  for (const name of ['bad%2fpath', 'bad%5cpath', 'bad%00name', 'bad%252fpath', '%2e%2e', 'invalid%xx'])
    await assert.rejects(() => s.request('net.minecraft/' + name + '.json'));
});
test('LegacyFTB keeps both original HTTPS URLs outside certificate replacement and mirror routing', () => {
  assert.equal(INTERCEPT_HOSTS.has('dist.creeper.host'), false);
  for (const name of ['thirdparty.xml', 'modpacks.xml']) {
    const url = 'https://dist.creeper.host/FTB2/static/' + name;
    assert.equal(mirrorURL(url, { mcim: 'https://mirror.invalid', bmcl: 'https://mirror.invalid' }), url);
  }
});
test('a fresh official LWJGL 3.3.3 selection resolves from BMCL before any Minecraft component has warmed its aliases', async () => {
  const raw = JSON.parse(await readFile(new URL('./fixtures/bmcl-vanilla.json', import.meta.url)));
  raw.id = '1.21.1';
  for (const lib of raw.libraries) if (lib.name.startsWith('org.lwjgl:')) lib.name = lib.name.replace(':3.3.1', ':3.3.3');
  const config = { bmcl: 'https://bmcl.example', cacheSeconds: 60, compatibilityRecipes: false }, calls = [];
  const s = new MetadataService(config, { json: async url => {
    calls.push(url);
    if (url.endsWith('version_manifest_v2.json')) return { versions: [{ id: '1.21.1', releaseTime: raw.releaseTime }] };
    if (url.endsWith('/version/1.21.1/json')) return structuredClone(raw);
    throw new Error('Unexpected upstream route');
  } });
  const value = await s.request('org.lwjgl3/3.3.3.json');
  assert.equal(value.version, '3.3.3'); assert.equal(value.uid, 'org.lwjgl3');
  assert(value.libraries.some(l => l.name === 'org.lwjgl:lwjgl:3.3.3'));
  assert(calls.every(url => new URL(url).origin === 'https://bmcl.example'));
});
