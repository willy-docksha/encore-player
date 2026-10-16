// breakdown library in the browser: songs, results and stems live in indexeddb, analysis runs in a
// worker on this device. api() answers the same /api/jobs routes the python server had, so the ui
// talks to it the same way.

import { parseLink } from "./core.js";
import { MODEL_URL, AUTO_START } from "./config.js";
import { PIPELINE_VERSION } from "./analysis/version.js";

// models are big (~240 mb, downloaded once and cached); local dev always uses the models/ folder
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const MODEL_BASE = (!LOCAL && MODEL_URL) || new URL("../models/", import.meta.url).href;
const SR = 44100;
const ACTIVE = ["queued", "downloading", "waiting", "running"];

export const supported = typeof Worker !== "undefined" && typeof indexedDB !== "undefined" && typeof WebAssembly !== "undefined";

// ------------------------------------------------------------------ indexeddb

let dbp = null;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open("encore-breakdown", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("jobs", { keyPath: "id" });
      d.createObjectStore("analysis");
      d.createObjectStore("files");
      d.createObjectStore("sources");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    let out;
    Promise.resolve(fn(t.objectStore(store))).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("transaksi dibatalkan"));
  });
}
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const get = (store, key) => tx(store, "readonly", (s) => req(s.get(key)));
const put = (store, value, key) => tx(store, "readwrite", (s) => { s.put(value, key); });
const all = (store) => tx(store, "readonly", (s) => req(s.getAll()));

async function removeJob(id) {
  const d = await db();
  await new Promise((resolve, reject) => {
    const t = d.transaction(["jobs", "analysis", "files", "sources"], "readwrite");
    t.objectStore("jobs").delete(id);
    t.objectStore("analysis").delete(id);
    t.objectStore("sources").delete(id);
    t.objectStore("files").delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`));
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  for (const [k, url] of urls) if (k.startsWith(`${id}/`)) { URL.revokeObjectURL(url); urls.delete(k); }
}

// ------------------------------------------------------------------ jobs

const metas = new Map(); // in-memory copy, written through to indexeddb
let loaded = null;

async function load() {
  loaded ||= (async () => {
    for (const m of await all("jobs")) {
      // a reload stops the worker: anything that was in flight starts over
      if (ACTIVE.includes(m.status)) Object.assign(m, { status: "queued", stage: "Menunggu giliran", progress: 0 });
      metas.set(m.id, m);
    }
    try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
  })();
  return loaded;
}

let saveTimers = new Map();
function update(id, patch, { now = false } = {}) {
  const m = metas.get(id);
  if (!m) return null;
  Object.assign(m, patch);
  clearTimeout(saveTimers.get(id));
  // progress ticks are frequent: write them lazily
  if (now) put("jobs", m); else saveTimers.set(id, setTimeout(() => put("jobs", m), 1000));
  return m;
}

function sourceKey(source) {
  const p = source.url ? parseLink(source.url) : null;
  return p?.type === "drive" ? `gd_${p.id}` : null;
}

function analysisInfo(m) {
  if (!m.finished) return {};
  return { analyzed_at: m.finished, outdated: (m.version || 0) < PIPELINE_VERSION };
}

function publicMeta(m) {
  const { source, ...rest } = m;
  return { ...rest, url: source?.url || null, ...analysisInfo(m) };
}

// position in line and a time estimate from how fast this device has been
function withQueueInfo(list) {
  const ratios = list.filter((j) => j.status === "done" && j.compute_sec && j.duration).map((j) => j.compute_sec / j.duration);
  ratios.sort((a, b) => a - b);
  const rate = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 2.0;
  const fallback = 240 * rate;
  let ahead = 0;
  for (const j of list.filter((x) => x.status === "running" || x.status === "downloading")) {
    const total = j.duration ? rate * j.duration : fallback;
    const elapsed = Date.now() / 1000 - (j.started || Date.now() / 1000);
    const p = j.progress || 0;
    j.eta_sec = Math.round(Math.max(5, p >= 0.15 ? (elapsed * (1 - p)) / p : total - elapsed));
    ahead += j.eta_sec;
  }
  const line = list.filter((j) => j.status === "queued" || j.status === "waiting").sort((a, b) => a.created - b.created);
  line.forEach((j, i) => {
    const own = j.duration ? rate * j.duration : fallback;
    j.position = i + 1;
    j.eta_sec = Math.round(ahead + own);
    ahead += own;
  });
  return list;
}

// ------------------------------------------------------------------ queue + worker

let worker = null;
let current = null; // id being processed
let cancelRun = null; // rejects the running analysis
let backend = null; // "webgpu" or "wasm" once known

function getWorker() {
  if (!worker) worker = new Worker(new URL("./analysis/worker.js", import.meta.url), { type: "module" });
  return worker;
}

function stopWorker() {
  worker?.terminate();
  worker = null;
}

async function fetchDrive(id, onProgress) {
  const r = await fetch(`/drive?id=${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(r.status === 403 ? "File Google Drive tidak publik. Bagikan sebagai “Siapa saja yang memiliki link”, lalu salin ulang link-nya dari tombol Bagikan." : `Gagal mengunduh dari Google Drive (${r.status})`);
  const total = Number(r.headers.get("content-length")) || 0;
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress(got / total);
  }
  return new Blob(parts, { type: r.headers.get("content-type") || "audio/mpeg" });
}

async function driveTitle(id) {
  try {
    const r = await fetch(`/title?type=drive&id=${encodeURIComponent(id)}`);
    return r.ok ? (await r.json()).title : null;
  } catch { return null; }
}

// any audio/video file -> stereo float32 at 44100 (the browser decodes and resamples)
async function decode(blob) {
  const ctx = new OfflineAudioContext(2, 1, SR);
  let buf;
  try { buf = await ctx.decodeAudioData(await blob.arrayBuffer()); } catch { throw new Error("Format audio tidak bisa dibaca browser ini"); }
  const left = buf.getChannelData(0).slice();
  const right = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : left.slice();
  return { left, right, duration: buf.duration };
}

let running = false;
async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = [...metas.values()].filter((m) => m.status === "queued" || m.status === "waiting").sort((a, b) => a.created - b.created)[0];
      if (!next) break;
      await processJob(next.id);
    }
  } finally {
    running = false;
  }
}

async function processJob(id) {
  current = id;
  const m = metas.get(id);
  try {
    let blob = await get("sources", id);
    if (!blob) {
      const p = parseLink(m.source.url);
      update(id, { status: "downloading", stage: "Mengunduh audio", progress: 0, error: null }, { now: true });
      notify();
      blob = await fetchDrive(p.id, (x) => { update(id, { progress: x }); notify(); });
      await put("sources", blob, id);
      if (!m.title || m.title === m.source.url) update(id, { title: (await driveTitle(p.id)) || "Lagu dari Google Drive" });
    }
    if (!metas.has(id)) return;
    update(id, { status: "running", stage: "Membaca audio", progress: 0, started: Date.now() / 1000, downloaded: m.downloaded || Date.now() / 1000 }, { now: true });
    notify();
    const { left, right, duration } = await decode(blob);
    update(id, { duration: Math.round(duration * 1000) / 1000 });
    const out = await runWorker(id, m.title, left, right);
    if (!metas.has(id)) return; // deleted meanwhile
    await put("analysis", out.result, id);
    await tx("files", "readwrite", (s) => {
      for (const [name, bytes] of Object.entries(out.files)) {
        s.put(new Blob([bytes], { type: name.endsWith(".mp3") ? "audio/mpeg" : "audio/midi" }), `${id}/${name}`);
      }
    });
    for (const [k, url] of urls) if (k.startsWith(`${id}/`)) { URL.revokeObjectURL(url); urls.delete(k); }
    update(id, {
      status: "done", stage: "Selesai", progress: 1, error: null, reanalyze_error: null,
      key: out.result.key, bpm: out.result.bpm, duration: out.result.duration,
      compute_sec: Math.round(out.computeSec), finished: Date.now() / 1000, version: out.result.version,
    }, { now: true });
  } catch (err) {
    if (!metas.has(id)) return;
    const hadResult = !!(await get("analysis", id));
    // a failed re-analysis keeps the previous result
    if (hadResult) update(id, { status: "done", stage: "Selesai", progress: 1, reanalyze_error: err.message }, { now: true });
    else update(id, { status: "error", stage: "Gagal", error: err.message }, { now: true });
  } finally {
    current = null;
    cancelRun = null;
    notify();
  }
}

function runWorker(id, title, left, right) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    let dl = {};
    w.onmessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === "backend") backend = data.backend;
      else if (data.type === "download") {
        dl[data.name] = data;
        const got = Object.values(dl).reduce((a, d) => a + d.got, 0);
        const total = Object.values(dl).reduce((a, d) => a + (d.total || 0), 0);
        update(id, { stage: `Mengunduh model AI (sekali saja) ${total ? Math.round((got / total) * 100) : 0}%` });
        notify();
      } else if (data.type === "progress") {
        update(id, { stage: data.stage, progress: data.p });
        notify();
      } else if (data.type === "done") resolve(data);
      else if (data.type === "error") reject(new Error(data.message));
    };
    w.onerror = (e) => { reject(new Error(e.message || "Worker analisis berhenti")); stopWorker(); };
    cancelRun = () => { stopWorker(); reject(new Error("dibatalkan")); };
    w.postMessage({ type: "run", id, title, left, right, modelBase: MODEL_BASE }, [left.buffer, right.buffer]);
  });
}

const listeners = new Set();
let notifyQueued = false;
function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  requestAnimationFrame(() => { notifyQueued = false; listeners.forEach((fn) => fn()); });
}
export const onChange = (fn) => listeners.add(fn);
export const info = () => ({ backend, busy: !!current });

// ------------------------------------------------------------------ files

const urls = new Map();
// object url for a stem / midi file of a finished song
export async function fileUrl(id, name) {
  const k = `${id}/${name}`;
  if (urls.has(k)) return urls.get(k);
  const blob = await get("files", k);
  if (!blob) throw new Error("file tidak ditemukan");
  const url = URL.createObjectURL(blob);
  urls.set(k, url);
  return url;
}

// ------------------------------------------------------------------ api (same routes as the old server)

class HttpError extends Error {}
const fail = (msg) => { throw new HttpError(msg); };

async function createJob(form) {
  const kind = form.get("kind");
  let source, title = null, blob = null;
  if (kind === "gdrive") {
    const url = String(form.get("url") || "").trim();
    if (!url.startsWith("http")) fail("link tidak valid");
    source = { type: "gdrive", url };
    const key = sourceKey(source);
    const same = [...metas.values()].find((m) => m.source?.type === "gdrive" && sourceKey(m.source) === key && m.status !== "error");
    if (same) return { ...publicMeta(same), existing: true };
  } else if (kind === "youtube") {
    fail("Link YouTube tidak bisa dianalisis langsung di browser. Download audionya dulu lalu upload filenya, atau pakai link Google Drive.");
  } else if (kind === "file") {
    blob = form.get("file");
    if (!blob) fail("file wajib diupload");
    title = (blob.name || "audio").replace(/\.[^.]+$/, "");
    source = { type: "file", name: blob.name || "audio", title };
  } else fail("kind tidak dikenal");
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  // without auto start a new song waits until "Mulai" is pressed
  const meta = AUTO_START
    ? { id, title: title || source.url, source, source_type: source.type, status: "queued", stage: "Menunggu giliran", progress: 0, created: Date.now() / 1000 }
    : { id, title: title || source.url, source, source_type: source.type, status: "pending", stage: "Belum dimulai", progress: 0, created: Date.now() / 1000 };
  metas.set(id, meta);
  await put("jobs", meta);
  if (blob) await put("sources", blob, id);
  pump();
  notify();
  return publicMeta(meta);
}

function requeue(id) {
  update(id, { status: "queued", stage: "Menunggu giliran", progress: 0, error: null, created: Date.now() / 1000 }, { now: true });
  pump();
  notify();
}

export async function api(path, { method = "GET", body } = {}) {
  await load();
  pump();
  const u = new URL(path, location.href);
  const parts = u.pathname.split("/").filter(Boolean); // api, jobs, id, action
  if (parts[0] !== "api" || parts[1] !== "jobs") fail("tidak dikenal");
  const id = parts[2];
  const m = id ? metas.get(id) : null;
  if (id && !m) fail("lagu tidak ditemukan");

  if (!id && method === "GET") {
    return withQueueInfo([...metas.values()].map((x) => ({ ...x })))
      .map(publicMeta)
      .sort((a, b) => (b.created || 0) - (a.created || 0));
  }
  if (!id && method === "POST") return createJob(body);
  if (method === "DELETE") {
    metas.delete(id);
    if (current === id) cancelRun?.();
    await removeJob(id);
    pump();
    notify();
    return { ok: true };
  }
  const action = parts[3];
  if (!action && method === "GET") return publicMeta(m);
  if (action === "analysis") {
    const data = await get("analysis", id);
    if (!data) fail("analisis belum siap");
    return { ...data, ...analysisInfo(m), url: m.source?.url || null, source_type: m.source_type };
  }
  if (action === "start") {
    if (m.status !== "pending") fail("lagu ini sudah dimulai");
    requeue(id);
    return publicMeta(m);
  }
  if (action === "retry") {
    if (m.status !== "error") fail("hanya lagu yang gagal yang bisa dicoba lagi");
    requeue(id);
    return publicMeta(m);
  }
  if (action === "reanalyze") {
    if (ACTIVE.includes(m.status)) fail("lagu ini masih di antrian");
    if (!(await get("sources", id)) && m.source?.type !== "gdrive") fail("file asli sudah tidak tersimpan, silakan upload ulang");
    requeue(id);
    return publicMeta(m);
  }
  fail("tidak dikenal");
}

// warn before leaving: a reload restarts the running analysis from 0
addEventListener("beforeunload", (e) => {
  if (![...metas.values()].some((m) => ACTIVE.includes(m.status))) return;
  e.preventDefault();
  e.returnValue = "";
});

// resume whatever was waiting when the page was closed
if (supported) load().then(pump);
