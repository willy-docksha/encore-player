// demucs separation: stft / istft and overlap-add in js, the network core in onnxruntime
// (mirrors demucs.apply.apply_model with split=True, overlap=0.25 and HTDemucs _spec / _ispec)
import { realFFT, hann } from "./dsp.js";

const NFFT = 4096, HOP = 1024, BINS = NFFT / 2;

function reflectPad(x, left, right) {
  const n = x.length;
  const out = new Float32Array(n + left + right);
  out.set(x, left);
  for (let i = 1; i <= left; i++) out[left - i] = x[Math.min(n - 1, i)];
  for (let i = 1; i <= right; i++) out[left + n - 1 + i] = x[Math.max(0, n - 1 - i)];
  return out;
}

const WIN = hann(NFFT);

// HTDemucs._spec on one channel -> { re, im } of [2048 bins][le frames] (bin-major, like the model input)
function spec(x, le) {
  const pad = (HOP / 2) * 3;
  const xp = reflectPad(x, pad, pad + le * HOP - x.length);
  // torch.stft(center=True, reflect, normalized=True)
  const xc = reflectPad(xp, NFFT / 2, NFFT / 2);
  const frames = 1 + Math.floor(xp.length / HOP);
  const rf = realFFT(NFFT);
  const buf = new Float64Array(NFFT);
  const or = new Float64Array(BINS + 1), oi = new Float64Array(BINS + 1);
  const re = new Float32Array(BINS * le), im = new Float32Array(BINS * le);
  const scale = 1 / Math.sqrt(NFFT);
  for (let t = 2; t < 2 + le && t < frames; t++) {
    const o = t * HOP;
    for (let i = 0; i < NFFT; i++) buf[i] = xc[o + i] * WIN[i];
    rf.forward(buf, or, oi);
    const col = t - 2;
    for (let k = 0; k < BINS; k++) { re[k * le + col] = or[k] * scale; im[k * le + col] = oi[k] * scale; }
  }
  return { re, im };
}

// HTDemucs._ispec for one channel: re/im [2048][le] -> waveform of `length`
function ispec(re, im, le, length) {
  const pad = (HOP / 2) * 3;
  const total = HOP * Math.ceil(length / HOP) + 2 * pad;
  const frames = le + 4; // two zero frames each side
  const outLen = NFFT + HOP * (frames - 1);
  const acc = new Float64Array(outLen);
  const norm = new Float64Array(outLen);
  const rf = realFFT(NFFT);
  const fr = new Float64Array(BINS + 1), fi = new Float64Array(BINS + 1);
  const buf = new Float64Array(NFFT);
  const scale = Math.sqrt(NFFT); // undo normalized=True
  for (let t = 0; t < frames; t++) {
    const col = t - 2;
    if (col >= 0 && col < le) {
      for (let k = 0; k < BINS; k++) { fr[k] = re[k * le + col] * scale; fi[k] = im[k * le + col] * scale; }
    } else { fr.fill(0); fi.fill(0); }
    fr[BINS] = 0; fi[BINS] = 0;
    fi[0] = 0;
    rf.inverse(fr, fi, buf);
    const o = t * HOP;
    for (let i = 0; i < NFFT; i++) { acc[o + i] += buf[i] * WIN[i]; norm[o + i] += WIN[i] * WIN[i]; }
  }
  // center=True: drop n_fft / 2, keep `total`, then trim the _spec padding
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const j = NFFT / 2 + pad + i;
    out[i] = j < outLen && norm[j] > 1e-11 ? acc[j] / norm[j] : 0;
  }
  return out;
}

// one model call on exactly `segment` samples (stereo) -> per source [left, right]
async function runSegment(ort, session, info, left, right) {
  const L = info.segment, le = info.frames;
  const mix = new Float32Array(2 * L);
  mix.set(left, 0); mix.set(right, L);
  const mag = new Float32Array(4 * BINS * le);
  [left, right].forEach((ch, c) => {
    const { re, im } = spec(ch, le);
    mag.set(re, (2 * c) * BINS * le);
    mag.set(im, (2 * c + 1) * BINS * le);
  });
  const res = await session.run({
    mix: new ort.Tensor("float32", mix, [1, 2, L]),
    mag: new ort.Tensor("float32", mag, [1, 4, BINS, le]),
  });
  const specOut = await res.spec.getData();
  const wave = await res.wave.getData();
  res.spec.dispose?.(); res.wave.dispose?.();
  const S = info.sources.length;
  const out = [];
  for (let s = 0; s < S; s++) {
    const chans = [];
    for (let c = 0; c < 2; c++) {
      const base = ((s * 4) + 2 * c) * BINS * le;
      const re = specOut.subarray(base, base + BINS * le);
      const im = specOut.subarray(base + BINS * le, base + 2 * BINS * le);
      const x = ispec(re, im, le, L);
      const w = wave.subarray((s * 2 + c) * L, (s * 2 + c + 1) * L);
      for (let i = 0; i < L; i++) x[i] += w[i];
      chans.push(x);
    }
    out.push(chans);
  }
  return out;
}

// a window of `segment` samples around [offset, offset + len), zero padded, centred like TensorChunk.padded
function chunk(x, offset, len, segment) {
  const delta = segment - len;
  const start = offset - Math.floor(delta / 2);
  const out = new Float32Array(segment);
  for (let i = 0; i < segment; i++) { const j = start + i; if (j >= 0 && j < x.length) out[i] = x[j]; }
  return out;
}

// separate normalised stereo audio with one model; keep only the `want`ed sources.
// returns { name: [left, right] } at the input length
export async function applyModel(ort, session, info, [left, right], want, onProgress) {
  const length = left.length;
  const segment = info.segment;
  const stride = Math.floor(0.75 * segment);
  const half = Math.floor(segment / 2);
  const weight = new Float32Array(segment);
  for (let i = 0; i < half; i++) weight[i] = (i + 1) / half;
  for (let i = half; i < segment; i++) weight[i] = (segment - i) / half;
  const keep = want.map((name) => info.sources.indexOf(name));
  if (keep.some((k) => k < 0)) throw new Error(`model has no ${want}`);
  const out = keep.map(() => [new Float32Array(length), new Float32Array(length)]);
  const sumW = new Float32Array(length);
  const offsets = [];
  for (let o = 0; o < length; o += stride) offsets.push(o);
  for (let n = 0; n < offsets.length; n++) {
    const offset = offsets[n];
    const len = Math.min(segment, length - offset);
    const res = await runSegment(ort, session, info, chunk(left, offset, len, segment), chunk(right, offset, len, segment));
    // center_trim back to the chunk length
    const trim = Math.floor((segment - len) / 2);
    keep.forEach((k, q) => {
      for (let c = 0; c < 2; c++) {
        const src = res[k][c], dst = out[q][c];
        for (let i = 0; i < len; i++) dst[offset + i] += weight[i] * src[trim + i];
      }
    });
    for (let i = 0; i < len; i++) sumW[offset + i] += weight[i];
    onProgress?.((n + 1) / offsets.length);
  }
  for (const pair of out) for (const ch of pair) for (let i = 0; i < length; i++) ch[i] /= sumW[i];
  return Object.fromEntries(want.map((name, q) => [name, out[q]]));
}

// mean / std of the mono mix, used to normalise the input and undo it on the output
export function normStats([left, right]) {
  const n = left.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += (left[i] + right[i]) / 2;
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += ((left[i] + right[i]) / 2 - m) ** 2;
  const std = Math.sqrt(v / Math.max(1, n - 1)) + 1e-8;
  return { mean: m, std };
}
