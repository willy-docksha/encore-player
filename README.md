# Encore

Sekali lagi, sampai hafal. Encore punya dua bagian:

- **Playlist**: media player latihan dari link YouTube dan Google Drive. Jalan di mana saja, termasuk Vercel dan HP.
- **Breakdown**: memisahkan instrumen (drum, bass, vokal, gitar, piano, lainnya), menampilkan not bass, melodi vokal, dan chord-nya. Semua AI-nya jalan **langsung di browser pengunjung** (WebGPU), jadi tidak butuh server yang kuat: cukup hosting statis gratis seperti Vercel.

## Playlist

- Playlist dari daftar link (YouTube & Google Drive bisa dicampur), auto next
- Bisa langsung tempel chat daftar lagu (mis. dari WhatsApp). Judul `1) Nama Lagu`, catatan seperti *Chorus saja*, dan nama ibadah ikut terbaca, dengan preview sebelum ditambahkan
- Geser lagu untuk mengubah urutan
- Prev / Play / Pause / Stop / Next, lompat ±5s dan ±10s
- Ulang: tanpa ulang, ulang 1 lagu, ulang semua · acak
- Kecepatan 0.25×–2×, loop A–B (penanda A/B bisa digeser di progress bar)
- Bisa dipasang di layar HP (Add to Home Screen), dengan kontrol di layar kunci untuk audio Drive
- Audio Drive otomatis disimpan di perangkat: hemat kuota saat diputar ulang dan bisa offline
- Saat Encore jalan di Mac/server: tombol **Breakdown** di setiap lagu

File Google Drive harus dibagikan sebagai **"Siapa saja yang memiliki link"**.

## Breakdown

- Tarik file audio atau tempel link Google Drive. Lagu masuk antrian dan dianalisis satu per satu **di perangkat ini**; tab harus tetap terbuka selama proses
- Pemisahan stem: Demucs `htdemucs` + spesialis bass `htdemucs_ft` + gitar/piano dari `htdemucs_6s`, lewat onnxruntime-web (WebGPU, atau WASM kalau tidak ada GPU)
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
- Library (hasil analisis, stem, MIDI, audio asli) disimpan di browser masing-masing (IndexedDB), jadi tiap pengunjung punya library sendiri
- Lagu yang dianalisis dengan algoritma lama ditandai **versi lama**

**Batasan:**

- Link YouTube tidak bisa dianalisis langsung (browser tidak boleh mengunduh audio YouTube). Upload file audionya atau pakai link Google Drive
- Kunjungan pertama mengunduh model AI ±240 MB, setelah itu tersimpan di cache browser
- Butuh laptop/PC dengan browser terbaru (Chrome, Edge, Safari). Dengan GPU, lagu 4 menit selesai dalam beberapa menit; tanpa GPU (WASM) bisa jauh lebih lama. HP umumnya kekurangan memori

## Jalankan lokal

Klik dua kali `start.command`, atau:

```bash
node dev.mjs
```

Lalu buka http://localhost:8765. `dev.mjs` menyajikan aplikasinya plus fungsi `api/` (Drive & judul) sama seperti di Vercel, dan model AI dari folder `models/`.

## Model AI

Model diekspor ke ONNX dari model aslinya (PyTorch) dengan `tools/export_models.py`. Bobotnya disimpan sebagai fp16 (ukuran setengah, tanpa kehilangan presisi) dan diubah kembali ke fp32 di browser. STFT, iSTFT, pYIN, CQT, onset, dan seluruh logika transkripsi ditulis ulang di JavaScript (`app/analysis/`) dan sudah dicek sama dengan versi Python lamanya.

Membuat ulang folder `models/` (butuh Python, sekali saja):

```bash
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python -r tools/requirements.txt
uv pip install --python .venv/bin/python --no-deps basic-pitch
.venv/bin/python tools/export_models.py models
```

Model terlalu besar untuk paket gratis Vercel (batas 100 MB), jadi untuk versi publik model di-host di **Hugging Face** (gratis, sudah mendukung CORS):

1. Buat akun dan repo model baru di huggingface.co, misalnya `encore-models`
2. Upload isi folder `models/` (bukan file `_test_*`):
   ```bash
   hf upload <user>/encore-models models . --exclude "_test_*"
   ```
3. Isi `MODEL_URL` di `app/config.js` dengan `https://huggingface.co/<user>/encore-models/resolve/main/`

## Deploy ke Vercel

Import repo ini di Vercel, pilih Framework Preset **Other**, lalu Deploy. Yang ter-deploy hanya `index.html`, `app/`, dan `api/` (lihat `.vercelignore`). `api/drive.js` meneruskan audio Drive dan `api/title.js` mengambil judul lagu.

## Struktur

| Path | Isi |
|---|---|
| `index.html`, `app/` | Tampilan: `core.js`, `playlist.js`, `bass.js`, `main.js`, `styles.css` |
| `app/library.js` | Library Breakdown di browser: antrian, IndexedDB, worker analisis |
| `app/analysis/` | Pipeline analisis di browser: Demucs, pYIN, Basic Pitch, beat_this, chord, drum, MIDI |
| `app/config.js` | Alamat model AI |
| `api/` | Fungsi Vercel untuk Drive & judul |
| `dev.mjs` | Server lokal untuk development |
| `tools/export_models.py` | Ekspor model PyTorch ke ONNX |

## Shortcut keyboard

**Playlist:** `Space` play/pause · `N`/`P` next/prev · `S` stop · `R` mode ulang · `←`/`→` 5 detik · `J`/`L` 10 detik · `[`/`]` kecepatan · `A`/`B`/`C` loop A–B

**Breakdown:** `Space` play/pause · `←`/`→` 2 detik · `A`/`B` titik loop · `L` loop on/off · `Esc` hapus loop · `M` multitrack · `V` bagian berikutnya · `T` grafik ↔ tab (bass, gitar) · `1`–`6` mute kanal mixer
