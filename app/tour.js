// overlay tutorial: dims the page, spotlights one real control at a time and explains it.
// opens by itself on the first visit; "Cara pakai" in the menu opens it again.

import { $, el, store, router, server } from "./core.js";

const DONE_KEY = "tour-done";

// target: css selector of what to spotlight; a list ("a, b") spotlights them together.
// null = centered welcome card.
// steps whose target is hidden on this screen are skipped.
const steps = () => [
  {
    target: null,
    title: "Selamat datang di Encore 👋",
    text: "Tempat latihan lagu: putar berulang, pelankan, dan loop bagian yang sulit sampai hafal. Ikuti tur singkat ini, cuma sekitar 1 menit.",
  },
  {
    target: "#openEditor",
    title: "1. Tambah lagu",
    text: "Tempel link YouTube atau Google Drive. Bisa juga langsung tempel satu chat daftar lagu dari WhatsApp, judul dan catatannya ikut terbaca.",
  },
  {
    target: ".queue-card",
    title: "2. Antrian lagu",
    text: "Klik lagu untuk memutarnya. Tahan ⋮⋮ lalu geser untuk ubah urutan. Tombol ⋯ untuk buka link asli, ganti link, atau hapus lagu.",
  },
  {
    target: "#player .transport, #player .transport-sub",
    title: "3. Kontrol putar",
    text: "Play/pause, lagu sebelum/berikutnya, mundur/maju 5 detik, mode ulang, dan acak. Nyalakan Auto next supaya lanjut otomatis ke lagu berikutnya.",
  },
  {
    target: "#bar",
    title: "4. Progress bar",
    text: "Klik atau geser untuk lompat ke bagian mana pun. Penanda loop A dan B juga muncul di sini dan bisa digeser.",
  },
  {
    target: ".tools .tool:nth-child(1)",
    title: "5. Kecepatan",
    text: "Pelankan lagu sampai 0.5× untuk latihan bagian yang cepat. Nadanya tidak berubah.",
  },
  {
    target: ".tools .tool:nth-child(2)",
    title: "6. Loop A–B",
    text: "Klik Set A di awal bagian yang mau dilatih, lalu Set B di akhirnya. Bagian itu akan diputar terus sampai loop dihapus.",
  },
  {
    target: ".tools .tool:nth-child(3)",
    title: "7. Volume",
    text: "Atur volume, atau klik ikon speaker untuk mute dan unmute.",
  },
  {
    target: '.nav-item[data-nav="bass"]',
    title: "8. Breakdown",
    text: server.released
      ? "Pisahkan vokal, drum, bass, dan instrumen lain, lalu lihat not dan chord-nya. Hasilnya bisa diekspor tanpa instrumen tertentu."
      : "Segera hadir: memisahkan vokal, drum, bass, dan instrumen lain, lengkap dengan not dan chord-nya.",
  },
  {
    target: "#shortcutsBtn",
    title: "9. Shortcut keyboard",
    text: "Di laptop, semuanya bisa lewat keyboard: Spasi untuk play/pause, ← → untuk mundur/maju, A dan B untuk loop, M untuk mute. Daftar lengkapnya ada di sini.",
  },
  {
    target: "#tourBtn",
    title: "Selesai! 🎉",
    text: "Tutorial ini bisa dibuka lagi kapan saja dari tombol Cara pakai.",
  },
];

let list = [], at = 0, box = null, spot = null, tip = null, raf = 0;

// bounding box around every element the selector matches
function rectOf(sel) {
  const rs = [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
  if (!rs.length) return null;
  const top = Math.min(...rs.map((r) => r.top)), left = Math.min(...rs.map((r) => r.left));
  const bottom = Math.max(...rs.map((r) => r.bottom)), right = Math.max(...rs.map((r) => r.right));
  return { top, left, bottom, right, width: right - left, height: bottom - top };
}

const visible = (sel) => {
  if (!sel) return true;
  return !!rectOf(sel);
};

export function startTour() {
  if (box) return;
  if (router.current !== "playlist") router.go("#/");
  // wait a frame so the playlist view is laid out
  requestAnimationFrame(() => {
    list = steps().filter((s) => visible(s.target));
    at = 0;
    build();
    show();
  });
}

function build() {
  document.body.classList.add("touring");
  box = el("div", "tour");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  spot = el("div", "tour-spot");
  tip = el("div", "tour-tip");
  box.append(spot, tip);
  // clicks on the dim area do nothing, so a stray tap doesn't end the tour
  box.addEventListener("click", (e) => e.stopPropagation());
  document.body.append(box);
  addEventListener("resize", queue);
  addEventListener("scroll", queue, true);
  document.addEventListener("keydown", onKey, true);
}

function end() {
  store.set(DONE_KEY, true);
  cancelAnimationFrame(raf);
  removeEventListener("resize", queue);
  removeEventListener("scroll", queue, true);
  document.removeEventListener("keydown", onKey, true);
  box?.remove();
  box = spot = tip = null;
  document.body.classList.remove("touring");
}

function onKey(e) {
  if (!box) return;
  if (e.key === "Escape") end();
  else if (e.key === "ArrowRight" || e.key === "Enter") go(1);
  else if (e.key === "ArrowLeft") go(-1);
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function go(d) {
  const n = at + d;
  if (n < 0) return;
  if (n >= list.length) { end(); return; }
  at = n;
  show();
}

function show() {
  const s = list[at];
  const last = at === list.length - 1;
  const head = el("div", "tour-head");
  head.append(el("span", "tour-count", `${at + 1} / ${list.length}`));
  const skip = el("button", "tour-skip", last ? "" : "Lewati");
  skip.type = "button";
  skip.hidden = last;
  skip.onclick = end;
  head.append(skip);
  const foot = el("div", "tour-foot");
  const dots = el("div", "tour-dots");
  list.forEach((_, i) => dots.append(el("i", i === at ? "on" : "")));
  const nav = el("div", "tour-nav");
  if (at > 0) {
    const back = el("button", "btn sm ghost", "Kembali");
    back.type = "button"; back.onclick = () => go(-1);
    nav.append(back);
  }
  const next = el("button", "btn sm primary", at === 0 ? "Mulai tur" : last ? "Selesai" : "Lanjut");
  next.type = "button"; next.onclick = () => go(1);
  nav.append(next);
  foot.append(dots, nav);
  tip.replaceChildren(head, el("h3", "tour-title", s.title), el("p", "tour-text", s.text), foot);
  tip.classList.remove("in");
  if (s.target) document.querySelector(s.target).scrollIntoView({ block: "center", behavior: "smooth" });
  // place once now and again after the smooth scroll settles
  place();
  setTimeout(place, 380);
  requestAnimationFrame(() => tip?.classList.add("in"));
  next.focus({ preventScroll: true });
}

function queue() { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); }

function place() {
  if (!box) return;
  const s = list[at];
  const vw = innerWidth, vh = innerHeight, G = 16, PAD = 6;
  const w = Math.min(340, vw - G * 2);
  tip.style.width = `${w}px`;
  const th = tip.offsetHeight;
  if (!s.target) {
    spot.classList.add("none");
    tip.style.left = `${(vw - w) / 2}px`;
    tip.style.top = `${Math.max(G, (vh - th) / 2)}px`;
    return;
  }
  spot.classList.remove("none");
  const r = rectOf(s.target);
  if (!r) return;
  const top = Math.max(4, r.top - PAD), left = Math.max(4, r.left - PAD);
  const bottom = Math.min(vh - 4, r.bottom + PAD), right = Math.min(vw - 4, r.right + PAD);
  Object.assign(spot.style, { top: `${top}px`, left: `${left}px`, width: `${right - left}px`, height: `${bottom - top}px` });
  // below the target if it fits, else above, else pinned to the bottom of the screen
  let y;
  if (bottom + 12 + th <= vh - G) y = bottom + 12;
  else if (top - 12 - th >= G) y = top - 12 - th;
  else y = vh - th - G;
  // beside a tall sidebar item on desktop: put the bubble to its right
  let x = Math.min(Math.max(G, r.left), vw - w - G);
  if (r.right < vw * 0.3 && right + 12 + w <= vw - G) { x = right + 12; y = Math.min(Math.max(G, r.top), vh - th - G); }
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

// first visit: open once the page has settled
export function maybeStartTour() {
  if (store.get(DONE_KEY, false)) return;
  setTimeout(() => { if (!document.querySelector("dialog[open]")) startTour(); }, 700);
}
