#!/usr/bin/env python3
"""Validate and extract a portable release, then test the actual extracted code."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
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
            release.extractall(temporary)
        root = Path(temporary) / 'PrismMirrorBridge'
        for command in [['node', 'scripts/test.mjs'], ['node', 'scripts/smoke-test.mjs']]:
            r = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=90)
            if r.returncode: raise RuntimeError(r.stdout + r.stderr)
            if 'test.mjs' == command[1].split('/')[-1] and ('# pass 43\n' not in r.stdout or '# fail 0\n' not in r.stdout):
                raise RuntimeError('Expected the complete offline suite')
        print(json.dumps({'passed': True, 'archiveCRC': True, 'allFileHashes': True, 'privateStateExcluded': True, 'extractedOfflineTests': 43,
                          'extractedCLISmoke': True, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}))

if __name__ == '__main__': main()
