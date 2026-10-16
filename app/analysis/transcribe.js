// note transcription for bass, vocals and chordal parts (port of backend/pipeline.py)
import {
  rms, amplitudeToDb, hzToMidi, noteToHz, onsetDetect, maximumFilter1d, minimumFilter1d,
  medianFilter1d, max, mean, median,
} from "./dsp.js";
import { chunkedPyin } from "./pyin.js";

export const PYIN_SR = 11025, PYIN_HOP = 64, PYIN_FRAME = 1024;
export const BASS_RANGE = ["B0", "G4"];
export const VOCAL_RANGE = ["C2", "C6"];
const SECTION_SEC = 2.0;
const WEAK_CONFIDENCE = 0.2;
const REATTACK_RISE_DB = 2.5;
const REATTACK_SUSTAIN_DB = 1.5;

// python round(): half to even on exact ties
export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}
export const r3 = (x) => Math.round(x * 1000) / 1000;
const clip01 = (x) => Math.min(1, Math.max(0, x));

export function overlap(a, b) {
  return Math.max(0, Math.min(a.t + a.d, b.t + b.d) - Math.max(a.t, b.t));
}

const anyNonZero = (y) => { for (let i = 0; i < y.length; i++) if (y[i]) return true; return false; };

function maxIn(a, lo, hi) { let m = -Infinity; for (let i = lo; i < hi; i++) if (a[i] > m) m = a[i]; return m; }

// ------------------------------------------------------------------ bass

// re-plucks of the same note from the short-time level of the bass stem
function reattackEvidence(y, hop, n, active, frameT) {
  let env = amplitudeToDb(rms(y, 256, hop));
  const e0 = new Float32Array(n).fill(-80);
  e0.set(env.subarray(0, Math.min(n, env.length)));
  env = e0;
  const pad = 32;
  const e = new Float32Array(n + 2 * pad);
  for (let i = 0; i < e.length; i++) e[i] = env[Math.min(n - 1, Math.max(0, i - pad))];
  const ok = new Uint8Array(n);
  const rise = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const idx = f + pad;
    let pre = 0; for (let k = idx - 7; k < idx - 1; k++) pre += e[k]; pre /= 6;
    let peak = -Infinity; for (let k = idx; k < idx + 9; k++) if (e[k] > peak) peak = e[k];
    let post = 0; for (let k = idx + 15; k < idx + 26; k++) post += e[k]; post /= 11;
    let slope = 0; for (let q = 0; q < 13; q++) slope += e[idx - 14 + q] * (q - 6); slope /= 182;
    const expected = pre + slope * 24;
    rise[f] = peak - pre;
    const sust = Math.max(post - pre, post - expected);
    ok[f] = rise[f] >= REATTACK_RISE_DB && sust >= REATTACK_SUSTAIN_DB && active[f] ? 1 : 0;
  }
  const spacing = Math.max(1, Math.floor(0.09 / frameT));
  const lmax = maximumFilter1d(rise, 2 * 7 + 1);
  const picks = [];
  for (let f = 0; f < n; f++) {
    if (ok[f] && rise[f] === lmax[f] && (!picks.length || f - picks[picks.length - 1] >= spacing)) picks.push(f);
  }
  const isReattack = (f) => {
    for (let k = Math.max(0, f - 4); k < Math.min(n, f + 5); k++) if (ok[k]) return true;
    return false;
  };
  return { isReattack, picks };
}

// fold short pitch blips (attack scoops, slides, octave glitches) into the neighbouring note
export function absorbBlips(notes, maxLen = 0.08, maxGap = 0.03) {
  const out = notes.map((n) => ({ ...n }));
  const close = (a, b) => Math.abs(a.midi - b.midi) <= 2 || Math.abs(a.midi - b.midi) === 12;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const n = out[i];
      if (n.d >= maxLen) continue;
      const nxt = out[i + 1], prv = out[i - 1];
      if (nxt && nxt.t - (n.t + n.d) < maxGap && close(n, nxt) && nxt.d > n.d) {
        const end = nxt.t + nxt.d;
        nxt.t = n.t;
        nxt.d = r3(end - n.t);
        nxt.v = Math.max(nxt.v, n.v);
      } else if (prv && n.t - (prv.t + prv.d) < maxGap && close(n, prv)) {
        prv.d = r3(n.t + n.d - prv.t);
      } else continue;
      out.splice(i, 1);
      changed = true;
      break;
    }
  }
  return out;
}

function weakSections(vprob, rmsDb, frameT) {
  const per = Math.floor(SECTION_SEC / frameT);
  const nSec = Math.ceil(vprob.length / per);
  const weak = new Uint8Array(nSec);
  for (let k = 0; k < nSec; k++) {
    let loud = 0, sum = 0;
    for (let i = k * per; i < Math.min(vprob.length, (k + 1) * per); i++) {
      if (rmsDb[i] > -30) { loud++; sum += vprob[i]; }
    }
    if (loud > 10) weak[k] = sum / loud < WEAK_CONFIDENCE ? 1 : 0;
  }
  return weak;
}

// y: bass stem, mono at 11025. basicPitch(): note events for the bass stem (only called when needed)
export async function transcribeBass(y, { pyinChunk, basicPitch, onProgress } = {}) {
  const sr = PYIN_SR, hop = PYIN_HOP, frame = PYIN_FRAME;
  if (!anyNonZero(y)) return [];
  const opts = { fmin: noteToHz(BASS_RANGE[0]), fmax: noteToHz(BASS_RANGE[1]), sr, frameLength: frame, hop };
  const p = await chunkedPyin(y, opts, pyinChunk && ((s) => pyinChunk(s, opts)), onProgress);
  const rmsAll = rms(y, frame, hop);
  const n = Math.min(p.f0.length, rmsAll.length);
  const f0 = p.f0.subarray(0, n), voiced = p.voiced.subarray(0, n), vprob = p.vprob.subarray(0, n);
  const rmsV = rmsAll.subarray(0, n);
  const rmsDb = amplitudeToDb(rmsV);
  const frameT = hop / sr;
  const rmsMax = max(rmsV);

  const active = new Uint8Array(n);
  const q = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    active[i] = voiced[i] && rmsDb[i] > -38 && Number.isFinite(f0[i]) ? 1 : 0;
    q[i] = active[i] ? roundHalfEven(hzToMidi(f0[i])) : -1;
  }

  const onsets = onsetDetect(y, sr, hop, { delta: 0.08, wait: Math.floor(0.06 / frameT) });
  const starts = [];
  for (let i = 0; i < n; i++) if (active[i] && !(i > 0 && active[i - 1])) starts.push(i);
  const { isReattack, picks } = reattackEvidence(y, hop, n, active, frameT);
  const bounds = [...new Set([...onsets, ...starts, ...picks, n])].sort((a, b) => a - b);

  const minFrames = Math.max(1, Math.floor(0.05 / frameT));
  const stable = Math.max(1, Math.floor(0.03 / frameT));
  let notes = [];
  for (let b = 0; b + 1 < bounds.length; b++) {
    const s = bounds[b], e = bounds[b + 1];
    // pitch runs inside this attack segment; split on legato pitch changes
    let runs = [];
    for (let i = 0; i < e - s; i++) {
      const pq = q[s + i];
      const last = runs[runs.length - 1];
      if (last && last[0] === pq) last[2] = i + 1;
      else runs.push([pq, i, i + 1]);
    }
    runs = runs.filter((r) => r[0] >= 0 && r[2] - r[1] >= stable);
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && last[0] === r[0]) last[2] = r[2];
      else merged.push(r);
    }
    merged.forEach(([pitch, rs, re], k) => {
      const start = k === 0 && rs * frameT < 0.12 ? s : s + rs;
      const end = s + re;
      if (end - start < minFrames) return;
      notes.push({
        t: r3(start * frameT),
        d: r3((end - start) * frameT),
        midi: pitch,
        v: r3(clip01(maxIn(rmsV, start, end) / (rmsMax + 1e-9))),
        c: r3(mean(vprob, start, end)),
        _f: start,
      });
    });
  }

  // same pitch back to back: keep the split only if there is real re-pluck evidence
  const startSet = new Set(starts);
  const kept = [];
  for (const nt of notes) {
    const last = kept[kept.length - 1];
    if (last) {
      const gap = nt.t - (last.t + last.d);
      if (last.midi === nt.midi && gap < 0.03 && !startSet.has(nt._f) && !isReattack(nt._f)) {
        last.d = r3(nt.t + nt.d - last.t);
        last.v = Math.max(last.v, nt.v);
        continue;
      }
    }
    kept.push(nt);
  }
  for (const nt of kept) delete nt._f;
  notes = absorbBlips(kept);

  // sections where pyin is unsure (slap, pops, dead notes): use basic pitch there instead
  const weak = weakSections(vprob, rmsDb, frameT);
  if (weak.some(Boolean) && basicPitch) {
    try {
      const alt = bassLine(await basicPitch());
      const inWeak = (t) => weak[Math.min(weak.length - 1, Math.floor(t / SECTION_SEC))];
      const altWeak = alt.filter((nt) => inWeak(nt.t));
      // basic pitch is deaf below ~E1; keep pyin notes where it left a gap
      const gapFill = notes.filter((nt) => inWeak(nt.t) && nt.d >= 0.1
        && altWeak.every((b) => overlap(nt, b) < 0.3 * nt.d && Math.abs(nt.t - b.t) > 0.08));
      notes = [...notes.filter((nt) => !inWeak(nt.t)), ...altWeak, ...gapFill].sort((a, b) => a.t - b.t);
    } catch (err) {
      console.warn("basic pitch on bass failed", err);
    }
  }
  for (const nt of notes) delete nt.c;
  return notes;
}

// basic pitch events reduced to a single line (louder note wins an overlap)
function bassLine(events) {
  events = [...events].sort((a, b) => a[0] - b[0] || b[3] - a[3]);
  const peak = Math.max(...events.map((e) => e[3]), 0) || 1;
  const out = [];
  for (const [start, end, pitch, amp] of events) {
    const nt = { t: r3(start), d: r3(end - start), midi: pitch, v: r3(Math.min(1, amp / peak)) };
    const prev = out[out.length - 1];
    if (prev && nt.t < prev.t + prev.d - 0.03) {
      if (!(amp / peak > prev.v * 1.2)) continue; // overlapping weaker note (harmonic / octave ghost)
      prev.d = r3(nt.t - prev.t);
      if (prev.d < 0.05) out.pop();
    }
    out.push(nt);
  }
  return out; // no blip folding: short slap notes are real
}

// ------------------------------------------------------------------ vocals

// sung melody: notes plus the continuous pitch contour (vibrato, slides) for display
export async function transcribeVocals(y, { pyinChunk, onProgress } = {}) {
  const sr = PYIN_SR, hop = PYIN_HOP, frame = PYIN_FRAME;
  const frameT = hop / sr;
  if (!anyNonZero(y)) return { notes: [], contour: { t0: 0, step: frameT, midi: [] } };
  const opts = { fmin: noteToHz(VOCAL_RANGE[0]), fmax: noteToHz(VOCAL_RANGE[1]), sr, frameLength: frame, hop };
  const p = await chunkedPyin(y, opts, pyinChunk && ((s) => pyinChunk(s, opts)), onProgress);
  const rmsAll = rms(y, frame, hop);
  const n = Math.min(p.f0.length, rmsAll.length);
  const rmsV = rmsAll.subarray(0, n);
  const rmsDb = amplitudeToDb(rmsV);
  const rmsMax = max(rmsV);
  const active = new Uint8Array(n);
  const midi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    active[i] = p.voiced[i] && rmsDb[i] > -35 && Number.isFinite(p.f0[i]) ? 1 : 0;
    midi[i] = active[i] ? hzToMidi(p.f0[i]) : 0;
  }

  // contour for drawing: light smoothing, ~23 ms resolution
  const step = 4;
  const smooth = medianFilter1d(midi, 5);
  const contour = [];
  for (let i = 0; i < n; i += step) contour.push(active[i] ? Math.round(smooth[i] * 100) / 100 : null);

  // a new syllable on the same pitch shows up as a dip in loudness: treat deep dips as breaks
  const envRaw = amplitudeToDb(rms(y, 256, hop));
  const env = new Float32Array(n).fill(-80);
  env.set(envRaw.subarray(0, Math.min(n, envRaw.length)));
  const w = Math.max(1, Math.floor(0.1 / frameT));
  const lmax = maximumFilter1d(env, w);
  const lmin = minimumFilter1d(env, 2 * w + 1);
  const dip = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const left = n > w ? (i < w ? -80 : lmax[i - w]) : lmax[i];
    const right = n > w ? (i + w < n ? lmax[i + w] : -80) : lmax[i];
    dip[i] = env[i] <= lmin[i] && left - env[i] >= 6 && right - env[i] >= 6 ? 1 : 0;
    if (dip[i]) active[i] = 0;
  }

  // notes: a new note starts when the pitch settles more than ~0.6 semitone away for 50 ms
  const settle = Math.max(1, Math.floor(0.05 / frameT));
  const notes = [];
  let i = 0;
  while (i < n) {
    if (!active[i]) { i++; continue; }
    const start = i;
    let ref = smooth[i], j = i, away = 0;
    const vals = [];
    while (j < n && active[j]) {
      if (Math.abs(smooth[j] - ref) > 0.6) {
        away++;
        if (away >= settle) { j -= away - 1; break; }
      } else {
        away = 0;
        vals.push(smooth[j]);
        ref = median(vals.slice(-20));
      }
      j++;
    }
    const end = j;
    if ((end - start) * frameT >= 0.08 && vals.length) {
      notes.push({
        t: r3(start * frameT),
        d: r3((end - start) * frameT),
        midi: roundHalfEven(median(vals)),
        v: r3(clip01(maxIn(rmsV, start, end) / (rmsMax + 1e-9))),
      });
    }
    i = Math.max(end, start + 1);
  }

  // join same-pitch notes split by a breath shorter than 60 ms
  const merged = [];
  for (const nt of notes) {
    const last = merged[merged.length - 1];
    const gap = last ? nt.t - (last.t + last.d) : 1.0;
    let breath = false;
    if (last) {
      const a = roundHalfEven((nt.t - gap) / frameT), b = roundHalfEven(nt.t / frameT);
      for (let k = a; k < b; k++) if (k < n && dip[k]) { breath = true; break; }
    }
    if (last && last.midi === nt.midi && gap < 0.06 && !breath) last.d = r3(nt.t + nt.d - last.t);
    else merged.push(nt);
  }
  return { notes: merged, contour: { t0: 0, step: Math.round(frameT * step * 1e5) / 1e5, midi: contour } };
}

// ------------------------------------------------------------------ piano / guitar

export const POLY_RANGE = { piano: [27.5, 4200.0], guitar: [80.0, 1400.0] };
const HARMONIC_STEPS = new Set([12, 19, 24, 28]); // octave, octave+fifth, two octaves, two octaves+third
const HARMONIC_RATIO = 0.65;

// an overtone of a sounding note shows up as a quieter note 12/19/24/28 semitones higher: remove it
export function dropHarmonics(notes, ratio = HARMONIC_RATIO) {
  const byStart = notes.map((_, i) => i).sort((a, b) => notes[a].t - notes[b].t);
  const keep = [];
  for (const i of byStart) {
    const n = notes[i];
    const end = n.t + n.d;
    let ghost = false;
    for (const j of byStart) {
      const m = notes[j];
      if (m.t > end) break;
      if (j === i || !HARMONIC_STEPS.has(n.midi - m.midi)) continue;
      if (overlap(n, m) >= 0.5 * n.d && n.v <= ratio * m.v) { ghost = true; break; }
    }
    if (!ghost) keep.push(n);
  }
  return keep;
}

// all notes of a chordal part; quiet bleed from other instruments is dropped.
// events: basic pitch output for the stem; y11k: the stem, mono at 11025
export function polyNotes(events, y11k) {
  if (!events.length) return [];
  const sr = 11025, hop = 110;
  const db = amplitudeToDb(rms(y11k, hop * 2, hop));
  const peak = Math.max(...events.map((e) => e[3])) || 1;
  const out = [];
  for (const [start, end, pitch, amp] of [...events].sort((a, b) => a[0] - b[0] || a[2] - b[2])) {
    const f0 = Math.floor((start * sr) / hop);
    const f1 = Math.max(f0 + 1, Math.floor((end * sr) / hop));
    let loud = -80;
    for (let k = f0; k < Math.min(f1, db.length); k++) if (db[k] > loud) loud = db[k];
    if (amp / peak < 0.2 || loud < -32) continue;
    out.push({ t: r3(start), d: r3(end - start), midi: pitch, v: r3(Math.min(1, amp / peak)) });
  }
  return dropHarmonics(out, HARMONIC_RATIO);
}
