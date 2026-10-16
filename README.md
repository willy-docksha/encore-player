# Encore

Sekali lagi, sampai hafal. Encore punya dua bagian:

- **Playlist**: media player latihan dari link YouTube dan Google Drive. Jalan di mana saja, termasuk Vercel dan HP.
- **Breakdown**: memisahkan instrumen (drum, bass, vokal, lainnya), menampilkan not bass, melodi vokal, dan chord-nya. Butuh server Encore (Mac atau server sendiri) karena memakai AI yang berat.

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

- Tempel link YouTube/Drive atau tarik file audio. Lagu masuk antrian: download berjalan paralel, analisis satu per satu
- Pemisahan stem: Demucs `htdemucs` + spesialis bass `htdemucs_ft` + gitar/piano dari `htdemucs_6s` (GPU Apple). ±5 menit per lagu
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
- Audio asli disimpan di `data/cache/`, jadi analisis ulang tidak perlu download lagi
- Lagu yang dianalisis dengan algoritma lama ditandai **versi lama**

## Jalankan di Mac

Klik dua kali `start.command`, atau:

```bash
./run.sh
```

Lalu buka http://localhost:8765. Saat pertama dijalankan, `run.sh` menyiapkan Python 3.14 dan library-nya (butuh beberapa menit dan ±2 GB). Model AI (~240 MB) diunduh otomatis.

Kebutuhan: [`uv`](https://docs.astral.sh/uv/), `ffmpeg`, dan `node` (untuk download YouTube). Semuanya bisa dipasang lewat Homebrew.

Catatan Python 3.14: `basic-pitch` mewajibkan TensorFlow di macOS, padahal TensorFlow belum tersedia untuk 3.14. Encore hanya memakai model ONNX-nya, jadi `run.sh` memasang `basic-pitch` dengan `--no-deps`.

### YouTube & login

Video publik tidak perlu login. YouTube kadang meminta login kalau curiga ada bot (biasanya setelah banyak download), dan blokir ini hilang sendiri setelah beberapa jam. Opsional, Encore bisa memakai sesi login dari browser:

```bash
DELVE_YT_COOKIES_BROWSER=chrome ./run.sh
```

## Mode lokal vs server

| | Lokal (default) | Server |
|---|---|---|
| Cara jalan | `./run.sh` atau `start.command` | `ENCORE_MODE=server HOST=0.0.0.0 ./run.sh` |
| Link YouTube | ✅ diunduh & dianalisis | ❌ ditolak (hanya upload file & link Google Drive) |
| Hasil yang sudah ada | ✅ | ✅ termasuk lagu YouTube yang dianalisis di Mac |

Mode server dibuat untuk dipakai banyak orang: server tidak pernah mengunduh dari YouTube, sehingga tidak berisiko diblokir dan tidak perlu login YouTube. Lagu dari YouTube bisa dianalisis di Mac, lalu hasilnya (`data/jobs/…`) disalin ke server. Penolakan YouTube dilakukan di backend, bukan cuma di tampilan.

Catatan: mode server belum punya login atau batas pemakaian. Tambahkan dulu sebelum dibuka untuk publik.

## Publish ke server kecil (analisis di Mac)

Server dengan RAM kecil (mis. 1 GB) tidak kuat menjalankan Demucs: satu lagu butuh RAM ±2–3 GB. Jalankan server sebagai **library saja**, lalu analisis lagu di Mac dan kirim hasilnya ke sana.

**Di server**, jalankan Encore tanpa analisis dengan token rahasia. Pemakaian RAM-nya hanya ±100 MB, dan instalasinya tidak memasang model AI:

```bash
ENCORE_MODE=server ENCORE_ANALYSIS=off ENCORE_PUBLISH_TOKEN=token-panjang-acak HOST=0.0.0.0 ./run.sh
```

Di mode ini form tambah lagu, analisis ulang, dan hapus disembunyikan. Pengunjung hanya bisa membuka dan memutar lagu yang sudah di-publish.

**Di Mac**, salin `publish.env.example` menjadi `publish.env`, isi alamat server dan token yang sama, lalu:

```bash
./publish.sh            # kirim semua lagu yang baru atau berubah
./publish.sh "dia raja" # kirim lagu tertentu (id atau sebagian judul)
./publish.sh --list     # lihat lagu mana yang sudah ada di server
./publish.sh --remove 7e1f7bb738   # hapus lagu dari server
```

Yang dikirim hanya hasil analisis (stem mp3, MIDI, `analysis.json`, `meta.json`), bukan audio asli atau cache. Lagu yang dianalisis ulang di Mac akan terkirim lagi otomatis pada `./publish.sh` berikutnya.

## Deploy ke Vercel

Import repo ini di Vercel, pilih Framework Preset **Other**, lalu Deploy. Yang ter-deploy hanya Playlist (`index.html`, `app/`, `api/`). Backend Python di-skip lewat `.vercelignore`, dan bagian Breakdown akan memberi tahu bahwa fitur itu butuh server Encore.
`api/drive.js` meneruskan audio Drive dan `api/title.js` mengambil judul lagu. Di Mac, keduanya dilayani `backend/app.py`.

## Struktur

| Path | Isi |
|---|---|
| `index.html`, `app/` | Tampilan (satu untuk Vercel dan Mac): `core.js`, `playlist.js`, `bass.js`, `main.js`, `styles.css` |
| `api/` | Fungsi Vercel untuk Drive & judul |
| `backend/app.py` | Server Encore: web app, Drive & judul, antrian Breakdown |
| `backend/pipeline.py` | Pipeline audio Breakdown |
| `data/` | Hasil analisis & cache download (tidak masuk git) |

## Shortcut keyboard

**Playlist:** `Space` play/pause · `N`/`P` next/prev · `S` stop · `R` mode ulang · `←`/`→` 5 detik · `J`/`L` 10 detik · `[`/`]` kecepatan · `A`/`B`/`C` loop A–B

**Breakdown:** `Space` play/pause · `←`/`→` 2 detik · `A`/`B` titik loop · `L` loop on/off · `Esc` hapus loop · `M` multitrack · `V` bagian berikutnya · `T` grafik ↔ tab (bass, gitar) · `1`–`6` mute kanal mixer
