import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { configurePrism, repairPrismMetadata, restorePrism, getGeneral, BRIDGE_KEYS } from '../src/prism-config.mjs';
import { assertPrismClosed } from '../src/prism-metadata-state.mjs';

const closed = () => {};
const config = { port: 17643 };
const source = 'http://127.0.0.1:17643/meta/v1/';
function fixture(t, legacy = false) {
  const root = fs.mkdtempSync(join(tmpdir(), 'Prism state 测试 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'prismlauncher.cfg'), backup = file + '.bridge-backup.json';
  const original = '[General]\r\nLanguage=zh_CN\r\nProxyType=SOCKS5\r\nProxyPort=1080\r\nKeep=value\r\n';
  fs.writeFileSync(file, legacy ? original + `MetaURLOverride=${source}\r\n` : original);
  const meta = join(root, 'meta'); fs.mkdirSync(join(meta, 'net.neoforged'), { recursive: true });
  const index = JSON.stringify({ formatVersion: 1, uid: 'net.neoforged', versions: [{ version: '21.1.265', releaseTime: '1970-01-01T00:00:00+00:00' }] });
  fs.writeFileSync(join(meta, 'net.neoforged/index.json'), index);
  fs.writeFileSync(join(meta, 'net.neoforged/21.1.259.json'), 'preserved old component');
  fs.writeFileSync(join(meta, 'net.neoforged/21.1.265.json.part'), Buffer.alloc(36042, 65));
  for (const [name, content] of [['instances/a/mods/keep.jar', 'mod'], ['accounts.json', 'test account sentinel'], ['assets/keep', 'asset']]) {
    const p = join(root, name); fs.mkdirSync(join(p, '..'), { recursive: true }); fs.writeFileSync(p, content);
  }
  if (legacy) fs.writeFileSync(backup, JSON.stringify({ owner: 'PrismMirrorBridge/1', file,
    createdAt: '2000-01-01T00:00:00.000Z', values: Object.fromEntries(BRIDGE_KEYS.map(k => [k, getGeneral(original)[k] ?? null])) }));
  return { root, file, backup, meta, original, index, read: () => JSON.parse(fs.readFileSync(backup, 'utf8')) };
}
function untouched(f) {
  assert.equal(fs.readFileSync(join(f.root, 'instances/a/mods/keep.jar'), 'utf8'), 'mod');
  assert.equal(fs.readFileSync(join(f.root, 'accounts.json'), 'utf8'), 'test account sentinel');
  assert.equal(fs.readFileSync(join(f.root, 'assets/keep'), 'utf8'), 'asset');
}
function populate(meta, value = 'bridge cache') { fs.mkdirSync(meta, { recursive: true }); fs.writeFileSync(join(meta, 'marker'), value); }

test('legacy hashless disk index and partial component are preserved as evidence during repair', t => {
  const f = fixture(t, true), old = f.read();
  assert(!fs.readFileSync(join(f.meta, 'net.neoforged/index.json'), 'utf8').includes('sha256'));
  const result = repairPrismMetadata(f.file, config, { checkClosed: closed });
  assert(result.metadata.migrated); assert(!fs.existsSync(f.meta));
  const saved = f.read(), archived = join(f.root, saved.metadataState.archives[0]);
  assert.deepEqual(saved.values, old.values); assert.equal(saved.createdAt, old.createdAt);
  assert.equal(saved.metadataState.originalCache, null);
  assert.equal(fs.readFileSync(join(archived, 'net.neoforged/index.json'), 'utf8'), f.index);
  assert.equal(fs.readFileSync(join(archived, 'net.neoforged/21.1.259.json'), 'utf8'), 'preserved old component');
  assert.equal(fs.statSync(join(archived, 'net.neoforged/21.1.265.json.part')).size, 36042);
  untouched(f);
});
test('running Prism prevents repair and restore before any disk mutation', t => {
  const f = fixture(t, true), before = fs.readFileSync(f.file), backup = fs.readFileSync(f.backup);
  const checkClosed = () => { throw new Error('Prism is still running'); };
  for (const operation of [() => repairPrismMetadata(f.file, config, { checkClosed }), () => restorePrism(f.file, { checkClosed })]) {
    assert.throws(operation, /still running/);
    assert.deepEqual(fs.readFileSync(f.file), before); assert.deepEqual(fs.readFileSync(f.backup), backup);
    assert(fs.existsSync(join(f.meta, 'net.neoforged/21.1.265.json.part')));
  }
  assert.equal(fs.readdirSync(f.root).filter(n => n.startsWith('meta.prism-bridge-')).length, 0);
});
test('first setup archives metadata once, and undo restores the exact original snapshot', t => {
  const f = fixture(t);
  const first = configurePrism(f.file, config, { checkClosed: closed });
  const state = f.read().metadataState; assert(state.originalCache); assert.equal(state.archives.length, 1);
  populate(f.meta);
  const again = configurePrism(f.file, config, { checkClosed: closed });
  assert.equal(again.metadata.migrated, false); assert.equal(f.read().metadataState.archives.length, 1);
  assert.equal(fs.readFileSync(join(f.meta, 'marker'), 'utf8'), 'bridge cache');
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('Keep=value', 'Keep=changed-later'));
  const undo = restorePrism(f.file, { checkClosed: closed });
  assert.equal(getGeneral(fs.readFileSync(f.file, 'utf8')).MetaURLOverride, undefined);
  assert.equal(getGeneral(fs.readFileSync(f.file, 'utf8')).Keep, 'changed-later');
  assert.equal(fs.readFileSync(join(f.meta, 'net.neoforged/index.json'), 'utf8'), f.index);
  assert(!fs.existsSync(first.metadata.archives[0]), 'the original snapshot was moved back to meta');
  untouched(f); assert(fs.existsSync(undo.backup));
});
test('legacy undo retains mixed cache backups and starts the original source with fresh metadata', t => {
  const f = fixture(t, true);
  repairPrismMetadata(f.file, config, { checkClosed: closed }); const first = f.read().metadataState.archives[0];
  populate(f.meta);
  const undone = restorePrism(f.file, { checkClosed: closed });
  assert(!fs.existsSync(f.meta)); assert(fs.existsSync(join(f.root, first, 'net.neoforged/index.json')));
  const saved = JSON.parse(fs.readFileSync(undone.backup, 'utf8'));
  assert.equal(saved.metadataState.archives.length, 2);
  assert.equal(fs.readFileSync(join(f.root, saved.metadataState.archives[1], 'marker'), 'utf8'), 'bridge cache');
  assert.equal(getGeneral(fs.readFileSync(f.file, 'utf8')).ProxyType, 'SOCKS5'); untouched(f);
});
test('explicit repair isolates a later cache even after a successful previous migration', t => {
  const f = fixture(t, true);
  repairPrismMetadata(f.file, config, { checkClosed: closed }); populate(f.meta, 'later cache');
  repairPrismMetadata(f.file, config, { checkClosed: closed });
  assert(!fs.existsSync(f.meta)); const state = f.read().metadataState; assert.equal(state.archives.length, 2);
  assert.equal(fs.readFileSync(join(f.root, state.archives[1], 'marker'), 'utf8'), 'later cache');
});
test('changing the metadata endpoint isolates the active cache without losing the original snapshot', t => {
  const f = fixture(t);
  configurePrism(f.file, config, { checkClosed: closed }); const originalCache = f.read().metadataState.originalCache;
  populate(f.meta);
  configurePrism(f.file, { port: 17644 }, { checkClosed: closed });
  assert.equal(f.read().metadataState.originalCache, originalCache); assert(!fs.existsSync(f.meta));
  restorePrism(f.file, { checkClosed: closed }); assert(fs.existsSync(join(f.meta, 'net.neoforged/21.1.259.json')));
});
test('repair requires the selected Prism to have a matching bridge source and original backup', t => {
  const f = fixture(t);
  assert.throws(() => repairPrismMetadata(f.file, config, { checkClosed: closed }), /requires an existing bridge/);
  assert(!fs.existsSync(f.backup)); assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  configurePrism(f.file, config, { checkClosed: closed });
  assert.throws(() => repairPrismMetadata(f.file, { port: 17644 }, { checkClosed: closed }), /requires an existing bridge/);
});
test('a completed rename before its journal checkpoint resumes without moving or losing data twice', t => {
  const f = fixture(t); let interrupted = false;
  const io = { ...fs, renameSync(from, to) {
    fs.renameSync(from, to);
    if (from === f.meta && !interrupted) { interrupted = true; throw new Error('simulated interruption after directory rename'); }
  } };
  assert.throws(() => configurePrism(f.file, config, { io, checkClosed: closed }), /simulated interruption/);
  assert(f.read().metadataPending); assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  configurePrism(f.file, config, { checkClosed: closed });
  const state = f.read(); assert.equal(state.metadataPending, undefined); assert.equal(state.metadataState.archives.length, 1);
  restorePrism(f.file, { checkClosed: closed }); assert.equal(fs.readFileSync(join(f.meta, 'net.neoforged/index.json'), 'utf8'), f.index);
});
test('a config commit failure can be recovered by undo using the recorded directory moves', t => {
  const f = fixture(t);
  const io = { ...fs, renameSync(from, to) { if (to === f.file) throw new Error('simulated config commit failure'); fs.renameSync(from, to); } };
  assert.throws(() => configurePrism(f.file, config, { io, checkClosed: closed }), /config commit failure/);
  assert(f.read().metadataPending); assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  restorePrism(f.file, { checkClosed: closed });
  assert.equal(fs.readFileSync(join(f.meta, 'net.neoforged/index.json'), 'utf8'), f.index);
  assert.equal(getGeneral(fs.readFileSync(f.file, 'utf8')).ProxyType, 'SOCKS5'); untouched(f);
});
test('conflicting directories after interruption are refused without overwriting either copy', t => {
  const f = fixture(t);
  const io = { ...fs, renameSync(from, to) { fs.renameSync(from, to); if (from === f.meta) throw new Error('interrupted'); } };
  assert.throws(() => configurePrism(f.file, config, { io, checkClosed: closed }), /interrupted/);
  const archived = f.read().metadataPending.moves[0].to; populate(f.meta, 'created by another session');
  assert.throws(() => configurePrism(f.file, config, { checkClosed: closed }), /conflicting/);
  assert.equal(fs.readFileSync(join(f.meta, 'marker'), 'utf8'), 'created by another session');
  assert.equal(fs.readFileSync(join(f.root, archived, 'net.neoforged/index.json'), 'utf8'), f.index);
});
test('a missing original snapshot stops undo before moving the current metadata', t => {
  const f = fixture(t);
  configurePrism(f.file, config, { checkClosed: closed });
  const originalCache = join(f.root, f.read().metadataState.originalCache); fs.renameSync(originalCache, originalCache + '.moved-by-test');
  populate(f.meta); const before = fs.readFileSync(f.file);
  assert.throws(() => restorePrism(f.file, { checkClosed: closed }), /snapshot is missing/);
  assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(fs.readFileSync(join(f.meta, 'marker'), 'utf8'), 'bridge cache');
});
test('undo resumes after restoring the original snapshot but before recording that step', t => {
  const f = fixture(t);
  configurePrism(f.file, config, { checkClosed: closed }); populate(f.meta);
  const fromOriginal = join(f.root, f.read().metadataState.originalCache);
  const io = { ...fs, renameSync(from, to) { fs.renameSync(from, to); if (from === fromOriginal && to === f.meta) throw new Error('interrupted restore'); } };
  assert.throws(() => restorePrism(f.file, { io, checkClosed: closed }), /interrupted restore/);
  const result = restorePrism(f.file, { checkClosed: closed }); assert(fs.existsSync(result.backup));
  assert.equal(fs.readFileSync(join(f.meta, 'net.neoforged/index.json'), 'utf8'), f.index); untouched(f);
});
test('migration journals cannot reference files outside the Prism metadata backup names', t => {
  const f = fixture(t, true); const saved = f.read();
  saved.metadataPending = { operation: 'configure', changes: {}, moves: [{ from: '../instances', to: 'meta', complete: false }],
    nextState: { schema: 1, source, archives: [], originalCache: null, lastOperation: 'configure' } };
  fs.writeFileSync(f.backup, JSON.stringify(saved)); const before = fs.readFileSync(f.file);
  assert.throws(() => configurePrism(f.file, config, { checkClosed: closed }), /Unrecognized pending/);
  assert.deepEqual(fs.readFileSync(f.file), before); untouched(f);
});
test('symbolic-link metadata is refused rather than traversed', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); fs.renameSync(f.meta, f.meta + '-external'); fs.symlinkSync(f.meta + '-external', f.meta);
  assert.throws(() => configurePrism(f.file, config, { checkClosed: closed }), /symbolic links/);
  assert.equal(fs.readFileSync(join(f.meta + '-external', 'net.neoforged/index.json'), 'utf8'), f.index);
});
test('process detection rejects active Prism and unknown detection results on Windows and POSIX', () => {
  assert.throws(() => assertPrismClosed({ platform: 'win32', run: () => ({ status: 3 }) }), /still running/);
  assert.doesNotThrow(() => assertPrismClosed({ platform: 'win32', run: () => ({ status: 0 }) }));
  for (const result of [{ status: 1 }, { status: null, error: new Error('timeout') }])
    assert.throws(() => assertPrismClosed({ platform: 'win32', run: () => result }), /Cannot verify/);
  for (const output of ['prismlauncher\n', '/Applications/PrismLauncher.app/Contents/MacOS/prismlauncher\n', 'PrismLauncher.exe\n'])
    assert.throws(() => assertPrismClosed({ platform: 'linux', run: () => ({ status: 0, stdout: output }) }), /still running/);
  assert.doesNotThrow(() => assertPrismClosed({ platform: 'linux', run: () => ({ status: 0, stdout: 'node\nps\n' }) }));
});
test('direct CLI guard sees a real process named prismlauncher before allowing later setup', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const f = fixture(t); const executable = join(f.root, 'prismlauncher'); fs.symlinkSync(process.execPath, executable);
  const child = spawn(executable, ['-e', "process.title = 'prismlauncher'; process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout, 'data');
    assert.throws(() => configurePrism(f.file, config), /still running/); assert(!fs.existsSync(f.backup));
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  } finally { if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; } }
  assert.doesNotThrow(() => configurePrism(f.file, config));
});
