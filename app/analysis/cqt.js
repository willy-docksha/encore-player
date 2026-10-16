// constant-q chroma (librosa.feature.chroma_cqt with norm=None), computed octave by octave
import { realFFT, hann, decimate, stft, median, noteToHz } from "./dsp.js";

const BPO = 36;
const N_OCTAVES = 7;

// librosa.estimate_tuning(y, sr, bins_per_octave) via piptrack (n_fft 2048, hop 512, 150-4000 hz)
export function estimateTuning(y, sr, binsPerOctave = BPO) {
  const nFft = 2048, hop = 512;
  const s = stft(y, nFft, hop);
  const { frames, bins } = s;
  const S = new Float64Array(frames * bins);
  for (let i = 0; i < S.length; i++) S[i] = Math.hypot(s.re[i], s.im[i]);
  const pitches = [], mags = [];
  const fmin = 150, fmax = Math.min(4000, sr / 2);
  const col = new Float64Array(bins);
  for (let t = 0; t < frames; t++) {
    let ref = 0;
    for (let k = 0; k < bins; k++) { col[k] = S[t * bins + k]; if (col[k] > ref) ref = col[k]; }
    ref *= 0.1;
    const g = (k) => (k === 0 ? col[1] - col[0] : k === bins - 1 ? col[k] - col[k - 1] : (col[k + 1] - col[k - 1]) / 2);
    const thr = (k) => (col[k] > ref ? col[k] : 0);
    for (let k = 1; k < bins; k++) {
      const f = (k * sr) / nFft;
      if (f < fmin || f >= fmax) continue;
      const isMax = k === bins - 1 ? thr(k) > thr(k - 1) : thr(k) > thr(k - 1) && thr(k) >= thr(k + 1);
      if (!isMax) continue;
      let shift = 0;
      if (k < bins - 1) {
        const a = col[k + 1] + col[k - 1] - 2 * col[k];
        const b = (col[k + 1] - col[k - 1]) / 2;
        shift = Math.abs(b) >= Math.abs(a) ? 0 : -b / a;
      }
      const p = ((k + shift) * sr) / nFft;
      if (p > 0) { pitches.push(p); mags.push(col[k] + 0.5 * g(k) * shift); }
    }
  }
  if (!pitches.length) return 0;
  const thr = median(mags);
  const counts = new Int32Array(100);
  let any = false;
  for (let i = 0; i < pitches.length; i++) {
    if (mags[i] < thr) continue;
    let r = (binsPerOctave * Math.log2(pitches[i] / (440 / 16))) % 1;
    if (r < 0) r += 1;
    if (r >= 0.5) r -= 1;
    let b = Math.floor((r + 0.5) * 100);
    if (b >= 100) b = 99;
    counts[b]++;
    any = true;
  }
  if (!any) return 0;
  let best = 0;
  for (let b = 1; b < 100; b++) if (counts[b] > counts[best]) best = b;
  return -0.5 + best / 100;
}

// |cqt| for 252 bins (36 per octave from C1), frame-major [frame][bin]
export function cqtMagnitude(y, sr, hop, tuning) {
  const fmin = noteToHz("C1") * 2 ** (tuning / BPO);
  const nBins = BPO * N_OCTAVES;
  const r = 2 ** (1 / BPO);
  const alpha = (r * r - 1) / (r * r + 1);
  const Q = 1 / alpha;
  let x = y;
  let srO = sr, hopO = hop;
  const perOctave = [];
  for (let o = 0; o < N_OCTAVES; o++) {
    // bins of this octave, top octave first
    const hiBin = nBins - o * BPO;
    const loBin = hiBin - BPO;
    const filters = [];
    let maxLen = 0;
    for (let k = loBin; k < hiBin; k++) {
      const f = fmin * 2 ** (k / BPO);
      const len = (Q * srO) / f;
      filters.push({ k, f, len });
      maxLen = Math.max(maxLen, len);
    }
    let nFft = 1;
    while (nFft < Math.ceil(maxLen)) nFft <<= 1;
    const rf = realFFT(nFft);
    const nb = (nFft >> 1) + 1;
    // filter spectra (hann-windowed complex exponentials, l1-normalised, centred in the frame)
    const tmp = new Float64Array(nFft);
    const spec = filters.map(({ f, len }) => {
      const ilen = Math.floor(len);
      const win = hann(ilen);
      const re = new Float64Array(nFft), im = new Float64Array(nFft);
      let l1 = 0;
      for (let i = 0; i < ilen; i++) l1 += win[i];
      const start = Math.floor((nFft - ilen) / 2);
      const off = -Math.floor(ilen / 2);
      for (let i = 0; i < ilen; i++) {
        const ph = (2 * Math.PI * f * (i + off)) / srO;
        re[start + i] = (win[i] * Math.cos(ph)) / l1;
        im[start + i] = (win[i] * Math.sin(ph)) / l1;
      }
      // spectrum of a complex sequence from two real ffts
      const ar = new Float64Array(nb), ai = new Float64Array(nb), br = new Float64Array(nb), bi = new Float64Array(nb);
      tmp.set(re); rf.forward(tmp, ar, ai);
      tmp.set(im); rf.forward(tmp, br, bi);
      // conj(F) restricted to positive frequencies: F[k] = A[k] + i B[k]
      const keep = [];
      let energy = 0;
      const mag = new Float64Array(nb);
      const fr = new Float64Array(nb), fi = new Float64Array(nb);
      for (let k = 0; k < nb; k++) {
        fr[k] = ar[k] - bi[k];
        fi[k] = ai[k] + br[k];
        mag[k] = Math.hypot(fr[k], fi[k]);
        energy += mag[k];
      }
      // sparsify like librosa (drop the smallest bins holding 1% of each filter's total magnitude)
      const order = Array.from(mag.keys()).sort((p, q) => mag[p] - mag[q]);
      let dropped = 0;
      const zero = new Uint8Array(nb);
      for (const k of order) {
        if (dropped + mag[k] > 0.01 * energy) break;
        dropped += mag[k];
        zero[k] = 1;
      }
      for (let k = 0; k < nb; k++) if (!zero[k]) keep.push(k);
      // librosa rescales each downsampled octave by sqrt(2) on top of sqrt(filter length)
      return { idx: Int32Array.from(keep), re: Float64Array.from(keep, (k) => fr[k]), im: Float64Array.from(keep, (k) => fi[k]), scale: Math.sqrt(len) * Math.SQRT2 ** o };
    });
    // frames of the (unscaled) signal, centred, zero padded
    const frames = 1 + Math.floor(x.length / hopO);
    const out = new Float32Array(frames * BPO);
    const buf = new Float64Array(nFft);
    const xr = new Float64Array(nb), xi = new Float64Array(nb);
    for (let t = 0; t < frames; t++) {
      const c = t * hopO - (nFft >> 1);
      for (let i = 0; i < nFft; i++) { const j = c + i; buf[i] = j >= 0 && j < x.length ? x[j] : 0; }
      rf.forward(buf, xr, xi);
      for (let q = 0; q < BPO; q++) {
        const { idx, re, im, scale } = spec[q];
        // inner product of the frame with the filter (parseval); the filter only has positive frequencies
        let sr_ = 0, si_ = 0;
        for (let p = 0; p < idx.length; p++) {
          const k = idx[p];
          sr_ += xr[k] * re[p] + xi[k] * im[p];
          si_ += xi[k] * re[p] - xr[k] * im[p];
        }
        out[t * BPO + q] = (Math.hypot(sr_, si_) / nFft) * scale;
      }
    }
    perOctave.push({ out, frames, loBin });
    if (o < N_OCTAVES - 1) {
      x = decimate(x, 2);
      srO /= 2;
      hopO /= 2;
    }
  }
  const frames = Math.min(...perOctave.map((p) => p.frames));
  const C = new Float32Array(frames * nBins);
  for (const { out, loBin } of perOctave) {
    for (let t = 0; t < frames; t++) for (let q = 0; q < BPO; q++) C[t * nBins + loBin + q] = out[t * BPO + q];
  }
  return { C, frames, nBins };
}

// chroma [frame][12] from |cqt| (librosa cq_to_chroma: three bins per semitone, centred)
export function chromaCqt(y, sr, hop, tuning = estimateTuning(y, sr)) {
  const { C, frames, nBins } = cqtMagnitude(y, sr, hop, tuning);
  const chroma = new Float32Array(frames * 12);
  for (let t = 0; t < frames; t++) {
    for (let b = 0; b < nBins; b++) {
      const c = Math.floor(((b % BPO) + 1) % BPO / 3);
      chroma[t * 12 + c] += C[t * nBins + b];
    }
  }
  return { chroma, frames, tuning };
}
