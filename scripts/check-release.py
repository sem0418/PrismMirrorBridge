#!/usr/bin/env python3
"""Validate and extract a portable release, then test the actual extracted code."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import re
import sys
import tempfile
import zipfile

def main():
    archive = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='prism-release-check-') as temporary:
        with zipfile.ZipFile(archive) as release:
            names = release.namelist()
            if len(names) != len(set(names)): raise ValueError('Duplicate ZIP entries')
            for name in names:
                p = PurePosixPath(name)
                if p.is_absolute() or '..' in p.parts or p.parts[0] != 'PrismMirrorBridge' or '\\' in name: raise ValueError('Unsafe ZIP path')
                if any(v in {'.git', '.bridge', 'node_modules', '__pycache__'} for v in p.parts) or name.endswith(('.pem', '.key', '.p12', '.so', '.o')):
                    raise ValueError('Private/build state in release')
            if release.testzip() is not None: raise ValueError('ZIP CRC failed')
            manifest = json.loads(release.read('PrismMirrorBridge/RELEASE_MANIFEST.json'))['files']
            if len(names) != len(manifest) + 1: raise ValueError('Manifest does not cover every file')
            for name, expected in manifest.items():
                if hashlib.sha256(release.read('PrismMirrorBridge/' + name)).hexdigest() != expected: raise ValueError('Hash mismatch: ' + name)
            code = {name: value for name, value in manifest.items()
                    if name.split('/')[0] in {'src', 'scripts', 'tests', 'data'}
                    or name in {'cli.mjs', 'package.json', 'config.json'} or name.endswith('.cmd')}
            code_hash = hashlib.sha256(json.dumps(code, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            release.extractall(temporary)
        root = Path(temporary) / 'PrismMirrorBridge'
        if hashlib.sha256((root / 'runtime/node.exe').read_bytes()).hexdigest() != '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9':
            raise ValueError('Bundled Node executable does not match the pinned official Windows runtime')
        test_count = 0
        for command in [['node', 'scripts/test.mjs'], ['node', 'scripts/smoke-test.mjs']]:
            r = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=90)
            if r.returncode: raise RuntimeError(r.stdout + r.stderr)
            if 'test.mjs' == command[1].split('/')[-1]:
                count = re.search(r'^# tests (\d+)$', r.stdout, re.M)
                passed = re.search(r'^# pass (\d+)$', r.stdout, re.M)
                if not count or not passed or int(count[1]) < 1 or count[1] != passed[1] or '# fail 0\n' not in r.stdout:
                    raise RuntimeError('Expected the complete offline suite')
                test_count = int(count[1])
        print(json.dumps({'passed': True, 'archiveCRC': True, 'allFileHashes': True, 'privateStateExcluded': True, 'officialWindowsRuntimeSHA256': True, 'extractedOfflineTests': test_count,
                          'extractedCLISmoke': True, 'validatedCodeSHA256': code_hash, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}))

if __name__ == '__main__': main()
