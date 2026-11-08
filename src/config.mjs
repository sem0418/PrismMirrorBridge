import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function loadConfig(file) {
  const config = { listen: '127.0.0.1', port: 17643, bmcl: 'https://bmclapi2.bangbang93.com', mcim: 'https://mod.mcimirror.top',
    prismRecipes: 'https://meta.prismlauncher.org/v1/', compatibilityRecipes: false, fileFallback: false,
    upstreamProxy: 'environment', timeoutMs: 30000, retries: 2, concurrency: 4, cacheSeconds: 300, dataDir: '.bridge',
    bulkBatchSize: 50, bulkConcurrency: 3, bulkTimeoutMs: 45000,
    ...JSON.parse(readFileSync(file, 'utf8')) };
  if (config.listen !== '127.0.0.1') throw new Error('This tool only binds to 127.0.0.1.');
  for (const [key, min, max] of [['port', 1, 65535], ['concurrency', 1, 8], ['retries', 0, 3], ['timeoutMs', 1000, 120000], ['cacheSeconds', 1, 86400],
    ['bulkBatchSize', 10, 100], ['bulkConcurrency', 1, 3], ['bulkTimeoutMs', 1000, 50000]])
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error('Invalid configuration: ' + key);
  for (const key of ['bmcl', 'mcim', 'prismRecipes']) {
    const u = new URL(config[key]);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error(key + ' must be an HTTPS URL without credentials/query');
    config[key] = u.href.replace(/\/$/, '') + (key === 'prismRecipes' ? '/' : '');
  }
  for (const key of ['compatibilityRecipes', 'fileFallback']) if (typeof config[key] !== 'boolean') throw new Error(key + ' must be boolean');
  config.dataDir = resolve(dirname(file), config.dataDir);
  const proxy = config.upstreamProxy === 'environment'
    ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy : config.upstreamProxy;
  if (proxy) {
    const u = new URL(proxy);
    if (['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port) === config.port) throw new Error('upstreamProxy points back to this bridge (proxy loop).');
  }
  return config;
}
