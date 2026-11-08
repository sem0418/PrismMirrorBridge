// Isolated CLI lifecycle check. On Windows, also exercises setup/undo with an
// explicit test config path and removes the temporary current-user CA afterwards.
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'Prism Bridge smoke '));
const app = join(temporary, 'Tool With Spaces');
const prism = join(temporary, 'Prism Data With Spaces', 'prismlauncher.cfg');
let service, trusted = false;
function run(args) {
  const r = spawnSync(process.execPath, [join(app, 'cli.mjs'), ...args], { encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout;
}
function batch(name) {
  const r = spawnSync('cmd.exe', ['/d', '/c', `${name} "${prism}" < NUL`],
    { cwd: app, encoding: 'utf8', timeout: 30000, windowsVerbatimArguments: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
}
try {
  await cp(root, app, { recursive: true, filter: path => !['.git', '.bridge', 'node_modules', 'dist', 'test-results', 'runtime'].includes(path.slice(root.length + 1).split(/[\\/]/)[0]) });
  const { mkdir } = await import('node:fs/promises'); await mkdir(dirname(prism), { recursive: true });
  await writeFile(prism, '[General]\nLanguage=zh_CN\nKeep=original\nProxyType=None\n');
  const listener = net.createServer(); await new Promise(done => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port; await new Promise(done => listener.close(done));
  const config = JSON.parse(await readFile(join(app, 'config.json'))); config.port = port; config.upstreamProxy = '';
  await writeFile(join(app, 'config.json'), JSON.stringify(config));
  run(['init']); run(['configure', '--prism-config', prism]);
  assert((await readFile(prism, 'utf8')).includes('ProxyType=HTTP'));
  await writeFile(prism, (await readFile(prism, 'utf8')).replace('Keep=original', 'Keep=changed-later'));
  run(['restore', '--prism-config', prism]);
  const restored = await readFile(prism, 'utf8'); assert(restored.includes('ProxyType=None') && restored.includes('Keep=changed-later') && !restored.includes('MetaURLOverride'));
  console.log('PASS CLI configure/restore preserves later settings and paths with spaces');
  service = spawn(process.execPath, [join(app, 'cli.mjs'), 'serve'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = ''; service.stdout.on('data', b => { diagnostic += b; }); service.stderr.on('data', b => { diagnostic += b; });
  let health;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }); if (r.ok) { health = await r.json(); break; } } catch {}
    if (service.exitCode !== null) throw new Error(diagnostic);
    await new Promise(done => setTimeout(done, 100));
  }
  assert(health?.ok, diagnostic); assert.equal(health.compatibilityRecipes, false); assert.equal(health.fileFallback, false);
  run(['doctor']); const index = await (await fetch(`http://127.0.0.1:${port}/meta/v1/index.json`)).json(); assert(index.packages.some(p => p.uid === 'net.minecraft'));
  console.log('PASS CLI init/serve/doctor and component root index');
  await new Promise(done => { service.once('exit', done); service.kill(); }); service = null;
  if (process.platform === 'win32') {
    const cert = new X509Certificate(await readFile(join(app, '.bridge/ca/ca.pem')));
    const thumbprint = cert.fingerprint.replaceAll(':', '');
    // Mark before setup so finally removes trust even if setup is interrupted.
    trusted = true; batch('01-setup.cmd');
    assert.equal(spawnSync('certutil.exe', ['-user', '-store', 'Root', thumbprint], { encoding: 'utf8', timeout: 10000 }).status, 0);
    batch('03-undo.cmd'); trusted = false;
    assert.notEqual(spawnSync('certutil.exe', ['-user', '-store', 'Root', thumbprint], { encoding: 'utf8', timeout: 10000 }).status, 0);
    assert((await readFile(prism, 'utf8')).includes('ProxyType=None'));
    console.log('PASS Windows setup/undo batch scripts and current-user certutil trust/untrust');
  }
} finally {
  if (service) { await new Promise(done => { if (service.exitCode !== null) return done(); service.once('exit', done); service.kill(); }); }
  if (trusted) spawnSync(process.execPath, [join(app, 'cli.mjs'), 'untrust-ca'], { encoding: 'utf8', timeout: 10000 });
  await rm(temporary, { recursive: true, force: true });
}
