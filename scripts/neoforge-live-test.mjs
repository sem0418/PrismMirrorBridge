// A single real component check, not a Windows/Prism or full modpack import.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Bridge } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { VERSION } from '../src/version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'bridge-neo-live-'));
const config = loadConfig(join(root, 'config.json'));
config.dataDir = temporary; config.port = 0; config.retries = 0;
const bridge = await new Bridge(config).start();
const report = { checkedAt: new Date().toISOString(), bridgeVersion: VERSION,
  scope: 'Real BMCL conversion and loopback HTTP; not a launcher import', windowsAndPrismRealMachine: '未实机验证', fullModpackImportTested: false };
try {
  const start = performance.now();
  const response = await fetch(`http://127.0.0.1:${bridge.port}/meta/v1/net.neoforged/21.1.265.json`, { signal: AbortSignal.timeout(90000) });
  assert.equal(response.status, 200);
  const body = Buffer.from(await response.arrayBuffer()), value = JSON.parse(body);
  const snapshot = await readFile(join(root, 'tests/fixtures/neoforge-checksum/bridge-neoforge-component.json'));
  assert.deepEqual(body, snapshot, 'Source-state repair must not fake or alter the known converted component');
  assert.equal(value.uid, 'net.neoforged'); assert.equal(value.version, '21.1.265');
  report.component = { status: response.status, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), durationMs: Math.round(performance.now() - start), unchangedFrom101: true };
  const index = await (await fetch(`http://127.0.0.1:${bridge.port}/meta/v1/net.neoforged/index.json`, { signal: AbortSignal.timeout(20000) })).json();
  const entry = index.versions.find(v => v.version === '21.1.265'); assert(entry); assert.equal(entry.sha256, undefined);
  report.indexEntry = entry; report.stats = bridge.stats; report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await bridge.close(); await rm(temporary, { recursive: true, force: true });
  await writeFile(join(root, 'test-results/neoforge-live-1.0.2.json'), JSON.stringify(report, null, 2) + '\n');
}
