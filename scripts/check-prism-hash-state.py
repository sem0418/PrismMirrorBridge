#!/usr/bin/env python3
"""Optional developer diagnostic: Qt 6, a C++17 compiler, and no network needed.

Executes exact extracted Prism 11.1.1 merge function bodies and its unmodified
ChecksumValidator with minimal object scaffolding. This is not a launcher run.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent

def extract(text, marker):
    start = text.index(marker)
    i = text.index('{', start) + 1
    depth = 1
    while depth:
        if text[i] == '{': depth += 1
        if text[i] == '}': depth -= 1
        i += 1
    return text[start:i]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--qt-include', type=Path, help='Qt6 include directory, if pkg-config is unavailable')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    reference = ROOT / 'tests/native/prism-11.1.1'
    provenance = json.loads((reference / 'PROVENANCE.json').read_text())
    for item in provenance['files']:
        blob = (reference / item['path'].removeprefix('launcher/')).read_bytes()
        gitsha = hashlib.sha1(b'blob ' + str(len(blob)).encode() + b'\0' + blob).hexdigest()
        if gitsha != item['gitBlobSHA']: raise ValueError('Reference source hash mismatch: ' + item['path'])
    probe = ROOT / 'tests/native/prism_hash_state.cpp'
    for path, marker in [('meta/Version.cpp', 'void Meta::Version::mergeFromList('),
                         ('meta/VersionList.cpp', 'void VersionList::mergeFromIndex(')]:
        if extract((reference / path).read_text(), marker) not in probe.read_text():
            raise ValueError('Diagnostic does not contain the exact upstream function body')
    if args.qt_include:
        flags = ['-I' + str(args.qt_include / suffix) for suffix in ['', 'QtCore', 'QtNetwork']]
        flags += ['-l:libQt6Core.so.6', '-l:libQt6Network.so.6']
    else:
        flags = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'Qt6Core', 'Qt6Network'], text=True))
    with tempfile.TemporaryDirectory(prefix='prism-checksum-probe-') as temporary:
        exe = Path(temporary) / 'probe'
        subprocess.run(['g++', '-std=c++17', '-fPIC', '-O1', '-I' + str(reference), str(probe), *flags, '-o', str(exe)], check=True, timeout=60)
        run = subprocess.run([str(exe), str(ROOT / 'tests/fixtures/neoforge-checksum')], check=True, capture_output=True, text=True, timeout=15)
        report = json.loads(run.stdout)
        if not report['passed']: raise ValueError('Native diagnostic failed')
        if args.report: args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'passed': True, 'checks': len(report['tests']), 'scope': report['scope']}, ensure_ascii=False))

if __name__ == '__main__': main()
