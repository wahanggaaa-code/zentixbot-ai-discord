# ZentixBot

Bot Discord untuk satu server, dengan dashboard web di proses yang sama. Ditulis dengan discord.js dan Express. Data disimpan di SQLite (berkas yang dibuat bot sendiri, tanpa pemasangan apa pun) atau di PostgreSQL.

**Status:** pengujian bot ini dilakukan secara lokal dengan Discord tiruan dan PostgreSQL sementara. Di hosting sungguhan baru startup yang terlihat berjalan (13 November 2026, dari log pemilik bot); fitur-fiturnya belum diperiksa di sana. Rinciannya ada di [`docs/progres-proyek.md`](docs/progres-proyek.md) dan [`docs/hosting.md`](docs/hosting.md).

## Fitur

Perintah slash dikelompokkan per kategori di `src/commands/`:

AI · Birthday · Community · Core · Economy · Fun · Giveaway · Join to Create · Leveling · Logging · Moderation · Music · Reaction Roles · Search · Server Stats · Ticket · Tools · Utility · Verification · Welcome

Dashboard web dibuka di `/dashboard/`. Login termudah memakai `DASHBOARD_TOKEN` dan `OWNER_IDS` (lihat [`docs/hosting.md`](docs/hosting.md)); login lewat Discord juga tersedia. Halaman mana yang sudah terhubung ke bot tercantum di [`docs/dashboard.md`](docs/dashboard.md).

## Kebutuhan

- Node.js 22.13 ke atas bila memakai SQLite (pilihan bawaan). Dengan PostgreSQL, Node.js 20.10 ke atas. Regresi penuh dijalankan pada Node 22.
- Database: tidak perlu disiapkan. Tanpa pengaturan database, bot membuat berkas SQLite `data/zentix.db` di folder bot. PostgreSQL bersifat pilihan; lihat "Database" di bawah.
- Aplikasi di Discord Developer Portal dengan dua intent khusus dinyalakan: Server Members dan Message Content.

## Menjalankan

```bash
npm ci
cp .env.example .env    # lalu isi nilainya
npm start
```

Saat startup bot membuat berkas database dan tabelnya sendiri, lalu mendaftarkan perintah slash ke server yang disebut di `GUILD_ID`.

Variabel yang wajib diisi:

| Variabel | Isi |
| --- | --- |
| `DISCORD_TOKEN` | Token bot |
| `CLIENT_ID` | Application ID |
| `GUILD_ID` | ID satu server yang dilayani bot |
| `NODE_ENV` | `production` di hosting |

Variabel lain (dashboard, AI, port, musik) dijelaskan di [`docs/hosting.md`](docs/hosting.md); daftar lengkapnya ada di `.env.example`.

Panel hosting yang menjalankan `index.js` juga didukung: berkas itu hanya memuat `src/app.js`.

## Database

Bot memilih database dari isi `.env`, sekali saat startup:

| Isi `.env` | Database yang dipakai |
| --- | --- |
| Tidak ada pengaturan database | SQLite di `data/zentix.db` (folder dan berkasnya dibuat otomatis) |
| `DATABASE_PATH=/lokasi/zentix.db` | SQLite di lokasi itu |
| `POSTGRES_URL=...` (atau `POSTGRES_HOST` dan kawan-kawannya) | PostgreSQL |

Baris pertama log startup menyebut database yang dipakai, misalnya `Database: SQLite, data is kept in the file /home/container/data/zentix.db`.

Yang perlu diketahui:

- **Seluruh data bot ada di folder `data/`.** Cadangkan folder itu (hentikan bot dulu, lalu salin seluruh isinya, termasuk berkas `-wal` dan `-shm` bila ada). Bila folder itu hilang atau hosting tidak menyimpannya saat restart, data ikut hilang.
- Bot tidak pernah berpindah database sendiri. Bila PostgreSQL sudah diatur tetapi tidak dapat dihubungi, bot berhenti dengan pesan galat; ia tidak diam-diam memakai SQLite atau memori.
- Data tidak disalin antara SQLite dan PostgreSQL. Pindah database berarti mulai dari data kosong.
- Bila pengaturan menunjuk ke dua database sekaligus (misalnya `DATABASE_PATH` dan `POSTGRES_URL`), bot berhenti dan meminta `DATABASE_ENGINE=sqlite` atau `DATABASE_ENGINE=postgresql`.
- Satu berkas SQLite untuk satu proses bot. Untuk server yang sangat ramai atau beberapa proses, pakai PostgreSQL.
- Node 22 mencetak `ExperimentalWarning: SQLite is an experimental feature` saat startup. Itu peringatan dari Node.js, bukan galat bot.

Perbedaan perilaku antara dua database itu dicatat di [`docs/migrasi-sqlite.md`](docs/migrasi-sqlite.md).

## Tes

Tes memakai `node --test`. Tes SQLite berjalan tanpa persiapan; tes PostgreSQL memerlukan PostgreSQL sementara dan dilewati bila itu tidak ada. Di Linux x86_64:

```bash
source scripts/setup-test-postgres.sh
node --test --test-concurrency=1 tests/*.test.js
```

Skrip itu mengunduh PostgreSQL ke folder cache, membuat database kosong di `/tmp`, dan mengatur variabel yang dibaca tes. Jangan arahkan tes ke database yang berisi data sungguhan.

Suite fitur yang ditulis untuk PostgreSQL dijalankan sekali lagi pada SQLite oleh `tests/sqlite-feature-suites.test.js`. Untuk menjalankan satu suite pada SQLite secara langsung:

```bash
ZENTIX_TEST_BACKEND=sqlite node --test tests/postgres-ticket-service.test.js
```

## Susunan folder

| Folder | Isi |
| --- | --- |
| `src/` | Kode bot: perintah, event, layanan, dashboard API |
| `dashboard-preview/` | Antarmuka dashboard (HTML, CSS dan JavaScript tanpa proses build) |
| `tests/` | Tes otomatis |
| `scripts/` | Migrasi, backup, restore, dan penyiapan database tes |
| `lavalink/` | Daftar node musik dan konfigurasi Lavalink mandiri |
| `docs/` | Dokumentasi; mulai dari [`docs/README.md`](docs/README.md) |

## Lisensi

MIT. Lihat [`LICENSE`](LICENSE).
