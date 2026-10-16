// beat and downbeat tracking with beat_this (final0): log-mel in js, model in onnxruntime, minimal peak picking
import { stft, melFilters, median } from "./dsp.js";

const SR = 22050, NFFT = 1024, HOP = 441, NMELS = 128, FPS = 50;

// beat_this LogMelSpect: torchaudio MelSpectrogram (magnitude, slaney scale, no norm,
// frame_length normalisation, reflect padding) then log1p(1000 x) -> [frame][128]
export function logMel(y) {
  const s = stft(y, NFFT, HOP, { pad: "reflect", scale: 1 / Math.sqrt(NFFT) });
  const { fb, bins } = melFilters(SR, NFFT, NMELS, 30, 11000, { norm: null, torchFreqs: true });
  const out = new Float32Array(s.frames * NMELS);
  const mag = new Float32Array(bins);
  for (let t = 0; t < s.frames; t++) {
    for (let k = 0; k < bins; k++) mag[k] = Math.hypot(s.re[t * bins + k], s.im[t * bins + k]);
    for (let m = 0; m < NMELS; m++) {
      let acc = 0;
      for (let k = 0; k < bins; k++) { const w = fb[m * bins + k]; if (w) acc += w * mag[k]; }
      out[t * NMELS + m] = Math.log1p(1000 * acc);
    }
  }
  return { spect: out, frames: s.frames };
}

// framewise beat / downbeat logits for the whole piece (split_predict_aggregate, keep_first)
async function predict(ort, session, spect, frames, { chunk = 1500, border = 6 } = {}) {
  const starts = [];
  for (let s = -border; s < frames - border; s += chunk - 2 * border) starts.push(s);
  if (frames > chunk - 2 * border) starts[starts.length - 1] = frames - (chunk - border);
  const beat = new Float32Array(frames).fill(-1000);
  const down = new Float32Array(frames).fill(-1000);
  const preds = [];
  for (const start of starts) {
    const x = new Float32Array(chunk * NMELS);
    const lo = Math.max(start, 0), hi = Math.min(start + chunk, frames);
    const left = Math.max(0, -start);
    x.set(spect.subarray(lo * NMELS, hi * NMELS), left * NMELS);
    const res = await session.run({ spect: new ort.Tensor("float32", x, [1, chunk, NMELS]) });
    preds.push({ start, b: await res.beat.getData(), d: await res.downbeat.getData() });
  }
  // keep_first: later chunks are written first so earlier ones win
  for (const { start, b, d } of preds.reverse()) {
    for (let i = border; i < chunk - border; i++) {
      const f = start + i;
      if (f >= 0 && f < frames) { beat[f] = b[i]; down[f] = d[i]; }
    }
  }
  return { beat, down };
}

function peaks(logits) {
  const n = logits.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) if (logits[k] > m) m = logits[k];
    if (logits[i] === m && logits[i] > 0) out.push(i);
  }
  // deduplicate adjacent peaks into their mean
  const res = [];
  let p = null, c = 0;
  for (const q of out) {
    if (p != null && q - p <= 1) { c++; p += (q - p) / c; } else { if (p != null) res.push(p); p = q; c = 1; }
  }
  if (p != null) res.push(p);
  return res;
}

const r3 = (x) => Math.round(x * 1000) / 1000;

// mono mix at 22050 -> { bpm, beats, downbeats }
export async function detectBeats(ort, session, y) {
  const { spect, frames } = logMel(y);
  const { beat, down } = await predict(ort, session, spect, frames);
  const beats = peaks(beat).map((f) => f / FPS);
  let downs = peaks(down).map((f) => f / FPS);
  if (beats.length) {
    downs = downs.map((d) => {
      let best = 0;
      for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - d) < Math.abs(beats[best] - d)) best = i;
      return beats[best];
    });
  }
  downs = [...new Set(downs)].sort((a, b) => a - b);
  const diffs = beats.slice(1).map((b, i) => b - beats[i]);
  const bpm = beats.length > 1 ? 60 / median(diffs) : 0;
  return { bpm: Math.round(bpm * 10) / 10, beats: beats.map(r3), downbeats: downs.map(r3) };
}
