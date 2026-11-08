import test from 'node:test';
import assert from 'node:assert/strict';
import { MetadataService } from '../src/metadata.mjs';
import { INTERCEPT_HOSTS, mirrorURL } from '../src/routing.mjs';
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
