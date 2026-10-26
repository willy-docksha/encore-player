// ear training toward perfect (absolute) pitch: one path of levels in five stages.
// there are no profiles, so any level can be picked; results stay in this browser (store).

import { $, el, icon, store, media, onKeys, toast } from "./core.js";

const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const FLATS = ["", "D♭", "", "E♭", "", "", "G♭", "", "A♭", "", "B♭", ""];
const SOLFA = ["do", "", "re", "", "mi", "fa", "", "sol", "", "la", "", "si"];
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const PASS = 0.8;
const noteList = (pcs) => pcs.map((pc) => NAMES[pc]).join(", ");

const STAGES = [
  { name: "Pemula", blurb: "7 not natural (do–si), satu per satu." },
  { name: "Dasar", blurb: "Tambah 5 tuts hitam sampai lengkap 12 not." },
  { name: "Menengah", blurb: "Not yang sama di 2–3 oktaf, lalu suara organ." },
  { name: "Mahir", blurb: "Semua warna suara, bunyi lebih singkat, akor mayor." },
  { name: "Master", blurb: "4 oktaf, akor mayor & minor, bunyi sangat singkat." },
];

// every level: the notes so far plus how they are played. add: notes introduced on that level
const LEVELS = (() => {
  const out = [];
  let pool = [];
  let base = { octaves: [4], timbres: ["piano"], dur: 1.4, chords: 0, minor: false };
  const push = (stage, o = {}) => {
    if (o.add) pool = [...pool, ...o.add];
    out.push({ stage, pool: [...pool], fresh: o.add || [], exam: !!o.exam, ...base });
  };
  const set = (o) => { base = { ...base, ...o }; };
  // pemula: naturals, far apart first
  push(0, { add: [0, 7] }); push(0); push(0, { add: [4] }); push(0, { add: [9] }); push(0);
  push(0, { add: [2] }); push(0, { add: [5] }); push(0); push(0, { add: [11] }); push(0); push(0); push(0, { exam: true });
  // dasar: black keys
  for (const pc of [10, 6, 3, 1, 8]) { push(1, { add: [pc] }); push(1); }
  push(1); push(1); push(1); push(1, { exam: true });
  // menengah: wider range, second timbre
  set({ octaves: [3, 4] }); for (let i = 0; i < 4; i++) push(2);
  set({ octaves: [3, 4, 5] }); for (let i = 0; i < 4; i++) push(2);
  set({ timbres: ["piano", "organ"], dur: 1.2 }); for (let i = 0; i < 5; i++) push(2);
  push(2, { exam: true });
  // mahir: all timbres, shorter, major chords
  set({ timbres: ["piano", "organ", "sine"], dur: 1 }); for (let i = 0; i < 4; i++) push(3);
  set({ chords: 0.25, dur: 0.9 }); for (let i = 0; i < 4; i++) push(3);
  set({ chords: 0.35, dur: 0.8 }); for (let i = 0; i < 3; i++) push(3);
  push(3, { exam: true });
  // master
  set({ octaves: [2, 3, 4, 5], chords: 0.4, minor: true, dur: 0.7 }); for (let i = 0; i < 4; i++) push(4);
  set({ dur: 0.6 }); for (let i = 0; i < 3; i++) push(4);
  push(4, { exam: true });
  return out;
})();
const TOTAL = LEVELS.length;

// everything about one level (1-based): title, tags, tip, quiz settings
export function level(n) {
  const L = LEVELS[n - 1], prev = LEVELS[n - 2];
  const stage = STAGES[L.stage].name;
  let title, tip;
  if (L.exam) {
    title = `Ujian ${stage}`;
    tip = "Semua yang sudah dipelajari, tanpa pemanasan. Jawab dengan rasa pertama, jangan menebak dari not sebelumnya.";
  } else if (L.fresh.length) {
    title = `Not baru: ${noteList(L.fresh)}`;
    tip = `Di pemanasan, putar ${noteList(L.fresh)} berkali-kali. Rasakan "warna"-nya sendiri, jangan dibandingkan dengan not lain.`;
  } else if (prev && L.minor && !prev.minor) {
    title = "Akor minor"; tip = "Akor mayor dan minor dicampur. Yang ditanya tetap root-nya (not paling dasar).";
  } else if (prev && L.chords && !prev.chords) {
    title = "Akor mayor"; tip = "Sebagian soal berupa akor. Cari not dasarnya (root), dengarkan bagian paling bawah.";
  } else if (prev && L.timbres.length > prev.timbres.length) {
    title = "Warna suara baru"; tip = "Suara berbeda, not tetap sama. Kenali karakter notnya, bukan suara alatnya.";
  } else if (prev && L.octaves.length > prev.octaves.length) {
    title = `Rentang ${L.octaves.length} oktaf`; tip = "Not bisa muncul lebih tinggi atau rendah. C tetap C di oktaf mana pun.";
  } else if (prev && L.dur < prev.dur) {
    title = "Bunyi lebih singkat"; tip = "Waktu dengarnya makin pendek. Percaya kesan pertama.";
  } else {
    title = `Latihan ${L.pool.length} not`;
    tip = "Tidak ada materi baru. Ulang sampai lancar, fokus ke not yang sering tertukar.";
  }
  const tags = [`${L.pool.length} not`, `${L.octaves.length} oktaf`, L.timbres.length === 1 ? "suara piano" : `${L.timbres.length} warna suara`];
  if (L.chords) tags.push(L.minor ? "akor mayor & minor" : "akor mayor");
  if (L.dur < 1.1) tags.push("bunyi singkat");
  return { ...L, n, stageName: stage, title, tip, tags, count: n === TOTAL ? 40 : L.exam ? 30 : 20 };
}

// ------------------------------------------------------------------ sound (web audio, no samples needed)

let ctx = null, master = null;
const voices = new Set();
function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}
function stopAll() {
  if (!ctx) return;
  for (const v of voices) { v.gain.setTargetAtTime(0, ctx.currentTime, 0.02); setTimeout(() => v.disconnect(), 200); }
  voices.clear();
}
media.register("ear", stopAll);

const PARTIALS = {
  piano: [[1, 1], [2, 0.45], [3, 0.25], [4, 0.14], [5, 0.08], [6, 0.05]],
  organ: [[1, 1], [2, 0.6], [3, 0.35], [4, 0.25], [6, 0.12], [8, 0.08]],
  sine: [[1, 1]],
};

function tone(bus, midi, timbre, dur, at, level = 1) {
  const f = 440 * 2 ** ((midi - 69) / 12);
  const parts = PARTIALS[timbre].filter(([h]) => f * h < 12000);
  const sum = parts.reduce((s, [, a]) => s + a, 0);
  for (const [h, a] of parts) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = f * h;
    const peak = (a / sum) * 0.6 * level;
    g.gain.setValueAtTime(0, at);
    if (timbre === "piano") {
      // fast attack, higher partials die out first
      g.gain.linearRampToValueAtTime(peak, at + 0.006);
      g.gain.setTargetAtTime(0, at + 0.006, (dur * 0.55) / h ** 0.5);
    } else {
      g.gain.linearRampToValueAtTime(peak, at + 0.03);
      g.gain.setTargetAtTime(0, at + dur, 0.06);
    }
    o.connect(g).connect(bus);
    o.start(at);
    o.stop(at + dur + 0.6);
  }
}

// q: {midi, timbre} for a note, plus {chord: [semitones]} for a chord
function play(q, dur, delay = 0) {
  audio();
  media.claim("ear");
  const bus = ctx.createGain();
  bus.connect(master);
  voices.add(bus);
  const at = ctx.currentTime + 0.03 + delay;
  if (q.chord) for (const s of q.chord) tone(bus, q.midi + s, q.timbre, dur * 1.3, at, 0.55);
  else tone(bus, q.midi, q.timbre, dur, at);
  setTimeout(() => { voices.delete(bus); bus.disconnect(); }, (delay + dur * 1.3 + 0.8) * 1000);
}

// ------------------------------------------------------------------ progress (this browser only)
// pitch-progress: {level: {best, tries, at}}

const progress = () => store.get("pitch-progress", {});
function saveResult(n, score) {
  const all = progress();
  const r = all[n] || { best: 0, tries: 0 };
  all[n] = { best: Math.max(r.best, score), tries: r.tries + 1, at: Date.now() };
  store.set("pitch-progress", all);
}
function suggestedLevel() {
  const all = progress();
  for (let n = 1; n <= TOTAL; n++) if ((all[n]?.best || 0) < PASS) return n;
  return TOTAL;
}
// days in a row (ending today or yesterday) with any finished level
function streak() {
  const days = new Set(Object.values(progress()).map((r) => new Date(r.at).toDateString()));
  const d = new Date();
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(d.toDateString())) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

// ------------------------------------------------------------------ ui

let current = store.get("pitch-level", 0) || suggestedLevel();
let session = null; // {lesson, step: "warmup"|"quiz"|"done", qs, i, picked, tries (wrong guesses), right, misses}

function pickLevel(n) {
  current = Math.min(TOTAL, Math.max(1, n | 0 || 1));
  store.set("pitch-level", current);
  render();
}

export function enterEar() { render(); }

function render() {
  $("#earHome").hidden = !!session;
  $("#earSession").hidden = !session;
  const s = streak();
  $("#earStreak").textContent = s ? `${s} hari berturut-turut` : "";
  if (session) return renderSession();
  renderLevels();
  renderLesson();
}

function renderLevels() {
  const all = progress();
  const next = suggestedLevel();
  const box = $("#earLevels");
  box.replaceChildren();
  STAGES.forEach((st, si) => {
    const nums = LEVELS.map((L, i) => (L.stage === si ? i + 1 : 0)).filter(Boolean);
    const done = nums.filter((n) => (all[n]?.best || 0) >= PASS).length;
    const group = el("div", "ear-stage" + (done === nums.length ? " done" : ""));
    const head = el("div", "ear-stage-head");
    head.append(el("b", "", st.name), el("span", "count", `${nums[0]}–${nums.at(-1)} · ${done}/${nums.length}`));
    group.append(head, el("p", "ear-small", st.blurb));
    const grid = el("div", "ear-days");
    for (const n of nums) {
      const b = el("button", "ear-day");
      b.type = "button";
      const r = all[n];
      if (r) b.classList.add(r.best >= PASS ? "pass" : "tried");
      if (LEVELS[n - 1].exam) b.classList.add("review");
      if (n === next) b.classList.add("next");
      if (n === current) b.classList.add("active");
      b.append(el("span", "n", n));
      if (r) b.append(el("span", "s", `${Math.round(r.best * 100)}`));
      b.title = `Level ${n}: ${level(n).title}${r ? ` · terbaik ${Math.round(r.best * 100)}%` : ""}`;
      b.onclick = () => pickLevel(n);
      grid.append(b);
    }
    group.append(grid);
    box.append(group);
  });
  const passedAll = Object.values(all).filter((r) => r.best >= PASS).length;
  $("#earDone").textContent = `${passedAll}/${TOTAL} lulus`;
  $("#earDayInput").max = TOTAL;
  $("#earDayInput").value = current;
  $("#earDayMax").textContent = `dari ${TOTAL}`;
  $("#earToday").hidden = current === next;
  $("#earToday").textContent = `Lanjut ke level ${next}`;
}

function renderLesson() {
  const L = level(current);
  const r = progress()[current];
  const box = $("#earLesson");
  box.replaceChildren();
  const head = el("div", "ear-lesson-head");
  head.append(el("p", "eyebrow", `${L.stageName} · Level ${L.n}`), el("h2", "", L.title));
  const tags = el("div", "chips");
  for (const t of L.tags) tags.append(el("span", "chip", t));
  if (L.exam) tags.prepend(el("span", "chip warn", "ujian"));
  box.append(head, tags);
  // the notes of the level on a keyboard, new ones marked
  box.append(keyboard({ enabled: L.pool, fresh: L.fresh, onPick: (pc) => play({ midi: 60 + pc, timbre: "piano" }, 1.2) }));
  box.append(el("p", "ear-tip", L.tip));
  if (r) {
    const st = el("p", "ear-status" + (r.best >= PASS ? " pass" : ""));
    st.append(icon(r.best >= PASS ? "check" : "refresh"), `Nilai terbaik ${Math.round(r.best * 100)}% · ${r.tries}× dicoba`);
    box.append(st);
  }
  const acts = el("div", "ear-acts");
  const warm = el("button", "btn" + (L.exam ? "" : " primary"));
  warm.type = "button";
  warm.append(icon("music"), L.exam ? "Pemanasan dulu" : "Mulai pemanasan");
  warm.onclick = () => start(L, "warmup");
  const quiz = el("button", "btn" + (L.exam ? " primary" : ""));
  quiz.type = "button";
  quiz.append(icon("play"), `Langsung kuis · ${L.count} soal`);
  quiz.onclick = () => start(L, "quiz");
  if (L.exam) acts.append(quiz, warm); else acts.append(warm, quiz);
  box.append(acts);
  box.append(el("p", "ear-small", `Lulus kalau benar ≥ ${PASS * 100}%. Klik tuts di atas untuk mendengar notnya.`));
}

// one octave of piano keys; enabled: pitch classes that can be played/answered
function keyboard({ enabled, fresh = [], onPick, mark = {} }) {
  const kb = el("div", "ear-kb");
  for (let pc = 0; pc < 12; pc++) {
    const black = !WHITE.includes(pc);
    const k = el("button", "ear-key " + (black ? "black" : "white"));
    k.type = "button";
    k.dataset.pc = pc;
    if (black) k.style.left = `${(WHITE.indexOf(pc - 1) + 1) * (100 / 7)}%`;
    const on = enabled.includes(pc);
    k.disabled = !on;
    if (fresh.includes(pc)) k.classList.add("fresh");
    if (mark[pc]) k.classList.add(mark[pc]);
    k.append(el("b", "", NAMES[pc]));
    if (SOLFA[pc] || FLATS[pc]) k.append(el("small", "", SOLFA[pc] || FLATS[pc]));
    k.title = on ? NAMES[pc] + (FLATS[pc] ? ` / ${FLATS[pc]}` : "") : "Belum dipelajari";
    k.onclick = () => onPick(pc);
    kb.append(k);
  }
  return kb;
}

// ------------------------------------------------------------------ session: warmup -> quiz -> result

const pick = (a) => a[Math.floor(Math.random() * a.length)];

function questions(L) {
  const qs = [];
  let last = -1;
  for (let i = 0; i < L.count; i++) {
    let pc;
    do pc = L.fresh.length && Math.random() < 0.4 ? pick(L.fresh) : pick(L.pool);
    while (pc === last && L.pool.length > 1);
    last = pc;
    const timbre = pick(L.timbres);
    if (Math.random() < L.chords) {
      const minor = L.minor && Math.random() < 0.5;
      qs.push({ pc, midi: 12 * (pick([3, 4]) + 1) + pc, timbre, chord: minor ? [0, 3, 7] : [0, 4, 7], minor });
    } else qs.push({ pc, midi: 12 * (pick(L.octaves) + 1) + pc, timbre });
  }
  return qs;
}

function start(L, step) {
  session = { lesson: L, step, qs: questions(L), i: 0, picked: null, tries: [], right: 0, misses: {} };
  render();
  if (step === "quiz") setTimeout(replay, 250);
}

function quit() { stopAll(); session = null; render(); }
const replay = () => { const q = session?.qs[session.i]; if (q && session.step === "quiz") play(q, session.lesson.dur); };

function renderSession() {
  const S = session, L = S.lesson;
  const box = $("#earSession");
  box.replaceChildren();
  const head = el("header", "ear-session-head");
  const back = el("button", "btn ghost sm");
  back.type = "button";
  back.append(icon("back"), "Keluar");
  back.onclick = quit;
  head.append(back, el("span", "count", `${L.stageName} · Level ${L.n} · ${L.title}`));
  if (S.step === "quiz" && S.i > 0) {
    // start over without finishing the rest
    const restart = el("button", "btn ghost sm");
    restart.type = "button";
    restart.append(icon("repeat"), "Ulang dari awal");
    restart.onclick = () => { stopAll(); start(L, "quiz"); };
    head.append(restart);
  }
  box.append(head);
  if (S.step === "warmup") return renderWarmup(box);
  if (S.step === "quiz") return renderQuiz(box);
  renderResult(box);
}

function renderWarmup(box) {
  const L = session.lesson;
  box.append(el("h2", "ear-q", "Pemanasan"));
  box.append(el("p", "ear-tip center", L.fresh.length
    ? `Fokus ke not baru: ${noteList(L.fresh)}. Klik tutsnya, sebut namanya dalam hati sambil dengar.`
    : "Klik tiap tuts dan sebut namanya dalam hati sambil mendengar."));
  box.append(keyboard({ enabled: L.pool, fresh: L.fresh, onPick: (pc) => play({ midi: 12 * (pick(L.octaves) + 1) + pc, timbre: pick(L.timbres) }, 1.2) }));
  const acts = el("div", "ear-acts center");
  const all = el("button", "btn");
  all.type = "button";
  all.append(icon("list"), "Putar semua berurutan");
  all.onclick = () => { stopAll(); [...L.pool].sort((a, b) => a - b).forEach((pc, i) => play({ midi: 60 + pc, timbre: "piano" }, 0.9, i * 0.9)); };
  const go = el("button", "btn primary");
  go.type = "button";
  go.append(icon("play"), `Mulai kuis · ${L.count} soal`);
  go.onclick = () => start(L, "quiz");
  acts.append(all, go);
  box.append(acts);
}

function renderQuiz(box) {
  const S = session, L = S.lesson, q = S.qs[S.i];
  const bar = el("div", "ear-progress");
  const fill = el("i");
  fill.style.width = `${(S.i / S.qs.length) * 100}%`;
  bar.append(fill);
  box.append(bar, el("p", "count center", `Soal ${S.i + 1} dari ${S.qs.length} · benar ${S.right}`));
  box.append(el("h2", "ear-q", q.chord ? "Akor ini, root-nya not apa?" : "Not apa ini?"));
  const big = el("button", "play-btn ear-replay");
  big.type = "button";
  big.title = "Putar lagi (Spasi)";
  big.append(icon("play"));
  big.onclick = replay;
  box.append(big);
  const mark = {};
  for (const pc of S.tries) mark[pc] = "wrong";
  if (S.picked != null) mark[q.pc] = "right";
  const kb = keyboard({ enabled: L.pool, mark, onPick: answer });
  if (S.picked != null) kb.classList.add("locked");
  box.append(kb);
  const fb = el("div", "ear-feedback");
  const name = NAMES[q.pc] + (q.chord ? (q.minor ? " minor" : " mayor") : "");
  const last = S.tries.at(-1);
  if (S.picked == null && S.tries.length) {
    // wrong, answer still hidden: try again or give up on this one
    fb.append(el("p", "bad", `Bukan ${NAMES[last]}. Dengarkan lagi, lalu coba tuts lain.`));
    const again = el("button", "btn primary");
    again.type = "button";
    again.append(icon("play"), "Putar lagi");
    again.onclick = replay;
    const show = el("button", "btn");
    show.type = "button";
    show.append("Lihat jawaban");
    show.onclick = reveal;
    fb.append(again, show);
  } else if (S.picked != null) {
    const ok = S.picked === q.pc;
    const text = !ok ? `Itu ${name}, bukan ${NAMES[last]}.`
      : S.tries.length ? `Benar, ${name}! Nilai cuma dihitung dari tebakan pertama.` : `Benar, ${name}!`;
    fb.append(el("p", ok ? "ok" : "bad", text));
    if (!ok) {
      // hear both again: the right note, then the last one picked
      const cmp = el("button", "btn");
      cmp.type = "button";
      cmp.append(icon("refresh"), `Bandingkan ${NAMES[q.pc]} & ${NAMES[last]}`);
      cmp.onclick = () => { stopAll(); play(q, L.dur); play({ ...q, midi: q.midi - q.pc + last }, L.dur, L.dur + 0.3); };
      fb.append(cmp);
    }
    const next = el("button", "btn primary");
    next.type = "button";
    next.append(S.i + 1 < S.qs.length ? "Soal berikutnya" : "Lihat hasil", icon("next"));
    next.onclick = advance;
    fb.append(next);
  } else fb.append(el("p", "ear-small", "Spasi: putar lagi · huruf C D E F G A B untuk jawab, Shift untuk ♯"));
  box.append(fb);
}

function answer(pc) {
  const S = session;
  if (!S || S.step !== "quiz" || S.picked != null || !S.lesson.pool.includes(pc) || S.tries.includes(pc)) return;
  const q = S.qs[S.i];
  if (pc === q.pc) {
    // only a right first guess counts
    if (!S.tries.length) S.right++;
    S.picked = pc;
    render();
    const at = S.i;
    setTimeout(() => { if (session === S && S.i === at) advance(); }, S.tries.length ? 1200 : 650);
    return;
  }
  if (!S.tries.length) S.misses[q.pc] = (S.misses[q.pc] || 0) + 1;
  S.tries.push(pc);
  render();
  play(q, S.lesson.dur);
}

function reveal() {
  const S = session;
  if (!S || S.step !== "quiz" || S.picked != null || !S.tries.length) return;
  S.picked = S.tries.at(-1);
  render();
  play(S.qs[S.i], S.lesson.dur);
}

function advance() {
  const S = session;
  if (!S || S.picked == null) return;
  S.picked = null;
  S.tries = [];
  if (++S.i >= S.qs.length) {
    S.step = "done";
    S.score = S.right / S.qs.length;
    saveResult(S.lesson.n, S.score);
    render();
    return;
  }
  render();
  setTimeout(replay, 150);
}

function renderResult(box) {
  const S = session, L = S.lesson, ok = S.score >= PASS;
  const res = el("div", "ear-result" + (ok ? " pass" : ""));
  res.append(el("span", "ear-score", `${Math.round(S.score * 100)}%`));
  res.append(el("h2", "", ok ? "Lulus! 🎉" : "Hampir, coba sekali lagi"));
  res.append(el("p", "ear-tip center", `${S.right} dari ${S.qs.length} benar. ${ok ? "Level berikutnya sudah menunggu." : `Butuh ${PASS * 100}% untuk lulus.`}`));
  const misses = Object.entries(S.misses).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (misses.length) res.append(el("p", "ear-small", `Paling sering salah: ${misses.map(([pc, n]) => `${NAMES[pc]} (${n}×)`).join(", ")}`));
  const acts = el("div", "ear-acts center");
  const again = el("button", "btn" + (ok ? "" : " primary"));
  again.type = "button";
  again.append(icon("repeat"), "Ulangi level ini");
  again.onclick = () => start(L, "quiz");
  acts.append(again);
  if (L.n < TOTAL) {
    const next = el("button", "btn" + (ok ? " primary" : ""));
    next.type = "button";
    next.append(`Ke level ${L.n + 1}`, icon("next"));
    // straight into the next level, without the level list in between
    next.onclick = () => {
      const N = level(L.n + 1);
      current = N.n;
      store.set("pitch-level", current);
      stopAll();
      start(N, N.exam ? "quiz" : "warmup");
    };
    acts.append(next);
  }
  const home = el("button", "btn ghost");
  home.type = "button";
  home.append("Daftar level");
  home.onclick = quit;
  acts.append(home);
  res.append(acts);
  box.append(res);
  if (ok && L.exam) toast(L.n === TOTAL ? "Semua level selesai. Telingamu sudah Master!" : `Tahap ${L.stageName} selesai. Lanjut ke tahap ${STAGES[L.stage + 1].name}!`);
}

// ------------------------------------------------------------------ init

export function initEar() {
  $("#earDayInput").onchange = (e) => pickLevel(+e.target.value);
  $("#earMinus").onclick = () => pickLevel(current - 1);
  $("#earPlus").onclick = () => pickLevel(current + 1);
  $("#earToday").onclick = () => pickLevel(suggestedLevel());

  onKeys("ear", (e) => {
    const S = session;
    if (e.key === "Enter") {
      e.preventDefault();
      if (!S) { const L = level(current); start(L, L.exam ? "quiz" : "warmup"); }
      else if (S.step === "warmup") start(S.lesson, "quiz");
      else if (S.step === "quiz") S.picked == null ? reveal() : advance();
      return;
    }
    if (!S) {
      if (e.key === "ArrowLeft") pickLevel(current - 1);
      else if (e.key === "ArrowRight") pickLevel(current + 1);
      return;
    }
    if (e.key === "Escape") return quit();
    if (S.step !== "quiz") return;
    if (e.code === "Space") { e.preventDefault(); replay(); return; }
    const m = e.code.match(/^Key([A-G])$/);
    // no e♯ / b♯
    if (!m || (e.shiftKey && "EB".includes(m[1]))) return;
    answer({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (e.shiftKey ? 1 : 0));
  });
}
