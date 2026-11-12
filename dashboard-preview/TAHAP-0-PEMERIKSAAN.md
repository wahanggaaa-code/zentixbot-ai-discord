# Tahap 0 — Pemeriksaan fondasi ZentixBot

Tanggal: 12 November 2026

## Ruang lingkup

Pemeriksaan statis terhadap paket bot asli `zentixbot.zip`, yang disalin ke workspace. Tidak ada perubahan pada kode bot, database, server Discord, atau repository. Tidak ada push. UI Tahap 1 berada di `dashboard-preview/` dan tidak terhubung ke bot.

## Hasil yang terverifikasi

1. Bot menggunakan Node.js ES module, discord.js v14, Express 5, PostgreSQL/`pg`, `node-cron`, dan Riffy/Lavalink untuk musik. `package.json` menyatakan Node >=20.10.0, sedangkan Dockerfile menggunakan Node 20.
2. Ditemukan 19 direktori kategori dan 99 file perintah di luar `modules` (jumlah file bukan jaminan jumlah slash command yang berhasil dimuat).
3. Dengan Node v20.20.2, `node --check` berhasil pada seluruh 271 file JavaScript dalam `src` dan `scripts`. Ini hanya pemeriksaan sintaks, bukan pengujian perilaku.
4. Aplikasi menyediakan server Express untuk `/`, `/health`, dan `/ready`; ini bukan dashboard terintegrasi. `/ready` memeriksa kondisi bot dan database.
5. Data utama memakai PostgreSQL. Jika koneksi gagal, wrapper dapat beralih ke memori sementara; data pada mode itu hilang saat proses restart. Proyek menyediakan skrip migrasi dan backup/restore.
6. Welcome menyimpan konfigurasi tersendiri, terpisah dari guild config. Jangan menulis setting welcome hanya ke guild config: event anggota masuk membaca `getWelcomeConfig`.
7. Package rilis yang diperiksa tidak menyertakan test suite atau script `npm test`. Sintaks diperiksa, tetapi belum ada pengujian menyeluruh Discord, database, dashboard, musik, atau AI.
8. Tidak ditemukan dependensi atau integrasi provider LLM yang jelas dalam paket bot asli; fitur AI, termasuk fallback, perlu dibangun dan diuji.

## Risiko dan pekerjaan sebelum integrasi

### Prioritas 1 — batas satu server

`GUILD_ID` tersedia, tetapi konfigurasi menyebutkannya bukan sebagai batas runtime; slash command didaftarkan secara global. Event dan job terjadwal, termasuk birthday dan counter, dapat berjalan untuk guild yang ada di cache. Implementasi satu-server harus memvalidasi `GUILD_ID`, membatasi event, command, komponen, jobs, dan akses dashboard, serta merancang konteks DM dengan aman. Jangan otomatis mengeluarkan bot dari guild lain tanpa persetujuan pengguna.

### Prioritas 2 — keamanan dashboard

Server Express asli tidak memiliki login dashboard. Default CORS berasal dari konfigurasi dan dapat `*`. Sebelum memberi akses nyata: implementasi Discord OAuth2, state anti-CSRF, cookie dan sesi aman, pembatasan origin, pemeriksaan izin Discord per aksi dan pembatasan khusus owner untuk provider AI serta statistik hosting. Jangan gunakan preview atau prototipe sebelumnya sebagai produksi tanpa audit dan uji menyeluruh.

### Prioritas 3 — data dan risiko tertimpa

Rencanakan migrasi/backup sebelum perubahan skema dan penyimpanan AI. Pembacaan dan penulisan konfigurasi harus menangani kegagalan database secara eksplisit dan menghindari hilangnya perubahan akibat pembaruan bersamaan. Jangan tampilkan data sementara sebagai tersimpan permanen.

### Prioritas 4 — AI dan privasi

Rancang adapter provider utama dan fallback yang memeriksa kemampuan model (teks/gambar/audio), batas penggunaan, serta handling timeout/rate limit. AI Welcome/Goodbye membutuhkan fallback template. Memori anggota opt-in; DM tidak ditampilkan ke admin, tetapi bot/penyedia AI dapat memproses data. Lakukan konfirmasi eksplisit untuk AI Server Builder dan tindakan Discord. Simpan kredensial hanya di server; jangan masukkan ke source control atau chat.

### Prioritas 5 — Wispbyte & fitur Discord

Pastikan sumber angka CPU/RAM/jaringan/disk dan izin yang tersedia pada hosting nyata sebelum memilih pendekatan; tidak menganggap endpoint API tertentu tersedia. Periksa intent Discord yang diperlukan, izin channel, hierarki role, serta akses Lavalink. Review alur welcome, verification, autorole, dan transcript sebelum menyambungkan UI.

## Belum diverifikasi

- Menjalankan bot dengan token Discord dan interaksi terhadap server nyata.
- PostgreSQL, migrasi, backup/restore, dan penanganan konflik pada database nyata.
- OAuth Discord, akses Wispbyte, Lavalink, provider AI, dan deployment.
- Browser sungguhan dan aksesibilitas menyeluruh untuk UI preview.

## Urutan selanjutnya

1. Tinjau/revisi UI Tahap 1 bersama pengguna.
2. Buat overview Tahap 2 dengan data contoh.
3. Rancang halaman fitur dan AI sesuai briefing.
4. Sebelum koneksi data nyata: uji dan terapkan pembatasan satu server, autentikasi, otorisasi, dan kesiapan database.
5. Integrasikan fitur bot dan AI secara bertahap, dengan tes per fitur.
