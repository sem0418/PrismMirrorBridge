// Optional Linux developer harness: links unmodified Prism parsing sources.
import { mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const source = option('--prism-source'), qt = option('--qt-include'), output = resolve(option('--out') || join(root, 'test-results/prism-probe'));
if (process.platform !== 'linux' || !source || !qt) throw new Error('Requires Linux, GCC 14+, Qt 6 headers/libraries; pass --prism-source PATH --qt-include PATH [--qt-lib PATH] [--out PATH].');
const repo = resolve(source), include = resolve(qt), objects = output + '.objects'; await mkdir(objects, { recursive: true });
const files = ['Json.cpp', 'minecraft/OneSixVersionFormat.cpp', 'minecraft/MojangVersionFormat.cpp', 'meta/JsonFormat.cpp',
  'minecraft/Library.cpp', 'minecraft/Rule.cpp', 'minecraft/ParseUtils.cpp', 'java/JavaMetadata.cpp', 'java/JavaVersion.cpp', 'Version.cpp', 'StringUtils.cpp', 'SysInfo.cpp'];
const flags = ['-std=c++23', '-DLAUNCHER_APPLICATION', '-fPIC', '-ffunction-sections', '-fdata-sections', '-O1',
  ...[include, ...['QtCore', 'QtGui', 'QtNetwork', 'QtWidgets'].map(d => join(include, d)), join(repo, 'launcher'), join(repo, 'buildconfig')].map(d => '-I' + d)];
const compiler = process.env.CXX || 'g++';
async function run(args) {
  await new Promise((done, reject) => {
    const child = spawn(compiler, args, { stdio: 'inherit' });
    child.on('error', reject); child.on('exit', code => code === 0 ? done() : reject(new Error('Native compilation failed: ' + code)));
  });
}
const built = [];
for (const file of files) {
  const object = join(objects, file.replaceAll('/', '_') + '.o');
  await run([...flags, '-c', join(repo, 'launcher', file), '-o', object]); built.push(object);
}
await run([...flags, join(root, 'tests/native/prism_probe.cpp'), ...built, '-Wl,--gc-sections',
  ...(option('--qt-lib') ? ['-L' + resolve(option('--qt-lib'))] : []), '-l:libQt6Core.so.6', '-l:libQt6Gui.so.6', '-l:libQt6Network.so.6', '-o', output]);
console.log('Built ' + output);
