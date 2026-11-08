// Isolated CLI lifecycle check. --windows-trust opts into the interactive
// Windows security dialog and removes the temporary current-user CA afterwards.
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
async function batch(name) {
  await new Promise((done, reject) => {
    const child = spawn('cmd.exe', ['/d', '/c', `${name} "${prism}" < NUL`],
      { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true });
    let output = '', expired = false;
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const timer = setTimeout(() => {
      expired = true;
      if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000, stdio: 'ignore', windowsHide: true });
    }, 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (expired || code !== 0) reject(new Error((expired ? 'Interactive Windows trust test timed out; complete the security dialog on a desktop.\n' : '') + output));
      else done();
    });
  });
}
try {
  await cp(root, app, { recursive: true, filter: path => !['.git', '.bridge', 'node_modules', 'dist', 'test-results', 'runtime'].includes(path.slice(root.length + 1).split(/[\\/]/)[0]) });
  const { mkdir } = await import('node:fs/promises'); await mkdir(dirname(prism), { recursive: true });
  await writeFile(prism, '[General]\nLanguage=zh_CN\nKeep=original\nProxyType=None\n');
  const listener = net.createServer(); await new Promise(done => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port; await new Promise(done => listener.close(done));
  const config = JSON.parse(await readFile(join(app, 'config.json'))); config.port = port; config.upstreamProxy = '';
  await writeFile(join(app, 'config.json'), JSON.stringify(config));
  const prismMeta = join(dirname(prism), 'meta'); await mkdir(join(prismMeta, 'net.neoforged'), { recursive: true });
  const originalIndex = '{"uid":"net.neoforged","versions":[{"version":"21.1.265"}]}';
  await writeFile(join(prismMeta, 'net.neoforged/index.json'), originalIndex);
  await writeFile(join(prismMeta, 'net.neoforged/21.1.265.json.part'), Buffer.alloc(36042, 65));
  run(['init']); run(['configure', '--prism-config', prism]);
  assert((await readFile(prism, 'utf8')).includes('ProxyType=HTTP'));
  await assert.rejects(readFile(join(prismMeta, 'net.neoforged/index.json')), { code: 'ENOENT' });
  await mkdir(prismMeta); await writeFile(join(prismMeta, 'bridge-cache'), 'preserved bridge cache');
  run(['repair-metadata', '--prism-config', prism]);
  await assert.rejects(readFile(join(prismMeta, 'bridge-cache')), { code: 'ENOENT' });
  await writeFile(prism, (await readFile(prism, 'utf8')).replace('Keep=original', 'Keep=changed-later'));
  run(['restore', '--prism-config', prism]);
  const restored = await readFile(prism, 'utf8'); assert(restored.includes('ProxyType=None') && restored.includes('Keep=changed-later') && !restored.includes('MetaURLOverride'));
  assert.equal(await readFile(join(prismMeta, 'net.neoforged/index.json'), 'utf8'), originalIndex);
  assert.equal((await readFile(join(prismMeta, 'net.neoforged/21.1.265.json.part'))).length, 36042);
  console.log('PASS CLI configure/repair/restore isolates metadata, restores its original snapshot, and preserves later settings and paths with spaces');
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
  if (process.platform === 'win32' && process.argv.includes('--windows-trust')) {
    const cert = new X509Certificate(await readFile(join(app, '.bridge/ca/ca.pem')));
    const thumbprint = cert.fingerprint.replaceAll(':', '');
    // Mark before setup so finally removes trust even if setup is interrupted.
    trusted = true; await batch('01-setup.cmd');
    assert.equal(spawnSync('certutil.exe', ['-user', '-store', 'Root', thumbprint], { encoding: 'utf8', timeout: 10000 }).status, 0);
    await batch('05-repair-metadata.cmd');
    await batch('03-undo.cmd'); trusted = false;
    assert.notEqual(spawnSync('certutil.exe', ['-user', '-store', 'Root', thumbprint], { encoding: 'utf8', timeout: 10000 }).status, 0);
    assert((await readFile(prism, 'utf8')).includes('ProxyType=None'));
    console.log('PASS Windows setup/undo batch scripts and current-user certutil trust/untrust');
  } else if (process.platform === 'win32') {
    console.log('SKIP Windows CA store setup/undo: interactive security confirmation; opt in with --windows-trust on a desktop');
  }
} finally {
  if (service) { await new Promise(done => { if (service.exitCode !== null) return done(); service.once('exit', done); service.kill(); }); }
  if (trusted) spawnSync(process.execPath, [join(app, 'cli.mjs'), 'untrust-ca'], { encoding: 'utf8', timeout: 10000 });
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
