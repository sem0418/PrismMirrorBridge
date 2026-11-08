#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './src/config.mjs';
import { ensureCA } from './src/certificates.mjs';
import { configurePrism, restorePrism, repairPrismMetadata } from './src/prism-config.mjs';
import { Bridge } from './src/server.mjs';
import { VERSION } from './src/version.mjs';

const args = process.argv.slice(2), command = args.shift() || 'serve';
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const root = dirname(fileURLToPath(import.meta.url));
async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || major === 24 && minor < 5) throw new Error('Node.js 24.5+ is required. Use the supplied Windows runtime or install Node 24 LTS.');
  const config = loadConfig(resolve(option('--config') || join(root, 'config.json')));
  if (command === 'serve') {
    const bridge = await new Bridge(config).start();
    console.log(`Prism Mirror Bridge ${VERSION}\n状态页：http://127.0.0.1:${bridge.port}/\n元数据：http://127.0.0.1:${bridge.port}/meta/v1/\nHTTP 代理：127.0.0.1:${bridge.port}\n按 Ctrl+C 停止服务。`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await bridge.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }
  if (['configure', 'restore', 'repair-metadata'].includes(command)) {
    const path = option('--prism-config') || option('--prism-dir');
    if (!path) throw new Error('Pass --prism-config <prismlauncher.cfg> or --prism-dir <Prism data directory>. Close Prism first.');
    const result = command === 'restore' ? restorePrism(path)
      : command === 'repair-metadata' ? repairPrismMetadata(path, config) : configurePrism(path, config);
    console.log(command === 'configure' ? 'Prism 接入完成。启动服务后重新打开 Prism。'
      : command === 'repair-metadata' ? 'Prism 元数据修复步骤已完成。请重新打开 Prism 后重试导入。'
        : 'Prism 的原有网络设置已恢复，桥接器元数据已隔离。');
    console.log(result.file);
    if (result.metadata?.migrated && result.metadata.archives?.some(path => existsSync(path))) console.log('旧 meta 目录以 meta.prism-bridge-* 名称保留在 Prism 根目录中；实例、账号与模组文件未改动。');
    if (command === 'configure' && !['None', 'Default'].includes(result.previousProxy)) console.log('原 Prism 使用了自定义代理；如仍需要它，请在 config.json 的 upstreamProxy 中配置该代理。');
    return;
  }
  const ca = ensureCA(join(config.dataDir, 'ca'));
  if (command === 'init') { console.log('本次安装的本地 CA：' + ca.certPath + '\nSHA-256：' + ca.fingerprint); return; }
  if (command === 'trust-ca' || command === 'untrust-ca') {
    if (process.platform !== 'win32') throw new Error('Automatic certificate trust is provided on Windows; see README for Linux/macOS.');
    const trustArgs = command === 'trust-ca' ? ['-user', '-addstore', 'Root', ca.certPath] : ['-user', '-delstore', 'Root', ca.thumbprint];
    const result = spawnSync('certutil.exe', trustArgs, { stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error('Windows certificate operation failed.');
    console.log(command === 'trust-ca' ? '已信任此安装的本地证书（当前 Windows 用户）。' : '已移除此安装的本地证书信任。'); return;
  }
  if (command === 'doctor') {
    console.log('Node: ' + process.versions.node + '\n配置有效。证书 SHA-256: ' + ca.fingerprint);
    try {
      const r = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) throw new Error('Health check failed');
      console.log(JSON.stringify(await r.json(), null, 2));
    } catch { console.log('服务未运行。先运行“02-start.cmd”，再检查状态。'); process.exitCode = 1; }
    return;
  }
  throw new Error('Commands: serve, init, configure, repair-metadata, restore, trust-ca, untrust-ca, doctor.');
}
main().catch(error => { console.error('错误：' + error.message); process.exitCode = 1; });
