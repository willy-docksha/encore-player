// tuner: listens to the microphone, names the incoming note and how far off it is (cents).
// pitch is found with yin on a 2x decimated buffer, low enough for a 5-string bass (low b ~31 hz).

import { $, $$, el, store, media, onKeys, router, toast } from "./core.js";

const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const SOLFA = ["do", "di", "re", "ri", "mi", "fa", "fi", "sol", "sel", "la", "li", "si"];

// strings low to high, as midi numbers
const INSTRUMENTS = [
  { id: "chromatic", name: "Kromatik", strings: [] },
  { id: "guitar", name: "Gitar", strings: [40, 45, 50, 55, 59, 64] },
  { id: "bass4", name: "Bass 4 senar", strings: [28, 33, 38, 43] },
  { id: "bass5", name: "Bass 5 senar", strings: [23, 28, 33, 38, 43] },
  { id: "ukulele", name: "Ukulele", strings: [67, 60, 64, 69] },
  { id: "violin", name: "Biola", strings: [55, 62, 69, 76] },
  { id: "dropd", name: "Gitar Drop D", strings: [38, 45, 50, 55, 59, 64] },
];

const IN_TUNE = 5; // cents
const MIN_HZ = 27, MAX_HZ = 1400;
const HOLD_MS = 1200; // keep the last reading on screen after the sound stops

let a4 = store.get("tuner-a4", 440);
let inst = INSTRUMENTS.find((i) => i.id === store.get("tuner-inst", "guitar")) || INSTRUMENTS[1];
let locked = null; // string index picked by hand, null = follow the nearest string
let ctx = null, stream = null, analyser = null, buf = null, raf = 0, tick = 0;
let recent = []; // last few raw frequencies, the median smooths out single bad frames
let shown = null; // { hz, at }
let needle = 0;
let toneUntil = 0;

const midiToHz = (m) => a4 * 2 ** ((m - 69) / 12);
const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / a4);
const noteName = (m) => NAMES[((m % 12) + 12) % 12];
const octave = (m) => Math.floor(m / 12) - 1;

// ------------------------------------------------------------------ pitch detection (yin)

// float samples in, frequency in hz (or 0 when there is no clear pitch)
function detect(raw, rate) {
  // halve the rate: plenty for tuning and 4x cheaper
  const n = raw.length >> 1;
  const x = buf && buf.length === n ? buf : (buf = new Float32Array(n));
  let rms = 0;
  for (let i = 0; i < n; i++) { x[i] = (raw[2 * i] + raw[2 * i + 1]) * 0.5; rms += x[i] * x[i]; }
  rms = Math.sqrt(rms / n);
  if (rms < 0.008) return 0;
  rate /= 2;

  const w = n >> 1;
  const tMin = Math.floor(rate / MAX_HZ), tMax = Math.min(w - 1, Math.ceil(rate / MIN_HZ));
  const d = new Float32Array(tMax + 2);
  // difference function
  for (let t = 1; t <= tMax + 1; t++) {
    let s = 0;
    for (let i = 0; i < w; i++) { const v = x[i] - x[i + t]; s += v * v; }
    d[t] = s;
  }
  // cumulative mean normalized difference
  d[0] = 1;
  let sum = 0;
  for (let t = 1; t <= tMax + 1; t++) { sum += d[t]; d[t] = sum ? (d[t] * t) / sum : 1; }
  // first dip under the threshold, then walk to its bottom
  let tau = -1;
  for (let t = Math.max(2, tMin); t <= tMax; t++) {
    if (d[t] < 0.15) {
      while (t + 1 <= tMax && d[t + 1] < d[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return 0;
  // parabolic interpolation for sub-sample accuracy
  const a = d[tau - 1], b = d[tau], c = d[tau + 1];
  const den = a + c - 2 * b;
  const shift = den ? (a - c) / (2 * den) : 0;
  return rate / (tau + shift);
}

// ------------------------------------------------------------------ mic

async function start() {
  if (stream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Browser ini tidak bisa memakai mikrofon (butuh HTTPS).", { error: true });
    return;
  }
  try {
    // raw signal: echo cancel / noise suppression bend the pitch
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    toast("Izin mikrofon ditolak. Izinkan mikrofon di pengaturan browser lalu coba lagi.", { error: true });
    return;
  }
  media.claim("tuner");
  ctx = ctx || new AudioContext();
  await ctx.resume();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  ctx.createMediaStreamSource(stream).connect(analyser);
  recent = [];
  shown = null;
  loop();
  render();
}

function stop() {
  cancelAnimationFrame(raf);
  raf = 0;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  analyser?.disconnect();
  analyser = null;
  shown = null;
  render();
}

function loop() {
  raf = requestAnimationFrame(loop);
  const now = performance.now();
  // every other frame is enough and keeps phones cool; skip while our own reference tone plays
  if (tick++ % 2 === 0 && now > toneUntil) {
    const raw = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(raw);
    const hz = detect(raw, ctx.sampleRate);
    if (hz) {
      recent.push(hz);
      if (recent.length > 5) recent.shift();
      const sorted = [...recent].sort((p, q) => p - q);
      shown = { hz: sorted[sorted.length >> 1], at: now };
    } else if (shown && now - shown.at > HOLD_MS) {
      shown = null;
      recent = [];
    }
  }
  paint(now);
}

// ------------------------------------------------------------------ reference tone

function playTone(midi) {
  ctx = ctx || new AudioContext();
  ctx.resume();
  if (!stream) media.claim("tuner");
  const t = ctx.currentTime, dur = 2;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = midiToHz(midi);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.35, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur);
  toneUntil = performance.now() + dur * 1000;
  recent = [];
}

// ------------------------------------------------------------------ ui

// target midi for the reading: the picked string, the nearest string, or the nearest semitone
function target(midi) {
  const s = inst.strings;
  if (!s.length) return { midi: Math.round(midi), string: -1 };
  if (locked != null) return { midi: s[locked], string: locked };
  let best = 0;
  s.forEach((m, i) => { if (Math.abs(m - midi) < Math.abs(s[best] - midi)) best = i; });
  return { midi: s[best], string: best };
}

function paint(now) {
  const root = $("#tunerMeter");
  if (!root) return;
  const live = shown && now - shown.at < HOLD_MS;
  root.classList.toggle("idle", !live);
  if (!live) {
    $("#tunerNote").textContent = "–";
    $("#tunerOct").textContent = "";
    $("#tunerSolfa").textContent = stream ? "mainkan satu senar / nada" : "";
    $("#tunerHz").textContent = stream ? "mendengarkan…" : "mikrofon mati";
    $("#tunerCents").textContent = "";
    $("#tunerHint").textContent = stream ? "Petik satu senar, biarkan berbunyi." : "Tekan Mulai, lalu izinkan mikrofon.";
    $("#tunerHint").className = "tuner-hint";
    needle += (0 - needle) * 0.2;
    $("#tunerNeedle").style.transform = `rotate(${needle * 0.9}deg)`;
    markStrings(-1);
    return;
  }
  const midi = hzToMidi(shown.hz);
  const near = Math.round(midi);
  const tg = target(midi);
  const off = (midi - tg.midi) * 100;
  const inTune = Math.abs(off) <= IN_TUNE;
  $("#tunerNote").textContent = noteName(near);
  $("#tunerOct").textContent = octave(near);
  $("#tunerSolfa").textContent = SOLFA[((near % 12) + 12) % 12];
  $("#tunerHz").textContent = `${shown.hz.toFixed(1)} Hz`;
  const nearOff = Math.round((midi - near) * 100);
  $("#tunerCents").textContent = `${nearOff > 0 ? "+" : ""}${nearOff} sen`;

  const hint = $("#tunerHint");
  const name = `${noteName(tg.midi)}${octave(tg.midi)}`;
  const str = tg.string >= 0 ? `senar ${inst.strings.length - tg.string} (${name})` : name;
  if (inTune) hint.textContent = `Pas! ${str}`;
  else if (Math.abs(off) > 50) hint.textContent = off < 0 ? `Terlalu rendah untuk ${str}, kencangkan` : `Terlalu tinggi untuk ${str}, kendorkan`;
  else hint.textContent = off < 0 ? `Sedikit rendah, kencangkan pelan ke ${name}` : `Sedikit tinggi, kendorkan pelan ke ${name}`;
  hint.className = `tuner-hint ${inTune ? "ok" : Math.abs(off) <= 20 ? "near" : "far"}`;
  root.classList.toggle("ok", inTune);

  // ease the needle so it does not jitter
  const goal = Math.max(-50, Math.min(50, off));
  needle += (goal - needle) * 0.25;
  $("#tunerNeedle").style.transform = `rotate(${needle * 0.9}deg)`;
  markStrings(tg.string, inTune);
}

function markStrings(active, ok) {
  $$("#tunerStrings .tuner-string").forEach((b, i) => {
    b.classList.toggle("active", i === active);
    b.classList.toggle("ok", i === active && !!ok);
  });
}

function render() {
  const insts = $("#tunerInst");
  insts.replaceChildren(...INSTRUMENTS.map((it) => {
    const b = el("button", `tuner-chip${it === inst ? " on" : ""}`, it.name);
    b.type = "button";
    b.onclick = () => { inst = it; locked = null; store.set("tuner-inst", it.id); render(); };
    return b;
  }));

  const strings = $("#tunerStrings");
  strings.hidden = !inst.strings.length;
  strings.replaceChildren(...inst.strings.map((m, i) => {
    const b = el("button", `tuner-string${locked === i ? " locked" : ""}`);
    b.type = "button";
    b.title = `Bunyikan nada ${noteName(m)}${octave(m)} (${midiToHz(m).toFixed(1)} Hz). Klik lagi untuk lepas kunci.`;
    b.append(el("small", null, `${inst.strings.length - i}`), el("b", null, noteName(m)), el("span", null, String(octave(m))));
    b.onclick = () => {
      locked = locked === i ? null : i;
      if (locked != null) playTone(m);
      render();
    };
    return b;
  }));
  $("#tunerLockNote").textContent = !inst.strings.length ? "Kromatik: menunjuk ke nada terdekat dari 12 nada."
    : locked == null ? "Otomatis memilih senar terdekat. Klik senar untuk mendengar nadanya dan menguncinya."
      : `Terkunci ke senar ${inst.strings.length - locked}. Klik lagi untuk kembali otomatis.`;

  $("#tunerA4").textContent = `A4 = ${a4} Hz`;
  const btn = $("#tunerToggle");
  btn.lastChild.textContent = stream ? "Berhenti" : "Mulai tuner";
  btn.classList.toggle("primary", !stream);
  paint(performance.now());
}

function setA4(v) {
  a4 = Math.max(415, Math.min(466, v));
  store.set("tuner-a4", a4);
  render();
}

export function enterTuner() { render(); }

export function initTuner() {
  media.register("tuner", stop);
  $("#tunerToggle").onclick = () => (stream ? stop() : start());
  $("#tunerA4Minus").onclick = () => setA4(a4 - 1);
  $("#tunerA4Plus").onclick = () => setA4(a4 + 1);
  $("#tunerA4").onclick = () => setA4(440);
  // the mic stays off outside this page
  window.addEventListener("hashchange", () => { if (router.current !== "tuner") stop(); });
  onKeys("tuner", (e) => {
    if (e.code === "Space") { e.preventDefault(); stream ? stop() : start(); return; }
    const n = +e.key;
    if (n >= 1 && n <= inst.strings.length) $$("#tunerStrings .tuner-string")[inst.strings.length - n].click();
  });
}
