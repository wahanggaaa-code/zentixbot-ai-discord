# SQLite: database bawaan bot

**Status:** SQLite dapat dipakai dan menjadi pilihan bawaan. Bila tidak ada koneksi PostgreSQL yang diatur, bot membuat berkas `data/zentix.db` di folder tempat ia dijalankan dan menyimpan semua datanya di sana. PostgreSQL tetap didukung dan dipakai begitu salah satu nilai koneksinya terisi. Yang sudah diuji hanyalah pengujian lokal dengan Discord tiruan; SQLite belum pernah dijalankan di hosting sungguhan atau dengan server Discord sungguhan.

Data PostgreSQL **tidak dipindahkan** ke SQLite, dan sebaliknya. Fungsi `importPostgres…Snapshot` yang dijelaskan di bawah tetap eksperimen internal dan tidak tersambung ke perintah atau skrip mana pun.

## Bagaimana database dipilih

Keputusannya dibuat sekali saat startup oleh `src/config/database/engine.js`:

| Keadaan `.env` | Hasil |
| --- | --- |
| `DATABASE_ENGINE` (atau `DATABASE_DRIVER`, `DB_TYPE`) berisi `sqlite`/`sqlite3` atau `postgresql`/`postgres`/`pg` | Pilihan itu dipakai. Nilai lain: startup berhenti dengan `DATABASE_ENGINE_INVALID`; tiga kunci itu saling berbeda: `DATABASE_ENGINE_AMBIGUOUS` |
| Salah satu dari `POSTGRES_URL`, `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` terisi, atau `DATABASE_URL` bukan `sqlite:`/`file:` | PostgreSQL |
| `DATABASE_PATH` terisi, atau `DATABASE_URL` berawalan `sqlite:`/`file:` | SQLite di lokasi itu |
| Dua baris di atas sama-sama berlaku tanpa `DATABASE_ENGINE` | Startup berhenti dengan `DATABASE_ENGINE_AMBIGUOUS` |
| Tidak ada satu pun | SQLite di `data/zentix.db` |

Nilai kosong dihitung sebagai tidak diisi. `:memory:` ditolak (`DATABASE_PATH_INVALID`): database yang hilang saat restart bukan pilihan.

Tidak ada perpindahan diam-diam ke database lain. PostgreSQL yang diatur tetapi tidak dapat dihubungi menghentikan startup (`POSTGRES_UNAVAILABLE`); berkas SQLite yang tidak dapat dibuka menghentikan startup dengan kode `SQLITE_…`. Tidak ada fallback ke memori pada keduanya. Node.js yang lebih lama dari 22.13 menghentikan startup dengan `SQLITE_RUNTIME`.

Pemeriksaan konfigurasi di `src/config/bot.js` hanya menuntut nilai PostgreSQL bila PostgreSQL yang akan dipakai, sehingga `NODE_ENV=production` tanpa pengaturan database berjalan dengan SQLite.

## Susunan data di SQLite

Satu berkas dengan mode WAL, dibuka oleh `src/services/storage/sqlite.js` memakai `node:sqlite` bawaan Node.js (tanpa paket tambahan). Tiga tabel: `zentix_bot_kv` (data bot, satu baris per kunci, nilai berupa JSON), `zentix_economy` (akun ekonomi) dan `zentix_kv` (data AI). Setiap perubahan fitur berjalan dalam satu transaksi `BEGIN IMMEDIATE` yang sinkron; hanya ada satu penulis pada satu waktu.

Berkas baru dibuat dengan izin 0600. Cadangan: hentikan bot, salin seluruh folder `data/` termasuk berkas `-wal` dan `-shm`.

## Perbedaan perilaku dengan PostgreSQL

Bot, perintah dan dashboard memakai jalur yang sama pada kedua database; suite tes fitur yang sama dijalankan pada keduanya. Perbedaan yang ada, semuanya disengaja dan dipasang di tes:

| Hal | PostgreSQL | SQLite |
| --- | --- | --- |
| `COMMIT` yang gagal | Jawaban "database tidak mengonfirmasi perubahan; mungkin tersimpan, mungkin tidak" (kode `…_UNCERTAIN`) | Perubahan dibatalkan dan jawabannya kegagalan biasa ("tidak ada yang diubah"). Jawaban `COMMIT` tidak dapat hilang karena tidak lewat jaringan |
| Dua penulis bersamaan | Kunci baris dan `pg_advisory_xact_lock` | Satu penulis; yang kedua menunggu transaksi pertama selesai |
| Menulis baris milik sebuah fitur lewat `client.db.set`/`delete` umum (welcome, Join to Create, counter, reaction role, counting, to-do) | Mengembalikan `false` | Melempar `CONFIG_WRITE_DISABLED` (lamaran: `APPLICATION_WRITE_DISABLED`). Membaca tetap bisa pada keduanya. Fitur-fitur itu menulis lewat penyimpanannya sendiri |
| Giveaway | Satu baris per giveaway di tabel `giveaways` | Satu baris per server berisi semua giveaway |
| Akun ekonomi | Kolom `balance`, `bank`, `data`; ada tabel `users` | Satu catatan JSON per akun di `zentix_economy`; tidak ada tabel `users` |
| Batas ukuran data Join to Create | Dihitung dari `jsonb` | Dihitung dari teks JSON yang disimpan |
| Database tidak dapat dipakai | Galat; tidak pernah dianggap "belum diatur" | Sama: `getEconomyData` melempar `ECONOMY_UNAVAILABLE`, penyimpanan fitur melempar kode `…_UNAVAILABLE` |
| AFK | Tabel `afk_status` | Ditolak oleh adapter. Tidak ada perintah bot yang memakainya saat ini |

Batas yang perlu diketahui: `DatabaseSync` memblokir event loop selama sebuah query, jadi SQLite cocok untuk satu proses bot pada satu server. Beban tinggi, beberapa proses bot pada satu berkas, dan berkas di penyimpanan jaringan belum diuji.

## Pengujian

- `tests/sqlite-startup-guard.test.js`: pemilihan database, startup, kegagalan, `/ready`.
- `tests/sqlite-everyday-use.test.js`: bot dimulai lewat kode startup yang sebenarnya tanpa pengaturan database; warning, ulang tahun, ekonomi, level, pengaturan server, akses perintah dan welcome disimpan dan ditemukan lagi setelah restart; `src/app.js` dijalankan utuh dalam mode produksi sampai tahap login Discord.
- `tests/sqlite-feature-suites.test.js`: suite fitur yang ditulis untuk PostgreSQL (to-do, counting, reaction role, server stats, lamaran, laporan, halaman dashboard, level dan reward role, ekonomi, Join to Create, giveaway, tiket) dijalankan ulang pada berkas SQLite. Tes yang hanya bermakna di PostgreSQL (jawaban `COMMIT` yang hilang di jaringan; penulisan yang ditahan di tengah oleh koneksi lain) dilewati dan jumlahnya dipasang di berkas itu.
- `tests/postgres-dashboard-live-walk.test.js`: seluruh formulir dashboard dijalankan pada kedua database dan status jawabannya harus sama.
- `tests/sqlite-*.test.js` lainnya: fondasi, adapter, transaksi lintas proses.

Tes memakai berkas SQLite sungguhan di folder sementara, bukan tiruan. Jalankan dengan Node 22.16 atau lebih baru.

## Catatan teknis lama

Bagian-bagian di bawah ditulis saat SQLite masih eksperimen. Rincian tentang importer snapshot, inventaris dan audit PostgreSQL masih berlaku sebagai catatan teknis; kalimat yang menyebut SQLite "belum tersambung ke startup" sudah tidak berlaku.

## Inventaris PostgreSQL read-only (eksperimental)

`npm run migrate:sqlite:inventory` membaca **hanya** PostgreSQL menggunakan `POSTGRES_URL` dari environment, tanpa membuat tabel maupun menulis ke SQLite. Tidak membaca `.env` otomatis. Jalankan dengan kredensial read-only dan TLS yang sesuai lingkungan; jangan letakkan URL/kredensial dalam argumen shell, log, commit, atau laporan yang dibagikan. Output JSON menampilkan nama schema/tabel dan jumlah baris, bukan isi row; informasi jumlah/nama tetap dapat sensitif. Query menghitung seluruh tabel dan bisa mahal; jalankan hanya pada waktu yang aman. Ada timeout 15 detik per query, batas 256 relasi, dan kegagalan menghasilkan error tanpa laporan parsial. Sudah diuji terbatas terhadap PostgreSQL 17 lokal yang sementara, tetapi belum pada server atau data deployment.

Transaksi `REPEATABLE READ READ ONLY` menjaga hitungan dalam satu snapshot. RLS, foreign table, view dan materialized view tidak dihitung; partisi dapat terhitung lebih dari sekali (jangan jumlahkan counts). Keterbatasan izin/catalog, database lain, skema atau obyek lain tetap membutuhkan audit manual. AI vs key lain di `temp_data`/`cache_data` hanya dikelompokkan berdasarkan prefix `ai:`; expired dihitung terpisah, tidak otomatis dibuang. `missingAppTables` membantu menemukan tabel baseline yang tidak ditemukan di schema aktif, bukan bukti kelengkapan. `migrationReady` selalu `false`: inventaris bukan ekspor, validasi isi, backup, migrasi, maupun izin cutover. Snapshot read-only juga **tidak** menghentikan writer. Tidak ada perintah import atau aktivasi SQLite dari alat ini.

## Fondasi konversi ekonomi (belum terhubung ke importer)

`src/services/migration/economyBatch.js` adalah fungsi internal eksperimental, **bukan** CLI migrasi dan belum membaca PostgreSQL. Ia mengubah maksimal 500 baris ekonomi dari satu guild per batch, meminta `balance::text`, `bank::text` dan `data::text` agar JSONB/BIGINT tidak dibulatkan oleh parser client. Nilai JSON numerik desimal/eksponen dan integer di luar rentang aman JavaScript ditolak, termasuk pada metadata; jika JSON bukan objek kosong, wallet/bank harus ada dan persis cocok dengan kolom PG. Data yang tidak memenuhi aturan butuh rekonsiliasi manual, bukan konversi otomatis.

SQLite memeriksa keberadaan akun dan key ekonomi legacy mentah (termasuk nilai null/kedaluwarsa), menolak konflik, menyimpan seluruh batch dalam satu transaksi, membaca ulang tiap akun dan menghitung total wallet/bank menggunakan BigInt. Tes file SQLite meliputi rollback, persistensi, konflik lintas proses dan pembacaan transaksi ekonomi. Batas 500 akun/2 MiB per batch mencegah batch tidak terbatas; keberhasilan satu batch **tidak** berarti impor seluruh database atomik atau lengkap. Sumber PostgreSQL harus dibaca dari snapshot yang konsisten dengan semua writer dihentikan untuk cutover, dan potensi key ekonomi legacy di PostgreSQL harus diaudit terpisah. Belum ada orkestrasi seluruh database, checkpoint/restart atau verifikasi semua tabel; sebagian sumber ekonomi telah diuji dengan PostgreSQL 17 lokal sementara. Jangan gunakan modul ini untuk memigrasi data produksi.

Tambahan `src/services/migration/postgresEconomyAudit.js` menyediakan fungsi preflight read-only internal untuk akun ekonomi satu guild: hitungan akun, data yang ditolak konverter, jumlah key legacy `temp_data`/`cache_data`, dan total saldo **akun valid saja** dalam satu snapshot. Akun guild lain dan ID tidak valid dihitung terpisah. Pemindaian memakai halaman terbatas dan menolak RLS, tabel partisi/inheritance, ketidaksesuaian jumlah dan kegagalan query. Fungsi ini belum punya CLI, telah diuji terbatas dengan PostgreSQL 17 lokal, dan tidak melakukan impor; hasilnya tidak memverifikasi tabel lain, isi key legacy, SQLite tujuan, backup atau cutover.

### Salinan sumber ekonomi terbatas, bukan migrasi lengkap

`importPostgresEconomySnapshot` adalah eksperimen internal, bukan perintah deployment. Ia membaca snapshot PostgreSQL read-only untuk satu guild (maksimal 500 akun dan 2 MiB data JSON), menolak akun dari guild lain, tabel sumber RLS/inheritance, dan semua key ekonomi legacy di tabel temp/cache. Lalu ia menyalin batch ke SQLite hanya bila seluruh penyimpanan ekonomi tujuan kosong, membaca ulang nilai dan membandingkan total sumber/tujuan **sebelum commit SQLite**. Kegagalan validasi atau transaksi tidak meninggalkan batch parsial. Tidak ada jaringan di dalam transaksi SQLite.

Sumber dan tujuan tetap harus dihentikan secara eksternal: snapshot tidak mencegah writer melakukan perubahan setelah snapshot. Fungsi ini tidak menyalin kolom waktu PG, user, atau tabel non-ekonomi, tidak memiliki checkpoint dan tidak aman untuk cutover atau data produksi. Pengujian integrasi menggunakan PostgreSQL 17 sementara lewat socket lokal mencakup snapshot konsisten dengan writer bersamaan, ekspor baris ke SQLite, konflik, RLS dan kegagalan. Tes integrasi bersifat opt-in dan hanya menggunakan socket khusus lokal `/tmp/zentix-local-pg`; bukan tes pada server pengguna atau Wispbyte.

### Salinan key AI terbatas, bukan migrasi lengkap

`importPostgresAIDataSnapshot` merupakan fungsi internal eksperimental, bukan CLI: menyalin maksimal 500 key dan 2 MiB JSON AI yang dikenal untuk satu guild dari `cache_data` PG ke namespace AI SQLite dalam satu transaksi SQLite. Sumber dibaca dalam satu snapshot read-only. Key AI yang tidak dikenal atau milik guild lain, key AI dalam `temp_data`, TTL non-null, RLS/inheritance, data numerik yang tidak aman, dan tujuan yang sudah memiliki key AI menyebabkan penolakan. Data diperiksa ulang setelah ditulis sebelum commit. JSON disalin secara konservatif; validasi bentuk tiap fitur, timestamp row, backup, checkpoint, semua tabel lain dan kesiapan cutover tetap belum selesai. Semua writer harus dihentikan secara eksternal dan backup diverifikasi.

Pengujian lokal dengan PostgreSQL 17 sementara mencakup konfigurasi, kuota, poin, dokumen, konflik, TTL, angka tidak aman dan rollback SQLite. Tidak ada data pengguna atau server PostgreSQL deployment yang diakses; jangan gunakan fungsi ini pada produksi.

### Salinan konfigurasi server terbatas, bukan migrasi lengkap

`importPostgresConfigSnapshot` adalah fungsi internal eksperimental untuk menyalin konfigurasi guild, counter, welcome dan leveling satu server ke SQLite. Sumber dibaca dalam snapshot PostgreSQL read-only; kondisi multi-guild, key legacy yang bertabrakan, RLS/inheritance, data konfigurasi yang tidak valid, dan kombinasi role/verifikasi yang bertentangan ditolak. Key tujuan, termasuk alias lama yang sudah kedaluwarsa atau bernilai null, harus kosong. Penulisan dan pembacaan ulang diverifikasi dalam satu transaksi SQLite. Salinan diuji dengan PostgreSQL 17 lokal sementara dan SQLite, termasuk kegagalan serta rollback.

Ini belum mengimpor tabel lain, riwayat timestamp, atau key bot umum, belum mengunci writer sumber secara eksternal dan tidak memberikan backup maupun prosedur cutover. PostgreSQL dan SQLite harus dihentikan serta backup diperiksa sebelum migrasi yang sesungguhnya; jangan gunakan fungsi ini untuk produksi.

### Salinan key bot teridentifikasi (eksperimental)

`importPostgresBotKvSnapshot` menyalin subset key bot beridentitas guild dari `temp_data` dan key `cache:<guild>:` yang dikenali, maksimum 500 key/2 MiB JSON, dari satu snapshot PostgreSQL read-only. Key lama yang dikenali dikonversi menjadi canonical, tetapi dua key sumber yang menuju canonical yang sama **ditolak**, bukan digabungkan. Key tidak dikenal/tidak dapat dipastikan guild-nya, key terstruktur yang memerlukan mapper tabel lain, nilai JSON null, angka yang tidak aman, dan konflik key/alias tujuan ditolak. Marker migrasi key PG `__meta:key_migration:v1` tidak disalin; key AI di `cache_data` ditangani secara terpisah.

TTL key bot yang didukung dikonversi berdasarkan zona waktu sesi PostgreSQL yang digunakan saat snapshot. Timestamp sub-milidetik atau di luar rentang aman ditolak, sementara key kedaluwarsa dipertahankan sebagai record mentah dengan expiry yang sama. Khusus peringatan moderasi, TTL non-null ditolak dan data harus divalidasi sebagaimana bagian peringatan di bawah. Tes PostgreSQL 17 lokal mencakup zona Asia/Jakarta, alias, TTL, data rusak dan rollback. Zona waktu dan perilaku data nyata tetap harus diverifikasi secara operasional. Ini hanya subset: banyak key umum/global dan tabel terstruktur masih memerlukan audit; jangan menjalankan pada data produksi atau menganggap migrasi selesai. Sumber dan target harus dihentikan serta backup diverifikasi secara eksternal. Importir subset saat ini menggunakan snapshot terpisah dan **belum** diorkestrasi menjadi satu migrasi utuh.

### Ulang tahun: penulisan atomik dan salinan terbatas

Operasi ulang tahun SQLite kini memutakhirkan satu anggota secara transaksional dan menolak penulisan/penghapusan peta penuh melalui adapter lama. Saat anggota keluar atau kembali, peta ulang tahun dan peta cadangan dipindahkan bersama dalam satu transaksi; konflik atau data lama yang ambigu ditolak tanpa menghapus data. Pembacaan SQLite tidak mengubah error menjadi peta kosong. Tes mencakup 100 pembaruan lintas proses, rollback, alias, dan konflik backup. Ini tidak memperbaiki jalur read-modify-write PostgreSQL atau seluruh penulis bot lain.

`importPostgresBirthdaysSnapshot` adalah fungsi internal eksperimental untuk menyalin maksimal 500 baris tabel birthdays dari satu guild ke satu peta SQLite. Tanggal tidak valid, RLS/inheritance, guild lain, alias sumber/tujuan yang bertabrakan dan data tujuan yang sudah ada ditolak. Pengujian lokal memakai PostgreSQL 17 dan SQLite, termasuk tahun kabisat. Metadata waktu row PG tidak disalin; writer, backup, validasi data produksi dan semua tabel lain tetap harus ditangani secara terpisah. Fungsi ini belum merupakan migrasi utuh dan tidak boleh digunakan untuk cutover.

### Leveling: transaksi SQLite dan salinan sumber terbatas

Backend SQLite eksperimental kini memperbarui XP dan memeriksa cooldown pesan dalam transaksi yang sama, termasuk lintas proses. Operasi tambah/kurangi/set level dan edit dashboard memakai penyimpanan transaksional yang sama; penulisan atau penghapusan key leveling dengan API KV lama ditolak. Nilai tidak aman, key dengan TTL, data rusak dan konflik canonical/alias ditolak. XP dicommit sebelum role, pengumuman atau log Discord dicoba. Efek Discord tetap best-effort: kegagalan atau proses mati setelah commit belum memiliki outbox/retry dan perlu rekonsiliasi manual. Perubahan konfigurasi, sinkronisasi role, leaderboard, leave/wipe dan seluruh jalur lain masih perlu audit menyeluruh; implementasi PostgreSQL lama belum mendapat jaminan atomis lintas proses.

`importPostgresLevelsSnapshot` hanya fungsi internal eksperimental untuk hingga 500 baris `user_levels` satu guild, snapshot read-only PG dan satu transaksi SQLite yang memverifikasi hasil tulis. RLS/inheritance, data guild lain, key leveling legacy pada PG, target leveling yang sudah ada, angka negatif/tidak aman, level >1000 dan timestamp sub-milidetik ditolak. Ia tidak menyalin `created_at`/`updated_at` atau tabel user/guild dan tidak membuktikan relasi lengkap. Ia mewajibkan parameter `runtimeTimeZone: 'UTC'` sebagai pernyataan operator, **bukan deteksi otomatis**: PostgreSQL memakai `timestamp without time zone`, sehingga hanya layak dicoba jika asal seluruh nilai historis (termasuk zona proses Node, sesi PostgreSQL dan writer lain) sudah diverifikasi memang merepresentasikan UTC. Jika campuran atau tidak diketahui, hentikan dan lakukan rekonsiliasi manual; sekadar mengatur timezone sekarang tidak memperbaiki data historis. `NULL` dipetakan ke `0` seperti pembacaan runtime lama, presisi milidetik dipertahankan, timestamp sebelum epoch ditolak. Tes terbatas memakai PostgreSQL 17 dan SQLite lokal, termasuk timezone sesi berbeda, rollback, batas dan konflik. Writer sumber/tujuan, backup dan validasi harus ditangani secara eksternal; snapshot tidak membekukan penulisan setelah pembacaan. Jangan gunakan importer ini untuk produksi atau cutover.

Sinkronisasi role leveling saat bot siap tidak lagi menghapus pengaturan reward ketika role hilang atau lookup Discord gagal: missing role dan error dilaporkan, lalu administrator dapat memeriksanya. Daftar level dan error Discord yang diteruskan ke layanan dihitung sebagai error, dan ID user 20 digit ikut dipindai. Level dan konfigurasi dicek lagi setelah mengambil member dan sebelum mencoba memberikan role, tetapi perubahan bisa tetap terjadi sesudah pengecekan; operasi Discord dan database bukan transaksi yang sama. Sejak audit reward role (2026-11-13) jalur PostgreSQL tidak lagi memakai `list()` untuk sinkronisasi ini: daftar anggota dibaca langsung dari `user_levels` dan query yang gagal dihitung sebagai error (lihat [`docs/audit/reward-role.md`](audit/reward-role.md)). Tes menggunakan SQLite lokal dan Discord mock, bukan server Discord nyata.

### Salinan riwayat audit verifikasi (eksperimental)

`importPostgresVerificationAuditSnapshot` menyalin maksimal 500 baris dan 2 MiB metadata dari satu guild dalam snapshot read-only PG. Transaksi SQLite menolak target audit yang sudah berisi data, mempertahankan ID numerik dan urutan, membaca kembali setiap record sebelum commit, serta menggagalkan seluruh batch pada error. Insert audit baru di SQLite menggunakan ID setelah ID terbesar yang disalin. RLS/inheritance, guild lain, ID/nilai tidak valid, metadata null atau angka JSON yang tak aman, timestamp null/sub-milidetik dan tipe timestamp yang tidak diharapkan ditolak. Tes PostgreSQL 17 lokal mencakup rollback dan perubahan sumber saat snapshot berlangsung.

`created_at` PG adalah `timestamp without time zone`, sehingga fungsi mensyaratkan pernyataan operator `runtimeTimeZone: 'UTC'` dan hanya boleh dipertimbangkan jika **semua** nilai historis benar-benar sudah diverifikasi merepresentasikan UTC. Pernyataan itu bukan deteksi otomatis; zona proses, sesi PostgreSQL dan semua writer historis perlu diperiksa. Timestamp sebelum epoch dan yang tidak dapat diwakili oleh JavaScript Date ditolak. Fungsi ini tidak menyalin tabel lain, tidak memverifikasi backup atau membekukan writer setelah snapshot; bukan alat produksi/cutover dan tidak boleh dipakai untuk migrasi deployment.

### Salinan giveaway terbatas (eksperimental)

`importPostgresGiveawaysSnapshot` hanya fungsi internal untuk maksimal 500 row giveaway dan total 2 MiB JSON dari satu guild. Ia mengambil satu snapshot PostgreSQL read-only, menolak RLS/inheritance, guild lain, key giveaway legacy pada temp/cache, dan target SQLite mana pun yang sudah memiliki key giveaway/lock/entry (termasuk key null atau kedaluwarsa). Ia menulis peta giveaway dan memeriksa hasilnya dalam satu transaksi SQLite; tidak melakukan panggilan Discord. Data yang tidak dikenali perlu ditinjau manual, bukan dinormalisasi diam-diam.

Untuk mencegah perubahan jadwal, importer hanya menerima `ends_at` yang sama persis dengan `data.endsAt` dalam milidetik integer (juga `endTime` jika ada), status `ended` dan `isEnded` boolean yang konsisten, ID peserta unik serta identitas/channel/host dan pemenang valid. Timestamp berbeda/sub-milidetik, JSON dengan angka tak aman, timestamp null dan sumber di luar batas ditolak. Nilai `dueActive` pada laporan menghitung giveaway aktif yang sudah jatuh tempo pada saat snapshot; setelah impor, scheduler dapat mencoba mengakhirinya segera. Tidak ada jaminan penyampaian Discord tepat sekali, dan angka ini bukan persetujuan untuk menyalakan scheduler.

Seperti import timestamp lain, `runtimeTimeZone: 'UTC'` adalah pernyataan operator, bukan verifikasi: seluruh riwayat zona Node/sesi PostgreSQL/penulis lain untuk `ends_at timestamp without time zone` harus telah terbukti UTC. ID row serial PostgreSQL serta metadata kolom `created_at`/`updated_at` tidak disalin; identitas giveaway di SQLite adalah message ID yang ada dalam JSON. Data user/guild, lock/entry legacy, riwayat dan tabel lain tetap butuh rekonsiliasi. Jalur manual end/reroll dan scheduler mencatat delivery pending pada SQLite, tetapi belum memiliki recovery otomatis maupun exactly-once. Tes menggunakan PostgreSQL 17 sementara, SQLite dan Discord mock; sumber/tujuan harus dihentikan dan backup diverifikasi secara terpisah. Jangan gunakan importer untuk produksi atau cutover.


### Delivery giveaway manual dan penghapusan (SQLite eksperimental)

End dan reroll melalui command maupun tombol menyimpan hasil dengan `deliveryStatus: pending` sebelum mengubah Discord, lalu menandai `delivered` hanya setelah tindakan Discord yang diperlukan pada jalur tersebut selesai. Jika Discord gagal, respons tidak pasti, atau penyimpanan status akhir gagal, hasilnya dapat tetap `pending`; jangan langsung mencoba ulang atau menggambar pemenang baru. Reroll menolak status pending/tidak dikenal dan lookup pesan pemenang lama yang gagal tidak dianggap bukti bahwa pesan hilang. Hasil pending harus diperiksa pada Discord dan direkonsiliasi secara manual; belum ada antarmuka operator atau retry otomatis yang aman. Tes juga mencakup dua reroll yang bersaing dan kegagalan simpan setelah aksi Discord, menggunakan SQLite lokal dan Discord mock.

Pada backend SQLite eksperimental `/gdelete` sementara ditolak **sebelum** menghapus pesan atau data karena kedua tindakan belum dapat dikoordinasikan dengan aman. Helper penyimpanan juga menolak menghapus record pending. Pembatasan ini tidak mengubah backend PostgreSQL lama. Perilaku saat proses mati pada setiap tahap, pembuatan pesan yatim, interaksi Discord nyata, dan prosedur resolusi operator masih harus diuji dan diselesaikan sebelum cutover; marker pending bukan outbox exactly-once.

### Tiket: snapshot SQLite dan salinan PG terbatas

`getTicketData`/`saveTicketData` SQLite menggunakan snapshot per record: pembaruan hanya diterima jika isi saat commit masih sama dengan isi yang dibaca; penulis tanpa snapshot tidak boleh menimpa record, dan record yang telah hilang tidak boleh dihidupkan kembali oleh snapshot lama. Pengecekan dan penulisan dilakukan dalam satu transaksi SQLite; penulisan atau penghapusan ticket key lewat adapter KV umum ditolak. Tes memakai dua proses independen yang bersaing mengubah tiket, serta uji feedback, data invalid, TTL dan penyimpanan legacy. Ini membandingkan **isi**, bukan nomor versi historis; operasi Discord dan snapshot tidak merupakan satu transaksi. Efek Discord setelah penyimpanan tiket masih bisa gagal dan belum memiliki outbox/recovery. Penghitungan tiket memeriksa key mentah termasuk yang kedaluwarsa dan gagal tertutup saat menemukan konflik, tetapi pemindaian bukan reservasi atomik untuk batas tiket per user.

Karena pembuatan channel dilakukan sebelum data tiket dapat dipastikan tersimpan, dan penghapusan channel/data belum punya protokol pemulihan, pembuatan dan penghapusan tiket melalui service **ditolak sebelum aksi Discord** pada backend SQLite eksperimental. Penghapusan data tiket langsung juga ditolak; penghapusan sistem tiket SQLite sebelumnya sudah diblokir. Channel yang dihapus secara manual masih bisa memicu event untuk menandai tiket, tetapi konflik snapshot perlu diperiksa dan belum ada antrean retry. Batasan ini tidak memperbaiki race backend PostgreSQL atau membuktikan seluruh jalur tiket/Discord telah diaudit.

`importPostgresTicketsSnapshot` menyalin maksimal 500 baris/2 MiB JSON dari tabel PostgreSQL **`ticket_data`** satu guild, dalam snapshot read-only dan satu transaksi SQLite. Record yang valid disalin beserta waktu `updated_at` untuk urutan dashboard, lalu dibaca ulang sebelum commit. Counter tiket merupakan key terpisah dan dapat disalin oleh importer bot KV; importer tiket tidak mengubah counter. Target tidak boleh sudah memiliki data tiket mana pun, termasuk key mentah null/kedaluwarsa atau namespace AI. Source key tiket terstruktur di temp/cache, RLS/inheritance, guild lain, ID/status/data tidak valid, angka JSON tak aman, timestamp null/sub-milidetik, dan `expires_at` non-null ditolak. Khusus expiry: jalur baca tiket PostgreSQL tidak memfilter kolom tersebut sedangkan TTL SQLite menghilangkan key saat expired, sehingga importer **tidak** menebak atau membuang nilai ini. Timestamp default PG sering menyimpan presisi mikrodetik dan akan membutuhkan rekonsiliasi manual, bukan pembulatan diam-diam.

`updated_at` bertipe `timestamp without time zone`; pernyataan `runtimeTimeZone: 'UTC'` bukan deteksi otomatis dan hanya boleh diberikan jika zona proses Node, sesi PostgreSQL serta semua penulis dan data historis telah diverifikasi UTC. Waktu sebelum epoch dan di luar Date JavaScript ditolak. Kolom `created_at`, hubungan guild dan data lainnya tidak disalin. Tes lokal meliputi konflik, rollback, batas, ordering, perubahan sumber saat snapshot dan PostgreSQL 17 sementara. Semua writer harus dihentikan dan backup diverifikasi secara eksternal; snapshot tidak menghentikan perubahan setelah pembacaan. Jangan gunakan fungsi ini sebagai alat produksi atau cutover.


### Peringatan moderasi SQLite (eksperimental)

Penambahan, penghapusan satu warning dan pengosongan daftar SQLite sekarang menggunakan satu transaksi per pengguna. ID warning numerik dialokasikan berdasarkan waktu dan sequence persisten per pengguna, sehingga tidak bertabrakan pada beberapa proses dan tidak digunakan lagi setelah clear; sequence dan warning ditulis atau di-rollback bersama. Adapter KV menolak penulisan langsung warning maupun sequence. Tes lokal mencakup 100 warning dari empat proses, operasi remove/clear, konflik alias, validasi data dan rollback. Clear tetap menghapus seluruh daftar yang ada **saat transaksi clear**, termasuk warning yang commit sebelum clear; konfirmasi lama belum mengikat snapshot daftar.

Satu alias legacy valid dapat dibaca dan dipindahkan ke canonical saat diubah, tetapi dua alias, key pada namespace AI, data rusak/ID ganda dan TTL warning non-null ditolak tanpa reset. Penghitungan/listing guild memeriksa key mentah termasuk expired; itu bukan snapshot atomik seluruh guild. Cleanup TTL sengaja tidak menghapus key warning atau sequence yang mencurigakan, termasuk dalam namespace AI, agar dapat direkonsiliasi. Importer bot KV kini menolak warning dengan TTL, bentuk/identitas invalid atau ID duplikat sebelum penulisan; importer tetap tidak memvalidasi semantik seluruh jenis key lain. Salinan eksperimental yang dibuat oleh versi sebelumnya perlu diaudit ulang, khususnya warning ber-TTL atau malformed; jangan hapus data tersebut sebagai jalan pintas.

Warning PostgreSQL kini juga memakai transaksi dan menolak data corrupt, TTL dan konflik alias; lihat docs/postgresql.md. Sequence warning PostgreSQL baru belum didukung importer bot KV dan menyebabkan importer eksperimental menolak snapshot, bukan diam-diam melewatkannya; jangan mencoba cutover sampai ditangani dan diuji. Pencatatan aksi moderasi dan efek Discord belum menjadi transaksi yang sama dengan warning, sehingga gagal setelah penyimpanan dapat memerlukan pemeriksaan sebelum mencoba ulang. Wipe dan migrasi penuh tetap belum siap, dan startup SQLite masih diblokir.


### AFK SQLite dan snapshot PostgreSQL (eksperimental)

`importPostgresAfkSnapshot` menyalin maksimal 500 baris `afk_status`, total teks reason maksimal 2 MiB dan maksimal 256 KiB per reason, untuk satu guild dalam snapshot PostgreSQL read-only dan transaksi SQLite. Data disimpan dengan bentuk `{reason, setAt, expiresAt}`; timestamp disalin sebagai ISO UTC atau null, dan expiry adalah **data**, bukan TTL SQLite. Ini mempertahankan baris yang sudah melewati `expires_at`, karena pembacaan PostgreSQL lama tidak memfilter masa berlaku. Tabel/namespace AFK tujuan yang sudah berisi key mentah, termasuk yang null atau kedaluwarsa, dan key `guild:*:afk:*` pada temp/cache sumber ditolak. Bentuk legacy lain yang belum dikenal masih memerlukan audit manual.

Sumber yang mengandung RLS, inheritance, guild lain, timestamp non-milidetik, timestamp sebelum epoch, tipe timestamp yang tidak sesuai, atau data melebihi batas ditolak. Parameter `runtimeTimeZone: 'UTC'` adalah pernyataan operator bahwa **seluruh sejarah** nilai `timestamp without time zone` memang UTC, bukan deteksi otomatis. Tes PostgreSQL lokal mencakup zona sesi berbeda, data expired/null, snapshot bersamaan, konflik dan rollback. Importer tidak menyalin relasi guild/user maupun menghentikan writer dan tidak memverifikasi backup; `migrationReady` tetap false dan ini bukan alat produksi.

AFK saat ini belum mempunyai implementasi runtime SQLite yang setara. Adapter bot menolak get/exists/set/delete/increment AFK secara langsung; wrapper pemanggil yang menangkap error dapat tetap menyamarkannya, sehingga seluruh call site tetap harus diaudit sebelum fitur dipakai. Cleanup TTL tidak menghapus key AFK mentah pada kedua namespace untuk menghindari kehilangan data ambigu. Wipe SQLite tetap diblokir, seperti sebelumnya. Startup SQLite tetap diblokir, dan fitur AFK belum selesai dimigrasikan.

### Audit relasi PostgreSQL (read-only, eksperimental)

`auditPostgresRelations` menerima koneksi PostgreSQL **khusus yang belum berada dalam transaksi** dan ID guild utama. Dalam satu snapshot `REPEATABLE READ READ ONLY`, fungsi ini mengembalikan hitungan agregat untuk `guilds`, `users`, `guild_users`, birthdays, AFK, leveling, ekonomi, audit verifikasi, undangan, giveaway, tiket, konfigurasi welcome/leveling, dan application roles. Laporan menunjukkan jumlah identitas invalid, guild utama/lain, referensi guild/user yang parent-nya tidak ditemukan, users tanpa baris `guild_users`, serta keberadaan metadata pengguna dan waktu keanggotaan. Tidak ada isi baris atau ID pengguna yang diekspor, diubah, atau dihapus.

Hitungan yang saling beririsan **tidak boleh dijumlahkan**. User tanpa `guild_users` atau inviter tanpa parent `users` tidak otomatis berarti kerusakan: jalur lama tidak menjamin semua keanggotaan tercatat dan inviter boleh null. Audit verifikasi dan inviter tidak memiliki FK user dalam skema dasar; tanda `baselineForeignKeys` hanya menjelaskan skema dasar, bukan bukti constraint aktual. Jumlah parent hilang tidak membuktikan pelanggaran FK, dan tidak membuktikan apakah seseorang saat ini anggota Discord. Audit tidak memeriksa JSON, moderator, key legacy, semua kolom/relasi, tabel/skema lain, atau target SQLite. RLS, tabel hilang, view, partisi/inheritance, query gagal dan data respons invalid menyebabkan error; batas statement 15 detik dapat membuat audit database besar berhenti tanpa laporan.

Tes menggunakan PostgreSQL sementara mencakup parent hilang, ID invalid, metadata, inviters opsional, snapshot saat writer aktif, RLS, inheritance dan kegagalan query. Ini **bukan** alat migrasi atau rekonsiliasi lengkap, tidak membuktikan akses menyeluruh, tidak menghentikan writer, dan tidak memverifikasi backup/restore. `migrationReady` selalu false. `users`/`guild_users` dan metadata/relasinya belum diimpor secara lengkap ke SQLite; keputusan preservasi membutuhkan audit data nyata. Jangan gunakan laporan ini sebagai izin cutover.

### Aplikasi pengguna dan keluar guild

Audit menemukan create/delete aplikasi memperbarui record dan indeks user secara terpisah, sementara update/review dan cleanup otomatis belum aman terhadap penulisan bersamaan. Karena itu seluruh fungsi aplikasi pada facade SQLite eksperimental **ditolak sebelum baca, tulis atau cleanup**, termasuk penghapusan saat `guildMemberRemove`; adapter KV juga menolak get/set/delete/increment key `guild:*:applications:*`. Ini pemblokiran sementara, bukan implementasi fitur aplikasi yang selesai. Pemanggil luar masih perlu audit terhadap penanganan error, respons, dan efek Discord; event keluar mencatat error dan melanjutkan tindakan lain, sehingga data aplikasi sengaja dipertahankan, bukan dihapus.

Cleanup TTL tidak menghapus key aplikasi mentah dari namespace bot maupun AI sampai data tersebut direkonsiliasi. Importer bot KV lama masih hanya menyalin key aplikasi yang dikenalnya tanpa memvalidasi keterkaitan indeks dan record, serta mempertahankan expiry aslinya; settings khusus role yang tidak dikenali ditolak. Keberhasilan salinan tersebut bukan bukti aplikasi siap: rekonsiliasi seluruh key, peran, indeks, status, TTL, dan tabel `application_roles` masih diperlukan sebelum aktivasi.

Selain itu `/app-admin list` tidak lagi menghapus aplikasi ketika Discord gagal me-resolve anggota; daftar kini tetap menampilkan record tanpa lookup anggota. Ini mengubah perilaku kedua backend dan mencegah error jaringan dianggap sebagai bukti bahwa anggota telah keluar. Cleanup retensi PostgreSQL lama dan penghapusan pada event keluar tetap ada dan masih perlu diaudit; perubahan ini tidak menjamin list sepenuhnya bebas dari mutasi akibat cleanup lama. Tidak ada perubahan yang mengaktifkan SQLite produksi.
