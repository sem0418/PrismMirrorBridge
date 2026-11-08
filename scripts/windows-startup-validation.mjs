// Actual Windows + official Prism diagnostic. --fixed additionally requires a
// complete, hash-verified automatic Java installation and runs its java.exe.
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
const fixed = process.argv.includes('--fixed');
const report = { bridgeVersion: VERSION, platform: process.platform, architecture: process.arch,
  windows: (await import('node:os')).release(), node: process.version,
  mode: fixed ? 'verify-java-fix' : 'reproduce-released-501', compatibilityRecipes: false, freshDataDirectory: true,
  fullGameLaunchVerified: false, userMachineVerified: false, probes: [] };
const cfg = loadConfig(join(root, 'config.json'));
Object.assign(cfg, { dataDir: join(temporary, 'bridge'), port: 0, retries: 0, timeoutMs: 15000 });
let bridge = await new Bridge(cfg, { log: line => console.log(line) }).start();
const observed = [];
function trackRequests(instance) {
  const originalRequest = instance.meta.request.bind(instance.meta);
  instance.meta.request = async path => {
    try { const value = await originalRequest(path); observed.push({ path, status: 200 }); return value; }
    catch (error) { observed.push({ path, status: error.status || 502 }); throw error; }
  };
}
trackRequests(bridge);
let prism, ui, trusted = false;
const hash = data => createHash('sha256').update(data).digest('hex');
function testTrust(add) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop";' +
    '$principal=[System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent());' +
    'if(-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)){throw "Disposable test runner is not elevated"};' +
    '$cert=[System.Security.Cryptography.X509Certificates.X509Certificate2]::new($env:BRIDGE_PROBE_CA);' +
    'if($cert.Subject -notlike "*Prism Mirror Bridge*"){throw "Unexpected test CA"};' +
    '$store=[System.Security.Cryptography.X509Certificates.X509Store]::new("Root","LocalMachine");' +
    '$store.Open("ReadWrite");try{$store.' + (add ? 'Add' : 'Remove') + '($cert)}finally{$store.Close()}'],
    { env: { ...process.env, BRIDGE_PROBE_CA: bridge.ca.certPath }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, 'Isolated disposable Windows runner test certificate operation: ' + result.stdout + result.stderr);
}
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
  await probe('net.minecraft.java/index.json', fixed ? 200 : 501);
  await probe('net.minecraft.java/java21.json', fixed ? 200 : 501);
  await probe('org.lwjgl3/3.3.3.json', fixed ? 200 : 501);
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
  // Probes above must not warm either the Java or Minecraft cache used by the
  // actual launcher startup below.
  await bridge.close();
  bridge = await new Bridge({ ...cfg, dataDir: join(temporary, 'fresh-ui-bridge') }, { log: line => console.log(line) }).start();
  observed.length = 0; trackRequests(bridge);
  report.launcherBridgeCacheInitiallyEmpty = true;
  if (fixed) {
    testTrust(true); trusted = true;
    report.windowsTestCAStore = 'LocalMachine Root on disposable elevated CI runner';
    report.interactiveCurrentUserSetupTested = false;
  }
  const data = join(temporary, 'Fresh Prism Data');
  const instance = join(data, 'instances', 'ColdStart501');
  await mkdir(instance, { recursive: true });
  await writeFile(join(data, 'prismlauncher.cfg'), `[General]\nLanguage=en_US\nApplicationTheme=bright\nIconTheme=flat\nAutomaticJavaDownload=true\nAutomaticJavaSwitch=true\nUserAskedAboutAutomaticJavaDownload=true\nIgnoreJavaWizard=true\nMetaURLOverride=http://127.0.0.1:${bridge.port}/meta/v1/\nProxyType=HTTP\nProxyAddr=127.0.0.1\nProxyPort=${bridge.port}\nCheckUpdateOnStart=false\n`);
  await writeFile(join(instance, 'instance.cfg'), '[General]\nInstanceType=OneSix\nname=ColdStart501\n');
  await writeFile(join(instance, 'mmc-pack.json'), JSON.stringify({ formatVersion: 1, components: [
    { uid: 'net.minecraft', version: '1.21.1', important: true },
    { uid: 'org.lwjgl3', version: fixed ? '3.3.3' : 'bridge-1.21.1', dependencyOnly: true },
  ] }));
  const probeCount = observed.length;
  prism = spawn(executable, ['--dir', data, '--launch', 'ColdStart501'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let prismOutput = ''; prism.stdout.on('data', b => { prismOutput += b; }); prism.stderr.on('data', b => { prismOutput += b; });
  let uiOutput = '';
  ui = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts/windows-startup-ui.ps1'), '-PrismProcessId', String(prism.pid), '-Seconds', fixed ? '440' : '150'], { stdio: ['ignore', 'pipe', 'pipe'] });
  ui.stdout.on('data', b => { uiOutput += b; }); ui.stderr.on('data', b => { uiOutput += b; });
  let installedManifest;
  for (let step = 0; step < (fixed ? 420 : 160); step++) {
    if (!fixed && observed.slice(probeCount).some(r => r.path === 'net.minecraft.java/index.json' && r.status === 501)) break;
    if (fixed && step % 5 === 0) {
      const javaDir = join(data, 'java', 'java-runtime-delta');
      try {
        if (!installedManifest) {
          const component = JSON.parse(await readFile(join(data, 'meta/net.minecraft.java/java21.json'), 'utf8'));
          const runtime = component.runtimes.find(r => r.name === 'java-runtime-delta' && r.runtimeOS === 'windows-x64');
          const response = await fetch(runtime.url, { signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 200);
          const bytes = Buffer.from(await response.arrayBuffer());
          assert.equal(createHash('sha1').update(bytes).digest('hex'), runtime.checksum.hash);
          installedManifest = JSON.parse(bytes);
          report.runtimeManifestSHA1Verified = runtime.checksum.hash;
        }
        let count = 0, totalBytes = 0;
        for (const [path, entry] of Object.entries(installedManifest.files)) if (entry.type === 'file') {
          const bytes = await readFile(join(javaDir, path));
          assert.equal(bytes.length, entry.downloads.raw.size);
          assert.equal(createHash('sha1').update(bytes).digest('hex'), entry.downloads.raw.sha1);
          count++; totalBytes += bytes.length;
        }
        const version = spawnSync(join(javaDir, 'bin/java.exe'), ['-version'], { encoding: 'utf8', timeout: 15000 });
        assert.equal(version.status, 0); assert.match(version.stdout + version.stderr, /version "21\./);
        report.installedJava = { allFilesSHA1Verified: count, bytes: totalBytes, executableVersion: (version.stdout + version.stderr).trim(), exitCode: version.status };
        report.prismAutomaticJavaVerified = true;
        break;
      } catch (error) { report.lastInstallProgress = { seconds: step, reason: error.code || error.message }; }
      if (step % 30 === 0) console.log('JAVA_INSTALL_PROGRESS ' + JSON.stringify({ seconds: step, counts: bridge.stats, last: report.lastInstallProgress }));
    }
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
      const relevant = log.split(/\r?\n/).filter(line => /501|Checksum mismatch|net\.minecraft\.java|JRE::|ColdStart501|MinecraftLoadAndCheck|AutoInstallJava/.test(line));
      report.prismLogEvidence.push(...relevant.map(line => line.replaceAll(temporary, '<TEMP>').replaceAll(temporary.replaceAll('\\', '/'), '<TEMP>')));
    }
  } catch {}
  // A green diagnostic run means its assertions ran; the booleans above are
  // the evidence. A non-reproduced GUI scenario must remain visibly failed.
  if (fixed) {
    assert(report.prismAutomaticJavaVerified, 'Official Windows Prism did not finish a complete, verified Java installation');
    assert(!report.prismJava501Reproduced);
    assert.equal(bridge.stats.compatibilityRecipes, 0);
  } else assert(report.prismJava501Reproduced, 'Official Windows Prism did not reach the Java 501; inspect UI evidence, no reproduction claimed');
  report.bridgeCounts = bridge.stats;
  report.diagnosticPassed = true;
} catch (error) {
  report.diagnosticPassed = false; report.failure = error.message; process.exitCode = 1;
} finally {
  for (const child of [ui, prism]) if (child?.pid && child.exitCode === null)
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000, stdio: 'ignore' });
  if (trusted) {
    try { testTrust(false); report.windowsTestCARemoved = true; }
    catch (error) { report.windowsTestCARemoved = false; report.cleanupFailure = error.message; report.diagnosticPassed = false; process.exitCode = 1; }
  }
  await bridge.close();
  await writeFile(join(root, 'test-results/windows-cold-start-501.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('WINDOWS_COLD_START_REPORT ' + JSON.stringify(report));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}
