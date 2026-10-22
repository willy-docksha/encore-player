# Encore

Sekali lagi, sampai hafal. Encore punya dua bagian:

- **Playlist**: media player latihan dari link YouTube dan Google Drive. Jalan di mana saja, termasuk Vercel dan HP.
- **Breakdown**: memisahkan instrumen (drum, bass, vokal, gitar, piano, lainnya), menampilkan not bass, melodi vokal, dan chord-nya. AI-nya berat, jadi Breakdown hanya jalan di **Encore App** (Mac, Windows, Linux) di komputer pengguna. Di versi web, menu Breakdown berisi halaman download app-nya.

## Playlist

- Playlist dari daftar link (YouTube & Google Drive bisa dicampur), auto next
- Bisa langsung tempel chat daftar lagu (mis. dari WhatsApp). Judul `1) Nama Lagu`, catatan seperti *Chorus saja*, dan nama ibadah ikut terbaca, dengan preview sebelum ditambahkan
- Geser lagu untuk mengubah urutan
- Prev / Play / Pause / Stop / Next, lompat ±5s dan ±10s
- Ulang: tanpa ulang, ulang 1 lagu, ulang semua · acak
- Kecepatan 0.25×–2×, loop A–B (penanda A/B bisa digeser di progress bar)
- Bisa dipasang di layar HP (Add to Home Screen), dengan kontrol di layar kunci untuk audio Drive
- Audio Drive otomatis disimpan di perangkat: hemat kuota saat diputar ulang dan bisa offline
- Di Encore App: tombol **Breakdown** di setiap lagu

File Google Drive harus dibagikan sebagai **"Siapa saja yang memiliki link"**.

## Breakdown

- Tarik file audio atau tempel link YouTube / Google Drive. Lagu masuk antrian dan dianalisis satu per satu oleh Encore App; tab browser boleh ditutup, asal app-nya tetap jalan
- Pemisahan stem: Demucs `htdemucs` + spesialis bass `htdemucs_ft` + gitar/piano dari `htdemucs_6s` (PyTorch, GPU Apple/NVIDIA kalau ada, selain itu CPU)
- Transkripsi bass: pYIN + deteksi petikan ulang. Bagian slap/pop memakai Basic Pitch, dan not sangat rendah diisi pYIN
- Tempo, beat & downbeat (beat_this), chord & kunci, slash chord dari bass
- **Mixer 6 stem**: Drum, Bass, Vokal, Gitar, Piano, Lainnya (pad/synth). Masing-masing bisa mute, solo, dan diatur volumenya; semuanya kalau dijumlah persis lagu aslinya
- Satu pilihan tampilan: **Multitrack · Drum · Bass · Vokal · Piano · Gitar** (bagian yang tidak ada disembunyikan)
  - **Multitrack**: semua instrumen bertumpuk di satu timeline, dengan penanda **filler** (gitar/piano/pad mengisi saat vokal diam) dan **fill drum**. Klik nama lajur untuk mute
  - **Drum**: grid 16 langkah per bar (hi-hat, snare, tom, kick), bar fill ditandai otomatis. Deteksinya memakai ciri spektrum, jadi di rekaman live snare masih bisa tertukar dengan klik kick atau simbal
  - **Bass**: grafik atau tab (4/5 senar, otomatis)
  - **Vokal**: kontur nada (vibrato, slide) plus not-notnya
  - **Piano / Gitar**: piano roll dari not polifonik (Basic Pitch, nada harmonik disaring). Gitar juga punya **tab 6 senar** (tebakan terbaik: jangkauan tangan maks. 4 fret, perpindahan minimal)
- **Chord lengkap**: mayor/minor plus 7, maj7, m7, sus2, sus4, add9, dim, dan slash chord. Not bass ikut membantu (misalnya C dengan bass A dibaca Am7). Ambang batasnya sengaja konservatif
- **MIDI** per bagian: bass, vokal, piano, gitar, drum
- Loop dan speed tanpa ubah nada
- Library (hasil analisis, stem, MIDI, audio asli) disimpan di komputer: `~/Library/Application Support/Encore` (Mac), `%APPDATA%\Encore` (Windows), `~/.local/share/encore` (Linux)
- Lagu yang dianalisis dengan algoritma lama ditandai **versi lama**

**Batasan:**

- Analisis pertama mengunduh model AI ±500 MB (sekali saja)
- Butuh laptop/PC, RAM 8 GB+. Di Mac chip Apple lagu 4 menit selesai dalam beberapa menit; di Windows/Linux tanpa GPU NVIDIA (build-nya CPU) bisa jauh lebih lama
- Link YouTube butuh `deno` atau `node` terpasang di komputer itu supaya selalu bisa diunduh; tanpa itu sebagian video bisa gagal. Upload file atau link Drive selalu bisa
- App belum ditandatangani Apple/Microsoft, jadi pertama kali dibuka muncul peringatan (lihat halaman Breakdown di web atau catatan rilis)

## Encore App

`backend/` berisi server Python (FastAPI) yang menyajikan tampilan yang sama plus pipeline analisisnya. `backend/main.py` menyalakan server di http://localhost:8765 lalu membuka browser.

Jalankan dari source (klik dua kali `start.command`, atau):

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r backend/requirements.txt
uv pip install --python .venv/bin/python --no-deps basic-pitch
.venv/bin/python backend/main.py
```

Build executable di komputer sendiri (hasilnya di `dist/`, hanya untuk OS yang sedang dipakai):

```bash
uv pip install --python .venv/bin/python pyinstaller pillow
.venv/bin/pyinstaller --noconfirm backend/encore.spec
.venv/bin/python backend/smoke_test.py dist/Encore.app/Contents/MacOS/Encore   # Windows/Linux: dist/Encore/Encore
```

**Rilis untuk Mac, Windows, dan Linux sekaligus:** push tag `app-v*`. GitHub Actions (`.github/workflows/release.yml`) membangun ketiganya, menjalankan smoke test (menganalisis klip pendek) di tiap OS, lalu menerbitkan GitHub Release. Halaman download di web selalu menunjuk ke rilis terbaru.

```bash
git tag app-v1.0.1 && git push origin app-v1.0.1
```

## Jalankan versi web

```bash
node dev.mjs
```

Lalu buka http://localhost:8765. `dev.mjs` menyajikan versi web plus fungsi `api/` (Drive & judul) sama seperti di Vercel. Breakdown di sini menampilkan halaman download app (jalankan Encore App di port lain kalau perlu keduanya: `PORT=8766 .venv/bin/python backend/main.py`).

## Deploy ke Vercel

Import repo ini di Vercel, pilih Framework Preset **Other**, lalu Deploy. Yang ter-deploy hanya `index.html`, `app/`, dan `api/` (lihat `.vercelignore`). `api/drive.js` meneruskan audio Drive dan `api/title.js` mengambil judul lagu.

## Struktur

| Path | Isi |
|---|---|
| `index.html`, `app/` | Tampilan: `core.js`, `playlist.js`, `bass.js`, `getapp.js` (halaman download), `main.js`, `styles.css` |
| `app/config.js` | Alamat rilis Encore App |
| `api/` | Fungsi Vercel untuk Drive & judul |
| `backend/app.py` | Server Encore App: antrian, library, file stem/MIDI, Drive & judul |
| `backend/pipeline.py` | Analisis: Demucs, pYIN, Basic Pitch, beat_this, chord, drum, MIDI |
| `backend/main.py` | Pembuka app (server + browser, ikon Dock di Mac) |
| `backend/encore.spec`, `backend/smoke_test.py` | Build PyInstaller dan tes hasil build |
| `dev.mjs` | Server lokal untuk versi web |

## Shortcut keyboard

**Playlist:** `Space` play/pause · `N`/`P` next/prev · `S` stop · `R` mode ulang · `←`/`→` 5 detik · `J`/`L` 10 detik · `[`/`]` kecepatan · `A`/`B`/`C` loop A–B

**Breakdown:** `Space` play/pause · `←`/`→` 2 detik · `A`/`B` titik loop · `L` loop on/off · `Esc` hapus loop · `M` multitrack · `V` bagian berikutnya · `T` grafik ↔ tab (bass, gitar) · `1`–`6` mute kanal mixer
