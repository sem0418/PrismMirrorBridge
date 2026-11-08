import { readFileSync } from 'node:fs';
import { rewriteGameURLs } from './routing.mjs';
import { createHash } from 'node:crypto';

const data = name => JSON.parse(readFileSync(new URL('../data/' + name, import.meta.url), 'utf8'));
const patches = data('library-patches.json');
const overrides = data('legacy-overrides.json').versions;
const legacyServices = new Set(data('legacy-services.json'));
export const EPOCH = '1970-01-01T00:00:00+00:00';
export const DEFAULT_GAME_ARGS = '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type} --versionType ${version_type}';
export function timestamp(value) {
  if (!value) return EPOCH;
  // Some installer manifests use local ISO timestamps or nanosecond precision.
  let s = String(value).replace(/(\.\d{3})\d+/, '$1');
  if (!/[Zz]$|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  return Number.isNaN(Date.parse(s)) ? EPOCH : new Date(s).toISOString();
}
export function base(uid, name, version, time, order = 10) {
  return { formatVersion: 1, uid, name, version, releaseTime: timestamp(time), type: 'release', order };
}
export function mavenPath(coordinate) {
  const [c, extension = 'jar'] = coordinate.split('@'), [g, a, v, classifier] = c.split(':');
  if (!g || !a || !v || /[\/\\]/.test(coordinate)) throw new Error('Invalid Maven coordinate');
  return `${g.replaceAll('.', '/')}/${a}/${v}/${a}-${v}${classifier ? '-' + classifier : ''}.${extension}`;
}
function merge(a, b) {
  const r = structuredClone(a);
  for (const [k, v] of Object.entries(b)) {
    if (Array.isArray(v)) r[k] = [...(r[k] || []), ...structuredClone(v)];
    else if (v && typeof v === 'object') r[k] = merge(r[k] || {}, v);
    else if (v !== null) r[k] = v;
  }
  return r;
}
const lwjgl = lib => /^(org\.lwjgl(?:\.lwjgl)?|net\.java\.jinput|net\.java\.jutils):/.test(lib.name);
function nativeArch(lib) {
  const name = lib.name;
  let target;
  if (/natives-(?:macos|osx)-(?:arm64|aarch64)/.test(name)) target = ['osx', 'osx-arm64'];
  else if (/natives-windows-(?:arm64|aarch64)/.test(name)) target = ['windows', 'windows-arm64'];
  else if (/natives-linux-(?:arm64|aarch64)/.test(name)) target = ['linux', 'linux-arm64'];
  else if (/natives-linux-(?:arm32|aarch32)/.test(name)) target = ['linux', 'linux-arm32'];
  else if (/natives-linux-riscv64/.test(name)) target = ['linux', 'linux-riscv64'];
  if (target && lib.rules?.some(r => r.action === 'allow' && r.os?.name === target[0])) {
    lib.rules = lib.rules.filter(r => !(r.action === 'allow' && r.os?.name === target[0]));
    lib.rules.push({ action: 'allow', os: { name: target[1] } });
  }
  return lib;
}
function patchOne(original) {
  let lib = structuredClone(original), extras = [];
  for (const p of patches) if (p.match.includes(lib.name)) {
    if (p.override) lib = merge(lib, p.override);
    for (const extra of p.additionalLibraries || []) extras.push(...(p.patchAdditionalLibraries ? patchOne(extra) : [structuredClone(extra)]));
  }
  return [nativeArch(lib), ...extras];
}
function patchedLibraries(libs) {
  const result = [], seen = new Set();
  for (const original of libs) {
    const lib = structuredClone(original);
    // Prism merges libraries by Maven artifact; split-native artifacts need a
    // distinct artifact name so OS variants cannot overwrite one another.
    // Upstream patch keys use the split-native artifact names. Apply the
    // rename before matching fixes such as LWJGL 3.3.1's Linux GLFW patch.
    const parts = lib.name.split(':');
    if (parts[3]?.startsWith('natives-')) { parts[1] += '-' + parts[3]; parts.splice(3, 1); lib.name = parts.join(':'); }
    for (let v of patchOne(lib)) {
      for (const artifact of [v.downloads?.artifact, ...Object.values(v.downloads?.classifiers || {})]) if (artifact) delete artifact.path;
      const key = JSON.stringify(v);
      if (!seen.has(key)) { seen.add(key); result.push(v); }
    }
  }
  return result;
}
function argumentString(value) {
  // Mojang arguments normally contain no literal whitespace. Preserve quoting
  // for future arguments which do; Prism's splitter understands double quotes.
  return /\s|"/.test(value) ? '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"' : value;
}
export function gameArguments(raw) {
  if (typeof raw.minecraftArguments === 'string') return { args: raw.minecraftArguments, traits: [] };
  const traits = [], values = [], game = raw.arguments?.game || [];
  const supported = new Set(['is_quick_play_singleplayer', 'is_quick_play_multiplayer']);
  for (const value of game) {
    if (typeof value === 'string') {
      if (!['--clientId', '${clientid}', '--xuid', '${auth_xuid}'].includes(value)) values.push(argumentString(value));
    } else {
      for (const r of value.rules || []) for (const [feature, on] of Object.entries(r.features || {}))
        if (r.action === 'allow' && on && supported.has(feature)) traits.push('feature:' + feature);
    }
  }
  return { args: values.join(' '), traits: [...new Set(traits)] };
}

function fixLog4j(lib) {
  const [group, artifact, version] = lib.name.split(':');
  if (group !== 'org.apache.logging.log4j') return lib;
  const v = version.split(/[.-]/).map(Number);
  // Match upstream Prism's two compatibility replacements, including hashes.
  let replacement, hashes;
  if (v[0] < 2 || (v[0] === 2 && v[1] === 0)) {
    replacement = '2.0-beta9-fixed';
    hashes = { 'log4j-api': ['b61eaf2e64d8b0277e188262a8b771bbfa1502b3', 107347], 'log4j-core': ['677991ea2d7426f76309a73739cecf609679492c', 677588] };
  } else if (v[0] === 2 && (v[1] < 17 || v[1] === 17 && (v[2] || 0) <= 1)) {
    replacement = '2.17.1';
    hashes = { 'log4j-api': ['d771af8e336e372fb5399c99edabe0919aeaf5b2', 301872], 'log4j-core': ['779f60f3844dadc3ef597976fcb1e5127b1f343d', 1790452], 'log4j-slf4j18-impl': ['ca499d751f4ddd8afb016ef698c30be0da1d09f7', 21268] };
  }
  if (!replacement || !hashes[artifact]) return lib;
  const name = `${group}:${artifact}:${replacement}`, [sha1, size] = hashes[artifact];
  return { name, downloads: { artifact: { sha1, size, url: (replacement.endsWith('fixed') ? 'https://files.prismlauncher.org/maven/' : 'https://libraries.minecraft.net/') + mavenPath(name) } } };
}

export function convertMinecraft(raw, config) {
  if (!raw || typeof raw.id !== 'string' || !raw.downloads?.client?.sha1 || !Array.isArray(raw.libraries)) throw new Error('Invalid Mojang version manifest');
  if (raw.complianceLevel > 1) throw new Error('Unsupported Mojang complianceLevel: ' + raw.complianceLevel);
  const out = base('net.minecraft', 'Minecraft', raw.id, raw.releaseTime, -2);
  out.type = raw.type === 'pending' ? 'experiment' : raw.type;
  out.mainClass = raw.mainClass;
  if (raw.assets) out.assets = raw.assets;
  if (raw.assetIndex) out.assetIndex = structuredClone(raw.assetIndex);
  out.mainJar = { name: `com.mojang:minecraft:${raw.id}:client`, downloads: { artifact: structuredClone(raw.downloads.client) } };
  const major = raw.javaVersion?.majorVersion || 8;
  out.compatibleJavaMajors = major === 16 ? [16, 17] : [major];
  out.compatibleJavaName = raw.javaVersion?.component || 'jre-legacy';
  const args = gameArguments(raw); out.minecraftArguments = args.args;
  out['+traits'] = [...(raw.complianceLevel === 1 ? ['XR:Initial'] : []), ...args.traits];
  out['+jvmArgs'] = (raw.arguments?.jvm || []).filter(a => typeof a === 'string' && a.startsWith('-XX:StackShadowPages='));
  const graphics = raw.libraries.filter(lwjgl), rest = raw.libraries.filter(l => !lwjgl(l));
  out.libraries = patchedLibraries(rest.map(fixLog4j));
  const modern = graphics.some(l => l.name.startsWith('org.lwjgl:'));
  const graphicsUid = modern ? 'org.lwjgl3' : 'org.lwjgl';
  if (modern) out['+traits'].push('FirstThreadOnMacOS');
  if (graphics.length) out.requires = [{ uid: graphicsUid, suggests: 'bridge-' + raw.id }];
  const special = overrides[raw.id];
  if (special) {
    delete out.mainClass;
    if (special.mainClass) out.mainClass = special.mainClass;
    if (special.appletClass) out.appletClass = special.appletClass;
    if (special.releaseTime) out.releaseTime = timestamp(special.releaseTime);
    out['+traits'].push(...(special['+traits'] || []));
    out['+jvmArgs'].push(...(special['+jvmArgs'] || []));
    out.libraries = []; // The legacy launcher supplies its own bootstrap libraries.
  }
  if (legacyServices.has(raw.id)) out['+traits'].push('legacyServices');
  const snap = raw.id.match(/^13w(\d\d)[a-c]$/);
  if (snap && Number(snap[1]) >= 16 && Number(snap[1]) <= 23) out['+traits'].push(...(raw.id !== '13w23b' ? ['legacyLaunch', 'texturepacks'] : ['texturepacks']));
  out['+traits'] = [...new Set(out['+traits'])];
  const graphicsComponent = base(graphicsUid, modern ? 'LWJGL 3 (BMCL)' : 'LWJGL 2 (BMCL)', 'bridge-' + raw.id, raw.releaseTime, -1);
  graphicsComponent.volatile = true;
  graphicsComponent.conflicts = [{ uid: modern ? 'org.lwjgl' : 'org.lwjgl3' }];
  graphicsComponent.libraries = patchedLibraries(graphics.filter(l => !modern || !/^net\.java\.j(?:input|utils):/.test(l.name)));
  return { minecraft: rewriteGameURLs(out, config), graphics: rewriteGameURLs(graphicsComponent, config) };
}

export function convertFabric(details, version, config, quilt = false) {
  const uid = quilt ? 'org.quiltmc.quilt-loader' : 'net.fabricmc.fabric-loader';
  const mappingsUid = 'net.fabricmc.intermediary'; // Quilt currently uses Fabric intermediary mappings.
  const meta = details.launcherMeta || details;
  if (!meta.libraries || !meta.mainClass) throw new Error('Loader installer metadata is incomplete');
  const out = base(uid, quilt ? 'Quilt Loader' : 'Fabric Loader', version, details.releaseTime, 10);
  out.type = /beta|alpha/.test(version) ? 'beta' : 'release';
  out.mainClass = typeof meta.mainClass === 'string' ? meta.mainClass : meta.mainClass.client;
  out.requires = [{ uid: mappingsUid }];
  out.libraries = [...(meta.libraries.common || []), ...(meta.libraries.client || []), {
    name: `${quilt ? 'org.quiltmc:quilt-loader' : 'net.fabricmc:fabric-loader'}:${version}`,
    url: quilt ? 'https://maven.quiltmc.org/repository/release/' : 'https://maven.fabricmc.net/',
  }].map(lib => {
    const v = structuredClone(lib);
    if (v.sha1 && Number.isInteger(v.size)) v.downloads = { artifact: { url: new URL(mavenPath(v.name), v.url).href, sha1: v.sha1, size: v.size } };
    for (const k of ['md5', 'sha1', 'sha256', 'sha512', 'size']) delete v[k];
    return v;
  });
  return rewriteGameURLs(out, config);
}

export const FORGE_WRAPPER = {
  name: 'io.github.zekerzhayard:ForgeWrapper:prism-2026-08-01',
  downloads: { artifact: { sha1: '852b7e59748da1512d40e38407eadb1f0031a996', size: 29800,
    url: 'https://files.prismlauncher.org/maven/io/github/zekerzhayard/ForgeWrapper/prism-2026-08-01/ForgeWrapper-prism-2026-08-01.jar' } },
};
export function convertForge({ profile, versionManifest, installerURL, installer, version, minecraft, fullVersion, neo = false }, config) {
  const uid = neo ? 'net.neoforged' : 'net.minecraftforge';
  const out = base(uid, neo ? 'NeoForge' : 'Forge', version, versionManifest?.releaseTime || profile.versionInfo?.releaseTime, 5);
  out.type = /beta|alpha/.test(version) ? 'beta' : 'release';
  out.requires = [{ uid: 'net.minecraft', equals: profile.minecraft || minecraft }];
  if (versionManifest?.arguments) {
    out.mainClass = 'io.github.zekerzhayard.forgewrapper.installer.Main';
    const group = neo ? 'net.neoforged' : 'net.minecraftforge', artifact = neo && !version.startsWith('47.') ? 'neoforge' : 'forge';
    out.mavenFiles = [{ name: `${group}:${artifact}:${fullVersion}:installer`, downloads: { artifact: {
      url: installerURL, sha1: createHash('sha1').update(installer).digest('hex'), size: installer.length,
    } } }, ...(profile.libraries || []).filter(l => !l.name.startsWith('org.apache.logging.log4j:'))];
    out.libraries = [structuredClone(FORGE_WRAPPER), ...(versionManifest.libraries || []).filter(l => !l.name.startsWith('org.apache.logging.log4j:')).map(original => {
      const l = structuredClone(original), parts = l.name.split(':');
      if (!neo && parts[0] === 'net.minecraftforge' && parts[1] === 'forge' && parts.length === 3) {
        l.name += ':launcher';
        if (l.downloads?.artifact) { l.downloads.artifact.url = 'https://maven.minecraftforge.net/' + mavenPath(l.name); delete l.downloads.artifact.path; }
      }
      return l;
    }).filter(l => !l.downloads?.artifact || Boolean(l.downloads.artifact.url))];
    const game = versionManifest.arguments.game || [];
    if (game.some(v => typeof v !== 'string')) throw new Error('Unsupported structured Forge launch arguments');
    out.minecraftArguments = DEFAULT_GAME_ARGS + ' ' + game.map(argumentString).join(' ');
    if (!neo) for (const [k, v] of [['--fml.forgeGroup', group], ['--fml.forgeVersion', version], ['--fml.mcVersion', minecraft]]) {
      if (!game.includes(k)) out.minecraftArguments += ' ' + k + ' ' + v;
    }
  } else {
    // Forge 1.6 through 1.12 installers describe a LaunchWrapper profile.
    const v = versionManifest || profile.versionInfo;
    if (!v?.minecraftArguments || !v.mainClass) throw new Error('Legacy Forge installer needs a Prism compatibility recipe');
    out.mainClass = v.mainClass;
    out.libraries = (v.libraries || []).filter(l => !(l.clientreq === false) && !lwjgl(l) && !l.name.startsWith('org.apache.logging.log4j:')).map(lib => {
      const l = structuredClone(lib); delete l.serverreq; delete l.clientreq;
      const parts = l.name.split(':');
      if (parts[0] === 'net.minecraftforge' && ['forge', 'minecraftforge'].includes(parts[1])) {
        if (parts[1] === 'minecraftforge') { parts[1] = 'forge'; parts[2] = minecraft + '-' + parts[2]; }
        parts[3] = 'universal'; l.name = parts.join(':');
        const url = 'https://maven.minecraftforge.net/' + mavenPath(l.name);
        if (l.downloads?.artifact) { l.downloads.artifact.url = url; l.downloads.artifact.path = mavenPath(l.name); }
        else l.url = 'https://maven.minecraftforge.net/';
      }
      return l;
    });
    const match = [...v.minecraftArguments.matchAll(/--tweakClass\s+(\S+)/g)];
    out['+tweakers'] = match.map(m => m[1]);
    // Preserve the base game's arguments and let Prism append the tweakers.
    // Keep the Minecraft component's launch arguments, as upstream Prism does.
  }
  return rewriteGameURLs(out, config);
}
