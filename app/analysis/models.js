// model download (cached), fp16 weight expansion and onnxruntime sessions

const CACHE = "encore-models-v1";

async function cachedFetch(url, onBytes) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* no cache storage (private mode, node) */ }
  const hit = cache && (await cache.match(url));
  const res = hit || (await fetch(url));
  if (!res.ok) throw new Error(`gagal mengunduh model (${res.status}): ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onBytes?.(got, total, !!hit);
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  if (cache && !hit) {
    try { await cache.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream" } })); } catch { /* quota */ }
  }
  return bytes;
}

// half floats -> float32 bytes (weights are shipped as fp16 to halve the download)
export function expandHalf(u8) {
  const h = new Uint16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1);
  const out = new Uint32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const x = h[i];
    const sign = (x & 0x8000) << 16;
    let exp = (x >> 10) & 0x1f;
    let man = x & 0x3ff;
    if (exp === 0) {
      if (man === 0) { out[i] = sign; continue; }
      // subnormal: normalise
      exp = 1;
      while (!(man & 0x400)) { man <<= 1; exp--; }
      man &= 0x3ff;
      out[i] = sign | ((exp + 112) << 23) | (man << 13);
    } else if (exp === 0x1f) {
      out[i] = sign | 0x7f800000 | (man << 13);
    } else {
      out[i] = sign | ((exp + 112) << 23) | (man << 13);
    }
  }
  return new Uint8Array(out.buffer);
}

export class ModelStore {
  // base: url of the folder with manifest.json and the model files
  constructor(ort, base, { providers = ["webgpu", "wasm"], onDownload } = {}) {
    this.ort = ort;
    this.base = base.replace(/\/$/, "");
    this.providers = providers;
    this.onDownload = onDownload;
    this.manifest = null;
    this.sessions = new Map();
  }

  async info(name) {
    if (!this.manifest) {
      const r = await fetch(`${this.base}/manifest.json`, { cache: "no-cache" });
      if (!r.ok) throw new Error("manifest model tidak ditemukan");
      this.manifest = await r.json();
    }
    const info = this.manifest[name];
    if (!info) throw new Error(`model ${name} tidak ada di manifest`);
    return info;
  }

  async session(name) {
    if (this.sessions.has(name)) return this.sessions.get(name);
    const p = (async () => {
      const info = await this.info(name);
      const report = (part) => (got, total, cached) => this.onDownload?.({ name, part, got, total, cached });
      const graph = await cachedFetch(`${this.base}/${info.file}`, report("graph"));
      const opts = { executionProviders: this.providers, graphOptimizationLevel: "all", logSeverityLevel: 3 };
      if (info.weights) {
        const half = await cachedFetch(`${this.base}/${info.weights}.f16`, report("weights"));
        opts.externalData = [{ path: info.weights, data: expandHalf(half) }];
      }
      return this.ort.InferenceSession.create(graph, opts);
    })();
    this.sessions.set(name, p);
    try { return await p; } catch (err) { this.sessions.delete(name); throw err; }
  }

  async release(name) {
    const p = this.sessions.get(name);
    this.sessions.delete(name);
    if (p) { try { (await p).release?.(); } catch { /* already gone */ } }
  }
}
