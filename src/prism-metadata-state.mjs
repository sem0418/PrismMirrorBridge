import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Disk metadata cannot reset an already-running Prism's Meta::Version objects.
// This guard also applies to direct CLI users, not only the Windows batch files.
export function assertPrismClosed({ platform = process.platform, run = spawnSync } = {}) {
  const windows = platform === 'win32';
  const command = windows ? 'powershell.exe' : 'ps';
  const args = windows
    ? ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $p=@(Get-Process -Name prismlauncher -ErrorAction SilentlyContinue); if ($p.Count -gt 0) { exit 3 }; exit 0"]
    : ['-A', '-o', 'comm='];
  const result = run(command, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (result.error || ![0, ...(windows ? [3] : [])].includes(result.status))
    throw new Error('Cannot verify that Prism is closed. Operation stopped; keep any recorded metadata backups and retry after closing Prism.');
  const running = windows ? result.status === 3
    : String(result.stdout).split(/\r?\n/).some(line => /^(?:prismlauncher|prismlauncher\.exe)$/i.test(line.trim().split('/').pop()));
  if (running) throw new Error('Prism is still running. Close all Prism windows and processes, then retry; disk changes cannot reset its in-memory checksum state.');
}

export function atomicWrite(file, content, io = fs) {
  const temporary = file + '.bridge-' + randomBytes(8).toString('hex') + '.tmp';
  let descriptor, created = false;
  try {
    descriptor = io.openSync(temporary, 'wx', 0o600); created = true;
    io.writeFileSync(descriptor, content);
    io.closeSync(descriptor); descriptor = undefined;
    io.renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch {} }
    if (created) { try { io.unlinkSync(temporary); } catch {} }
    throw error;
  }
}

const archiveName = name => typeof name === 'string' && /^meta\.prism-bridge-[a-f0-9]{32}$/.test(name);
const moveName = name => name === 'meta' || archiveName(name);
function validateState(state) {
  if (!state || state.schema !== 1 || typeof state.source !== 'string'
      || !['configure', 'restore'].includes(state.lastOperation)
      || !Array.isArray(state.archives) || state.archives.some(name => !archiveName(name))
      || (state.originalCache !== null && (!archiveName(state.originalCache) || !state.archives.includes(state.originalCache))))
    throw new Error('Unrecognized metadata migration state; saved data was not changed.');
}
export function validateMetadataState(saved, keys) {
  if (saved.metadataState !== undefined) validateState(saved.metadataState);
  if (saved.metadataPending !== undefined) {
    const p = saved.metadataPending;
    if (!p || !['configure', 'restore'].includes(p.operation) || !p.changes || !Array.isArray(p.moves)
        || p.moves.length > 2 || p.moves.some(m => !moveName(m.from) || !moveName(m.to) || m.from === m.to || typeof m.complete !== 'boolean')
        || Object.keys(p.changes).some(k => !keys.includes(k))
        || Object.values(p.changes).some(v => v !== null && (typeof v !== 'string' || /[\r\n]/.test(v))))
      throw new Error('Unrecognized pending metadata migration; saved data was not changed.');
    validateState(p.nextState);
  }
}
function directory(root, name, io) {
  let stat;
  try { stat = io.lstatSync(join(root, name)); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Metadata paths must be real directories, not files or symbolic links.');
  return true;
}
const persist = (backup, saved, io) => atomicWrite(backup, JSON.stringify(saved, null, 2) + '\n', io);

// The pending move plan is saved before any directory rename. A later run can
// finish after interruption, including a rename completed before its checkpoint.
export function resumeMetadataSwitch({ file, backup, saved, patch, io = fs, checkClosed = assertPrismClosed }) {
  const pending = saved.metadataPending;
  if (!pending) return false;
  const root = dirname(file);
  for (const move of pending.moves) {
    if (move.complete) continue;
    checkClosed();
    const from = directory(root, move.from, io), to = directory(root, move.to, io);
    if (from && !to) io.renameSync(join(root, move.from), join(root, move.to));
    else if (from || !to) throw new Error('Metadata migration has conflicting or missing directories. Nothing was overwritten; keep the metadata backups and close Prism before retrying.');
    move.complete = true;
    persist(backup, saved, io);
  }
  checkClosed();
  atomicWrite(file, patch(io.readFileSync(file, 'utf8'), pending.changes), io);
  saved.metadataState = pending.nextState;
  delete saved.metadataPending;
  persist(backup, saved, io);
  return true;
}

export function switchMetadata({ file, backup, saved, changes, operation, freshBackup = false, force = false,
  patch, readGeneral, io = fs, checkClosed = assertPrismClosed }) {
  const root = dirname(file), state = saved.metadataState;
  const source = changes.MetaURLOverride || '';
  const current = io.readFileSync(file, 'utf8');
  const currentSource = readGeneral(current).MetaURLOverride || '';
  if (operation === 'configure' && !force && state?.lastOperation === 'configure' && state.source === source && currentSource === source) {
    checkClosed(); atomicWrite(file, patch(current, changes), io);
    return { migrated: false, archives: state.archives.map(name => join(root, name)) };
  }
  const nextState = { schema: 1, source, originalCache: state?.originalCache ?? null,
    archives: [...(state?.archives || [])], lastOperation: operation };
  const moves = [];
  if (directory(root, 'meta', io)) {
    const archived = 'meta.prism-bridge-' + randomBytes(16).toString('hex');
    if (directory(root, archived, io)) throw new Error('Metadata backup path already exists.');
    moves.push({ from: 'meta', to: archived, complete: false });
    nextState.archives.push(archived);
    // Only a snapshot taken on a new first-time setup is known to represent
    // the pre-bridge cache. A 1.0.0/1.0.1 cache can already mix both sources.
    if (operation === 'configure' && freshBackup) nextState.originalCache = archived;
  }
  if (operation === 'restore' && nextState.originalCache) {
    if (!directory(root, nextState.originalCache, io)) throw new Error('The original metadata snapshot is missing; restore stopped before changing data.');
    moves.push({ from: nextState.originalCache, to: 'meta', complete: false });
    nextState.originalCache = null;
  }
  saved.metadataPending = { operation, changes, moves, nextState };
  persist(backup, saved, io);
  resumeMetadataSwitch({ file, backup, saved, patch, io, checkClosed });
  return { migrated: true, archives: nextState.archives.map(name => join(root, name)) };
}
