# Encore Player

Sekali lagi, sampai hafal. Media player untuk latihan lagu dari link YouTube dan Google Drive.

- Playlist dari daftar link (YouTube & Google Drive bisa dicampur), auto next
- Prev / Play / Pause / Stop / Next, lompat ±5s dan ±10s
- Ulang: tanpa ulang, ulang 1 lagu, ulang semua · acak
- Kecepatan 0.25×–2×, loop A–B
- Bisa dipasang di layar HP (Add to Home Screen), kontrol di layar kunci untuk audio Drive

File Google Drive harus dibagikan sebagai **"Siapa saja yang memiliki link"**.

## Jalankan di Mac

Klik dua kali `start.command`, atau:

```bash
python3 server.py
```

Lalu buka http://localhost:8765.

## Deploy ke Vercel

Import repo ini di Vercel, pilih Framework Preset **Other**, lalu Deploy.
`api/drive.js` meneruskan audio Drive dan `api/title.js` mengambil judul lagu.

## Shortcut keyboard

`Space` play/pause · `N`/`P` next/prev · `S` stop · `R` mode ulang ·
`←`/`→` 5 detik · `J`/`L` 10 detik · `[`/`]` kecepatan · `A`/`B`/`C` loop A–B
