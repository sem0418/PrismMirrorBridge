import { HTTPError } from './transport.mjs';

// MCIM has project summaries but no CurseForge /description endpoint. Preserve
// the real text and disclose the reduced content instead of inventing a body.
export function curseForgeSummaryDescription(response, expectedId) {
  const project = response?.data;
  if (project?.id !== Number(expectedId) || typeof project.summary !== 'string' || !project.summary.trim())
    throw new HTTPError(404, 'MCIM does not provide a description or project summary');
  const escaped = project.summary.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return { data: '<p><em>镜像暂不提供完整介绍，以下为项目摘要。 / Project summary only; the full description is unavailable from the mirror.</em></p><p>' + escaped.replace(/\r?\n/g, '<br>') + '</p>' };
}
// Prism sends CurseForge bulk IDs as JSON strings. MCIM's Rust handlers require
// Vec<i32>, so forwarding the original request would produce HTTP 400.
export function adaptModRequest(provider, body) {
  if (!body?.length) return body;
  let value; try { value = JSON.parse(body.toString('utf8')); }
  catch { throw new HTTPError(400, 'Invalid API request JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HTTPError(400, 'API request must be an object');
  if (provider === 'curseforge') for (const key of ['modIds', 'fileIds', 'fingerprints']) {
    if (!(key in value)) continue;
    if (!Array.isArray(value[key]) || value[key].length > 1000) throw new HTTPError(400, 'Invalid bulk ID list');
    value[key] = value[key].map(v => {
      if (!['number', 'string'].includes(typeof v) || !/^\d+$/.test(String(v))) throw new HTTPError(400, 'Invalid numeric mod ID');
      const n = Number(v), max = key === 'fingerprints' ? 0xffffffff : 0x7fffffff;
      if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new HTTPError(400, 'Mod ID outside supported range');
      return n;
    });
  }
  return Buffer.from(JSON.stringify(value));
}
