import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { HTTPError } from './transport.mjs';
import { mirrorURL } from './routing.mjs';

const MAX_BYTES = 1024 * 1024;
const sha1 = bytes => createHash('sha1').update(bytes).digest('hex');

// A Mojang Java manifest contains the same licence object at many different
// installation paths. Coalesce/cache only small objects registered from an
// already verified manifest; ordinary downloads keep their streaming path.
export class JavaFileCache {
  constructor(config, transport, onSource = () => {}) {
    this.config = config; this.t = transport; this.onSource = onSource;
    this.objects = new Map(); this.pending = new Map();
  }
  registerVerifiedManifest(bytes) {
    const files = JSON.parse(bytes).files;
    for (const file of Object.values(files)) {
      const raw = file.type === 'file' && file.downloads?.raw;
      if (raw && Number.isSafeInteger(raw.size) && raw.size >= 0 && raw.size <= MAX_BYTES)
        this.objects.set(raw.url, { url: raw.url, sha1: raw.sha1, size: raw.size });
    }
  }
  lookup(url) { return this.objects.get(url); }
  async bytes(source) {
    if (this.pending.has(source.sha1)) {
      this.onSource('java-file-cache-hit');
      return this.pending.get(source.sha1);
    }
    const job = (async () => {
      const directory = join(this.config.dataDir, 'java-files'), path = join(directory, source.sha1);
      try {
        const bytes = await readFile(path);
        if (bytes.length !== source.size || sha1(bytes) !== source.sha1)
          throw new HTTPError(502, 'Cached Java file failed integrity verification');
        this.onSource('java-file-cache-hit'); return bytes;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.onSource('java-file-download'); this.onSource('bmcl');
      const bytes = await this.t.limit.run(() => this.t.bytes(mirrorURL(source.url, this.config), { maxBytes: MAX_BYTES }));
      if (bytes.length !== source.size || sha1(bytes) !== source.sha1)
        throw new HTTPError(502, 'BMCL Java file failed integrity verification');
      await mkdir(directory, { recursive: true });
      const temporary = path + '.' + randomBytes(6).toString('hex');
      await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, path);
      return bytes;
    })();
    this.pending.set(source.sha1, job);
    try { return await job; } finally { this.pending.delete(source.sha1); }
  }
}
