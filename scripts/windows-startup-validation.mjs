// Diagnostic only: run released production code, never pretend that an expected
// HTTP 501 has been fixed. No accounts or existing user data are used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { VERSION } from '../src/version.mjs';

assert.equal(process.platform, 'win32', 'This diagnostic requires actual Windows');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'Prism Windows cold start '));
const report = { bridgeVersion: VERSION, platform: process.platform, architecture: process.arch,
  windows: (await import('node:os')).release(), node: process.version,
  productionChanged: false, compatibilityRecipes: false, freshDataDirectory: true,
  fullGameLaunchVerified: false, userMachineVerified: false, probes: [] };
const cfg = loadConfig(join(root, 'config.json'));
Object.assign(cfg, { dataDir: join(temporary, 'bridge'), port: 0, retries: 0, timeoutMs: 15000 });
const bridge = await new Bridge(cfg, { log: line => console.log(line) }).start();
const observed = [];
const originalRequest = bridge.meta.request.bind(bridge.meta);
bridge.meta.request = async path => {
  try { const value = await originalRequest(path); observed.push({ path, status: 200 }); return value; }
  catch (error) { observed.push({ path, status: error.status || 502 }); throw error; }
};
let prism, ui;
const hash = data => createHash('sha256').update(data).digest('hex');
async function probe(path, status) {
  const response = await fetch(`http://127.0.0.1:${bridge.port}/meta/v1/${path}`, { signal: AbortSignal.timeout(45000) });
  const body = await response.json();
  report.probes.push({ path, status: response.status });
  assert.equal(response.status, status, path);
  return body;
}
async function findExecutable(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === 'prismlauncher.exe') return path;
    if (entry.isDirectory()) { const found = await findExecutable(path); if (found) return found; }
  }
}
try {
  await probe('net.minecraft.java/index.json', 501);
  await probe('net.minecraft.java/java21.json', 501);
  await probe('org.lwjgl3/3.3.3.json', 501);
  try {
    await probe('net.minecraft/1.21.1.json', 200);
    const graphics = await probe('org.lwjgl3/bridge-1.21.1.json', 200);
    const native = graphics.libraries.find(l => /natives-windows:/.test(l.name))?.downloads?.artifact;
    assert(native?.url && native.sha1, 'Missing Windows native library');
    const bytes = await bridge.t.bytes(native.url, { maxBytes: 8 * 1024 * 1024, signal: AbortSignal.timeout(45000) });
    assert.equal(createHash('sha1').update(bytes).digest('hex'), native.sha1);
    assert.equal(bytes.length, native.size);
    report.windowsNativeDownload = { bytes: bytes.length, checksumValid: true };
  } catch (error) {
    report.liveMirrorFailure = error.message;
    console.log('LIVE MIRROR FAILURE ' + error.message);
  }
  const download = 'https://github.com/PrismLauncher/PrismLauncher/releases/download/11.1.1/PrismLauncher-Windows-MinGW-w64-Portable-11.1.1.zip';
  const response = await fetch(download, { signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = '05841d0b3bfc0a8212658457cc6035e1c29cd7ffae919464e874e384cbe8d062';
  assert.equal(hash(bytes), digest, 'Official Prism distribution checksum');
  report.prism = { version: '11.1.1', officialZipSHA256: digest, checksumValid: true };
  const archive = join(temporary, 'prism.zip'), installation = join(temporary, 'launcher');
  await writeFile(archive, bytes);
  const expanded = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Expand-Archive -LiteralPath $env:BRIDGE_PROBE_ARCHIVE -DestinationPath $env:BRIDGE_PROBE_INSTALL'],
    { env: { ...process.env, BRIDGE_PROBE_ARCHIVE: archive, BRIDGE_PROBE_INSTALL: installation }, encoding: 'utf8', timeout: 60000 });
  assert.equal(expanded.status, 0, expanded.stdout + expanded.stderr);
  const executable = await findExecutable(installation); assert(executable);
  const data = join(temporary, 'Fresh Prism Data');
  const instance = join(data, 'instances', 'ColdStart501');
  await mkdir(instance, { recursive: true });
  await writeFile(join(data, 'prismlauncher.cfg'), `[General]\nLanguage=en_US\nApplicationTheme=bright\nIconTheme=flat\nAutomaticJavaDownload=true\nAutomaticJavaSwitch=true\nUserAskedAboutAutomaticJavaDownload=true\nIgnoreJavaWizard=true\nMetaURLOverride=http://127.0.0.1:${bridge.port}/meta/v1/\nProxyType=HTTP\nProxyAddr=127.0.0.1\nProxyPort=${bridge.port}\nCheckUpdateOnStart=false\n`);
  await writeFile(join(instance, 'instance.cfg'), '[General]\nInstanceType=OneSix\nname=ColdStart501\n');
  await writeFile(join(instance, 'mmc-pack.json'), JSON.stringify({ formatVersion: 1, components: [
    { uid: 'net.minecraft', version: '1.21.1', important: true },
    { uid: 'org.lwjgl3', version: 'bridge-1.21.1', dependencyOnly: true },
  ] }));
  const probeCount = observed.length;
  prism = spawn(executable, ['--dir', data, '--launch', 'ColdStart501'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let prismOutput = ''; prism.stdout.on('data', b => { prismOutput += b; }); prism.stderr.on('data', b => { prismOutput += b; });
  let uiOutput = '';
  ui = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts/windows-startup-ui.ps1'), '-PrismProcessId', String(prism.pid), '-Seconds', '150'], { stdio: ['ignore', 'pipe', 'pipe'] });
  ui.stdout.on('data', b => { uiOutput += b; }); ui.stderr.on('data', b => { uiOutput += b; });
  for (let step = 0; step < 160; step++) {
    if (observed.slice(probeCount).some(r => r.path === 'net.minecraft.java/index.json' && r.status === 501)) break;
    if (prism.exitCode !== null) break;
    await delay(1000);
  }
  report.actualPrismRequests = observed.slice(probeCount);
  report.prismJava501Reproduced = report.actualPrismRequests.some(r => r.path === 'net.minecraft.java/index.json' && r.status === 501);
  report.ui = uiOutput.slice(-18000);
  try {
    const files = await readdir(join(data, 'logs'));
    report.prismLogEvidence = [];
    for (const name of files.filter(n => /^PrismLauncher-\d+\.log$/.test(n)).slice(0, 3)) {
      const log = await readFile(join(data, 'logs', name), 'utf8');
      const relevant = log.split(/\r?\n/).filter(line => /501|net\.minecraft\.java|ColdStart501|MinecraftLoadAndCheck|AutoInstallJava/.test(line));
      report.prismLogEvidence.push(...relevant.map(line => line.replaceAll(temporary, '<TEMP>')));
    }
  } catch {}
  // A green diagnostic run means its assertions ran; the booleans above are
  // the evidence. A non-reproduced GUI scenario must remain visibly failed.
  assert(report.prismJava501Reproduced, 'Official Windows Prism did not reach the Java 501; inspect UI evidence, no reproduction claimed');
  report.diagnosticPassed = true;
} catch (error) {
  report.diagnosticPassed = false; report.failure = error.message; process.exitCode = 1;
} finally {
  for (const child of [ui, prism]) if (child?.pid && child.exitCode === null)
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000, stdio: 'ignore' });
  await bridge.close();
  await writeFile(join(root, 'test-results/windows-cold-start-501.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('WINDOWS_COLD_START_REPORT ' + JSON.stringify(report));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}
