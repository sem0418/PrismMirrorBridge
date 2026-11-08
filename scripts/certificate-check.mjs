// Optional independent X.509 conformance check; requires the openssl CLI.
import tls from 'node:tls';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureCA, CertificateStore } from '../src/certificates.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'bridge-cert-check-'));
const report = { startedAt: new Date().toISOString(), checks: [] };
const ca = ensureCA(join(temporary, 'ca')), store = new CertificateStore(ca, ['api.modrinth.com']);
const server = tls.createServer({ SNICallback: (_host, callback) => callback(null, store.context('api.modrinth.com')) }, socket => socket.end());
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const leaf = await new Promise((resolve, reject) => {
    const client = tls.connect({ host: '127.0.0.1', port: server.address().port, servername: 'api.modrinth.com', ca: ca.cert }, () => {
      resolve(client.getPeerCertificate().raw); client.end();
    }); client.on('error', reject);
  });
  const leafPath = join(temporary, 'leaf.pem');
  await writeFile(leafPath, '-----BEGIN CERTIFICATE-----\n' + leaf.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n');
  function openssl(args) {
    const result = spawnSync('openssl', args, { encoding: 'utf8', timeout: 10000 });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  }
  function check(name, passed) { report.checks.push({ name, passed }); console.log((passed ? 'PASS ' : 'FAIL ') + name); }
  check('OpenSSL strict X.509 chain and server-auth purpose', openssl(['verify', '-x509_strict', '-purpose', 'sslserver', '-verify_hostname', 'api.modrinth.com', '-CAfile', ca.certPath, leafPath]).status === 0);
  check('Wrong hostname rejected', openssl(['verify', '-verify_hostname', 'api.curseforge.com', '-CAfile', ca.certPath, leafPath]).status !== 0);
  const unrelated = ensureCA(join(temporary, 'unrelated'));
  check('Unrelated root CA rejected', openssl(['verify', '-CAfile', unrelated.certPath, leafPath]).status !== 0);
  for (const [name, file] of [['root', ca.certPath], ['leaf', leafPath]]) {
    const asn = openssl(['asn1parse', '-in', file]);
    check(name + ' uses RFC 5280 UTCTime for dates before 2050', asn.status === 0 && (asn.output.match(/UTCTIME/g) || []).length === 2);
    const extensions = openssl(['x509', '-in', file, '-noout', '-text']);
    check(name + ' includes subject and authority key identifiers', extensions.status === 0 && extensions.output.includes('Subject Key Identifier') && extensions.output.includes('Authority Key Identifier'));
  }
  report.passed = report.checks.every(v => v.passed);
} finally {
  await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(join(root, 'test-results/certificate-report.json'), JSON.stringify(report, null, 2) + '\n');
}
if (!report.passed) process.exitCode = 1;
