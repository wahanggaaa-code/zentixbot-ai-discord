# ZentixBot

Bot Discord untuk satu server, dengan dashboard web di proses yang sama. Ditulis dengan discord.js, Express dan PostgreSQL.

**Status:** pengujian bot ini dilakukan secara lokal dengan Discord tiruan dan PostgreSQL sementara. Di hosting sungguhan baru startup yang terlihat berjalan (13 November 2026, dari log pemilik bot); fitur-fiturnya belum diperiksa di sana. Rinciannya ada di [`docs/progres-proyek.md`](docs/progres-proyek.md) dan [`docs/hosting.md`](docs/hosting.md).

## Fitur

Perintah slash dikelompokkan per kategori di `src/commands/`:

AI · Birthday · Community · Core · Economy · Fun · Giveaway · Join to Create · Leveling · Logging · Moderation · Music · Reaction Roles · Search · Server Stats · Ticket · Tools · Utility · Verification · Welcome

Dashboard web dibuka di `/dashboard/` dan memakai login Discord. Halaman mana yang sudah terhubung ke bot tercantum di [`docs/dashboard.md`](docs/dashboard.md).

## Kebutuhan

- Node.js 20.10 ke atas (regresi penuh dijalankan pada Node 22).
- Database PostgreSQL. Tanpa database, bot berhenti saat startup; SQLite belum dapat dipilih.
- Aplikasi di Discord Developer Portal dengan dua intent khusus dinyalakan: Server Members dan Message Content.

## Menjalankan

```bash
npm ci
cp .env.example .env    # lalu isi nilainya
npm start
```

Saat startup bot membuat tabelnya sendiri pada database kosong dan mendaftarkan perintah slash ke server yang disebut di `GUILD_ID`.

Variabel yang wajib diisi:

| Variabel | Isi |
| --- | --- |
| `DISCORD_TOKEN` | Token bot |
| `CLIENT_ID` | Application ID |
| `GUILD_ID` | ID satu server yang dilayani bot |
| `POSTGRES_URL` | Alamat database PostgreSQL |
| `NODE_ENV` | `production` di hosting |

Variabel lain (dashboard, AI, port, musik) dijelaskan di [`docs/hosting.md`](docs/hosting.md); daftar lengkapnya ada di `.env.example`.

Panel hosting yang menjalankan `index.js` juga didukung: berkas itu hanya memuat `src/app.js`.

## Tes

Tes memakai `node --test` dan PostgreSQL sementara. Di Linux x86_64:

```bash
source scripts/setup-test-postgres.sh
node --test --test-concurrency=1 tests/*.test.js
```

Skrip itu mengunduh PostgreSQL ke folder cache, membuat database kosong di `/tmp`, dan mengatur variabel yang dibaca tes. Jangan arahkan tes ke database yang berisi data sungguhan.

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
