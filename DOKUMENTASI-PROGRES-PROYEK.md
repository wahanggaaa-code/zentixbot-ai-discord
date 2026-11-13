# Progres proyek ZentixBot dan dashboard

- **Tanggal inventaris:** 12 November 2026 (WIB)
- **Repositori kerja:** `zentixbot-bot-only`
- **Basis kode yang ditinjau:** commit `98b2bee`
- **Tujuan:** mengintegrasikan fitur bot ke dashboard web secara bertahap, dengan penyimpanan dan operasi Discord yang aman untuk jalur yang digunakan.

> **Kesimpulan singkat:** dashboard sudah mempunyai banyak jalur terhubung ke bot, tetapi integrasi seluruh fitur **belum selesai** dan proyek **belum dinyatakan siap produksi**. Join to Create sudah memiliki inventaris baca-saja; transaksi dan alur create yang baru masih prototipe terisolasi. PostgreSQL adalah backend runtime saat ini. SQLite masih eksperimental dan belum bisa digunakan sebagai backend runtime.

## 1. Cara membaca status

- **Terhubung sebagian:** kode dashboard memiliki jalur ke bot/API untuk fungsi yang disebutkan. Ini tidak berarti semua fungsi kategori sudah selesai atau layanan eksternal sudah diuji langsung.
- **Baca-saja:** halaman dapat membaca data, tetapi tidak menyediakan perubahan data untuk area tersebut.
- **Prototipe:** kode dan tes tersedia untuk pengembangan, tetapi belum digunakan oleh runtime bot atau alur dashboard yang aktif.
- **Belum:** fitur/operasi belum dibuat, belum diaudit, atau sengaja dinonaktifkan karena belum aman.

Preview statis `dashboard-preview/` yang dibuka sendiri adalah **simulasi**. Akses yang terhubung membutuhkan dashboard yang disajikan bot melalui `/dashboard/`, login Discord, izin dan layanan yang relevan. Pengujian sejauh ini memakai database lokal, Discord/provider tiruan dan jsdom; itu bukan bukti deployment nyata berhasil.

## 2. Ringkasan pekerjaan yang sudah dilakukan

- Struktur dashboard web, login Discord dan API untuk berbagai fitur telah dikembangkan. Akses dashboard memakai pemeriksaan owner/admin server; beberapa area AI atau operasi sensitif memiliki pembatasan tambahan untuk bot owner. Jalur perubahan yang relevan memakai Origin dan CSRF.
- Jalur PostgreSQL diperkuat: pemeriksaan startup, versi dan kelengkapan skema, audit key legacy yang dikenal, TLS dengan verifikasi, serta `/health` dan `/ready` dengan fungsi yang berbeda.
- Penguncian/transaksi dan pemeriksaan konflik telah ditambahkan pada jalur tertentu untuk konfigurasi guild/welcome, verification, Birthday, warning, tiket, ekonomi dan Giveaway. Jaminan hanya berlaku bagi jalur yang benar-benar mengikuti protokol dan diuji.
- Backup PostgreSQL dan latihan restore ke target uji terpisah tersedia. **Restore produksi masih dinonaktifkan.**
- Dashboard Giveaway sudah memiliki daftar dan aksi akhiri/undi ulang dengan pengaman; Join to Create sudah memiliki inventaris baca-saja dan pemeriksaan Discord untuk ID pending yang tercatat.
- Fondasi SQLite, sejumlah adapter dan importer terbatas telah dibuat untuk eksperimen, tetapi belum merupakan migrasi atau backend produksi.
- Workspace telah dirapikan dan sembilan arsip ZIP yang ditemukan telah dihapus sesuai permintaan. Kode proyek, gambar unggahan, direktori referensi dan hasil pengujian akhir dipertahankan. Penghapusan ZIP tidak membuktikan bahwa seluruh backup atau salinan lain telah dihapus.

## 3. Status dashboard per fitur

| Fitur | Sudah dikerjakan | Belum / batas penting |
|---|---|---|
| **Overview & hosting** | Status bot dan informasi resource hosting bila dikonfigurasi. | Koneksi dan resource hosting nyata belum diverifikasi; data yang tidak tersedia bukan bukti host mati. |
| **Welcome & verification** | Pengaturan Welcome, Goodbye non-AI, verification dan pengiriman panel verification memiliki jalur dashboard. Pengamanan konflik dan stale edit diterapkan pada jalur PostgreSQL yang diuji. | Discord dan event nyata belum diuji; efek Discord dan database tidak atomik. Beberapa event lama masih dapat kembali ke default saat pembacaan database gagal. |
| **Moderation** | Tampilan kasus dan tindakan dashboard; operasi warning PostgreSQL memakai protokol transaksi/lock pada jalur yang diuji. | Audit permission/hierarki dan hasil Discord nyata masih diperlukan. `/wipedata` dan tombol lama dinonaktifkan untuk semua backend; belum ada penghapusan data menyeluruh yang terverifikasi. |
| **Ticket** | Pengaturan/panel, daftar, detail, tindakan dan transcript terbatas; counter PostgreSQL atomik pada jalur yang diuji. | Batas tiket per pengguna masih dapat balapan dengan pembuatan Discord; aksi Discord/DB tidak atomik, transcript bergantung channel dan izin. |
| **Leveling & economy** | Pengaturan leveling, leaderboard, pencarian anggota dan sebagian pengelolaan saldo. Sejumlah perintah ekonomi PostgreSQL sudah memakai transaksi. | Reward role tidak tersinkron otomatis; pembelian role premium dan penulis ekonomi lain masih perlu audit. Poin Activities belum disambungkan ke wallet. |
| **Music** | Player, antrean, pencarian dan kontrol yang didukung memiliki jalur dashboard. | Memerlukan Lavalink dan Discord; operasi nyata dan resource hosting belum diuji. Sebagian state musik berada di memori proses. |
| **Logging** | Pengaturan dan riwayat terbatas dari channel audit. | Bukan riwayat seluruh event; bergantung pada channel, izin dan pesan Discord yang tersedia. |
| **Birthday** | Pengaturan channel, melihat daftar serta mengubah/menghapus entri yang sudah ada pada PostgreSQL. Jalur transaksi per anggota telah diuji lokal. | Penambahan entri baru via web dan audit khusus perubahan belum ada. Scheduler/Discord belum diuji live; penanganan 29 Februari pada web dan command lama belum seragam. |
| **Core & command access** | Melihat, memfilter dan mengaktifkan/menonaktifkan akses perintah atau kategori pada PostgreSQL, dengan konfirmasi dan pemeriksaan stale. | Mengelola akses perintah, bukan seluruh konfigurasi fitur atau hak Discord. Penulis lama/SQL langsung tidak dijamin mengikuti lock. |
| **Giveaway** | Inventaris PostgreSQL, aksi web akhiri/undi ulang, dan jalur runtime PostgreSQL tertentu memakai transaksi per giveaway dan status pengiriman. | Web belum bisa create/delete; `/gdelete` PostgreSQL diblokir. Hasil `pending`, create yang tidak pasti dan hasil lama tanpa `delivered` memerlukan pemeriksaan manual. |
| **Join to Create** | Inventaris PostgreSQL baca-saja, peringatan data pending, dan tombol pemeriksaan Discord terbatas untuk ID pending yang telah tercatat. | Pengeditan, create/delete, transfer dan rekonsiliasi via web **belum tersedia**. Prototipe penulis/reservasi belum dipakai bot; kondisi Discord dapat berubah setelah pemeriksaan. |
| **AI Studio** | Fondasi provider dan jalur parsial untuk AI Welcome/Goodbye, Activities, chat/agent, pengetahuan, tools, gambar dan Server Builder. | Memerlukan pengaturan provider, kuota, biaya, izin, privasi dan konfirmasi sesuai fitur. Provider/model dan Discord nyata belum diuji; beberapa fungsi tetap terbatas. |
| **Pengaturan utama** | Struktur halaman dan beberapa pengaturan tersedia di area fitur masing-masing. | Halaman utama pengaturan masih placeholder, bukan panel umum yang lengkap. |
| **Kategori lain** | Kategori bot sudah terdaftar dalam kode/struktur. | Community, Fun, Reaction Roles, Search, Server Stats, Tools dan Utility belum memiliki integrasi dashboard terpadu untuk masing-masing kategori. |

Rincian batas tiap area ada di `DOKUMENTASI-DASHBOARD.md`, `DOKUMENTASI-CORE-DASHBOARD.md` dan `DOKUMENTASI-TAHAP-8.md`.

## 4. Fokus saat ini: Join to Create

### Sudah

- Inventaris owner/admin membaca konfigurasi PostgreSQL dan daftar channel sementara yang tersimpan. ID pemilik dan token pending tidak dikirim ke browser; respons memakai `no-store`.
- Data hilang, kedaluwarsa, terlalu besar, rusak atau konflik key ditangani secara berbeda; data tersimpan **bukan bukti** channel masih ada di Discord.
- Jika metadata pending prototipe memuat ID channel, dashboard dapat meminta pemeriksaan baca-saja ke Discord. ID dari browser hanya pembanding terhadap ID yang tersimpan; tidak dapat dipakai sebagai lookup channel sembarang.
- Telah dibuat prototipe transaksi, reservasi sebelum create, pencatatan ID hasil adapter dan acknowledgement. Ada tes race, rollback, batas ukuran, timeout, serta simulasi respons commit yang hilang.
- Tidak ada retry, penghapusan, pembatalan atau rekonsiliasi otomatis pada prototipe ketika hasil tidak pasti.

### Belum dan risiko yang masih ada

- **Prototipe penulis belum terhubung** ke command, event maupun operasi dashboard. Implementasi bot yang aktif masih memiliki beberapa penulis read-modify-write seluruh objek tanpa lock bersama dan dapat saling menimpa.
- Semua penulis command, collector, event dan akses key generik harus dipindahkan/diamankan bersama, disertai audit data legacy, TTL, backup, cutover dan pengujian konkurensi.
- Alur create, pemindahan anggota, delete dan transfer harus menangani kegagalan serta hasil tidak pasti antara Discord dan PostgreSQL. Belum ada workflow pemulihan pending yang aman dan teruji.
- Cleanup event saat fitur nonaktif/tanpa trigger masih dapat terlewat. Kategori yang tersimpan saat ini tidak dipakai saat membuat channel; bot memakai parent trigger.
- Pemeriksaan Discord hanya snapshot respons untuk ID tersebut: **bukan bukti** asal channel, pemilik, izin, atau bahwa channel masih ada sesudahnya. Timeout/gagal bukan bukti channel tidak ada. Perbandingan isi tidak mendeteksi A→B→A.
- Jangan gunakan prototipe untuk mengubah data produksi atau mengaktifkan tombol edit sebelum cutover selesai. Lihat `DOKUMENTASI-JOIN-TO-CREATE-PG.md`.

## 5. Penyimpanan, keamanan dan operasional

### PostgreSQL — backend runtime saat ini

**Sudah:** startup gagal tertutup bila PostgreSQL tidak tersedia atau pemeriksaan skema/key tertentu gagal; tidak fallback diam-diam ke RAM. TLS runtime memverifikasi sertifikat dan hostname. `/health` menunjukkan liveness proses; `/ready` memeriksa kesiapan Discord dan query PostgreSQL pada saat itu. Backup `pg_dump` dan restore drill ke database uji terpisah telah diuji lokal.

**Belum:** semua jalur runtime belum sepenuhnya diaudit. Sebagian kode lama dapat menangkap error atau memakai default, dan `/ready` bukan jaminan operasi berikutnya aman. Pemeriksaan skema/key legacy tidak mencakup semua kemungkinan. Backup offsite, retensi, enkripsi dan restore produksi belum diselesaikan atau diuji di hosting pengguna. `pg_restore --list` bukan bukti recovery yang berhasil.

### SQLite — eksperimen, bukan backend runtime

**Sudah:** fondasi storage, transaksi, beberapa adapter, skema internal dan snapshot/importer terbatas beserta tes lokal. Eksperimen SQLite memerlukan Node 22.16+; tes dicatat menggunakan Node 22.23.5.

**Belum:** memilih SQLite saat startup ditolak dengan `SQLITE_INCOMPLETE`. Migrasi lengkap PostgreSQL→SQLite, seluruh jalur bot/dashboard, penanganan TTL dan WAL, backup/restore operasional, rekonsiliasi data legacy serta pengujian hosting belum selesai. Importer terbatas bukan alat cutover produksi. Lihat `DOKUMENTASI-MIGRASI-SQLITE.md`.

### Aturan operasional penting

1. Sebelum upgrade jalur yang memakai transaksi baru: hentikan instance lama dan penulis lain, backup, audit data/key legacy dan uji restore di target uji terpisah. Penulis SQL langsung, skrip luar, migrasi/restore dan bot lama dapat melewati lock aplikasi.
2. Discord dan database bukan satu transaksi. Jika pengiriman, pembuatan atau commit gagal/tidak diketahui, periksa keduanya sebelum mengulangi; jangan anggap rollback atau retry otomatis aman.
3. Jangan membagikan token bot, URL database, file `.env`, API key, backup, atau data pribadi. Token GitHub yang pernah muncul di percakapan harus dianggap terekspos; **belum ada bukti pencabutannya** dalam dokumentasi ini. Cabut/rotasi melalui penyedia jika belum dilakukan.
4. Login/sesi dashboard, sebagian state musik, sebagian memori AI dan rancangan Server Builder berada di memori proses; restart atau beberapa instance dapat mengubah perilakunya. Review kebutuhan session store dan koordinasi lintas instance sebelum deployment multi-worker.
5. Tes lokal bukan jaminan keamanan, kelengkapan data, izin Discord atau kesiapan produksi.

## 6. Pengujian terakhir yang tercatat

Untuk basis kode `98b2bee`:

| Pemeriksaan | Hasil | Cakupan/batas |
|---|---:|---|
| Regresi Node 22, PostgreSQL lokal dan tes TLS opt-in | **511/511 lulus** | Database PostgreSQL 17 disposable; Discord/provider tiruan dan jsdom. Bukan server Discord, Neon atau hosting nyata. |
| Tes terfokus Join to Create dengan Node 20 | **45/45 lulus** | API/UI, prototipe transaksi dan create; tidak mencakup seluruh proyek pada Node 20. |
| `npm audit --omit=dev` | **0 kerentanan dilaporkan** | Saat pengujian; hanya dependency produksi dan hasil advisory dapat berubah. |
| Git diff check | **Bersih** sebelum dokumentasi ini | Pemeriksaan whitespace, bukan audit kode/keamanan. |

Log di workspace ini: `/home/user/jtc-discord-check-regresi-final.txt`, `/home/user/jtc-discord-check-node20-final.txt`, dan `/home/user/jtc-discord-check-audit-final.txt`. File tersebut berada di luar repo dan mungkin tidak ikut jika repo dipindahkan.

Contoh perintah regresi yang dipakai, **hanya setelah PostgreSQL disposable dan sertifikat uji lokal disiapkan**:

```bash
ZENTIX_TEST_PG_SOCKET=/tmp/zentix-local-pg ZENTIX_TEST_PG_TLS=1 \
  npx --yes node@22 --test --test-concurrency=1 tests/*.test.js
npm audit --omit=dev
```

Jangan arahkan tes ke database produksi. Sertifikat dan direktori `/tmp` bersifat sementara dan dapat kedaluwarsa/hilang. Jalankan suite database secara sekuensial; fixture backup dan skema dapat berbenturan bila dijalankan paralel. Tanpa flag dan setup yang sesuai, sebagian tes PostgreSQL/TLS dilewati, bukan otomatis lulus.

## 7. Pekerjaan berikutnya — urutan yang disarankan

### Prioritas 1 — keselamatan dan Join to Create

- [ ] Rancang dan uji recovery yang diaudit untuk operasi pending, termasuk ketidakpastian commit dan respons Discord; jangan mengulangi efek secara otomatis.
- [ ] Selesaikan desain create, move, delete dan transfer, termasuk permission, voice state, event terlambat, cleanup saat disabled dan category behavior.
- [ ] Migrasikan **semua** penulis Join to Create yang aktif ke satu protokol; blokir penulis generik yang melewatinya setelah jalur pengganti siap. Uji beberapa instance/konkurensi, kegagalan dan bot lama.
- [ ] Baru setelah itu pertimbangkan aksi dashboard dengan autentikasi, CSRF/Origin, konfirmasi dan kontrol stale. Uji Discord sungguhan di server uji sebelum cutover.

### Prioritas 2 — integrasi dashboard yang belum lengkap

- [ ] Audit dan integrasikan kategori Community, Fun, Reaction Roles, Search, Server Stats, Tools dan Utility satu per satu, termasuk izin, penyimpanan, efek Discord dan tes.
- [ ] Lengkapi halaman pengaturan utama dan opsi yang masih simulasi. Bedakan informasi tersimpan dari kondisi Discord aktual.
- [ ] Lengkapi Giveaway create/delete dan pemulihan pending dengan protokol yang aman; audit fitur tiket, reward role dan seluruh penulis ekonomi sebelum memperluas perubahan.
- [ ] Tambahkan kemampuan dan audit Birthday yang masih kurang, termasuk penambahan lewat web bila diperlukan dan penyelarasan perilaku 29 Februari.

### Prioritas 3 — deployment dan pemulihan

- [ ] Uji end-to-end dengan server Discord uji, OAuth, PostgreSQL/Neon, provider AI, Lavalink, browser dan lingkungan hosting yang dipilih, termasuk izin, rate limit, restart dan putus koneksi.
- [ ] Selesaikan prosedur backup terenkripsi/offsite, retensi, restore produksi yang aman dan latihan pemulihan; uji lagi dengan akun/target terisolasi.
- [ ] Audit seluruh jalur yang masih mengembalikan default saat database gagal, key legacy, skema, data pribadi serta keamanan multi-instance.
- [ ] Bila SQLite masih menjadi tujuan, selesaikan kompatibilitas runtime, migrasi data, backup/WAL/TTL dan tes beban sebelum mempertimbangkan cutover. Sampai itu selesai gunakan PostgreSQL yang dikonfigurasi dan diverifikasi dengan benar.

## 8. Status Git dan berkas penting

Pada saat inventaris, `HEAD` kode adalah `98b2bee`; referensi **lokal** `origin/main` menunjuk ke `51cfc24fa63b74b6f40b7961e7e30b53a0eecaa6`, dan ada **11 commit kode lokal** di depannya. Dokumentasi ini serta pembaruan tabel status ditambahkan sebagai commit dokumentasi terpisah, sehingga bila commit tersebut dibuat dan belum ada push, total menjadi **12 commit lokal**. Angka ini dapat berubah; referensi remote lokal belum membuktikan keadaan GitHub terkini tanpa fetch. Tidak ada push yang dilakukan dalam tahap dokumentasi ini.

| Berkas / direktori | Kegunaan |
|---|---|
| `DOKUMENTASI-DASHBOARD.md` | Inventaris dashboard dan batas fitur. |
| `DOKUMENTASI-JOIN-TO-CREATE-PG.md` | Audit penulis, prototipe dan syarat cutover Join to Create. |
| `DOKUMENTASI-GIVEAWAY-PG.md` | Cutover, operasi, `pending` dan batas Giveaway PostgreSQL. |
| `DOKUMENTASI-POSTGRESQL.md` | Startup, TLS, health/readiness, backup dan restore drill. |
| `DOKUMENTASI-MIGRASI-SQLITE.md` | Fondasi dan batas migrasi SQLite eksperimental. |
| `DOKUMENTASI-CORE-DASHBOARD.md` | Akses perintah Core dan batas konkurensi. |
| `DOKUMENTASI-TAHAP-8.md` | Cakupan AI Studio, privasi, biaya dan keterbatasan. |
| `dashboard-preview/` | UI; bila disajikan sendiri hanya simulasi. |
| `src/dashboard/`, `src/services/`, `src/utils/` | API/dashboard, service dan penyimpanan bot. |
| `tests/` | Tes otomatis; beberapa membutuhkan PostgreSQL disposable atau Node 22. |

Sebagian dokumen lama masih merujuk dokumentasi tahap 5–7 yang tidak ada di checkout saat ini; referensi tersebut perlu diperbarui atau dibuat ulang bila diperlukan. Tabel dan catatan ini adalah inventaris berdasarkan kode dan tes pada tanggal di atas, bukan janji bahwa semua pekerjaan sudah selesai.
