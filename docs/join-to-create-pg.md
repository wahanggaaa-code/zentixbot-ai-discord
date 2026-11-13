# Join to Create PostgreSQL: satu protokol untuk semua penulis

## Status

Semua jalur bot yang menulis data Join to Create (perintah `/jointocreate`, event `voiceStateUpdate`, event `channelDelete`, dan rekonsiliasi saat bot menyala) sekarang memakai **satu protokol transaksi PostgreSQL**. Penulis lama yang membaca lalu menyimpan ulang seluruh objek tanpa kunci sudah dihapus, dan penulis key/value generik menolak key Join to Create.

Batas yang perlu diketahui sebelum membaca lebih jauh:

- **Belum pernah dijalankan di Discord sungguhan.** Semua pengujian memakai PostgreSQL lokal sekali pakai dan guild Discord tiruan di memori. Perilaku rate limit, urutan event gateway, dan izin Discord yang sebenarnya belum terbukti.
- Dashboard web dapat **mengubah pengaturan trigger** (aktifkan pada channel suara yang sudah ada, ubah template/batas/bitrate, lepas trigger). Itu hanya perubahan data tersimpan: web tidak membuat, memindah atau menghapus apa pun di Discord, dan tidak mengelola channel sementara.
- Tidak ada migrasi data lama. Bot belum pernah berjalan, jadi tidak ada data untuk dimigrasikan. Data berbentuk lama (key channel terpisah, key di cache, wrapper `{ok, value}`, atau record dengan TTL) **ditolak**, tidak ditimpa.
- Tidak ada perubahan skema database.

## Susunan kode

| Berkas | Tugas |
|---|---|
| `src/services/storage/postgresJoinToCreateTransactions.js` | Protokol transaksi. Satu-satunya kode yang menulis record Join to Create. Tidak mengenal Discord. |
| `src/services/joinToCreateRuntime.js` | Satu-satunya tempat efek Discord dan data tersimpan digabung: antrean per guild, urutan create/delete, pemulihan create yang terputus, rekonsiliasi. |
| `src/services/joinToCreateService.js` | API untuk perintah slash: validasi masukan dan pesan kesalahan untuk admin. |
| `src/utils/joinToCreateTemplate.js` | Validasi dan perenderan template nama channel, batas user, bitrate. |
| `src/events/voiceStateUpdate.js`, `src/events/channelDelete.js`, `src/events/ready.js` | Hanya meneruskan event ke runtime. |
| `src/commands/JoinToCreate/jointocreate.js` | Satu-satunya perintah Join to Create. |
| `src/dashboard/joinToCreateSettingsApi.js`, `dashboard-preview/join-to-create-settings.js` | Pengaturan trigger di dashboard. Memanggil runtime yang sama dengan perintah slash. |
| `src/dashboard/joinToCreateApi.js`, `dashboard-preview/join-to-create-live.js` | Inventaris baca-saja. |

Dihapus: helper Join to Create di `src/utils/database.js`, `src/commands/JoinToCreate/modules/setup.js` dan `config_setup.js` (tidak pernah dimuat oleh command loader), serta `src/services/postgresJoinToCreatePrototype.js`.

## Protokol transaksi

Setiap operasi, termasuk pembacaan, berjalan dalam satu transaksi:

1. Ambil advisory transaction lock berdasarkan key guild. Lock ini juga melindungi saat record belum ada.
2. Baca baris `temp_data` dengan `FOR UPDATE`.
3. Validasi seluruh record. Record yang tidak valid, lebih dari 512 KiB, ber-TTL, atau didampingi data bentuk lama ditolak dan **tidak diubah**.
4. Terapkan satu perubahan kecil, validasi ulang, simpan, COMMIT.

Batas waktu: menunggu lock 5 detik, per pernyataan 10 detik. Protokol **tidak pernah mengulang sendiri** setelah COMMIT gagal, karena hasilnya tidak diketahui; pemanggil membaca ulang keadaan lalu memutuskan.

Aturan yang dijaga protokol:

- Hanya home guild.
- Paling banyak 100 trigger, dan 5.000 channel sementara termasuk create yang tertunda.
- Satu channel sementara (atau satu create tertunda) per pemilik.
- Paling banyak **satu create tertunda per guild**. Selama ada, semua penulisan lain ditolak dengan `JTC_PENDING`.
- Reservasi create hanya diterima bila record masih muat untuk pendaftaran channelnya nanti.
- Registrasi, reservasi dan penyelesaian create mensyaratkan trigger masih ada dan fitur aktif.
- Setup hanya saat belum ada trigger, tidak ada create tertunda, dan tidak ada sisa opsi dari trigger lama.
- Ubah pengaturan memakai **patch per bidang** (`nameTemplate`, `userLimit`, `bitrate`). Bidang lain dan properti tak dikenal tidak disentuh.
- Menghapus trigger mempertahankan record channel sementara yang sudah ada, supaya channel itu tetap dibersihkan saat kosong.

Dua revisi tersedia. `revision` adalah hash seluruh record. `configRevision` adalah hash bidang konfigurasi saja, sehingga tidak berubah ketika anggota membuat atau meninggalkan channel. Ubah dan hapus trigger membandingkan `configRevision` **hanya bila pemanggil mengirimkannya**. Dashboard selalu mengirimkannya; perintah slash tidak, karena patch per bidang sudah cukup di sana. Hash isi tidak mendeteksi A→B→A.

Kode kesalahan: `JTC_SCOPE`, `JTC_UNAVAILABLE`, `JTC_INVALID`, `JTC_LEGACY`, `JTC_EXPIRY`, `JTC_STALE`, `JTC_MISSING`, `JTC_CONFLICT`, `JTC_PENDING`.

## Urutan Discord dan database

Discord dan PostgreSQL tidak bisa diubah secara atomik. Urutan berikut dipilih agar kegagalan di tengah selalu meninggalkan jejak yang bisa diperiksa.

**Membuat channel**

1. Simpan reservasi (token acak, pemilik, trigger, waktu) dan COMMIT.
2. Minta Discord membuat channel. Alasan audit log berisi `Join to Create <token>`. Channel meniru izin kategori trigger ditambah izin pemilik; tidak ada izin yang dibuka untuk `@everyone`.
3. Daftarkan channel dan lepas reservasi dalam satu transaksi.
4. Pindahkan anggota. Bila anggota sudah pergi dan channel kosong, channel dihapus lagi.

| Yang terjadi di langkah 2–3 | Tindakan bot |
|---|---|
| Discord menolak (4xx atau rate limit) | Reservasi dilepas, tidak ada channel, anggota diberi tahu lewat DM. |
| Discord menjawab 5xx atau jaringan putus | Hasil tidak diketahui. Bot langsung mencari channelnya (lihat pemulihan). |
| Discord tidak menjawab dalam 20 detik | Reservasi dibiarkan. Jawaban yang datang terlambat tetap ditangani: didaftarkan bila reservasinya masih ada, dihapus bila tidak. |
| Pendaftaran gagal | Bot membaca ulang keadaan. Bila ternyata sudah tersimpan, lanjut. Bila tidak bisa disimpan, channel yang baru dibuat dihapus. |

**Menghapus channel**: hapus di Discord dulu, baru lepas record. Bila Discord gagal menghapus, record dipertahankan dan penghapusan dicoba lagi saat ada yang keluar dari channel itu atau saat bot menyala.

**Pemilik keluar**: kepemilikan dipindah di database dulu (dengan membandingkan pemilik lama), lalu izin Discord disesuaikan. Ganti nama channel tidak ditunggu, karena Discord membatasi dua kali ganti nama per sepuluh menit.

**Antrean**: semua operasi satu guild berjalan berurutan dalam satu proses. Paling banyak 200 event suara menunggu; lebihnya dibuang dengan peringatan di log.

## Pemulihan create yang terputus

Setiap operasi lebih dulu menyelesaikan reservasi yang tertinggal:

- Reservasi berumur kurang dari 20 detik berarti create mungkin masih berjalan. Event Discord menunggu sampai boleh diperiksa; perintah admin ditolak dengan pesan untuk mencoba lagi.
- Setelah itu bot mengambil daftar channel terbaru dari Discord dan mencari **tepat satu** channel suara yang belum terdaftar, dibuat di sekitar waktu reservasi, berada di kategori trigger, dan punya izin khusus untuk pemilik tersebut.
  - Ketemu satu: channel didaftarkan, lalu dihapus bila kosong.
  - Tidak ketemu: reservasi dilepas.
  - Ketemu lebih dari satu: tidak ada yang disentuh, ID-nya ditulis ke log untuk diperiksa manual, reservasi dilepas.
- Bila Discord tidak bisa ditanya, **tidak ada yang dilepas atau dihapus**; dicoba lagi pada operasi berikutnya.

Saat bot menyala, `reconcileJoinToCreate` menyelesaikan reservasi tertinggal, menghapus record tanpa channel, menghapus channel kosong, memindah kepemilikan channel yang pemiliknya sudah pergi, melepas trigger yang sudah tidak ada, dan melayani anggota yang menunggu di trigger. Ringkasannya muncul di log startup.

## Pengaturan lewat dashboard

Halaman **Fitur bot → Join to Create** menampilkan pengaturan di atas inventaris.

| Permintaan | Guna |
|---|---|
| `GET /dashboard/api/bot/join-to-create/settings` | Nilai efektif tiap trigger dan `configRevision`, dibaca dalam satu transaksi. Tanpa trigger: daftar channel suara beserta apakah bot punya izin. |
| `POST …/settings/triggers` | Jadikan channel suara yang sudah ada sebagai trigger. |
| `PATCH …/settings/triggers/:channelId` | Ubah bidang yang dikirim saja. Wajib `revision`. |
| `DELETE …/settings/triggers/:channelId` | Lepas trigger. Wajib `revision`. Channel Discord tidak dihapus. |

- Semua permintaan memerlukan login owner/admin yang diperiksa ulang setiap kali. Perubahan juga memerlukan Origin dashboard, token CSRF sesi, dan `confirmed: true`.
- Halaman hanya mengirim bidang yang diubah. Bila pengaturan sudah berubah sejak halaman dimuat (oleh admin lain atau `/jointocreate`), simpan ditolak dengan permintaan memuat ulang. Anggota yang membuat atau meninggalkan channel tidak membatalkan suntingan.
- Selama bot sedang membuat channel, perubahan ditolak dengan pesan coba lagi.
- Data berformat lama, ber-TTL atau tidak valid membuat pengaturan tidak bisa dibuka maupun diubah; inventaris tetap menampilkan peringatannya.
- Nama channel dan izin bot yang ditampilkan berasal dari cache bot, bukan pemeriksaan langsung ke Discord.
- Setiap perubahan yang berhasil dikirim ke log bot beserta ID admin, lewat jalur yang sama dengan perintah slash; log hanya muncul bila logging bot dikonfigurasi. Bila pencatatan gagal, perubahan tetap tersimpan.
- Bila respons simpan tidak jelas (misalnya koneksi database putus saat COMMIT), halaman tidak menyatakan berhasil; muat ulang untuk melihat keadaan sebenarnya.
- Tampilan halaman ini belum dilihat di browser sungguhan; yang diuji adalah perilakunya lewat jsdom.

## Perubahan perilaku dari versi lama

- Event Join to Create tidak lagi bergantung pada flag `features.joinToCreate`, sehingga channel yang tersisa tetap dibersihkan saat fitur dimatikan. Flag itu tetap menentukan apakah perintah `/jointocreate` boleh dipakai.
- Auto-pause musik dijalankan lebih dulu dan tidak lagi bergantung pada Join to Create.
- Menghapus kategori di Discord tidak lagi mematikan Join to Create.
- Menghapus trigger tidak lagi membuang record channel sementara.
- `categoryId`, `createdAt` dan `updatedAt` tidak lagi disimpan di opsi. Channel selalu dibuat di kategori trigger.
- `/jointocreate setup` memvalidasi masukan sebelum membuat channel, dan menghapus channel trigger bila konfigurasi gagal disimpan.
- Trigger lama hanya dianggap hilang bila Discord menjawab "Unknown Channel"; gangguan jaringan tidak lagi menghapus konfigurasi.
- Dialog pengaturan menjawab dengan alasan penolakan; masukan seperti `12abc` ditolak, tidak lagi dibaca sebagai 12.
- Nama pengguna berisi `$&` atau teks seperti `{guild_name}` dipakai apa adanya dalam nama channel, tidak ditafsirkan.

## Risiko yang masih ada

- **Belum diuji di Discord sungguhan.** Ini risiko terbesar.
- **Satu proses bot.** Antrean hanya ada di dalam proses. Dua proses bot pada guild yang sama tetap tidak bisa merusak record (lock database), tetapi alur create dan pemulihannya belum diuji dalam keadaan itu.
- Bila Discord membuat channel **setelah** bot selesai memeriksa dan proses bot mati sebelum jawaban terlambat itu tiba, channel tersebut tidak terdaftar. Cari lewat audit log Discord dengan alasan `Join to Create <token>`.
- Event yang gagal diproses (misalnya database mati) tidak diulang. Channel kosong yang terlewat baru dibersihkan saat bot menyala lagi.
- SQL langsung, restore backup, dan kode lain yang menulis tabel tanpa protokol tidak menghormati advisory lock.
- Record bersama dibatasi 512 KiB dan seluruhnya ditulis ulang pada setiap perubahan. Cukup untuk satu guild; bukan rancangan untuk ribuan channel aktif.
- Token reservasi dan ID pemilik adalah data internal: tidak dikirim ke browser dan jangan dicatat sembarangan.

## Pengujian

- `tests/postgres-jointocreate-transactions.test.js`: protokol. Setup bersamaan, 40 registrasi bersamaan, revisi konfigurasi, transfer/hapus yang berlomba, data rusak/lama/ber-TTL, batas ukuran, reservasi, respons COMMIT yang hilang.
- `tests/postgres-jointocreate-runtime.test.js`: runtime dengan guild tiruan. 20 anggota masuk bersamaan, izin kategori, penolakan Discord, hasil tidak diketahui, jawaban terlambat, kegagalan pendaftaran, penghapusan, pindah pemilik, rekonsiliasi, enam skenario mati di tengah create, penolakan penulis generik, dan layanan perintah.
- `tests/postgres-dashboard-jointocreate.test.js`, `tests/dashboard-jointocreate-ui.test.js`: API dan UI inventaris baca-saja.
- `tests/postgres-dashboard-jointocreate-settings.test.js`: API pengaturan. Validasi, revisi usang, enam admin menyimpan bersamaan, lepas trigger, data yang harus ditolak, permintaan cacat, serta login/izin admin/Origin/CSRF lewat router dashboard yang sebenarnya.
- `tests/dashboard-jointocreate-settings-ui.test.js`: halaman pengaturan di jsdom. Escape data, hanya bidang yang berubah yang dikirim, konfirmasi, pesan penolakan.

Tes PostgreSQL dilewati, bukan lulus, bila `ZENTIX_TEST_PG_SOCKET` tidak disetel.

## Sebelum dipakai di server sungguhan

1. Jalankan di server Discord uji: setup, masuk/keluar trigger oleh beberapa akun sekaligus, pemilik keluar, hapus channel manual, matikan bot di tengah create lalu nyalakan lagi.
2. Periksa izin bot pada kategori trigger: Manage Channels, Move Members, Connect.
3. Buka halaman pengaturan di dashboard dengan login sungguhan: aktifkan trigger, ubah pengaturan, lalu pastikan channel sementara berikutnya mengikuti.
