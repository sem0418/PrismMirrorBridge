import { isDeepStrictEqual } from 'node:util';
import { HTTPError } from './transport.mjs';
import { normalizeModJSON } from './routing.mjs';

function allMissing(error, ids) {
  if (!(error instanceof HTTPError) || error.status !== 404 || !error.upstreamBody) return false;
  try {
    const value = JSON.parse(error.upstreamBody.toString('utf8'));
    const match = value.detail?.match(/^Mods not found: No mods found for the provided modIds: (\[[\d,\s]*\])$/);
    return value.code === 404 && value.error === 'Not Found' && !!match && isDeepStrictEqual(JSON.parse(match[1]), ids);
  } catch { return false; }
}

// Only POST /v1/mods is split. /v1/mods/files and its file-ID semantics remain
// independent. All successful bodies are collected before any client headers.
export async function curseForgeBulkMods(transport, url, body, config, { signal, onBatch, onMetrics } = {}) {
  const request = JSON.parse(body.toString('utf8'));
  const ids = Array.isArray(request.modIds) ? [...new Set(request.modIds)] : null;
  const batchSize = config.bulkBatchSize ?? 50;
  const budget = config.bulkTimeoutMs ?? 45000;
  const stop = new AbortController(), deadline = Date.now() + budget;
  const combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const timeout = new HTTPError(504, 'MCIM bulk project lookup exceeded its time budget; no partial result returned');
  const timer = setTimeout(() => stop.abort(timeout), budget);
  async function fetchBatch(values) {
    const payload = values ? Buffer.from(JSON.stringify({ ...request, modIds: values })) : body;
    return transport.limit.run(async () => {
      combined.throwIfAborted(); onBatch?.();
      return transport.requestJSON(url, { method: 'POST', body: payload, signal: combined,
        headers: { 'content-type': 'application/json', 'content-length': payload.length }, onMetrics });
    }, { signal: combined });
  }
  try {
    // Keep upstream validation, empty-list and small-request error behavior.
    if (!ids?.length || ids.length <= batchSize) {
      const value = await fetchBatch(ids);
      combined.throwIfAborted(); if (Date.now() >= deadline) throw timeout;
      return value;
    }
    const batches = []; for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));
    const results = new Array(batches.length), missing = new Array(batches.length);
    let cursor = 0, decodedTotal = 0;
    async function worker() {
      while (cursor < batches.length) {
        combined.throwIfAborted(); const index = cursor++;
        try {
          const value = normalizeModJSON(await fetchBatch(batches[index]), 'curseforge', config.mcim);
          if (!value || !Array.isArray(value.data)) throw new HTTPError(502, 'MCIM returned an invalid bulk project response');
          const expected = new Set(batches[index]), seen = new Set();
          for (const mod of value.data) {
            if (!mod || !Number.isInteger(mod.id) || !expected.has(mod.id) || seen.has(mod.id)) throw new HTTPError(502, 'MCIM returned unexpected bulk project IDs');
            seen.add(mod.id);
          }
          decodedTotal += Buffer.byteLength(JSON.stringify(value));
          if (decodedTotal > 32 * 1024 * 1024) throw new HTTPError(502, 'Combined MCIM response exceeds limit');
          results[index] = value;
        } catch (error) {
          if (allMissing(error, batches[index])) { missing[index] = error; continue; }
          stop.abort(error); throw error;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(config.bulkConcurrency ?? 3, batches.length) }, worker));
    combined.throwIfAborted(); if (Date.now() >= deadline) throw timeout;
    const successes = results.filter(Boolean);
    if (!successes.length) throw missing.find(Boolean);
    const { data: _first, ...envelope } = successes[0]; const records = new Map();
    for (const value of successes) {
      const { data, ...other } = value;
      if (!isDeepStrictEqual(envelope, other)) throw new HTTPError(502, 'MCIM bulk response envelopes differ between batches');
      for (const mod of data) records.set(mod.id, mod);
    }
    // Mongo's $in bulk endpoint returns only found IDs, with no ordering promise.
    // Missing IDs stay absent; duplicate input IDs produce one result.
    return { ...envelope, data: ids.filter(id => records.has(id)).map(id => records.get(id)) };
  } catch (error) {
    if (combined.aborted) throw combined.reason;
    stop.abort(error); throw error;
  } finally { clearTimeout(timer); }
}
