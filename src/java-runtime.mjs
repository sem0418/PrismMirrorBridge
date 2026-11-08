import { HTTPError } from './transport.mjs';
import { base, timestamp } from './converters.mjs';
import { mirrorURL } from './routing.mjs';
import { createHash } from 'node:crypto';

// Same Mojang entry point used by upstream Prism's metadata generator. Fetch
// it through BMCL; no Prism compatibility recipe or vendor API is required.
export const JAVA_MANIFEST_PATH = '/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const UID = 'net.minecraft.java';
const sha1 = bytes => createHash('sha1').update(bytes).digest('hex');
function invalid() { throw new HTTPError(502, 'BMCL returned invalid Windows Java runtime metadata'); }
function versionInfo(name) {
  if (typeof name !== 'string') invalid();
  const legacy = name.match(/^(\d+)u(\d+)(?:-([a-zA-Z0-9.-]+))?$/);
  if (legacy) {
    const major = Number(legacy[1]), security = Number(legacy[2]);
    if (!Number.isSafeInteger(major) || major < 1 || !Number.isSafeInteger(security)) invalid();
    return { major, minor: 0, security, name, ...(legacy[3] ? { buildstr: legacy[3] } : {}) };
  }
  if (!/^\d+(?:\.\d+)*$/.test(name)) invalid();
  const [major, minor = 0, security = 0, build] = name.split('.').map(Number);
  if (![major, minor, security, ...(build === undefined ? [] : [build])].every(Number.isSafeInteger) || major < 1) invalid();
  return { major, minor, security, ...(build === undefined ? {} : { build }), name };
}

export function convertWindowsJava(raw, config) {
  const windows = raw?.['windows-x64'];
  if (!windows || typeof windows !== 'object' || Array.isArray(windows)) invalid();
  const groups = new Map(), manifests = new Map();
  for (const [name, entries] of Object.entries(windows)) {
    // minecraft-java-exe is a launcher helper, not a runnable JRE.
    if (name !== 'jre-legacy' && !/^java-runtime-[a-z0-9-]+$/.test(name)) continue;
    if (!Array.isArray(entries)) invalid();
    for (const entry of entries) {
      const version = versionInfo(entry?.version?.name), manifest = entry?.manifest;
      if (!manifest || typeof manifest.sha1 !== 'string' || !/^[a-fA-F0-9]{40}$/.test(manifest.sha1)
        || !Number.isSafeInteger(manifest.size) || manifest.size <= 0
        || typeof entry.version.released !== 'string' || !Number.isFinite(Date.parse(entry.version.released))) invalid();
      let source;
      try { source = new URL(manifest.url); } catch { invalid(); }
      if (source.protocol !== 'https:' || source.username || source.password || source.port || source.search || source.hash
        || !['piston-meta.mojang.com', 'launchermeta.mojang.com', 'launcher.mojang.com'].includes(source.hostname)
        || source.pathname !== `/v1/packages/${manifest.sha1}/manifest.json`) invalid();
      const url = mirrorURL(source.href, config);
      if (new URL(url).origin !== new URL(config.bmcl).origin) invalid();
      const runtime = { name, vendor: 'mojang', url, releaseTime: timestamp(entry.version.released),
        checksum: { type: 'sha1', hash: manifest.sha1 }, downloadType: 'manifest', packageType: 'jre',
        version, runtimeOS: 'windows-x64' };
      manifests.set(manifest.sha1, { url, size: manifest.size, sha1: manifest.sha1 });
      const group = groups.get(version.major) || []; group.push(runtime); groups.set(version.major, group);
    }
  }
  if (!groups.size) invalid();
  const components = new Map();
  for (const [major, runtimes] of [...groups].sort(([a], [b]) => a - b)) {
    const releaseTime = runtimes.map(r => r.releaseTime).sort()[0];
    components.set(`java${major}`, { ...base(UID, `Java ${major}`, `java${major}`, releaseTime), runtimes });
  }
  return { index: { formatVersion: 1, uid: UID, name: 'Java Runtimes (BMCL, Windows x64)',
    versions: [...components.values()].map(({ version, releaseTime, type }) => ({ version, releaseTime, type })) }, components, manifests };
}

// Mojang serializes its manifest with Python's default comma/colon spaces.
// BMCL currently returns the same JSON with compact separators. Reconstruct
// that representation only if its bytes match Mojang's advertised SHA1 and
// length. This never substitutes a new hash or accepts changed JSON content.
function mojangJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(mojangJSON).join(', ') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).map(([k, v]) => mojangJSON(k) + ': ' + mojangJSON(v)).join(', ') + '}';
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}
export function restoreJavaManifest(bytes, expected) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { invalid(); }
  if (!value?.files || typeof value.files !== 'object' || Array.isArray(value.files) || !Object.keys(value.files).length) invalid();
  for (const [path, file] of Object.entries(value.files)) {
    if (!path || path.startsWith('/') || /[\\:\u0000-\u001f\u007f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')
      || !file || !['file', 'directory'].includes(file.type)) invalid();
    if (file.type !== 'file') continue;
    const raw = file.downloads?.raw;
    if (!raw || !/^[a-f0-9]{40}$/i.test(raw.sha1 || '') || !Number.isSafeInteger(raw.size) || raw.size < 0) invalid();
    let url; try { url = new URL(raw.url); } catch { invalid(); }
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash
      || !['piston-data.mojang.com', 'launcher.mojang.com', 'launchermeta.mojang.com'].includes(url.hostname)
      || !url.pathname.startsWith('/v1/objects/' + raw.sha1 + '/')) invalid();
  }
  const restored = sha1(bytes) === expected.sha1 ? bytes : Buffer.from(mojangJSON(value));
  if (restored.length !== expected.size || sha1(restored) !== expected.sha1)
    throw new HTTPError(502, 'BMCL Java runtime manifest failed integrity verification');
  return restored;
}
