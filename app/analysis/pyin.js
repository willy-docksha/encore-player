// probabilistic yin, a line-by-line port of librosa.pyin (same defaults and quirks)
import { realFFT, viterbi } from "./dsp.js";

const N_THRESHOLDS = 100;
const BETA = [2, 18];
const BOLTZMANN = 2;
const RESOLUTION = 0.1;
const MAX_TRANSITION_RATE = 35.92;
const SWITCH_PROB = 0.01;
const NO_TROUGH_PROB = 0.01;
const TRANSITION_MIN_PROB = 1e-4;
const TINY = 2.2250738585072014e-308;

// regularized incomplete beta for integer a, b (closed form)
function betaCdf(x, a, b) {
  const n = a + b - 1;
  let s = 0;
  let c = 1; // binomial(n, j)
  for (let j = 0; j <= n; j++) {
    if (j >= a) s += c * x ** j * (1 - x) ** (n - j);
    c = (c * (n - j)) / (j + 1);
  }
  return s;
}

const betaProbs = (() => {
  const p = new Float64Array(N_THRESHOLDS);
  let prev = betaCdf(0, BETA[0], BETA[1]);
  for (let t = 0; t < N_THRESHOLDS; t++) {
    const c = betaCdf((t + 1) / N_THRESHOLDS, BETA[0], BETA[1]);
    p[t] = c - prev;
    prev = c;
  }
  return p;
})();

function boltzmannPmf(k, lambda, n) {
  if (k < 0 || k >= n) return 0;
  return ((1 - Math.exp(-lambda)) / (1 - Math.exp(-lambda * n))) * Math.exp(-lambda * k);
}

// sparse predecessor lists of kron(transition_loop(2, 1 - switch), transition_local(nBins, width))
const predCache = new Map();
function pitchPredecessors(nBins, width) {
  const key = `${nBins}:${width}`;
  let preds = predCache.get(key);
  if (preds) return preds;
  const half = width >> 1;
  const tri = new Float64Array(width);
  for (let i = 0; i < width; i++) tri[i] = 1 - Math.abs(i - (width - 1) / 2) / ((width + 1) / 2);
  // local[i][j]: triangle centred on i, cut at the edges, rows normalised
  const rowSum = new Float64Array(nBins);
  for (let i = 0; i < nBins; i++) {
    for (let j = Math.max(0, i - half); j <= Math.min(nBins - 1, i + half); j++) rowSum[i] += tri[j - i + half];
  }
  const local = (i, j) => (Math.abs(i - j) > half ? 0 : tri[j - i + half] / rowSum[i]);
  const sw = [[1 - SWITCH_PROB, SWITCH_PROB], [SWITCH_PROB, 1 - SWITCH_PROB]];
  const thr = Math.log(TRANSITION_MIN_PROB + TINY);
  preds = [];
  for (let b = 0; b < 2; b++) {
    for (let j = 0; j < nBins; j++) {
      const ks = [], ws = [];
      for (let a = 0; a < 2; a++) {
        for (let i = Math.max(0, j - half); i <= Math.min(nBins - 1, j + half); i++) {
          const lw = Math.log(sw[a][b] * local(i, j) + TINY);
          if (lw >= thr) { ks.push(a * nBins + i); ws.push(lw); }
        }
      }
      // keep librosa's order (ascending state index) so ties resolve the same way
      const order = ks.map((_, q) => q).sort((p, q) => ks[p] - ks[q]);
      preds.push({ k: Int32Array.from(order.map((q) => ks[q])), w: Float64Array.from(order.map((q) => ws[q])) });
    }
  }
  predCache.set(key, preds);
  return preds;
}

// returns { f0 (NaN when unvoiced), voiced (Uint8Array), vprob }
export function pyin(y, { fmin, fmax, sr, frameLength, hop }) {
  const half = frameLength >> 1;
  const n = y.length + 2 * half;
  const frames = 1 + Math.floor((n - frameLength) / hop);
  const minPeriod = Math.floor(sr / fmax);
  const maxPeriod = Math.min(Math.ceil(sr / fmin), frameLength - 1);
  const L = maxPeriod - minPeriod + 1;
  const binsPerSemitone = Math.ceil(1 / RESOLUTION);
  const nBins = Math.floor(12 * binsPerSemitone * Math.log2(fmax / fmin)) + 1;
  const nStates = 2 * nBins;

  let nfft = 1;
  while (nfft < 2 * frameLength - 1) nfft <<= 1;
  const rf = realFFT(nfft);
  const buf = new Float64Array(nfft);
  const re = new Float64Array(nfft / 2 + 1), im = new Float64Array(nfft / 2 + 1);
  const acf = new Float64Array(nfft);
  const d = new Float64Array(maxPeriod + 1);
  const yin = new Float64Array(L);
  const shift = new Float64Array(L);
  const probs = new Float64Array(L);

  const obs = new Float32Array(frames * nStates);
  const vprob = new Float32Array(frames);
  const sample = (i) => (i >= half && i < half + y.length ? y[i - half] : 0);

  for (let t = 0; t < frames; t++) {
    const o = t * hop;
    buf.fill(0);
    for (let i = 0; i < frameLength; i++) buf[i] = sample(o + i);
    // autocorrelation through the power spectrum
    rf.forward(buf, re, im);
    for (let k = 0; k < re.length; k++) { re[k] = re[k] * re[k] + im[k] * im[k]; im[k] = 0; }
    rf.inverse(re, im, acf);
    // difference function (librosa's cumulative-energy form)
    // C[i] = cumsum(x^2)[i] for i >= 1, C[0] = 0; d[tau] = 2 (r0 - r_tau) - C[tau - 1]
    let cum = buf[0] * buf[0];
    d[0] = 0;
    for (let tau = 1; tau <= maxPeriod; tau++) {
      if (tau >= 2) cum += buf[tau - 1] * buf[tau - 1];
      d[tau] = 2 * (acf[0] - acf[tau]) - (tau >= 2 ? cum : 0);
    }
    // cumulative mean normalised difference for periods min..max
    let run = 0;
    for (let tau = 1; tau <= maxPeriod; tau++) {
      run += d[tau];
      if (tau >= minPeriod) yin[tau - minPeriod] = d[tau] / (run / tau + TINY);
    }
    // parabolic interpolation
    shift[0] = 0; shift[L - 1] = 0;
    for (let i = 1; i < L - 1; i++) {
      const a = yin[i + 1] + yin[i - 1] - 2 * yin[i];
      const b = (yin[i + 1] - yin[i - 1]) / 2;
      shift[i] = Math.abs(b) >= Math.abs(a) ? 0 : -b / a;
    }
    // troughs
    const troughs = [];
    if (yin[0] < yin[1]) troughs.push(0);
    for (let i = 1; i < L - 1; i++) if (yin[i] < yin[i - 1] && yin[i] <= yin[i + 1]) troughs.push(i);
    if (yin[L - 1] < yin[L - 2]) troughs.push(L - 1);
    probs.fill(0);
    if (troughs.length) {
      const nT = troughs.length;
      // n_troughs per threshold and running positions
      const nBelow = new Int32Array(N_THRESHOLDS);
      for (const ti of troughs) {
        const h = yin[ti];
        for (let th = 0; th < N_THRESHOLDS; th++) if (h < (th + 1) / N_THRESHOLDS) nBelow[th]++;
      }
      const pos = new Int32Array(N_THRESHOLDS).fill(-1);
      let gmin = 0;
      for (let j = 0; j < nT; j++) if (yin[troughs[j]] < yin[troughs[gmin]]) gmin = j;
      for (let j = 0; j < nT; j++) {
        const h = yin[troughs[j]];
        let p = 0;
        for (let th = 0; th < N_THRESHOLDS; th++) {
          if (h < (th + 1) / N_THRESHOLDS) {
            pos[th]++;
            p += boltzmannPmf(pos[th], BOLTZMANN, nBelow[th]) * betaProbs[th];
          }
        }
        if (j === gmin) {
          let nb = 0;
          for (let th = 0; th < N_THRESHOLDS; th++) if (!(h < (th + 1) / N_THRESHOLDS)) nb++;
          let s = 0;
          for (let th = 0; th < nb; th++) s += betaProbs[th];
          p += NO_TROUGH_PROB * s;
        }
        probs[troughs[j]] = p;
      }
    }
    // observation probabilities on the pitch grid (later periods overwrite earlier ones, like numpy)
    const ob = t * nStates;
    for (let i = 0; i < L; i++) {
      if (!probs[i]) continue;
      const period = minPeriod + i + shift[i];
      const f0 = sr / period;
      let bin = Math.round(12 * binsPerSemitone * Math.log2(f0 / fmin));
      bin = Math.min(nBins, Math.max(0, bin));
      obs[ob + bin] = probs[i];
    }
    let v = 0;
    for (let b = 0; b < nBins; b++) v += obs[ob + b];
    v = Math.min(1, Math.max(0, v));
    vprob[t] = v;
    for (let b = nBins; b < nStates; b++) obs[ob + b] = (1 - v) / nBins;
  }

  const maxSemis = Math.round((MAX_TRANSITION_RATE * 12 * hop) / sr);
  const width = maxSemis * binsPerSemitone + 1;
  const preds = pitchPredecessors(nBins, width);
  const logInit = new Float64Array(nStates).fill(Math.log(1 / nStates + TINY));
  const states = viterbi(frames, nStates, (t, s) => Math.log(obs[t * nStates + s] + TINY), preds, logInit);

  const f0 = new Float64Array(frames);
  const voiced = new Uint8Array(frames);
  for (let t = 0; t < frames; t++) {
    const s = states[t];
    voiced[t] = s < nBins ? 1 : 0;
    f0[t] = voiced[t] ? fmin * 2 ** ((s % nBins) / (12 * binsPerSemitone)) : NaN;
  }
  return { f0, voiced, vprob };
}

// pyin on overlapping 20 s chunks, stitched on the global frame grid (same split as the python pipeline).
// runChunk(slice) may run on another worker; it must return pyin()'s result for that slice.
export async function chunkedPyin(y, opts, runChunk = async (s) => pyin(s, opts), onProgress) {
  const { sr, hop } = opts;
  const chunk = Math.floor((20 * sr) / hop) * hop;
  const ctx = Math.floor(sr / hop) * hop;
  const nFrames = 1 + Math.floor(y.length / hop);
  const f0 = new Float64Array(nFrames).fill(NaN);
  const voiced = new Uint8Array(nFrames);
  const vprob = new Float32Array(nFrames);
  const jobs = [];
  for (let s0 = 0; s0 < y.length; s0 += chunk) {
    const a = Math.max(0, s0 - ctx);
    jobs.push({ s0, a, slice: y.subarray(a, Math.min(y.length, s0 + chunk + ctx)) });
  }
  let done = 0;
  await Promise.all(jobs.map(async (job) => {
    const r = await runChunk(job.slice);
    const skip = (job.s0 - job.a) / hop;
    const dst0 = job.s0 / hop;
    const take = Math.min(chunk / hop, nFrames - dst0, r.f0.length - skip);
    for (let i = 0; i < take; i++) {
      f0[dst0 + i] = r.f0[skip + i];
      voiced[dst0 + i] = r.voiced[skip + i];
      vprob[dst0 + i] = r.vprob[skip + i];
    }
    done++;
    onProgress?.(done / jobs.length);
  }));
  return { f0, voiced, vprob };
}
