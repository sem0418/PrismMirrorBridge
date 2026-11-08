import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGeneral, patchGeneral, configurePrism, restorePrism } from '../src/prism-config.mjs';

test('INI patching preserves unrelated content, sections, BOM and Windows newlines', () => {
  const original = '\uFEFF[General]\r\nLanguage=zh_CN\r\n# comment\r\nProxyType=SOCKS5\r\nProxyType=None\r\n[Other]\r\nProxyType=unchanged\r\n';
  const changed = patchGeneral(original, { ProxyType: 'HTTP', ProxyPort: '17643', Absent: null });
  assert(changed.startsWith('\uFEFF')); assert(changed.includes('Language=zh_CN\r\n# comment'));
  assert(changed.includes('[Other]\r\nProxyType=unchanged')); assert.equal(getGeneral(changed).ProxyType, 'HTTP');
  assert.equal(changed.match(/ProxyType=HTTP/g).length, 1); assert(changed.includes('ProxyPort=17643\r\n[Other]'));
});
test('configure is repeatable and restore preserves later unrelated settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-config-'));
  try {
    const file = join(dir, 'prismlauncher.cfg');
    writeFileSync(file, '[General]\nLanguage=zh_CN\nProxyType=SOCKS5\nProxyPort=1080\nResourceURL=old\n[Accounts]\nmarker=untouched\n');
    configurePrism(file, { port: 17643 }); configurePrism(file, { port: 17643 });
    const value = getGeneral(readFileSync(file, 'utf8')); assert.equal(value.ProxyType, 'HTTP'); assert.equal(value.ResourceURL, undefined);
    writeFileSync(file, readFileSync(file, 'utf8').replace('Language=zh_CN', 'Language=en_US'));
    restorePrism(file);
    const restored = readFileSync(file, 'utf8'), parsed = getGeneral(restored);
    assert.equal(parsed.ProxyType, 'SOCKS5'); assert.equal(parsed.ProxyPort, '1080'); assert.equal(parsed.MetaURLOverride, undefined);
    assert.equal(parsed.ResourceURL, 'old'); assert.equal(parsed.Language, 'en_US'); assert(restored.includes('[Accounts]\nmarker=untouched'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('restore refuses a backup referring to a different configuration file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-restore-'));
  try {
    const file = join(dir, 'prismlauncher.cfg'); writeFileSync(file, '[General]\n');
    writeFileSync(file + '.bridge-backup.json', JSON.stringify({ owner: 'PrismMirrorBridge/1', file: 'different', values: {} }));
    assert.throws(() => restorePrism(file), /does not match/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
