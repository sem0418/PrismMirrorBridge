export const GAME_HOSTS = new Set([
  'launchermeta.mojang.com', 'launcher.mojang.com', 'piston-meta.mojang.com', 'piston-data.mojang.com',
  'libraries.minecraft.net', 'resources.download.minecraft.net', 'maven.minecraftforge.net', 'files.minecraftforge.net',
  'maven.neoforged.net', 'maven.fabricmc.net', 'meta.fabricmc.net', 'maven.quiltmc.org', 'meta.quiltmc.org',
]);
export const MOD_API_HOSTS = new Set(['api.modrinth.com', 'api.curseforge.com']);
export const MOD_FILE_HOSTS = new Set(['cdn.modrinth.com', 'edge.forgecdn.net', 'media.forgecdn.net']);
export const INTERCEPT_HOSTS = new Set([...GAME_HOSTS, ...MOD_API_HOSTS, ...MOD_FILE_HOSTS, 'meta.prismlauncher.org']);

export function mirrorURL(value, config) {
  let u; try { u = new URL(value); } catch { return value; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))) return value;
  const h = u.hostname.toLowerCase(), tail = u.pathname + u.search;
  if (['launcher.mojang.com', 'launchermeta.mojang.com', 'piston-meta.mojang.com', 'piston-data.mojang.com'].includes(h)) return config.bmcl + tail;
  if (h === 'resources.download.minecraft.net') return config.bmcl + '/assets' + tail;
  if (h === 'libraries.minecraft.net') return config.bmcl + '/maven' + tail;
  if (h === 'meta.fabricmc.net') return config.bmcl + '/fabric-meta' + tail;
  if (h === 'meta.quiltmc.org') return config.bmcl + '/quilt-meta' + tail;
  if (['maven.minecraftforge.net', 'files.minecraftforge.net', 'maven.fabricmc.net'].includes(h)) return config.bmcl + '/maven' + tail.replace(/^\/maven(?=\/)/, '');
  if (h === 'maven.neoforged.net') return config.bmcl + '/maven' + tail.replace(/^\/releases(?=\/)/, '');
  if (h === 'maven.quiltmc.org') return config.bmcl + '/maven' + tail.replace(/^\/repository\/release(?=\/)/, '');
  if (h === 'api.modrinth.com') return config.mcim + '/modrinth' + tail;
  if (h === 'api.curseforge.com') return config.mcim + '/curseforge' + tail;
  if (MOD_FILE_HOSTS.has(h)) return config.mcim + tail;
  // mediafilez.forgecdn.net intentionally remains unchanged per MCIM's current guide.
  return value;
}

export function rewriteGameURLs(value, config) {
  if (typeof value === 'string') {
    let u; try { u = new URL(value); } catch { return value; }
    return GAME_HOSTS.has(u.hostname) ? mirrorURL(value, config) : value;
  }
  if (Array.isArray(value)) return value.map(v => rewriteGameURLs(v, config));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteGameURLs(v, config)]));
  return value;
}

// Prism enforces cdn.modrinth.com for mrpack downloads. Keep the original
// external identity and perform the mirror mapping inside CONNECT instead.
export function normalizeModJSON(value, provider, mirrorBase) {
  if (Array.isArray(value)) return value.map(v => normalizeModJSON(v, provider, mirrorBase));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'sync_at').map(([k, v]) => {
    if (provider === 'modrinth' && k === 'url' && typeof v === 'string') {
      try {
        const u = new URL(v), m = new URL(mirrorBase);
        if (u.origin === m.origin && /^\/data\//.test(u.pathname)) v = 'https://cdn.modrinth.com' + u.pathname + u.search;
      } catch { /* leave opaque strings untouched */ }
    }
    return [k, normalizeModJSON(v, provider, mirrorBase)];
  }));
}

export function sanitizedHeaders(headers, { mirror = false } = {}) {
  const dynamic = new Set((headers.connection || '').toLowerCase().split(',').map(s => s.trim()));
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (['host', 'connection', 'proxy-connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-authorization'].includes(key) || dynamic.has(key)) continue;
    if (mirror && ['authorization', 'cookie', 'x-api-key', 'modrinth-download-meta'].includes(key)) continue;
    out[key] = v;
  }
  return out;
}
