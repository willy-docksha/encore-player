// spotify basic pitch: onnx model + note creation (port of basic_pitch.inference / note_creation)
import { hzToMidi } from "./dsp.js";

const FFT_HOP = 256;
const SR = 22050;
const AUDIO_N_SAMPLES = SR * 2 - FFT_HOP; // 43844
const ANNOT_FPS = Math.floor(SR / FFT_HOP); // 86
const ANNOT_N_FRAMES = ANNOT_FPS * 2; // 172
const N_OVERLAP_FRAMES = 30;
const OVERLAP_LEN = N_OVERLAP_FRAMES * FFT_HOP;
const HOP_SIZE = AUDIO_N_SAMPLES - OVERLAP_LEN;
const MIDI_OFFSET = 21;
const MAX_FREQ_IDX = 87;
const N_NOTES = 88;
const BATCH = 4;

// model output for the whole signal: { note, onset } as [frame][88]
async function runModel(ort, session, y) {
  const padded = new Float32Array(y.length + OVERLAP_LEN / 2);
  padded.set(y, OVERLAP_LEN / 2);
  const starts = [];
  for (let i = 0; i < padded.length; i += HOP_SIZE) starts.push(i);
  const nOut = Math.floor((y.length * ANNOT_FPS) / SR);
  const keepPer = ANNOT_N_FRAMES - N_OVERLAP_FRAMES; // drop 15 frames each side
  const note = new Float32Array(starts.length * keepPer * N_NOTES);
  const onset = new Float32Array(starts.length * keepPer * N_NOTES);
  for (let b = 0; b < starts.length; b += BATCH) {
    const group = starts.slice(b, b + BATCH);
    const input = new Float32Array(group.length * AUDIO_N_SAMPLES);
    group.forEach((s, g) => input.set(padded.subarray(s, Math.min(padded.length, s + AUDIO_N_SAMPLES)), g * AUDIO_N_SAMPLES));
    const res = await session.run({ "serving_default_input_2:0": new ort.Tensor("float32", input, [group.length, AUDIO_N_SAMPLES, 1]) });
    const n = await res["StatefulPartitionedCall:1"].getData();
    const o = await res["StatefulPartitionedCall:2"].getData();
    group.forEach((_, g) => {
      const w = b + g;
      for (let f = 0; f < keepPer; f++) {
        const src = (g * ANNOT_N_FRAMES + f + N_OVERLAP_FRAMES / 2) * N_NOTES;
        const dst = (w * keepPer + f) * N_NOTES;
        note.set(n.subarray(src, src + N_NOTES), dst);
        onset.set(o.subarray(src, src + N_NOTES), dst);
      }
    });
  }
  return { note: note.subarray(0, nOut * N_NOTES), onset: onset.subarray(0, nOut * N_NOTES), frames: nOut };
}

function framesToTime(n) {
  const offset = (FFT_HOP / SR) * (ANNOT_N_FRAMES - AUDIO_N_SAMPLES / FFT_HOP) + 0.0018;
  return Float64Array.from({ length: n }, (_, i) => (i * FFT_HOP) / SR - offset * Math.floor(i / ANNOT_N_FRAMES));
}

// max-heap of (value, index) for the melodia loop (numpy argmax order: highest value, then lowest index)
class Heap {
  constructor() { this.v = []; this.i = []; }
  get size() { return this.v.length; }
  less(a, b) { return this.v[a] < this.v[b] || (this.v[a] === this.v[b] && this.i[a] > this.i[b]); }
  swap(a, b) { [this.v[a], this.v[b]] = [this.v[b], this.v[a]]; [this.i[a], this.i[b]] = [this.i[b], this.i[a]]; }
  push(v, i) {
    this.v.push(v); this.i.push(i);
    let c = this.v.length - 1;
    while (c > 0) { const p = (c - 1) >> 1; if (!this.less(p, c)) break; this.swap(p, c); c = p; }
  }
  pop() {
    const top = [this.v[0], this.i[0]];
    const lv = this.v.pop(), li = this.i.pop();
    if (this.v.length) {
      this.v[0] = lv; this.i[0] = li;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < this.v.length && this.less(m, l)) m = l;
        if (r < this.v.length && this.less(m, r)) m = r;
        if (m === p) break;
        this.swap(p, m); p = m;
      }
    }
    return top;
  }
}

// output_to_notes_polyphonic -> [startFrame, endFrame, pitch, amplitude]
function outputToNotes(frames, onsets, n, { onsetThresh, frameThresh, minNoteLen, minFreq, maxFreq, melodia, energyTol = 11 }) {
  const F = N_NOTES;
  if (maxFreq != null) {
    const hi = Math.round(hzToMidi(maxFreq) - MIDI_OFFSET);
    for (let t = 0; t < n; t++) for (let k = Math.max(0, hi); k < F; k++) { onsets[t * F + k] = 0; frames[t * F + k] = 0; }
  }
  if (minFreq != null) {
    const lo = Math.round(hzToMidi(minFreq) - MIDI_OFFSET);
    for (let t = 0; t < n; t++) for (let k = 0; k < Math.min(F, lo); k++) { onsets[t * F + k] = 0; frames[t * F + k] = 0; }
  }
  // inferred onsets from large frame increases
  const diff = new Float32Array(n * F);
  let maxDiff = 0, maxOnset = 0;
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < F; k++) {
      const cur = frames[t * F + k];
      const p1 = t >= 1 ? frames[(t - 1) * F + k] : 0;
      const p2 = t >= 2 ? frames[(t - 2) * F + k] : 0;
      let d = Math.min(cur - p1, cur - p2);
      if (d < 0 || t < 2) d = 0;
      diff[t * F + k] = d;
      if (d > maxDiff) maxDiff = d;
      if (onsets[t * F + k] > maxOnset) maxOnset = onsets[t * F + k];
    }
  }
  const on = new Float32Array(n * F);
  for (let i = 0; i < on.length; i++) on[i] = Math.max(onsets[i], maxDiff ? (maxOnset * diff[i]) / maxDiff : 0);

  // onset peaks over time, visited backwards in (time, freq) order
  const peaks = [];
  for (let t = 1; t < n - 1; t++) {
    for (let k = 0; k < F; k++) {
      const v = on[t * F + k];
      if (v > on[(t - 1) * F + k] && v > on[(t + 1) * F + k] && v >= onsetThresh) peaks.push(t * F + k);
    }
  }
  const remaining = Float32Array.from(frames);
  const events = [];
  for (let q = peaks.length - 1; q >= 0; q--) {
    const start = Math.floor(peaks[q] / F), k = peaks[q] % F;
    if (start >= n - 1) continue;
    let i = start + 1, c = 0;
    while (i < n - 1 && c < energyTol) {
      if (remaining[i * F + k] < frameThresh) c++; else c = 0;
      i++;
    }
    i -= c;
    if (i - start <= minNoteLen) continue;
    for (let t = start; t < i; t++) {
      remaining[t * F + k] = 0;
      if (k < MAX_FREQ_IDX) remaining[t * F + k + 1] = 0;
      if (k > 0) remaining[t * F + k - 1] = 0;
    }
    let amp = 0;
    for (let t = start; t < i; t++) amp += frames[t * F + k];
    events.push([start, i, k + MIDI_OFFSET, amp / (i - start)]);
  }

  if (melodia) {
    const heap = new Heap();
    for (let idx = 0; idx < remaining.length; idx++) if (remaining[idx] > frameThresh) heap.push(remaining[idx], idx);
    const clear = (t, kk) => {
      remaining[t * F + kk] = 0;
      if (kk < MAX_FREQ_IDX) remaining[t * F + kk + 1] = 0;
      if (kk > 0) remaining[t * F + kk - 1] = 0;
    };
    while (heap.size) {
      const [val, idx] = heap.pop();
      if (remaining[idx] !== val || val <= frameThresh) continue; // stale
      const mid = Math.floor(idx / F), k = idx % F;
      remaining[idx] = 0;
      let i = mid + 1, c = 0;
      while (i < n - 1 && c < energyTol) {
        if (remaining[i * F + k] < frameThresh) c++; else c = 0;
        clear(i, k);
        i++;
      }
      const end = i - 1 - c;
      i = mid - 1; c = 0;
      while (i > 0 && c < energyTol) {
        if (remaining[i * F + k] < frameThresh) c++; else c = 0;
        clear(i, k);
        i--;
      }
      const start = i + 1 + c;
      if (end - start <= minNoteLen) continue;
      let amp = 0;
      for (let t = start; t < end; t++) amp += frames[t * F + k];
      events.push([start, end, k + MIDI_OFFSET, amp / (end - start)]);
    }
  }
  return events;
}

// note events [start s, end s, pitch, amplitude] for mono audio at 22050
export async function basicPitch(ort, session, y, { onsetThresh = 0.5, frameThresh = 0.3, minNoteLenMs = 127.7, minFreq = null, maxFreq = null, melodia = true } = {}) {
  const out = await runModel(ort, session, y);
  const minNoteLen = Math.round((minNoteLenMs / 1000) * (SR / FFT_HOP));
  const ev = outputToNotes(Float32Array.from(out.note), Float32Array.from(out.onset), out.frames,
    { onsetThresh, frameThresh, minNoteLen, minFreq, maxFreq, melodia });
  const times = framesToTime(out.frames);
  return ev.map(([s, e, p, a]) => [times[s], times[e], p, a]);
}
