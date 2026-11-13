# Dokumentasi ZentixBot

Semua dokumen proyek ada di folder ini. Setiap dokumen memisahkan apa yang terbukti lewat tes dari apa yang baru dibaca di kode, dan menutup dengan daftar hal yang belum diuji.

## Mulai dari sini

| Dokumen | Isi |
| --- | --- |
| [`progres-proyek.md`](progres-proyek.md) | Status tiap bagian bot dan dashboard, hasil tes terakhir, dan daftar pekerjaan berikutnya |
| [`hosting.md`](hosting.md) | Variabel lingkungan, aturan port, dashboard lewat `http://ip:port`, node musik, dan pilihan penyedia untuk suara, pencarian web dan gambar |

## Database

| Dokumen | Isi |
| --- | --- |
| [`postgresql.md`](postgresql.md) | Kesiapan PostgreSQL: perilaku startup, TLS, `/health` dan `/ready`, backup dan restore |
| [`migrasi-sqlite.md`](migrasi-sqlite.md) | Fondasi SQLite yang masih eksperimental; SQLite belum dapat dipilih saat startup |
| [`giveaway-pg.md`](giveaway-pg.md) | Perpindahan bertahap Giveaway ke transaksi PostgreSQL |
| [`join-to-create-pg.md`](join-to-create-pg.md) | Protokol penulisan Join to Create di PostgreSQL |

## Dashboard

| Dokumen | Isi |
| --- | --- |
| [`dashboard.md`](dashboard.md) | Inventaris halaman dashboard: mana yang terhubung ke bot dan mana yang masih simulasi |
| [`core-dashboard.md`](core-dashboard.md) | Mengaktifkan dan menonaktifkan perintah atau kategori dari dashboard |

Catatan tentang folder antarmukanya sendiri ada di [`dashboard-preview/README.md`](../dashboard-preview/README.md).

## Fitur AI

| Dokumen | Isi |
| --- | --- |
| [`tahap-8.md`](tahap-8.md) | Chat AI, pengetahuan server, tools teks, pencarian, gambar, Server Builder, beserta batas masing-masing |

## Audit per kategori

Satu dokumen per kategori perintah: izin, penyimpanan, efek di Discord, masalah yang diperbaiki, dan tesnya.

| Dokumen | Kategori |
| --- | --- |
| [`audit/community.md`](audit/community.md) | Community (lamaran role) |
| [`audit/ekonomi.md`](audit/ekonomi.md) | Ekonomi (wallet, bank, toko, role premium) |
| [`audit/fun.md`](audit/fun.md) | Fun (permainan hitung, dadu, duel, koin) |
| [`audit/reaction-roles.md`](audit/reaction-roles.md) | Reaction Roles (panel pilih role sendiri) |
| [`audit/reward-role.md`](audit/reward-role.md) | Reward role (role hadiah leveling) |
| [`audit/search.md`](audit/search.md) | Search (kamus, Urban Dictionary, tautan Google) |
| [`audit/server-stats.md`](audit/server-stats.md) | Server Stats (counter jumlah anggota) |
| [`audit/tiket.md`](audit/tiket.md) | Tiket |
| [`audit/tools.md`](audit/tools.md) | Tools (kalkulator, hitung mundur, poll, embed builder, dan alat kecil lain) |
| [`audit/utility.md`](audit/utility.md) | Utility (to-do, laporan, cuaca, info server dan pengguna) |

## Arsip

| Dokumen | Isi |
| --- | --- |
| [`arsip/tahap-0-pemeriksaan.md`](arsip/tahap-0-pemeriksaan.md) | Pemeriksaan awal paket bot pada 12 November 2026, sebelum pekerjaan integrasi dimulai. Disimpan sebagai catatan; sebagian isinya sudah tidak berlaku (misalnya fallback database ke memori sudah dihapus) |

## Nama lama

Sampai 13 November 2026 dokumen ini berada di akar repository dengan nama `DOKUMENTASI-<JUDUL>.md`. Nama barunya adalah judul yang sama dengan huruf kecil, tanpa awalan itu; dokumen audit masuk ke `audit/`. Contoh: `DOKUMENTASI-HOSTING.md` menjadi `docs/hosting.md`, dan `DOKUMENTASI-AUDIT-TOOLS.md` menjadi `docs/audit/tools.md`. Catatan arsip sebelumnya bernama `dashboard-preview/TAHAP-0-PEMERIKSAAN.md`.
