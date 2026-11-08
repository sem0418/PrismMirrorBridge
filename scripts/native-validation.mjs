// Optional developer test. Requires the upstream-based prism-probe executable.
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { Bridge } from '../src/server.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const executable = option('--probe');
if (!executable) throw new Error('Pass --probe /absolute/path/to/prism-probe (build tests/native/prism_probe.cpp with the unmodified upstream sources).');
const temporary = await mkdtemp(join(tmpdir(), 'prism-native-validation-'));
const config = loadConfig(join(root, 'config.json')); config.dataDir = temporary; config.port = 0; config.compatibilityRecipes = false;
const bridge = await new Bridge(config, { log: () => {} }).start();
const files = join(temporary, 'components'); await mkdir(files);
const report = { startedAt: new Date().toISOString(), upstreamSourceCommit: '899d2f3957215a09fe398a8a8cbb8a8a9c619968',
  parserSourceModified: false, sourceCases: [], parsedComponents: [], qtNetworkChecks: [], fullGameLaunchTested: false };
try {
  const games = ['1.5.2', '1.7.10', '1.12.2', '1.16.5', '1.20.1', '1.21.1', '26.3', '3D Shareware v1.34'];
  const cases = [
    ...games.map(version => ['net.minecraft', version]),
    ...games.map(version => [version.startsWith('1.5') || version.startsWith('1.7') || version.startsWith('1.12') ? 'org.lwjgl' : 'org.lwjgl3', 'bridge-' + version]),
    ['net.fabricmc.fabric-loader', '0.16.14'], ['net.fabricmc.fabric-loader', '0.20.1'], ['net.fabricmc.intermediary', '1.20.1'],
    ['org.quiltmc.quilt-loader', '0.23.0'], ['net.minecraftforge', '10.13.4.1614'], ['net.minecraftforge', '14.23.5.2860'],
    ['net.minecraftforge', '47.3.0'], ['net.neoforged', '21.1.1'], ['net.neoforged', '26.3.0.101'],
  ];
  for (const [uid, version] of cases) {
    try {
      const value = await bridge.meta.request(uid + '/' + encodeURIComponent(version) + '.json');
      await writeFile(join(files, uid + '__' + version + '.json'), JSON.stringify(value));
      report.sourceCases.push({ uid, version, passed: true }); console.log('FETCH PASS ' + uid + '/' + version);
    } catch (e) { report.sourceCases.push({ uid, version, passed: false, error: e.message }); console.log('FETCH FAIL ' + uid + '/' + version + ': ' + e.message); }
  }
  const parsed = spawnSync(executable, [files], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (parsed.error) throw parsed.error;
  report.parsedComponents = parsed.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  report.parserExitCode = parsed.status;
  await rm(join(root, 'test-results/native-cases'), { recursive: true, force: true });
  await cp(files, join(root, 'test-results/native-cases'), { recursive: true });
  // spawnSync would block the bridge's Node event loop; network probe uses an
  // asynchronous child so it can receive live replies from this exact build.
  const { spawn } = await import('node:child_process');
  await new Promise((done, reject) => {
    const child = spawn(executable, ['--network', String(bridge.port), bridge.ca.certPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { error += b; });
    const timer = setTimeout(() => child.kill(), 280000);
    child.once('error', reject); child.once('exit', code => {
      clearTimeout(timer); report.qtNetworkExitCode = code;
      report.qtNetworkChecks = output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      if (error) report.qtDiagnostics = error;
      done();
    });
  });
  report.compatibilityRequests = bridge.stats.compatibilityRecipes;
  report.passed = report.sourceCases.every(v => v.passed) && report.parsedComponents.length === report.sourceCases.length &&
    report.parserExitCode === 0 && report.qtNetworkExitCode === 0 && report.qtNetworkChecks.length === 4 &&
    report.qtNetworkChecks.every(v => v.passed) && report.compatibilityRequests === 0;
} finally {
  await bridge.close(); await rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(join(root, 'test-results/native-report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, cases: report.sourceCases.length, parsed: report.parsedComponents.length,
  qtNetwork: report.qtNetworkChecks, compatibilityRequests: report.compatibilityRequests }));
if (!report.passed) process.exitCode = 1;
