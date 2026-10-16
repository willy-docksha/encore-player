// full analysis in the browser: separate -> transcribe -> beats / key / chords -> stems, midi, layers.
// same steps and output as analyze() in backend/pipeline.py, so the player reads both alike.
import { mono, decimate } from "./dsp.js";
import { applyModel, normStats } from "./demucs.js";
import { transcribeBass, transcribeVocals, polyNotes, POLY_RANGE } from "./transcribe.js";
import { basicPitch } from "./basicpitch.js";
import { detectBeats } from "./beats.js";
import { detectChords } from "./chords.js";
import { stemLayers } from "./drums.js";
import { midiFile, drumMidiFile } from "./midi.js";

import { PIPELINE_VERSION } from "./version.js";

export { PIPELINE_VERSION };
export const STEMS = ["drums", "bass", "vocals", "guitar", "piano", "other"];
export const SR = 44100;

// audio: [left, right] Float32Array at 44100.
// deps: { ort, models (ModelStore), encodeMp3(left, right) -> Uint8Array, pyinChunk?, progress(stage, p) }
export async function analyze(audio, title, { ort, models, encodeMp3, pyinChunk, progress = () => {} }) {
  const duration = audio[0].length / SR;
  const files = {};
  const small = {}; // name -> { m11: mono 11025, m22: mono 22050 }

  // ---------------------------------------------------------------- separation
  const SEP = "Memisahkan instrumen (Demucs)";
  progress(SEP, 0);
  const { mean, std } = normStats(audio);
  const norm = audio.map((ch) => ch.map((v) => (v - mean) / std));
  const harmony = audio.map((ch) => Float32Array.from(ch));

  // a finished stem: undo the normalisation, keep the small mono copies, encode it, drop the big arrays
  const finish = async (name, [l, r], { subtract = true } = {}) => {
    for (let i = 0; i < l.length; i++) { l[i] = l[i] * std + mean; r[i] = r[i] * std + mean; }
    if (subtract) for (let i = 0; i < l.length; i++) { harmony[0][i] -= l[i]; harmony[1][i] -= r[i]; }
    const m = mono([l, r]);
    const m22 = decimate(m, 2);
    small[name] = { m22, m11: decimate(m22, 2) };
    files[`${name}.mp3`] = await encodeMp3(l, r);
  };

  const run = async (model, want, lo, hi) => {
    const session = await models.session(model);
    const info = await models.info(model);
    const out = await applyModel(ort, session, info, norm, want, (p) => progress(SEP, lo + (hi - lo) * p));
    await models.release(model);
    return out;
  };

  // bass specialist first: if it fails, the main model's bass is used instead
  let bassDone = false;
  try {
    const { bass } = await run("htdemucs_ft_bass", ["bass"], 0.0, 0.12);
    await finish("bass", bass);
    bassDone = true;
  } catch (err) {
    console.warn("bass specialist failed, using htdemucs bass", err);
  }
  const main = await run("htdemucs", bassDone ? ["drums", "vocals"] : ["drums", "bass", "vocals"], 0.12, 0.3);
  for (const [name, st] of Object.entries(main)) await finish(name, st);

  // chords read all harmony instruments together (same as the old "other" stem)
  const harmony22 = decimate(mono(harmony), 2);
  try {
    const six = await run("htdemucs_6s", ["guitar", "piano"], 0.3, 0.45);
    for (const [name, st] of Object.entries(six)) await finish(name, st);
  } catch (err) {
    console.warn("6-source model failed, no guitar / piano", err);
  }
  // "other" is whatever is left, so all stems always add up to the original mix
  await finish("other", harmony, { subtract: false });

  // ---------------------------------------------------------------- transcription
  progress("Transkripsi bass", 0.45);
  const bpSession = () => models.session("basic_pitch");
  const notes = await transcribeBass(small.bass.m11, {
    pyinChunk,
    basicPitch: async () => basicPitch(ort, await bpSession(), small.bass.m22,
      { minNoteLenMs: 50, minFreq: 29, maxFreq: 400 }),
    onProgress: (p) => progress("Transkripsi bass", 0.45 + 0.13 * p),
  });

  progress("Transkripsi melodi vokal", 0.58);
  const vocals = await transcribeVocals(small.vocals.m11, {
    pyinChunk,
    onProgress: (p) => progress("Transkripsi melodi vokal", 0.58 + 0.12 * p),
  });

  progress("Transkripsi piano & gitar", 0.7);
  const poly = {};
  for (const part of ["piano", "guitar"]) {
    if (!small[part]) continue;
    const [lo, hi] = POLY_RANGE[part];
    const events = await basicPitch(ort, await bpSession(), small[part].m22, { minNoteLenMs: 70, minFreq: lo, maxFreq: hi });
    poly[part] = polyNotes(events, small[part].m11);
  }
  await models.release("basic_pitch");

  progress("Deteksi tempo & beat", 0.78);
  const mix22 = decimate(mono(audio), 2);
  const { bpm, beats, downbeats } = await detectBeats(ort, await models.session("beat_this"), mix22);
  await models.release("beat_this");

  progress("Deteksi chord & kunci", 0.85);
  const { chords, key } = detectChords(harmony22, small.bass.m22, beats, notes);

  progress("Menyiapkan tampilan multitrack", 0.95);
  const present = STEMS.filter((n) => small[n]);
  const layers = stemLayers(Object.fromEntries(present.map((n) => [n, small[n].m11])), small.drums?.m22);
  files["bass.mid"] = midiFile(notes, bpm);
  files["vocals.mid"] = midiFile(vocals.notes, bpm, 53);
  if (poly.piano) files["piano.mid"] = midiFile(poly.piano, bpm, 0);
  if (poly.guitar) files["guitar.mid"] = midiFile(poly.guitar, bpm, 25);
  files["drums.mid"] = drumMidiFile(layers.drums, bpm);

  const result = {
    title,
    duration: Math.round(duration * 1000) / 1000,
    bpm,
    key,
    beats,
    downbeats,
    notes,
    vocals,
    ...Object.fromEntries(Object.entries(poly).map(([part, ns]) => [part, { notes: ns }])),
    chords,
    layers,
    audio: Object.fromEntries(present.map((n) => [n, `${n}.mp3`])),
    version: PIPELINE_VERSION,
  };
  progress("Selesai", 1);
  return { result, files };
}
