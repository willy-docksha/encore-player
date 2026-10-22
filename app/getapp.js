// web version of breakdown: point visitors to the encore app build for their computer

import { $, el } from "./core.js";
import { APP_RELEASES, APP_FILES } from "./config.js";

const fileUrl = (os) => `${APP_RELEASES}/download/${APP_FILES[os].file}`;

// mac / windows / linux, or null on phones and tablets (ipads report "mac" but have touch)
function guessOs() {
  const ua = navigator.userAgent;
  if (/android|iphone|ipad|ipod/i.test(ua)) return null;
  const p = (navigator.userAgentData?.platform || navigator.platform || ua).toLowerCase();
  if (p.includes("mac")) return navigator.maxTouchPoints > 1 ? null : "mac";
  if (p.includes("win")) return "windows";
  if (p.includes("linux")) return "linux";
  return null;
}

// what to do the first time, since the app is not signed by apple / microsoft
const OPEN_TIP = {
  mac: "Buka file .dmg, seret Encore ke Applications, lalu buka. Kalau muncul peringatan, buka System Settings → Privacy & Security → Open Anyway (sekali saja).",
  windows: "Extract zip-nya, lalu buka Encore.exe. Kalau muncul SmartScreen, klik More info → Run anyway (sekali saja).",
  linux: "Extract, lalu jalankan ./Encore di folder Encore. Encore terbuka sendiri di browser.",
};

export function renderGetApp() {
  const os = guessOs();
  const main = $("#getMain");
  const others = Object.keys(APP_FILES).filter((k) => k !== os);
  if (os) {
    main.hidden = false;
    main.href = fileUrl(os);
    main.querySelector("span").textContent = `Download untuk ${APP_FILES[os].label}`;
    $("#getNeed").textContent = APP_FILES[os].need;
    $("#getOpenTip").textContent = OPEN_TIP[os];
  } else {
    // phone: the app needs a laptop or pc, still list every build
    main.hidden = true;
    $("#getNeed").textContent = "Encore App jalan di laptop/PC. Buka halaman ini dari komputermu, atau download dari sini:";
  }
  const links = others.map((k) => {
    const a = el("a", null, APP_FILES[k].label);
    a.href = fileUrl(k);
    a.title = APP_FILES[k].need;
    return a;
  });
  const out = [os ? "Pakai komputer lain? " : ""];
  links.forEach((a, i) => out.push(...(i ? [" · ", a] : [a])));
  const all = el("a", null, "semua versi");
  all.href = APP_RELEASES;
  all.target = "_blank";
  all.rel = "noopener noreferrer";
  out.push(" · ", all);
  $("#getOther").replaceChildren(...out);
}
