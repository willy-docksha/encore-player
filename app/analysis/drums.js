// drum hits and per-stem activity layers (port of drum_hits / stem_layers in backend/pipeline.py)
import { spectrogram, powerToDb, onsetDetect, percentile, median, rms, amplitudeToDb, max } from "./dsp.js";
import { r3, roundHalfEven } from "./transcribe.js";

// bands (hz) used to tell drum voices apart
const DRUM_BANDS = { sub: [35, 90], low: [90, 350], crack: [1500, 6000], air: [7000, 11000], body: [150, 350] };
// thresholds on band energy relative to this song's strong hits (90th percentile), plus shape ratios
const TH = {
  kick: 0.2, snare: 0.2, hat: 0.12, tom: 0.25,
  kick_sub_vs_low: 0.6, tom_low_vs_sub: 1.5, tom_max_crack: 0.15, snare_crack_vs_air: 0.6,
  snare_max_decay: 0.15, snare_vs_click: 2.6, snare_body: 0.15, hat_air_vs_crack: 1.2,
};
export const DRUM_VERSION = 3;
export const LAYER_STEP = 0.1;

// y: drum stem, mono at 22050 -> { kick, snare, hat, tom } hit times
export function drumHits(y) {
  const sr = 22050, hop = 128;
  const empty = { kick: [], snare: [], hat: [], tom: [] };
  if (!y.some((v) => v !== 0)) return empty;
  const { S, frames: n, bins } = spectrogram(y, 1024, hop);
  const fr = (sec) => Math.max(1, roundHalfEven((sec * sr) / hop));
  let onsets = onsetDetect(y, sr, hop, { delta: 0.04, wait: fr(0.045) });
  const total = new Float64Array(n);
  for (let t = 0; t < n; t++) for (let k = 0; k < bins; k++) total[t] += S[t * bins + k];
  const level = powerToDb(total, max(total));
  onsets = onsets.filter((f) => level[Math.min(f, n - 1)] > -45);
  if (!onsets.length) return empty;

  const band = {};
  for (const [name, [lo, hi]] of Object.entries(DRUM_BANDS)) {
    const b = new Float64Array(n);
    for (let k = 0; k < bins; k++) {
      const f = (k * sr) / 1024;
      if (f >= lo && f < hi) for (let t = 0; t < n; t++) b[t] += S[t * bins + k];
    }
    band[name] = b;
  }
  // the onset peak lags the hit a little; a hi-hat is almost gone by then, so start slightly earlier
  const lead = fr(0.012), post = fr(0.05);
  // summed frame-to-frame increases: a ringing crash only decays, so it cannot hide a new hit
  const flux = {};
  for (const [k, b] of Object.entries(band)) flux[k] = b.map((v, i) => Math.max(0, v - (i ? b[i - 1] : b[0])));
  const sum = (b, a, z) => { let s = 0; for (let i = a; i < z; i++) s += b[i]; return s; };
  const rise = (b, f) => sum(b, Math.max(0, f - lead), Math.min(n, f + post + 1));
  const tail = (b, f, t0, t1) => {
    if (f + fr(t0) >= n) return 0;
    const a = Math.min(n - 1, f + fr(t0)), z = Math.min(n, f + fr(t1));
    return z > a ? sum(b, a, z) / (z - a) : NaN;
  };
  const R = {}, N = {};
  for (const k of Object.keys(band)) {
    R[k] = onsets.map((f) => rise(flux[k], f));
    const p90 = percentile(R[k], 90) + 1e-12;
    N[k] = R[k].map((v) => v / p90);
  }
  const subT = onsets.map((f) => tail(band.sub, f, 0.03, 0.12));
  const lowT = onsets.map((f) => tail(band.low, f, 0.03, 0.12));
  const m = onsets.length;
  const idx = [...Array(m).keys()];

  const kick = idx.map((i) => N.sub[i] > TH.kick && subT[i] > TH.kick_sub_vs_low * lowT[i]);
  // snare wires sit lower than hi-hats, die out fast (cymbals keep ringing) and come with a drum body.
  // a live kick's beater click looks like wires too, so with a kick the crack must clearly beat the
  // usual click level of this song's kicks
  const crackPeak = onsets.map((f) => { let p = -Infinity; for (let i = f; i < Math.min(n, f + fr(0.05)); i++) p = Math.max(p, band.crack[i]); return p + 1e-12; });
  const crackDecay = onsets.map((f, i) => tail(band.crack, f, 0.12, 0.25) / crackPeak[i]);
  const body = onsets.map((f) => rise(flux.body, f));
  const bodyP90 = percentile(body, 90) + 1e-12;
  const bodyN = body.map((v) => v / bodyP90);
  const withKick = N.sub.map((v) => v > 0.4);
  const clicky = idx.map((i) => withKick[i] && N.crack[i] > 0.05); // kicks with an audible beater click
  // the kick sound can change between sections, so judge each hit against the kicks around it
  const times = onsets.map((f) => (f * hop) / sr);
  const clickyCrack = idx.filter((i) => clicky[i]).map((i) => R.crack[i]);
  const songClick = clickyCrack.length >= 8 ? percentile(clickyCrack, 25) : 0;
  const click = idx.map((i) => {
    const near = idx.filter((j) => clicky[j] && Math.abs(times[j] - times[i]) <= 6.0);
    return near.length >= 6 ? Math.max(songClick, percentile(near.map((j) => R.crack[j]), 25)) : songClick;
  });
  const snareShape = idx.map((i) => N.crack[i] > TH.snare && R.crack[i] > TH.snare_crack_vs_air * R.air[i] && crackDecay[i] < TH.snare_max_decay);
  const snare = idx.map((i) => snareShape[i] && (withKick[i] ? R.crack[i] > TH.snare_vs_click * click[i] : bodyN[i] > TH.snare_body));
  // hi-hats are quiet next to snares and crashes: size them against other hi-hat-shaped hits
  const hatShape = idx.map((i) => R.air[i] > TH.hat_air_vs_crack * R.crack[i] && !snare[i]);
  let hat = new Array(m).fill(false);
  if (hatShape.some(Boolean)) {
    const ref = percentile(idx.filter((i) => hatShape[i]).map((i) => R.air[i]), 90) + 1e-12;
    hat = idx.map((i) => hatShape[i] && R.air[i] / ref > TH.hat);
    // a hi-hat played with a kick picks up the kick's click in the snare band: use the clear ones as yardstick
    const clear = idx.filter((i) => hat[i]);
    if (clear.length >= 4) {
      const typical = median(clear.map((i) => R.air[i]));
      hat = idx.map((i) => hat[i] || (!snare[i] && R.air[i] >= 0.4 * typical && R.air[i] > 0.3 * R.crack[i]));
    }
  }
  const tom = idx.map((i) => N.low[i] > TH.tom && lowT[i] > TH.tom_low_vs_sub * subT[i] && N.crack[i] < TH.tom_max_crack && !snare[i]);
  const toT = (mask) => idx.filter((i) => mask[i]).map((i) => r3(times[i]));
  return { kick: toT(kick), snare: toT(snare), hat: toT(hat), tom: toT(tom) };
}

// per-stem loudness (0-100, every 100 ms) to show when each part plays, plus drum hits.
// stems11k: { name: mono at 11025 }, drums22k: drum stem mono at 22050
export function stemLayers(stems11k, drums22k) {
  const sr = 11025;
  const hop = Math.floor(sr * LAYER_STEP);
  const activity = {};
  for (const [name, y] of Object.entries(stems11k)) {
    const r = rms(y, hop * 2, hop);
    const db = amplitudeToDb(r, max(r) + 1e-9);
    activity[name] = Array.from(db, (d) => Math.trunc(Math.min(100, Math.max(0, 100 + (d * 100) / 50)))); // -50..0 db -> 0..100
  }
  const layers = { step: LAYER_STEP, activity };
  if (drums22k) {
    layers.drums = drumHits(drums22k);
    layers.drums_v = DRUM_VERSION;
  }
  return layers;
}
