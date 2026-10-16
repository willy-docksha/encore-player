// key and chord detection (port of detect_chords in backend/pipeline.py)
import { percentile, transitionLoop, predecessors, viterbi } from "./dsp.js";
import { chromaCqt } from "./cqt.js";
import { r3 } from "./transcribe.js";

export const NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const NOTE_NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

// krumhansl-kessler key profiles
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const FLAT_KEYS = new Set(["5maj", "10maj", "3maj", "8maj", "1maj", "6maj", "2min", "7min", "0min", "5min", "10min", "3min"]);

// thresholds relative to the chord core (mean of root and fifth), tuned on a synthetic chord set
const EXT = { third_max: 0.45, sus: 0.8, seventh: 0.75, add9: 0.8, dim: 0.6 };

function corr(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}

const roll = (prof, k) => prof.map((_, i) => prof[(((i - k) % 12) + 12) % 12]);

export function detectKey(chromaMean) {
  let best = [-Infinity, 0, "maj"];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, prof] of [["maj", KK_MAJOR], ["min", KK_MINOR]]) {
      const r = corr(chromaMean, roll(prof, tonic));
      if (r > best[0]) best = [r, tonic, mode];
    }
  }
  return [best[1], best[2]];
}

function chordTemplates() {
  const temps = [], labels = [];
  for (let root = 0; root < 12; root++) {
    for (const [qual, ivs] of [["maj", [0, 4, 7]], ["min", [0, 3, 7]]]) {
      const t = new Float64Array(12);
      for (const i of ivs) t[(root + i) % 12] = 1;
      t[root] += 0.3; // root a bit stronger
      const norm = Math.hypot(...t);
      temps.push(t.map((v) => v / norm));
      labels.push([root, qual]);
    }
  }
  return { temps, labels };
}

// suffix from the averaged chroma of the harmony stem
function chordExtension(c, root, qual) {
  const mx = Math.max(...c) + 1e-9;
  const at = (iv) => c[(root + iv) % 12] / mx;
  const core = (at(0) + at(7)) / 2 + 1e-9;
  if (qual === "min") {
    if (at(6) >= EXT.dim * core && at(6) > at(7) * 1.1) return "dim";
    return at(10) >= EXT.seventh * core ? "m7" : "m";
  }
  if (at(4) < EXT.third_max * core && Math.max(at(5), at(2)) >= EXT.sus * core) return at(5) >= at(2) ? "sus4" : "sus2";
  if (at(11) >= EXT.seventh * core && at(11) > at(10)) return "maj7";
  if (at(10) >= EXT.seventh * core) return "7";
  if (at(2) >= EXT.add9 * core) return "add9";
  return "";
}

// re-read a triad over a foreign bass note as the seventh / sus chord of that bass note
function bassReading(c, root, qual, bassPc) {
  if (bassPc == null || bassPc === root) return null;
  const iv = (((root - bassPc) % 12) + 12) % 12;
  if (qual === "maj" && iv === 3) return [bassPc, "min"]; // c over a = am7
  if (qual === "min" && iv === 4) return [bassPc, "maj"]; // em over c = cmaj7
  const mx = Math.max(...c) + 1e-9;
  const at = (k) => c[(bassPc + k) % 12] / mx;
  const core = (at(0) + at(7)) / 2 + 1e-9;
  if (at(7) > 0.5 && at(4) < EXT.third_max * core && at(3) < EXT.third_max * core && Math.max(at(5), at(2)) >= EXT.sus * core) {
    return [bassPc, "maj"]; // sus chord on the bass note (e.g. g over d = dsus4)
  }
  return null;
}

function dominantBassPc(notes, s, e) {
  const w = new Float64Array(12);
  let sum = 0;
  for (const nt of notes) {
    const ov = Math.min(e, nt.t + nt.d) - Math.max(s, nt.t);
    if (ov > 0) { w[nt.midi % 12] += ov; sum += ov; }
  }
  if (sum < 0.25 * (e - s)) return null;
  let best = 0;
  for (let k = 1; k < 12; k++) if (w[k] > w[best]) best = k;
  return best;
}

const searchsorted = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };

// harmony / bass: stems as mono at 22050. returns { chords, key }
export function detectChords(harmony, bass, beats, bassNotes) {
  const sr = 22050, hop = 2048;
  const n = Math.min(harmony.length, bass.length);
  const yo = harmony.subarray(0, n);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = yo[i] + 0.6 * bass[i];

  const { chroma, frames } = chromaCqt(y, sr, hop);
  // harmony-only chroma (no bass) to judge 7ths, 9ths and sus notes
  const ch = chromaCqt(yo, sr, hop);
  const energy = new Float64Array(frames);
  const chromaMean = new Float64Array(12);
  for (let t = 0; t < frames; t++) {
    for (let c = 0; c < 12; c++) { energy[t] += chroma[t * 12 + c]; chromaMean[c] += chroma[t * 12 + c] / frames; }
  }
  const [keyTonic, keyMode] = detectKey(chromaMean);
  const names = FLAT_KEYS.has(`${keyTonic}${keyMode}`) ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  const key = `${names[keyTonic]} ${keyMode === "maj" ? "major" : "minor"}`;

  const { temps, labels } = chordTemplates();
  const nState = labels.length;
  const S = nState + 1;
  const silentRef = 0.05 * percentile(energy, 95) + 1e-9;
  const probs = new Float64Array(frames * S);
  for (let t = 0; t < frames; t++) {
    let norm = 0;
    for (let c = 0; c < 12; c++) norm += chroma[t * 12 + c] ** 2;
    norm = Math.sqrt(norm) + 1e-9;
    let tot = 0;
    for (let s = 0; s < nState; s++) {
      let sc = 0;
      for (let c = 0; c < 12; c++) sc += temps[s][c] * (chroma[t * 12 + c] / norm);
      probs[t * S + s] = Math.exp(sc * 12);
      tot += probs[t * S + s];
    }
    // "no chord" state for silent / noisy frames
    probs[t * S + nState] = Math.exp((energy[t] < silentRef ? 1.0 : 0.55) * 12);
    tot += probs[t * S + nState];
    for (let s = 0; s < S; s++) probs[t * S + s] /= tot;
  }
  const eps = 2.2250738585072014e-308;
  const logMarg = Math.log(1 / S + eps);
  const preds = predecessors(transitionLoop(S, 0.97), S);
  const logInit = new Float64Array(S).fill(Math.log(1 / S + eps));
  const path = viterbi(frames, S, (t, s) => Math.log(probs[t * S + s] + eps) - logMarg, preds, logInit);

  const times = Float64Array.from({ length: frames + 1 }, (_, i) => (i * hop) / sr);
  let segs = [];
  for (let i = 0; i < frames; i++) {
    const last = segs[segs.length - 1];
    if (last && last.state === path[i]) last.e = times[i + 1];
    else segs.push({ state: path[i], s: times[i], e: times[i + 1] });
  }
  // snap boundaries to nearby beats
  if (beats?.length) {
    for (const sg of segs.slice(1)) {
      let j = 0;
      for (let b = 1; b < beats.length; b++) if (Math.abs(beats[b] - sg.s) < Math.abs(beats[j] - sg.s)) j = b;
      if (Math.abs(beats[j] - sg.s) < 0.2) sg.s = beats[j];
    }
    for (let i = 0; i + 1 < segs.length; i++) segs[i].e = segs[i + 1].s;
  }
  // merge very short segments into the previous one
  const cleaned = [];
  for (const sg of segs) {
    const last = cleaned[cleaned.length - 1];
    if (last && (sg.e - sg.s < 0.35 || last.state === sg.state)) last.e = sg.e;
    else cleaned.push({ ...sg });
  }

  const out = [];
  for (const sg of cleaned) {
    let label;
    if (sg.state === nState) label = "N";
    else {
      let [root, qual] = labels[sg.state];
      const f0 = searchsorted(times, sg.s);
      const f1 = Math.max(f0 + 1, searchsorted(times, sg.e));
      const c = new Float64Array(12);
      let cnt = 0;
      for (let t = f0; t < Math.min(f1, ch.frames); t++) { for (let k = 0; k < 12; k++) c[k] += ch.chroma[t * 12 + k]; cnt++; }
      for (let k = 0; k < 12; k++) c[k] /= cnt || 1;
      const bassPc = dominantBassPc(bassNotes, sg.s, sg.e);
      const alt = bassReading(c, root, qual, bassPc);
      if (alt) [root, qual] = alt;
      const suffix = chordExtension(c, root, qual);
      label = names[root] + suffix;
      const third = (root + (qual === "min" ? 3 : 4)) % 12;
      const fifth = (root + 7) % 12;
      if (bassPc != null && (bassPc === third || bassPc === fifth) && !suffix.startsWith("sus")) label += "/" + names[bassPc];
    }
    const last = out[out.length - 1];
    if (last && last.label === label) { last.d = r3(sg.e - last.t); continue; }
    out.push({ t: r3(sg.s), d: r3(sg.e - sg.s), label });
  }
  return { chords: out, key };
}
