// Minimal DER encoder for installation-local X.509 certificates. Node's crypto
// module performs all cryptography; no external openssl program is required.
import { generateKeyPairSync, randomBytes, sign, X509Certificate, createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import tls from 'node:tls';

function der(tag, ...parts) {
  const b = Buffer.concat(parts.flat().map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
  let len = b.length < 128 ? Buffer.from([b.length]) : (() => {
    let h = b.length.toString(16); if (h.length % 2) h = '0' + h;
    const n = Buffer.from(h, 'hex'); return Buffer.concat([Buffer.from([128 + n.length]), n]);
  })();
  return Buffer.concat([Buffer.from([tag]), len, b]);
}
const seq = (...p) => der(0x30, ...p);
const integer = b => {
  if (typeof b === 'number') b = Buffer.from([b]);
  while (b.length > 1 && b[0] === 0) b = b.subarray(1);
  return der(2, b[0] & 128 ? Buffer.concat([Buffer.from([0]), b]) : b);
};
function oid(value) {
  const a = value.split('.').map(Number), b = [40 * a[0] + a[1]];
  for (const n of a.slice(2)) {
    let x = n, v = [x & 127];
    while ((x = Math.floor(x / 128))) v.unshift((x & 127) | 128);
    b.push(...v);
  }
  return der(6, Buffer.from(b));
}
const bool = v => der(1, Buffer.from([v ? 255 : 0]));
const name = s => seq(der(0x31, seq(oid('2.5.4.3'), der(12, Buffer.from(s)))));
const algorithm = seq(oid('1.2.840.113549.1.1.11'), der(5)); // sha256WithRSAEncryption
const time = d => {
  const stamp = d.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z');
  // RFC 5280 requires UTCTime through 2049; use GeneralizedTime from 2050.
  return d.getUTCFullYear() >= 1950 && d.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(stamp.slice(2))) : der(0x18, Buffer.from(stamp));
};
const ext = (id, value, critical = false) => seq(oid(id), ...(critical ? [bool(true)] : []), der(4, value));
const pem = (label, b) => `-----BEGIN ${label}-----\n${b.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

function makeCertificate({ publicKey, issuer, subject, signer, ca = false, host }) {
  const now = Date.now();
  const keyID = key => createHash('sha1').update(key.export({ type: 'pkcs1', format: 'der' })).digest();
  const issuerID = keyID(createPublicKey(signer));
  const extensions = [
    ext('2.5.29.19', ca ? seq(bool(true), integer(0)) : seq(), true),
    ext('2.5.29.15', der(3, Buffer.from(ca ? [1, 6] : [5, 160])), true),
    ext('2.5.29.14', der(4, keyID(publicKey))),
    ext('2.5.29.35', seq(der(0x80, issuerID))),
  ];
  if (!ca) {
    extensions.push(ext('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.1'))));
    extensions.push(ext('2.5.29.17', seq(der(0x82, Buffer.from(host)))));
  }
  const tbs = seq(der(0xa0, integer(2)), integer(randomBytes(16)), algorithm,
    name(issuer), seq(time(new Date(now - 86400000)), time(new Date(now + (ca ? 3650 : 90) * 86400000))),
    name(subject), publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, seq(...extensions)));
  return pem('CERTIFICATE', seq(tbs, algorithm, der(3, Buffer.from([0]), sign('RSA-SHA256', tbs, signer))));
}

export function ensureCA(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, 'ca-key.pem'), certPath = join(directory, 'ca.pem');
  if (existsSync(keyPath) !== existsSync(certPath)) throw new Error('Incomplete CA files; restore the matching CA pair before starting.');
  if (!existsSync(keyPath)) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const subject = 'Prism Mirror Bridge ' + randomBytes(6).toString('hex');
    const cert = makeCertificate({ publicKey, issuer: subject, subject, signer: privateKey, ca: true });
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    writeFileSync(certPath, cert, { mode: 0o644, flag: 'wx' });
  }
  chmodSync(keyPath, 0o600);
  const cert = readFileSync(certPath, 'utf8'), key = readFileSync(keyPath, 'utf8');
  const x509 = new X509Certificate(cert);
  if (!x509.ca || !Number.isFinite(Date.parse(x509.validTo)) || Date.parse(x509.validTo) < Date.now() || !x509.checkPrivateKey(createPrivateKey(key))) {
    throw new Error('Invalid or expired bridge CA.');
  }
  return { cert, key, certPath, keyPath, subject: x509.subject.replace(/^CN=/, ''),
    fingerprint: x509.fingerprint256, thumbprint: createHash('sha1').update(x509.raw).digest('hex').toUpperCase() };
}

export class CertificateStore {
  constructor(ca, allowedHosts) { this.ca = ca; this.allowed = new Set(allowedHosts); this.contexts = new Map(); }
  context(host) {
    if (!this.allowed.has(host)) throw new Error('Certificate requested for non-mirror host');
    if (!this.contexts.has(host)) {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const cert = makeCertificate({ publicKey, issuer: this.ca.subject, subject: host,
        signer: this.ca.key, host });
      this.contexts.set(host, tls.createSecureContext({ key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        cert: cert + this.ca.cert, minVersion: 'TLSv1.2' }));
    }
    return this.contexts.get(host);
  }
}
