import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertPrismClosed, resumeMetadataSwitch, switchMetadata, validateMetadataState } from './prism-metadata-state.mjs';

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
function readBackup(file, backup, io) {
  const stat = io.lstatSync(backup);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unrecognized backup file');
  const saved = JSON.parse(io.readFileSync(backup, 'utf8'));
  if (saved.file !== file || saved.owner !== 'PrismMirrorBridge/1' || !saved.values
      || Object.values(saved.values).some(v => v !== null && (typeof v !== 'string' || /[\r\n]/.test(v))))
    throw new Error('Backup does not match selected Prism configuration');
  validateMetadataState(saved, BRIDGE_KEYS);
  return saved;
}
const patch = patchGeneral;
function archiveBackup(backup, io) {
  const archived = backup + '.restored-' + Date.now() + '-' + randomBytes(6).toString('hex');
  io.renameSync(backup, archived); return archived;
}
export function configurePrism(path, config, { io = fs, checkClosed = assertPrismClosed, forceMetadata = false } = {}) {
  checkClosed();
  const file = prismConfigPath(path);
  if (!io.existsSync(file)) throw new Error('Select an existing prismlauncher.cfg; run Prism once and close it first.');
  const fileStat = io.lstatSync(file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('Select the real Prism configuration file, not a symbolic link.');
  const backup = file + '.bridge-backup.json';
  const expected = `http://127.0.0.1:${config.port}/meta/v1/`;
  let saved, freshBackup = false;
  if (io.existsSync(backup)) {
    saved = readBackup(file, backup, io);
    resumeMetadataSwitch({ file, backup, saved, patch, io, checkClosed });
    if (saved.metadataState?.lastOperation === 'restore') { archiveBackup(backup, io); saved = undefined; }
  }
  const previous = getGeneral(io.readFileSync(file, 'utf8'));
  if (!saved) {
    if (previous.MetaURLOverride === expected) throw new Error('Prism already points to this bridge but its original backup is missing. Preserve the current files and restore your original network settings before a new setup.');
    saved = { owner: 'PrismMirrorBridge/1', file, createdAt: new Date().toISOString(), values: Object.fromEntries(BRIDGE_KEYS.map(k => [k, previous[k] ?? null])) };
    io.writeFileSync(backup, JSON.stringify(saved, null, 2), { mode: 0o600, flag: 'wx' });
    freshBackup = true;
  }
  const changes = Object.fromEntries(BRIDGE_KEYS.map(k => [k, null]));
  Object.assign(changes, { MetaURLOverride: expected, ResourceURLOverride: `http://127.0.0.1:${config.port}/assets/`,
    ProxyType: 'HTTP', ProxyAddr: '127.0.0.1', ProxyPort: String(config.port), ProxyUser: '', ProxyPass: '' });
  const metadata = switchMetadata({ file, backup, saved, changes, operation: 'configure', freshBackup, force: forceMetadata, patch, readGeneral: getGeneral, io, checkClosed });
  return { file, backup, previousProxy: previous.ProxyType || 'None', metadata };
}
export function repairPrismMetadata(path, config, options = {}) {
  const io = options.io || fs, file = prismConfigPath(path);
  (options.checkClosed || assertPrismClosed)();
  const current = getGeneral(io.readFileSync(file, 'utf8'));
  if (current.MetaURLOverride !== `http://127.0.0.1:${config.port}/meta/v1/` || !io.existsSync(file + '.bridge-backup.json'))
    throw new Error('Repair requires an existing bridge configuration and its original backup. Run setup for the selected Prism directory first.');
  return configurePrism(path, config, { ...options, forceMetadata: true });
}
export function restorePrism(path, { io = fs, checkClosed = assertPrismClosed } = {}) {
  checkClosed();
  const file = prismConfigPath(path), backup = file + '.bridge-backup.json';
  const fileStat = io.lstatSync(file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('Select the real Prism configuration file, not a symbolic link.');
  const saved = readBackup(file, backup, io);
  resumeMetadataSwitch({ file, backup, saved, patch, io, checkClosed });
  const values = Object.fromEntries(BRIDGE_KEYS.map(k => [k, saved.values[k] ?? null]));
  const metadata = saved.metadataState?.lastOperation === 'restore' ? { migrated: false }
    : switchMetadata({ file, backup, saved, changes: values, operation: 'restore', patch, readGeneral: getGeneral, io, checkClosed });
  const archivedBackup = archiveBackup(backup, io);
  return { file, backup: archivedBackup, metadata };
}
