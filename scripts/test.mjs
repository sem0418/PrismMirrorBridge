import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = (await readdir(join(root, 'tests'))).filter(n => n.endsWith('.test.mjs')).sort().map(n => join(root, 'tests', n));
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files], { cwd: root, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
