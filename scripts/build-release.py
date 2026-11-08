#!/usr/bin/env python3
"""Build the portable release using only Python's standard library.

The pinned official Node.js ZIP and executable hashes are checked before packing.
An existing --node-exe can be reused, but must match the same official executable.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
NODE_VERSION = '24.22.2'
NODE_ZIP_SHA256 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'
NODE_EXE_SHA256 = '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9'
DIRECTORIES = {'src', 'data', 'docs', 'scripts', 'tests', 'test-results', 'LICENSES', 'runtime', '.github'}
ROOT_FILES = {'README.md', 'TEST_REPORT.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
              'LICENSE', 'package.json', 'config.json', 'cli.mjs', 'run.cmd', '01-setup.cmd', '02-start.cmd', '03-undo.cmd', '04-test.cmd', '.gitignore', '.gitattributes'}

def digest(value): return hashlib.sha256(value).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'dist')
    parser.add_argument('--node-exe', type=Path, help='Existing official Windows Node.js executable')
    args = parser.parse_args()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version): raise ValueError('Invalid package version')
    config = json.loads((ROOT / 'config.json').read_text())
    if config != {'listen': '127.0.0.1', 'port': 17643, 'bmcl': 'https://bmclapi2.bangbang93.com', 'mcim': 'https://mod.mcimirror.top',
                  'prismRecipes': 'https://meta.prismlauncher.org/v1/', 'compatibilityRecipes': False, 'fileFallback': False,
                  'upstreamProxy': 'environment', 'timeoutMs': 30000, 'retries': 2, 'concurrency': 4, 'cacheSeconds': 300, 'dataDir': '.bridge'}:
        raise ValueError('Release config must contain the documented defaults, without local settings')
    content = {}
    for path in sorted(ROOT.rglob('*')):
        if not path.is_file() or path.is_symlink(): continue
        relative = path.relative_to(ROOT)
        if len(relative.parts) == 1:
            if relative.name not in ROOT_FILES: continue
        elif relative.parts[0] not in DIRECTORIES: continue
        if any(part in {'.git', '.bridge', '__pycache__', 'node_modules', 'dist'} for part in relative.parts): continue
        if path.suffix.lower() in {'.pem', '.key', '.p12', '.der', '.so', '.o', '.log', '.exe'} or 'bridge-backup' in path.name: continue
        value = path.read_bytes()
        if re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}', value):
            raise ValueError('Possible private material in ' + relative.as_posix())
        if path.suffix == '.cmd': value = value.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
        content[relative.as_posix()] = value
    if args.node_exe:
        executable = args.node_exe.read_bytes()
    else:
        url = f'https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-win-x64.zip'
        with urllib.request.urlopen(url, timeout=90) as response: archive = response.read()
        if digest(archive) != NODE_ZIP_SHA256: raise ValueError('Official Node.js ZIP hash mismatch')
        with zipfile.ZipFile(io.BytesIO(archive)) as nodezip:
            executable = nodezip.read(f'node-v{NODE_VERSION}-win-x64/node.exe')
            content['runtime/NODE-LICENSE'] = nodezip.read(f'node-v{NODE_VERSION}-win-x64/LICENSE')
    if digest(executable) != NODE_EXE_SHA256: raise ValueError('Node.js executable hash mismatch')
    content['runtime/node.exe'] = executable
    manifest = {'version': version, 'algorithm': 'sha256', 'files': {name: digest(value) for name, value in sorted(content.items())}}
    content['RELEASE_MANIFEST.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    # A caller can select a reproducible timestamp with SOURCE_DATE_EPOCH.
    epoch = max(315532800, int(os.environ.get('SOURCE_DATE_EPOCH', '315532800')))
    stamp = time.gmtime(epoch)[:6]
    args.out.mkdir(parents=True, exist_ok=True)
    destination = args.out / f'PrismMirrorBridge-{version}-Windows-x64.zip'
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as release:
        for name, value in sorted(content.items()):
            entry = zipfile.ZipInfo('PrismMirrorBridge/' + name, stamp)
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = (0o100755 if name == 'cli.mjs' else 0o100644) << 16
            release.writestr(entry, value, compresslevel=9)
    checksums = args.out / 'SHA256SUMS.txt'
    checksums.write_text(digest(destination.read_bytes()) + '  ' + destination.name + '\n', encoding='utf8')
    print(json.dumps({'archive': str(destination), 'bytes': destination.stat().st_size, 'sha256': digest(destination.read_bytes()), 'files': len(content)}))

if __name__ == '__main__': main()
