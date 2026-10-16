// signal helpers ported from librosa / scipy (same defaults, so results line up with the python pipeline)
import { RealFFT } from "./fft.js";

const ffts = new Map();
export function realFFT(n) {
  let f = ffts.get(n);
  if (!f) { f = new RealFFT(n); ffts.set(n, f); }
  return f;
}

// ------------------------------------------------------------------ windows

// periodic hann (scipy get_window("hann", n, fftbins=True) / torch.hann_window)
export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// ------------------------------------------------------------------ resampling

function kaiserBessel0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

const kernels = new Map();
function lowpass(factor) {
  let h = kernels.get(factor);
  if (h) return h;
  // windowed sinc, cutoff just under the new nyquist; long enough to be close to soxr_hq
  const half = 48 * factor;
  const fc = 0.475 / factor;
  const beta = 9;
  const i0b = kaiserBessel0(beta);
  h = new Float64Array(2 * half + 1);
  let sum = 0;
  for (let i = -half; i <= half; i++) {
    const x = i === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * i) / (Math.PI * i);
    const r = i / half;
    const w = kaiserBessel0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    h[i + half] = x * w;
    sum += x * w;
  }
  for (let i = 0; i < h.length; i++) h[i] /= sum;
  kernels.set(factor, h);
  return h;
}

// integer-factor downsampling with an anti-alias filter (44100 -> 22050 / 11025)
export function decimate(x, factor) {
  if (factor === 1) return Float32Array.from(x);
  const h = lowpass(factor);
  const half = (h.length - 1) / 2;
  const n = Math.ceil(x.length / factor);
  const out = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const c = j * factor;
    let acc = 0;
    const lo = Math.max(0, c - half), hi = Math.min(x.length - 1, c + half);
    for (let i = lo; i <= hi; i++) acc += x[i] * h[i - c + half];
    out[j] = acc;
  }
  return out;
}

export function mono(channels) {
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

// ------------------------------------------------------------------ stft

function padded(x, pad, mode) {
  const n = x.length;
  const out = new Float64Array(n + 2 * pad);
  for (let i = 0; i < n; i++) out[pad + i] = x[i];
  if (mode === "reflect") {
    for (let i = 1; i <= pad; i++) {
      out[pad - i] = x[Math.min(n - 1, i) % n];
      out[pad + n - 1 + i] = x[Math.max(0, n - 1 - i)];
    }
  }
  return out;
}

// centred stft -> { re, im, frames, bins } as [frame][bin] flat arrays (frame-major)
export function stft(x, nFft, hop, { pad = "constant", window = hann(nFft), scale = 1 } = {}) {
  const xp = padded(x, nFft >> 1, pad);
  const frames = 1 + Math.floor((xp.length - nFft) / hop);
  const bins = (nFft >> 1) + 1;
  const re = new Float32Array(frames * bins);
  const im = new Float32Array(frames * bins);
  const f = realFFT(nFft);
  const buf = new Float64Array(nFft);
  const or = new Float64Array(bins), oi = new Float64Array(bins);
  for (let t = 0; t < frames; t++) {
    const o = t * hop;
    for (let i = 0; i < nFft; i++) buf[i] = xp[o + i] * window[i];
    f.forward(buf, or, oi);
    const base = t * bins;
    for (let k = 0; k < bins; k++) { re[base + k] = or[k] * scale; im[base + k] = oi[k] * scale; }
  }
  return { re, im, frames, bins, nFft, hop };
}

// |stft|^power, frame-major
export function spectrogram(x, nFft, hop, opts = {}, power = 2) {
  const s = stft(x, nFft, hop, opts);
  const S = new Float32Array(s.frames * s.bins);
  for (let i = 0; i < S.length; i++) {
    const m = s.re[i] * s.re[i] + s.im[i] * s.im[i];
    S[i] = power === 2 ? m : Math.pow(m, power / 2);
  }
  return { S, frames: s.frames, bins: s.bins };
}

// ------------------------------------------------------------------ levels

// librosa.feature.rms (center=True, constant padding)
export function rms(y, frameLength, hop) {
  const pad = frameLength >> 1;
  const n = y.length + 2 * pad;
  const frames = 1 + Math.floor((n - frameLength) / hop);
  const out = new Float32Array(frames);
  // prefix sum of squares for O(1) windows
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = i >= pad && i < pad + y.length ? y[i - pad] : 0;
    cs[i + 1] = cs[i] + v * v;
  }
  for (let t = 0; t < frames; t++) {
    const a = t * hop;
    out[t] = Math.sqrt(Math.max(0, cs[a + frameLength] - cs[a]) / frameLength);
  }
  return out;
}

export function max(a) { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }
export function min(a) { let m = Infinity; for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i]; return m; }
export function mean(a, lo = 0, hi = a.length) {
  let s = 0;
  for (let i = lo; i < hi; i++) s += a[i];
  return hi > lo ? s / (hi - lo) : NaN;
}

// librosa.amplitude_to_db(S, ref=ref) with amin=1e-5, top_db=80
export function amplitudeToDb(a, ref = max(a)) {
  const amin = 1e-10;
  const refDb = 10 * Math.log10(Math.max(amin, ref * ref));
  const out = new Float32Array(a.length);
  let top = -Infinity;
  for (let i = 0; i < a.length; i++) {
    out[i] = 10 * Math.log10(Math.max(amin, a[i] * a[i])) - refDb;
    if (out[i] > top) top = out[i];
  }
  for (let i = 0; i < a.length; i++) if (out[i] < top - 80) out[i] = top - 80;
  return out;
}

// librosa.power_to_db(S, ref=ref) with amin=1e-10, top_db=80
export function powerToDb(a, ref = 1) {
  const amin = 1e-10;
  const refDb = 10 * Math.log10(Math.max(amin, ref));
  const out = new Float32Array(a.length);
  let top = -Infinity;
  for (let i = 0; i < a.length; i++) {
    out[i] = 10 * Math.log10(Math.max(amin, a[i])) - refDb;
    if (out[i] > top) top = out[i];
  }
  for (let i = 0; i < a.length; i++) if (out[i] < top - 80) out[i] = top - 80;
  return out;
}

export const hzToMidi = (f) => 12 * (Math.log2(f) - Math.log2(440)) + 69;
export const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);
const NOTE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function noteToHz(note) {
  const m = /^([A-G])([#b]?)(-?\d+)$/.exec(note);
  const pc = NOTE_PC[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return midiToHz(pc + 12 * (Number(m[3]) + 1));
}

// numpy percentile, linear interpolation
export function percentile(a, q) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const pos = ((s.length - 1) * q) / 100;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function median(a) { return percentile(a, 50); }

// ------------------------------------------------------------------ scipy.ndimage filters (mode="reflect")

const reflectIdx = (i, n) => {
  // scipy "reflect": (d c b a | a b c d | d c b a)
  if (n === 1) return 0;
  const p = 2 * n;
  i = ((i % p) + p) % p;
  return i < n ? i : p - 1 - i;
};

function rankFilter1d(x, size, pick) {
  const n = x.length;
  const out = new Float64Array(n);
  const left = size >> 1;
  for (let i = 0; i < n; i++) {
    let m = pick === "max" ? -Infinity : Infinity;
    for (let k = 0; k < size; k++) {
      const v = x[reflectIdx(i - left + k, n)];
      if (pick === "max" ? v > m : v < m) m = v;
    }
    out[i] = m;
  }
  return out;
}
export const maximumFilter1d = (x, size) => rankFilter1d(x, size, "max");
export const minimumFilter1d = (x, size) => rankFilter1d(x, size, "min");

export function medianFilter1d(x, size) {
  const n = x.length;
  const out = new Float64Array(n);
  const left = size >> 1;
  const win = new Float64Array(size);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < size; k++) win[k] = x[reflectIdx(i - left + k, n)];
    win.sort();
    out[i] = win[size >> 1];
  }
  return out;
}

// ------------------------------------------------------------------ mel

const hzToMelSlaney = (f) => {
  const fsp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fsp, logstep = Math.log(6.4) / 27;
  return f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logstep : f / fsp;
};
const melToHzSlaney = (m) => {
  const fsp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fsp, logstep = Math.log(6.4) / 27;
  return m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : fsp * m;
};

// triangular mel filterbank [mel][bin]; norm "slaney" (librosa) or null (torchaudio default)
export function melFilters(sr, nFft, nMels, fmin, fmax, { norm = "slaney", torchFreqs = false } = {}) {
  const bins = (nFft >> 1) + 1;
  const freqs = new Float64Array(bins);
  // torchaudio uses linspace(0, sr // 2, bins); librosa uses fft_frequencies (same for even sr)
  const top = torchFreqs ? Math.floor(sr / 2) : sr / 2;
  for (let k = 0; k < bins; k++) freqs[k] = (k * top) / (bins - 1);
  const mMin = hzToMelSlaney(fmin), mMax = hzToMelSlaney(fmax);
  const pts = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) pts[i] = melToHzSlaney(mMin + ((mMax - mMin) * i) / (nMels + 1));
  const fb = new Float32Array(nMels * bins);
  for (let m = 0; m < nMels; m++) {
    const lo = pts[m], c = pts[m + 1], hi = pts[m + 2];
    const enorm = norm === "slaney" ? 2 / (hi - lo) : 1;
    for (let k = 0; k < bins; k++) {
      const down = (freqs[k] - lo) / (c - lo);
      const up = (hi - freqs[k]) / (hi - c);
      const v = Math.max(0, Math.min(down, up));
      fb[m * bins + k] = v * enorm;
    }
  }
  return { fb, bins, nMels };
}

// apply a filterbank to a frame-major spectrogram -> frame-major [frame][mel]
export function applyFilters(S, frames, bins, { fb, nMels }) {
  const out = new Float32Array(frames * nMels);
  for (let t = 0; t < frames; t++) {
    const so = t * bins;
    for (let m = 0; m < nMels; m++) {
      const fo = m * bins;
      let acc = 0;
      for (let k = 0; k < bins; k++) {
        const w = fb[fo + k];
        if (w) acc += w * S[so + k];
      }
      out[t * nMels + m] = acc;
    }
  }
  return out;
}

// ------------------------------------------------------------------ onsets

// librosa.onset.onset_strength(y, sr, hop_length) with its defaults (mel power spectrum, lag 1, mean)
export function onsetStrength(y, sr, hop) {
  const nFft = 2048, nMels = 128;
  const { S, frames, bins } = spectrogram(y, nFft, hop);
  const mel = applyFilters(S, frames, bins, melFilters(sr, nFft, nMels, 0, sr / 2));
  const db = powerToDb(mel);
  const env = new Float32Array(frames);
  const pad = 1 + Math.floor(nFft / (2 * hop));
  for (let t = 1; t < frames; t++) {
    let acc = 0;
    for (let m = 0; m < nMels; m++) acc += Math.max(0, db[t * nMels + m] - db[(t - 1) * nMels + m]);
    const dst = t - 1 + pad;
    if (dst < frames) env[dst] = acc / nMels;
  }
  return env;
}

// librosa.util.peak_pick, greedy
export function peakPick(x, preMax, postMax, preAvg, postAvg, delta, wait) {
  const n = x.length;
  const peaks = [];
  const maxIn = (a, b) => { let m = -Infinity; for (let i = Math.max(0, a); i < Math.min(b, n); i++) if (x[i] > m) m = x[i]; return m; };
  const avgIn = (a, b) => { const lo = Math.max(0, a), hi = Math.min(b, n); let s = 0; for (let i = lo; i < hi; i++) s += x[i]; return s / (hi - lo); };
  let first = x[0] >= maxIn(0, postMax) && x[0] >= avgIn(0, postAvg) + delta;
  if (first) peaks.push(0);
  let i = first ? wait + 1 : 1;
  while (i < n) {
    if (x[i] !== maxIn(i - preMax, i + postMax)) { i++; continue; }
    if (!(x[i] >= avgIn(i - preAvg, i + postAvg) + delta)) { i++; continue; }
    peaks.push(i);
    i += wait + 1;
  }
  return peaks;
}

// librosa.onset.onset_detect(y, sr, hop_length, delta, wait), frames, no backtracking
export function onsetDetect(y, sr, hop, { delta = 0.07, wait = Math.floor((0.03 * sr) / hop) } = {}) {
  const env = onsetStrength(y, sr, hop);
  const lo = min(env);
  for (let i = 0; i < env.length; i++) env[i] -= lo;
  const hi = max(env) + 1.1754944e-38;
  let any = false;
  for (let i = 0; i < env.length; i++) { env[i] /= hi; if (env[i]) any = true; }
  if (!any) return [];
  const c = (v) => Math.ceil(v);
  return peakPick(env,
    c(Math.floor((0.03 * sr) / hop)), c(Math.floor(0 / hop) + 1),
    c(Math.floor((0.1 * sr) / hop)), c(Math.floor((0.1 * sr) / hop) + 1),
    delta, c(wait));
}

// ------------------------------------------------------------------ viterbi

// log-domain viterbi with a sparse predecessor list per state (librosa _viterbi with a threshold)
// logProb(t, s) -> log observation; preds[j] = { k: Int32Array, w: Float64Array (log trans k->j) }
export function viterbi(nSteps, nStates, logProb, preds, logInit) {
  let prev = new Float64Array(nStates);
  let cur = new Float64Array(nStates);
  const ptr = new Uint16Array(nSteps * nStates);
  for (let s = 0; s < nStates; s++) prev[s] = logProb(0, s) + logInit[s];
  for (let t = 1; t < nSteps; t++) {
    const po = t * nStates;
    for (let j = 0; j < nStates; j++) {
      const { k, w } = preds[j];
      let best = -Infinity, arg = 0;
      for (let q = 0; q < k.length; q++) {
        const c = prev[k[q]] + w[q];
        if (c > best) { best = c; arg = k[q]; }
      }
      cur[j] = best + logProb(t, j);
      ptr[po + j] = arg;
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  const states = new Int32Array(nSteps);
  let bestS = 0;
  for (let s = 1; s < nStates; s++) if (prev[s] > prev[bestS]) bestS = s;
  states[nSteps - 1] = bestS;
  for (let t = nSteps - 1; t > 0; t--) states[t - 1] = ptr[t * nStates + states[t]];
  return states;
}

// dense transition matrix -> predecessor lists (keeps entries >= minProb, like librosa's threshold)
export function predecessors(trans, n, minProb = 0) {
  const eps = 2.2250738585072014e-308;
  const thr = minProb > 0 ? Math.log(minProb + eps) : -Infinity;
  const preds = [];
  for (let j = 0; j < n; j++) {
    const ks = [], ws = [];
    for (let k = 0; k < n; k++) {
      const lw = Math.log(trans[k * n + j] + eps);
      if (lw >= thr) { ks.push(k); ws.push(lw); }
    }
    preds.push({ k: Int32Array.from(ks), w: Float64Array.from(ws) });
  }
  return preds;
}

// librosa.sequence.transition_loop
export function transitionLoop(n, p) {
  const t = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) t[i * n + j] = i === j ? p : (1 - p) / (n - 1);
  return t;
}
