import { HTTPError } from './transport.mjs';
import { zipJSON } from './zip.mjs';
import { base, EPOCH, convertMinecraft, convertFabric, convertForge, mavenPath } from './converters.mjs';
import { rewriteGameURLs, mirrorURL } from './routing.mjs';

export const PACKAGES = {
  'net.minecraft': 'Minecraft', 'org.lwjgl': 'LWJGL 2', 'org.lwjgl3': 'LWJGL 3',
  'net.fabricmc.fabric-loader': 'Fabric Loader', 'net.fabricmc.intermediary': 'Intermediary Mappings',
  'org.quiltmc.quilt-loader': 'Quilt Loader',
  'net.minecraftforge': 'Forge', 'net.neoforged': 'NeoForge',
};
const COMPAT_UIDS = new Set(['com.azul.java', 'com.ibm.java', 'net.adoptium.java', 'net.minecraft.java',
  'com.mumfrey.liteloader', 'org.lwjgl', 'org.lwjgl3', 'net.minecraftforge', 'net.neoforged',
  'net.fabricmc.intermediary', 'org.quiltmc.intermediary', 'net.fabricmc.legacy-intermediary',
  'net.fabricmc.legacy-fabric-loader', 'org.quiltmc.hashed']);
const forgeCompare = (a, b) => b.version.localeCompare(a.version, 'en', { numeric: true });
const LWJGL_SOURCES = {
  'org.lwjgl': { '2.9.4-nightly-20150209': '1.12.2' },
  'org.lwjgl3': { '3.3.1': '1.20.1' },
};
export function forgeMavenEntry(fullVersion) {
  const m = fullVersion.match(/^([^-]+)-([\d.]+)(?:-(.+))?$/);
  return m ? { version: m[2], fullVersion, minecraft: m[1].replace('_pre', '-pre'), branch: m[3] || null } : null;
}
export function neoMinecraftVersion(version) {
  const parts = version.split(/[.+-]/), major = Number(parts[0]), minor = Number(parts[1]);
  if (major < 26) return `1.${major}${minor ? '.' + minor : ''}`;
  const patch = Number(parts[2]), base = `${major}.${minor}${patch ? '.' + patch : ''}`;
  const preview = version.match(/\+(snapshot|pre|rc)-\d+$/);
  return base + (preview ? '-' + preview[0].slice(1) : '');
}

export class MetadataService {
  constructor(config, transport, onSource = () => {}) {
    this.config = config; this.t = transport; this.onSource = onSource;
    this.memoized = new Map();
    this.graphicsAliases = new Map(Object.entries(LWJGL_SOURCES).flatMap(([uid, entries]) => Object.entries(entries).map(([version, source]) => [uid + ':' + version, source])));
  }
  async memo(key, fn) {
    const existing = this.memoized.get(key);
    if (existing && existing.until > Date.now()) return structuredClone(await existing.promise);
    const promise = fn(); this.memoized.set(key, { until: Date.now() + this.config.cacheSeconds * 1000, promise });
    try { return structuredClone(await promise); } catch (e) { this.memoized.delete(key); throw e; }
  }
  bmcl(path) { this.onSource('bmcl'); return this.config.bmcl + path; }
  async manifest() { return this.t.json(this.bmcl('/mc/game/version_manifest_v2.json')); }
  async minecraft(version) {
    const manifest = await this.manifest();
    const entry = manifest.versions.find(v => v.id === version);
    if (!entry) throw new HTTPError(404, 'Unknown Minecraft version');
    return this.memo('mc:' + version, async () => {
      const primary = this.bmcl('/version/' + encodeURIComponent(version) + '/json');
      let raw;
      try { raw = await this.t.json(primary); }
      catch (error) {
        if (!(error instanceof HTTPError) || ![404, 500, 502, 503, 504].includes(error.status) || !entry.url) throw error;
        const alternate = mirrorURL(entry.url, this.config);
        // Both routes stay at BMCL. Never turn an outage into an implicit
        // request to Mojang or to an arbitrary URL from a manifest.
        if (alternate === primary || new URL(alternate).origin !== new URL(this.config.bmcl).origin) throw error;
        this.onSource('bmcl'); raw = await this.t.json(alternate);
      }
      const converted = convertMinecraft(raw, this.config);
      const core = raw.libraries.find(l => /^org\.lwjgl(?:\.lwjgl)?:lwjgl:/.test(l.name));
      if (core) this.graphicsAliases.set(converted.graphics.uid + ':' + core.name.split(':')[2], version);
      return converted;
    });
  }
  async compatibility(uid, file) {
    if (!this.config.compatibilityRecipes || !COMPAT_UIDS.has(uid)) throw new HTTPError(501, 'No BMCL converter for this component/version; compatibility recipes are disabled or unavailable');
    this.onSource('prism-compatibility');
    const value = await this.t.json(new URL(encodeURIComponent(uid) + '/' + encodeURIComponent(file), this.config.prismRecipes).href);
    // Changing nested URLs invalidates all metadata-file SHA256 references.
    delete value.sha256;
    for (const v of value.versions || []) delete v.sha256;
    return rewriteGameURLs(value, this.config);
  }
  async loaderList(quilt = false) {
    return this.t.json(this.bmcl((quilt ? '/quilt-meta/v3' : '/fabric-meta/v2') + '/versions/loader'));
  }
  async mappingsList(quilt = false) {
    return this.t.json(this.bmcl((quilt ? '/quilt-meta/v3' : '/fabric-meta/v2') + '/versions/' + (quilt ? 'hashed' : 'intermediary')));
  }
  async forgeList(neo = false) {
    return this.memo('forge-list:' + neo, async () => {
      const xml = await this.t.text(this.bmcl('/maven/net/' + (neo ? 'neoforged/neoforge' : 'minecraftforge/forge') + '/maven-metadata.xml'));
      const entries = [...xml.matchAll(/<version>\s*([^<]+?)\s*<\/version>/g)].map(m => m[1]);
      const values = [];
      for (const full of entries) {
        if (neo) {
          // Use BMCL's per-version detail for ambiguous 26.x/snapshot versions;
          // older NeoForge version numbers encode the Minecraft minor/patch.
          values.push({ version: full, fullVersion: full, minecraft: neoMinecraftVersion(full) });
        } else {
          const entry = forgeMavenEntry(full);
          if (entry) values.push(entry);
        }
      }
      // NeoForge's initial 1.20.1 builds use the net.neoforged:forge artifact.
      if (neo) {
        const old = await this.t.json(this.bmcl('/neoforge/list/1.20.1'));
        for (const e of old) values.push({ version: e.version, fullVersion: e.rawVersion, minecraft: '1.20.1', artifact: 'forge' });
      }
      // Branch suffixes belong to Maven coordinates, not Prism component IDs.
      const unique = new Map();
      for (const entry of values) if (!unique.has(entry.version) || entry.branch) unique.set(entry.version, entry);
      return [...unique.values()].sort(forgeCompare);
    });
  }
  async index(uid) {
    const out = { formatVersion: 1, uid, name: PACKAGES[uid], versions: [] };
    if (uid === 'net.minecraft') {
      const m = await this.manifest();
      out.versions = m.versions.map(v => ({ version: v.id, type: v.type, releaseTime: v.releaseTime,
        recommended: v.id === m.latest.release, volatile: v.type !== 'release' }));
    } else if (uid === 'org.lwjgl' || uid === 'org.lwjgl3') {
      const m = await this.manifest();
      const modernBoundary = Date.parse('2017-10-25T00:00:00Z');
      out.versions = m.versions.filter(v => (Date.parse(v.releaseTime) >= modernBoundary) === (uid === 'org.lwjgl3'))
        .map(v => ({ version: 'bridge-' + v.id, releaseTime: v.releaseTime, type: v.type }));
      out.versions.push(...[...this.graphicsAliases.keys()].filter(key => key.startsWith(uid + ':')).map(key => ({ version: key.slice(uid.length + 1), releaseTime: EPOCH, type: 'release' })));
    } else if (['net.fabricmc.fabric-loader', 'org.quiltmc.quilt-loader'].includes(uid)) {
      const list = await this.loaderList(uid.startsWith('org.quiltmc'));
      let recommended = false;
      out.versions = list.map(v => {
        const r = !recommended && (v.stable || !/-/.test(v.version)); recommended ||= r;
        return { version: v.version, type: /beta|alpha/.test(v.version) ? 'beta' : 'release', releaseTime: EPOCH,
          recommended: r, requires: [{ uid: 'net.fabricmc.intermediary' }] };
      });
    } else if (['net.fabricmc.intermediary', 'org.quiltmc.hashed'].includes(uid)) {
      const list = await this.mappingsList(uid.startsWith('org.quiltmc'));
      out.versions = list.map(v => ({ version: v.version, releaseTime: EPOCH, type: 'release', volatile: true,
        requires: [{ uid: 'net.minecraft', equals: v.version }] }));
    } else if (uid === 'net.minecraftforge' || uid === 'net.neoforged') {
      const list = await this.forgeList(uid === 'net.neoforged'), recommendedMC = new Set();
      out.versions = list.map(v => {
        const recommend = !recommendedMC.has(v.minecraft) && !/beta|alpha/.test(v.version);
        if (recommend) recommendedMC.add(v.minecraft);
        return { version: v.version, releaseTime: EPOCH, type: /beta|alpha/.test(v.version) ? 'beta' : 'release',
          recommended: recommend, requires: [{ uid: 'net.minecraft', equals: v.minecraft }] };
      });
    } else return this.compatibility(uid, 'index.json');
    return out;
  }
  async component(uid, version) {
    if (uid === 'net.minecraft') return (await this.minecraft(version)).minecraft;
    if (uid === 'org.lwjgl' || uid === 'org.lwjgl3') {
      if (!version.startsWith('bridge-')) {
        const source = this.graphicsAliases.get(uid + ':' + version);
        if (source) {
          const graphics = (await this.minecraft(source)).graphics;
          if (graphics.uid !== uid) throw new HTTPError(404, 'LWJGL alias generation mismatch');
          graphics.version = version;
          return graphics;
        }
        return this.compatibility(uid, version + '.json');
      }
      const graphics = (await this.minecraft(version.slice(7))).graphics;
      if (graphics.uid !== uid) throw new HTTPError(404, 'LWJGL generation does not match Minecraft version');
      return graphics;
    }
    if (uid === 'net.fabricmc.fabric-loader') {
      const list = await this.loaderList();
      if (!list.some(v => v.version === version)) throw new HTTPError(404, 'Unknown Fabric version');
      const details = await this.t.json(this.bmcl('/fabric-meta/v2/versions/loader/1.20.1/' + encodeURIComponent(version)));
      return convertFabric(details, version, this.config);
    }
    if (uid === 'org.quiltmc.quilt-loader') {
      const list = await this.loaderList(true);
      if (!list.some(v => v.version === version)) throw new HTTPError(404, 'Unknown Quilt version');
      return this.memo('quilt:' + version, async () => {
        const jar = await this.t.limit.run(() => this.t.bytes(this.bmcl('/maven/' + mavenPath('org.quiltmc:quilt-loader:' + version))));
        const data = zipJSON(jar, 'quilt_installer.json');
        return convertFabric(data, version, this.config, true);
      });
    }
    if (uid === 'net.fabricmc.intermediary' || uid === 'org.quiltmc.hashed') {
      const quilt = uid.startsWith('org.quiltmc');
      const list = await this.mappingsList(quilt), entry = list.find(v => v.version === version);
      if (!entry) throw new HTTPError(404, 'Mappings not available for this game version');
      const out = base(uid, quilt ? 'Quilt Mappings' : 'Intermediary Mappings', version, EPOCH, 11);
      out.requires = [{ uid: 'net.minecraft', equals: version }]; out.volatile = true;
      out.libraries = [{ name: entry.maven, url: this.config.bmcl + '/maven/' }];
      return out;
    }
    if (uid === 'net.minecraftforge' || uid === 'net.neoforged') {
      const neo = uid === 'net.neoforged', list = await this.forgeList(neo), entry = list.find(v => v.version === version);
      if (!entry) throw new HTTPError(404, 'Unknown Forge/NeoForge version');
      return this.memo(uid + ':' + version, async () => {
        const group = neo ? 'net.neoforged' : 'net.minecraftforge', artifact = entry.artifact || (neo ? 'neoforge' : 'forge');
        const installerURL = this.bmcl('/maven/' + mavenPath(`${group}:${artifact}:${entry.fullVersion}:installer`));
        try {
          const installer = await this.t.limit.run(() => this.t.bytes(installerURL));
          const profile = zipJSON(installer, 'install_profile.json');
          if (!profile) throw new Error('Missing install_profile.json');
          const versionManifest = zipJSON(installer, (profile.json || '/version.json').replace(/^\//, ''));
          return convertForge({ profile, versionManifest, installerURL, installer, version,
            minecraft: entry.minecraft, fullVersion: entry.fullVersion, neo }, this.config);
        } catch (e) {
          if (!this.config.compatibilityRecipes) throw e;
          return this.compatibility(uid, version + '.json');
        }
      });
    }
    return this.compatibility(uid, version + '.json');
  }
  async request(path) {
    // Do not allow URL normalization or percent encoding to turn a component
    // name into a different upstream path.
    if (path === 'index.json') return { formatVersion: 1, packages: [
      ...Object.entries(PACKAGES).map(([uid, name]) => ({ uid, name })),
      ...(this.config.compatibilityRecipes ? ['com.azul.java', 'com.ibm.java', 'net.adoptium.java', 'net.minecraft.java'].map(uid => ({ uid, name: 'Java Runtimes' })) : []),
    ] };
    const m = path.match(/^([a-zA-Z0-9_.-]+)\/([^/]+)\.json$/);
    if (!m || m[1].includes('..')) throw new HTTPError(404, 'Unknown metadata path');
    const uid = m[1]; let version;
    try { version = decodeURIComponent(m[2]); } catch { throw new HTTPError(404, 'Invalid metadata encoding'); }
    // Mojang has real IDs with spaces (for example 3D Shareware v1.34).
    // Decode one path segment, while rejecting separators, nested escapes and
    // control characters instead of rejecting every percent-encoded name.
    if (/[\\/%?#\u0000-\u001f\u007f]/.test(version) || version.includes('..') || version.length > 200) throw new HTTPError(404, 'Unknown metadata path');
    return version === 'index' ? this.index(uid) : this.component(uid, version);
  }
}
