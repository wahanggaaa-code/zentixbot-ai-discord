# Hosting di panel (Wispbyte dan sejenisnya)

Tanggal: 2026-11-13. Dokumen ini menjelaskan variabel lingkungan yang dibutuhkan bot, cara bot memilih port, dan cara membuka dashboard pada alamat `http://ip:port`.

**Bot ini belum pernah dijalankan di Wispbyte atau panel hosting mana pun.** Yang diuji hanyalah kode di bawah ini, dengan Discord tiruan dan PostgreSQL lokal. Keterangan tentang panel Wispbyte (image Node, tempat mengisi variabel, RAM 512 MB, alamat `http://ip:port`) diambil dari panduan hosting proyek referensi `whyuangga/Zypher-AI-Bot-Discord` dan tidak diperiksa sendiri.

## Yang dibutuhkan bot

- Node.js 20.10 ke atas. Regresi penuh dijalankan pada Node 22, jadi pilih image Node 22 bila tersedia.
- Berkas utama `index.js` (atau perintah `npm start`).
- Database PostgreSQL dari luar panel. Tanpa database bot berhenti saat startup; SQLite belum dapat dipilih.
- Dua intent khusus dinyalakan di Discord Developer Portal: Server Members dan Message Content.
- Disk sekitar 175 MB setelah `npm ci`.

## Variabel lingkungan

Wajib:

| Variabel | Isi |
| --- | --- |
| `DISCORD_TOKEN` | Token bot |
| `CLIENT_ID` | Application ID |
| `GUILD_ID` | ID satu server yang dilayani bot |
| `NODE_ENV` | `production` |
| `POSTGRES_URL` | Alamat database, misalnya `postgresql://user:password@host/namadb?sslmode=require` |

Disarankan:

| Variabel | Isi |
| --- | --- |
| `OWNER_IDS` | ID Discord pemilik bot. Halaman AI dan statistik hosting di dashboard hanya untuk ID ini |
| `NODE_OPTIONS` | `--max-old-space-size=384` pada container 512 MB. Saran panduan referensi; diisi di panel, bukan di berkas `.env`. Pemakaian memori bot ini belum pernah diukur |
| `AI_GROQ_API_KEY`, `AI_GEMINI_API_KEY`, `AI_OPENROUTER_API_KEY`, `AI_NVIDIA_API_KEY` | Minimal satu bila fitur AI dipakai |

Untuk dashboard:

| Variabel | Isi |
| --- | --- |
| `DISCORD_CLIENT_SECRET` | Client Secret dari halaman OAuth2 di Developer Portal |
| `DASHBOARD_URL` | Alamat dashboard, tanpa path: `https://bot.example.com` atau `http://203.0.113.5:16954` |
| `DASHBOARD_ALLOW_HTTP` | `true` hanya bila alamatnya `http://` publik. Lihat bagian "Dashboard lewat HTTP" |

Musik tidak memerlukan variabel: bot memakai enam node Lavalink publik yang tercantum di `lavalink/nodes.json` (vinster, trinium, nazha, serenetia, jirayu, millohost), diambil dari daftar di `lavalink.darrennathanael.com`. Node itu milik pihak ketiga dan belum diuji dari bot ini; untuk menggantinya, ubah berkas itu atau isi `LAVALINK_NODES`. Nama `LAVALINK_URI` dan `LAVALINK_NODE_NAME` tidak dibaca bot.

Opsional: `AI_IMAGE_API_KEY` + `AI_IMAGE_MODEL`, `AI_AUDIO_API_KEY` + `AI_AUDIO_MODEL`, `AI_BRAVE_SEARCH_KEY`, `HOSTING_PANEL_URL` + `HOSTING_SERVER_ID` + `HOSTING_API_KEY`, `TMDB_API_KEY`, `LOG_LEVEL`, `SENTRY_DSN`. Daftar lengkap ada di `.env.example`.

## Port

Bot memakai nilai pertama yang sah dari `WEB_PORT`, `PORT`, `SERVER_PORT`, dalam urutan itu. Bila tidak ada yang diisi, port 3000.

- `SERVER_PORT` adalah nama yang diisi sendiri oleh panel bergaya Pterodactyl. Bila panel mengisinya, port tidak perlu diatur manual.
- Kosong dan `0` berarti "belum diisi". Nilai lain yang bukan angka port 1–65535 dilewati, dan nama variabelnya ditulis di log.
- Log startup menyebut dari mana port diambil, misalnya `Web port 16954 taken from SERVER_PORT`.
- `.env.example` berisi `PORT=3000`. Bila berkas itu disalin apa adanya, `PORT` menang atas `SERVER_PORT`. Hapus baris `PORT` atau isi dengan port dari panel.

## Dashboard lewat HTTP

Bawaan: login dashboard hanya aktif pada alamat `https://` (atau `http://localhost` saat pengembangan). Dengan `DASHBOARD_URL=http://ip:port` saja, halaman login menjawab 503 dan menjelaskan sebabnya.

Untuk panel yang hanya memberi alamat `http://ip:port`:

1. Isi `DASHBOARD_URL=http://IP:PORT` persis seperti alamat server di panel, tanpa garis miring atau path di belakangnya.
2. Isi `DASHBOARD_ALLOW_HTTP=true`.
3. Di Discord Developer Portal → OAuth2 → Redirects, tambahkan `http://IP:PORT/dashboard/callback`.
4. Mulai ulang bot, lalu buka `http://IP:PORT/dashboard/`.

Langkah 3 belum diuji terhadap Discord sungguhan; bahwa Discord menerima alamat pengalihan `http://` dengan IP adalah anggapan, bukan hasil uji.

**Risikonya.** Lewat HTTP, sesi login berjalan tanpa enkripsi. Pihak di jaringan yang sama (Wi-Fi umum, jaringan kantor) atau di antara peramban dan server dapat membaca cookie sesi dan memakai dashboard dengan hak Anda sampai sesi berakhir. Proyek referensi punya kelemahan yang sama dengan kata sandi dashboard-nya.

Yang tetap berlaku pada mode ini:

- Login tetap lewat Discord; tidak ada kata sandi bersama.
- Hanya owner server dan pemegang izin Administrator yang dapat masuk, dan izin itu diperiksa ulang ke Discord pada setiap permintaan.
- Sesi paling lama 8 jam dan hilang saat bot dimulai ulang.
- Setiap perubahan tetap memerlukan token sesi dan harus datang dari alamat dashboard yang sama.

Yang ditambahkan agar mode ini tidak aktif tanpa disadari:

- Bot menulis peringatan di log saat startup.
- Halaman Pengaturan menampilkan catatan "Tanpa enkripsi" pada bagian akses.

Saran pemakaian: buka dashboard dari jaringan yang dipercaya, tekan KELUAR setelah selesai, dan pindah ke alamat `https://` bila hosting menyediakannya. Setelah pindah, kosongkan `DASHBOARD_ALLOW_HTTP`.

## Langkah di panel (dari panduan referensi, belum diperiksa)

1. Buat server dengan egg Node.js, image Node 22.
2. Arahkan ke repositori ini, branch `main`, berkas JS `index.js`.
3. Isi variabel di tab Startup → Environment, bukan dengan mengunggah berkas `.env`.
4. Mulai server dan baca log: port yang dipakai, status database, lalu login bot.

## Berkas

- `src/utils/webPort.js` (baru): aturan port. Dipakai `src/app.js` dan `src/config/application.js`.
- `src/dashboard/origin.js` (baru): aturan alamat dashboard dan pesan saat login belum dapat dipakai. Dipakai `src/dashboard/router.js` dan `src/dashboard/settingsApi.js`.
- `dashboard-preview/settings-live.js`: catatan "Tanpa enkripsi".
- `.env.example`: `DASHBOARD_ALLOW_HTTP`, `WEB_PORT`, keterangan `SERVER_PORT`.
- `tests/hosting-port-http.test.js` (baru) dan tambahan di `tests/dashboard-settings-control-center.test.js`.

## Yang belum diuji

- Bot di Wispbyte atau panel lain: instalasi, port yang diteruskan, batas RAM, perilaku saat restart.
- Login Discord sungguhan pada alamat `http://ip:port`.
- Koneksi dari panel ke penyedia PostgreSQL.
- Dashboard di peramban sungguhan; tesnya memakai jsdom.
