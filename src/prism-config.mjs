import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const BRIDGE_KEYS = ['MetaURLOverride', 'ResourceURLOverride', 'ResourceURL', 'ProxyType', 'ProxyAddr', 'ProxyHostName',
  'ProxyPort', 'ProxyUser', 'ProxyUsername', 'ProxyPass', 'ProxyPassword'];
function split(content) { return content.replace(/^\uFEFF/, '').split(/\r?\n/); }
export function getGeneral(content) {
  let general = false; const values = {};
  for (const l of split(content)) {
    if (/^\s*\[/.test(l)) { general = /^\s*\[General\]\s*$/.test(l); continue; }
    const m = l.match(/^([^=;#]+)=(.*)$/);
    if (general && m) values[m[1].trim()] = m[2];
  }
  return values;
}
export function patchGeneral(content, changes) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = split(content), out = [], pending = new Map(Object.entries(changes));
  let general = false, found = false;
  const append = () => { for (const [k, v] of pending) if (v !== null) out.push(k + '=' + v); pending.clear(); };
  for (const l of lines) {
    if (/^\s*\[/.test(l)) {
      if (general) append();
      general = /^\s*\[General\]\s*$/.test(l); found ||= general;
    }
    const m = general && l.match(/^([^=;#]+)=/), key = m && m[1].trim();
    if (key && Object.hasOwn(changes, key)) {
      if (pending.has(key) && changes[key] !== null) out.push(key + '=' + changes[key]);
      pending.delete(key);
    } else out.push(l);
  }
  if (!found) out.push('[General]');
  append();
  return (content.startsWith('\uFEFF') ? '\uFEFF' : '') + out.join(newline);
}
export function prismConfigPath(path) {
  return resolve(path.endsWith('.cfg') ? path : join(path, 'prismlauncher.cfg'));
}
function atomicWrite(file, content) {
  const temporary = file + '.bridge-' + randomBytes(6).toString('hex') + '.tmp';
  writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}
export function configurePrism(path, config) {
  const file = prismConfigPath(path);
  if (!existsSync(file)) throw new Error('Select an existing prismlauncher.cfg; run Prism once and close it first.');
  const content = readFileSync(file, 'utf8'), previous = getGeneral(content), backup = file + '.bridge-backup.json';
  const expected = `http://127.0.0.1:${config.port}/meta/v1/`;
  if (existsSync(backup)) {
    const saved = JSON.parse(readFileSync(backup, 'utf8'));
    if (saved.file !== file || saved.owner !== 'PrismMirrorBridge/1') throw new Error('Unrecognized backup file');
  } else {
    const saved = { owner: 'PrismMirrorBridge/1', file, createdAt: new Date().toISOString(), values: Object.fromEntries(BRIDGE_KEYS.map(k => [k, previous[k] ?? null])) };
    writeFileSync(backup, JSON.stringify(saved, null, 2), { mode: 0o600, flag: 'wx' });
  }
  const changes = Object.fromEntries(BRIDGE_KEYS.map(k => [k, null]));
  Object.assign(changes, { MetaURLOverride: expected, ResourceURLOverride: `http://127.0.0.1:${config.port}/assets/`,
    ProxyType: 'HTTP', ProxyAddr: '127.0.0.1', ProxyPort: String(config.port), ProxyUser: '', ProxyPass: '' });
  atomicWrite(file, patchGeneral(content, changes));
  // Do not delete instances or cached metadata. The new metadata index intentionally
  // omits upstream metadata SHA256 references and triggers remote refreshes.
  return { file, backup, previousProxy: previous.ProxyType || 'None' };
}
export function restorePrism(path) {
  const file = prismConfigPath(path), backup = file + '.bridge-backup.json';
  const saved = JSON.parse(readFileSync(backup, 'utf8'));
  if (saved.owner !== 'PrismMirrorBridge/1' || saved.file !== file) throw new Error('Backup does not match selected Prism configuration');
  const values = Object.fromEntries(BRIDGE_KEYS.map(k => [k, saved.values[k] ?? null]));
  atomicWrite(file, patchGeneral(readFileSync(file, 'utf8'), values));
  renameSync(backup, backup + '.restored-' + Date.now());
  return { file, backup };
}
