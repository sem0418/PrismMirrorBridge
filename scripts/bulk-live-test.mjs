// Small, explicit live regression for the reported ATM10 8.5 lookup. Never a CI
// or load test; it uses at most three concurrent /v1/mods calls and no mod JARs.
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { Bridge } from '../src/server.mjs';
import { viaProxy } from './test-client.mjs';
import { VERSION } from '../src/version.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(root, 'tests/fixtures/atm10-8.5-ids.json')));
const config = loadConfig(join(root, 'config.json'));
config.port = 0; config.dataDir = await mkdtemp(join(tmpdir(), 'bridge-bulk-live-'));
const bridge = await new Bridge(config, { log: () => {} }).start();
const report = { startedAt: new Date().toISOString(), version: VERSION, source: fixture.source, environment: process.platform + '/' + process.arch,
  node: process.versions.node, windowsAndPrismRealMachine: '未实机验证', fullModpackImportTested: false, checks: [] };
async function call(path, field, values) {
  const body = Buffer.from(JSON.stringify({ [field]: values.map(String) })); const start = performance.now();
  const r = await viaProxy(bridge.port, 'https://api.curseforge.com/v1/mods' + path, { ca: bridge.ca.cert, method: 'POST', body,
    headers: { 'content-type': 'application/json', 'content-length': body.length }, timeout: 60000 });
  const elapsedMs = Math.round(performance.now() - start); const value = JSON.parse(r.body);
  assert.equal(r.status, 200, JSON.stringify(value)); assert(Array.isArray(value.data));
  return { value, details: { status: r.status, inputIds: values.length, returnedRecords: value.data.length, responseBytes: r.body.length, elapsedMs } };
}
try {
  const files = await call('/files', 'fileIds', fixture.fileIds);
  assert(files.value.data.every(v => fixture.fileIds.includes(v.id))); assert.equal(bridge.stats.bulkModBatches, 0);
  report.checks.push({ endpoint: 'POST /v1/mods/files', ...files.details, passed: true }); console.log(JSON.stringify(report.checks.at(-1)));
  const mods = await call('', 'modIds', fixture.modIds);
  const returned = new Set(mods.value.data.map(v => v.id));
  assert.equal(returned.size, mods.value.data.length); assert(mods.value.data.every(v => fixture.modIds.includes(v.id)));
  assert(mods.details.elapsedMs < 60000); assert(bridge.stats.bulkModBatches > 1);
  report.checks.push({ endpoint: 'POST /v1/mods', ...mods.details, missingIds: fixture.modIds.filter(v => !returned.has(v)), passed: true });
  report.bulkCounts = { ...bridge.stats }; console.log(JSON.stringify(report.checks.at(-1))); console.log(JSON.stringify(report.bulkCounts));
  const sample = await call('', 'modIds', fixture.modIds.slice(0, 10));
  for (const mod of sample.value.data) assert.deepEqual(mods.value.data.find(v => v.id === mod.id), mod);
  report.checks.push({ endpoint: 'POST /v1/mods (10-ID semantic comparison)', ...sample.details, fieldsMatchBatchedResult: true, passed: true });
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; console.error(error.message); }
finally {
  report.finishedAt = new Date().toISOString(); await bridge.close(); await rm(config.dataDir, { recursive: true, force: true });
  await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(join(root, 'test-results/bulk-live-report.json'), JSON.stringify(report, null, 2) + '\n');
}
