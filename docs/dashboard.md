# Dashboard web — inventaris integrasi

Inventaris kode per perubahan dashboard ini, bukan sertifikasi produksi. **Live** di bawah berarti halaman memiliki jalur ke bot/API saat dashboard disajikan bot melalui `/dashboard/`; ia tetap memerlukan login, izin, database dan layanan pendukung. Pengujian lokal memakai PostgreSQL disposable, Discord tiruan dan jsdom; event keluar juga diuji dengan pengiriman Discord tiruan. Belum membuktikan OAuth, Discord, Lavalink, provider, Neon atau Wispbyte pada deployment sebenarnya. Ada dua cara login: token (`DASHBOARD_TOKEN` + `OWNER_IDS`, diketik di `/dashboard/login` atau dibawa tautan `/masuk/<token>`) dan Discord OAuth. Login Discord bawaannya hanya pada alamat `https://`; alamat `http://ip:port` memerlukan `DASHBOARD_ALLOW_HTTP=true`. Lewat `http://`, token dan sesi tidak terenkripsi dengan cara login mana pun (lihat [`docs/hosting.md`](hosting.md)). Preview statis (`dashboard-preview/` disajikan sendiri) hanya simulasi; jangan masukkan rahasia atau data pribadi.

## Status awal pekerjaan bertahap

| Area | Yang sudah punya jalur live | Batas utama / sisa pekerjaan |
|---|---|---|
| Overview | Status bot; pemakaian sistem (CPU, RAM, jaringan, disk) setiap 3 detik untuk owner bot; akses cepat | Angka diukur bot di dalam kontainernya sendiri dan belum dibandingkan dengan panel hosting sungguhan. Lihat "Overview — pemakaian sistem dan akses cepat". |
| Welcome & verification | Welcome, **Goodbye non-AI**, verification dan pengiriman panel verification | Goodbye hanya PostgreSQL; tampilan preview lokal tanpa mengirim. Perubahan pengaturan tidak membuktikan pesan berhasil dikirim saat anggota keluar. |
| Moderation | Daftar kasus dan tindakan melalui operasi dashboard | Efek Discord dan penyimpanan bukan transaksi bersama; pemeriksaan izin/hierarki dan hasil nyata perlu diuji. |
| Ticket | Konfigurasi, panel, daftar/detail, aksi dan transcript terbatas. Aksi yang ditolak service (tiket sudah diklaim, sudah tertutup, atau baru saja diubah) dijawab 409 dengan alasannya | Transcript bergantung channel yang tersedia; tindakan Discord dan database dapat berbeda hasilnya. Lihat [`docs/audit/tiket.md`](audit/tiket.md). |
| Leveling & economy | Pengaturan leveling, leaderboard, pencarian anggota serta sebagian pengelolaan | Reward role: lihat bagian "Role hadiah leveling"; belum diuji di Discord nyata. Role premium: lihat bagian "Ekonomi — role premium"; belum diuji di Discord nyata. Jangan sambungkan poin Activities ke wallet. |
| Music | Player, antrean, pencarian dan kontrol yang didukung | Memerlukan Lavalink dan Discord; perilaku langsung dan resource hosting belum diuji. |
| Logging | Pengaturan dan riwayat terbatas dari channel audit | Bukan riwayat lengkap semua event; bergantung pada izin dan pesan yang tersedia. |
| Birthday | Channel pengumuman serta lihat, tambah, ubah, atau hapus tanggal pada PostgreSQL; perubahan dicatat ke channel audit bila logging aktif | Penulis lama tidak atomik dan perlu dihentikan saat upgrade. Scheduler dan Discord perlu diuji langsung; catatan audit bersifat best-effort. |
| AI Studio | Jalur untuk welcome/goodbye AI, Activities, chat, pengetahuan, tools, gambar, builder dan fondasi provider. Semua khusus owner bot; akun lain diberi label | Beberapa fungsi memerlukan provider/biaya/izin dan konfirmasi. Tidak ada opsi simulasi di dashboard login (lihat "Audit simulasi"). Lihat [`docs/tahap-8.md`](tahap-8.md); label live tidak membuktikan provider sehat. |
| Pengaturan utama | Pusat kendali baca-saja: kondisi server dan izin bot di Discord, penyimpanan, dasar akses sesi, status konfigurasi hosting, pintasan ke halaman fitur | Tidak menyimpan atau mengubah apa pun. Izin yang ditampilkan adalah izin tingkat server. Lihat bagian "Pengaturan utama" di bawah. |
| Core | Akses perintah dan kategori dari registry bot; baca dan ubah pada PostgreSQL | Tidak mengelola data atau konfigurasi setiap fitur; lihat [`docs/core-dashboard.md`](core-dashboard.md). |
| Giveaway | Daftar PostgreSQL; buat, akhiri, undi ulang, hapus; perbaikan pengiriman yang tertunda (tandai terkirim atau kirim ulang) | Discord dan database bukan satu transaksi; setiap aksi bisa terhenti di tengah dan perlu dilanjutkan manual. Belum diuji di Discord nyata. `/gcreate` belum memakai pembersihan pesan yatim. |
| Join to Create | Pengaturan trigger, inventaris PostgreSQL baca-saja dan pemeriksaan Discord untuk ID pending yang tercatat | Web hanya mengubah pengaturan tersimpan; pengelolaan channel sementara dan rekonsiliasi tidak tersedia di web. |
| Server Stats | Counter jumlah anggota: daftar PostgreSQL dengan status nama channel; buat, ubah jenis dan hapus | **Bertindak di Discord**: membuat dan menghapus channel. Discord dan database bukan satu transaksi. Tidak ada tombol segarkan. Belum diuji di Discord nyata. Lihat [`docs/audit/server-stats.md`](audit/server-stats.md). |
| Reaction Roles | Panel pilih role: daftar PostgreSQL dengan status pesan; buat, ubah teks, tambah/lepas role, gambar ulang, pasang ulang dan hapus | **Bertindak di Discord**: mengirim, mengubah dan menghapus pesan. Discord dan database bukan satu transaksi; pesan dapat tertinggal dari catatan sampai digambar ulang. Belum diuji di Discord nyata. Lihat [`docs/audit/reaction-roles.md`](audit/reaction-roles.md). |
| Fun | Permainan hitung: keadaan dan papan skor dari PostgreSQL; aktifkan, ganti sistem, mulai ulang, nonaktifkan | Hanya mengubah pengaturan tersimpan; tidak mengirim atau menghapus pesan Discord. Angka yang tampil adalah keadaan saat halaman dimuat, bukan tampilan langsung. `/roll`, `/fight`, `/flip` tidak punya pengaturan. Belum diuji di Discord nyata. Lihat [`docs/audit/fun.md`](audit/fun.md). |
| Search | Tidak ada halaman: kategori ini tidak menyimpan pengaturan. Indeks fitur menampilkannya di blok "tanpa halaman sendiri" dengan tautan ke Akses perintah | Tiap subperintah (`search define`, `search google`, `search urban`) dapat dimatikan per server di Akses perintah. Pembatas channel berbatas usia untuk `search urban` tidak dapat diatur dari dashboard. Lihat [`docs/audit/search.md`](audit/search.md). |
| Utility | Tidak ada halaman: kategori ini tidak punya pengaturan server sendiri. Indeks fitur menampilkannya di blok "tanpa halaman sendiri" dengan tautan ke Logging dan Akses perintah | Daftar to-do adalah data pribadi anggota dan hanya dikelola lewat `/todo`. Channel `/report` diatur di halaman Logging ("Channel reports"). Tiap perintah dapat dimatikan per server di Akses perintah. Lihat [`docs/audit/utility.md`](audit/utility.md). |
| Community | Lamaran role: pengaturan (aktif/nonaktif, role pengelola, masa simpan) dan formulir lamaran (buat, ubah nama dan pertanyaan, buka/tutup, hapus) dari PostgreSQL | Hanya mengubah pengaturan tersimpan. Isi lamaran dan keputusannya tidak ada di web; lamaran dibaca dan diputuskan di Discord. Channel log hanya ditampilkan keadaannya. Menghapus formulir ikut menghapus lamarannya. Rincian di [`docs/audit/community.md`](audit/community.md). |
| Tools | Tidak ada halaman: kategori ini tidak menyimpan pengaturan apa pun. Indeks fitur menampilkannya di blok "tanpa halaman sendiri" dengan daftar sebelas perintahnya dan tautan ke Akses perintah | Tiap perintah dapat dimatikan per server di Akses perintah. `/embedbuilder` bawaannya hanya untuk anggota dengan Manage Messages. Lihat [`docs/audit/tools.md`](audit/tools.md). |
| Kategori lainnya | Tidak ada lagi. Bagian "BELUM ADA HALAMAN" di indeks fitur kosong dan tidak ditampilkan | Setiap kategori bot sudah punya halaman atau tercatat tidak memerlukannya. |

## Goodbye non-AI

Buka **Fitur bot → Welcome & verification → Goodbye** pada dashboard bot yang telah login. Admin server dapat memilih channel, pesan, ping, gambar HTTPS dan tampilan embed. Pratinjau hanya contoh lokal, tidak mengirim pesan atau memuat URL gambar. Bot memakai teks biasa jika tidak memiliki izin embed. URL gambar dikirim ke Discord ketika pesan dikirim; jangan gunakan URL yang mengandung rahasia atau token. Pengaturan ini berbagi record PostgreSQL dengan welcome dan autorole; ketika AI Goodbye aktif, AI Goodbye menggantikan pesan non-AI ini. Cek izin channel dan konfigurasi AI sebelum mencoba langsung.

API `GET /dashboard/api/bot/goodbye` dan `PATCH /dashboard/api/bot/goodbye` memakai autentikasi dashboard; PATCH juga memerlukan Origin dan CSRF valid. Saat menyimpan, transaksi mengunci guild lalu welcome dan menolak revisi yang usang. Perubahan welcome melalui bot atau dashboard membuat revisi goodbye usang; salin perubahan yang belum disimpan, muat ulang, lalu terapkan kembali. Pemeriksaan revisi berbasis isi tidak mendeteksi A→B→A dan tidak memaksa SQL langsung/bot lama mengikuti aturan. Data goodbye yang bentuknya rusak ditolak untuk ditinjau, tidak di-reset. Jika koneksi putus saat commit, hasil penyimpanan bisa tidak diketahui; muat ulang dan periksa sebelum mengulang. Field lain pada record dipertahankan. SQLite belum didukung untuk halaman ini dan tetap ditunda.

Tidak ada tombol tes Discord dalam integrasi ini. Discord dan PostgreSQL tidak berada dalam satu transaksi; pesan dapat gagal, event dapat terduplikasi, dan event join/leave lama masih punya fallback default ketika pembacaan database gagal. Pengujian langsung di server uji, serta prosedur pemulihan dan hosting, masih diperlukan sebelum produksi.

## Birthday

Buka **Fitur bot → Birthday** pada dashboard bot yang diautentikasi. Owner atau administrator dapat memilih channel teks untuk pengumuman atau memilih **Nonaktif**. Server memeriksa izin View Channel, Send Messages dan Embed Links saat menyimpan, tetapi izin dan keberadaan channel dapat berubah kemudian. Scheduler bot memakai tanggal **UTC** dan pengaturan channel ini; role birthday opsional tetap diatur di luar halaman ini. Saat channel dinonaktifkan, scheduler juga melewati pembersihan role birthday pada siklus itu; periksa role secara manual bila perlu. Menyimpan tidak mengirim pesan percobaan atau menjamin scheduler berjalan.

Daftar menampilkan ID serta hari/bulan maksimal 50 per halaman, tanpa tahun. Owner/admin dapat mengubah atau menghapus entri yang sudah ada setelah konfirmasi; fitur ini memberi admin kemampuan mengubah data anggota lain, jadi pastikan ada dasar dan izin yang sesuai. Penambahan entri baru dan catatan audit dijelaskan di bawah. Pengubahan memeriksa keanggotaan melalui Discord; penghapusan entri aktif tetap dapat dilakukan tanpa pemeriksaan itu. Penghapusan ini bukan penghapusan menyeluruh dari backup database atau salinan lain. Ini data pribadi: akses dibatasi owner/admin, respons no-store, dan tidak tersedia di preview statis. Data bisa berubah antarhalaman atau tampak sementara tidak lengkap jika penulis bot lama masih aktif; halaman bukan snapshot atau backup. Data tanggal tidak valid pada halaman ditolak untuk ditinjau. Jangan bagikan screenshot atau ekspor tanpa kebutuhan dan izin.

API `GET /dashboard/api/bot/birthday/settings`, `PATCH /dashboard/api/bot/birthday/settings`, `GET /dashboard/api/bot/birthday/list`, `GET /dashboard/api/bot/birthday/member/:userId`, `POST /dashboard/api/bot/birthday/member` dan `PATCH /dashboard/api/bot/birthday/member/:userId` memerlukan autentikasi; POST dan PATCH memerlukan Origin dan CSRF. PATCH pengaturan channel mengunci record guild lalu welcome dan menolak jika channel yang dilihat sudah berubah. Deteksi berdasarkan nilai channel tidak mendeteksi A→B→A; penulis SQL langsung atau bot lama dapat mengabaikan penguncian. Perubahan bidang lain dipertahankan. Jika status commit tidak diketahui, muat ulang dan periksa sebelum mencoba lagi. SQLite belum didukung.

**Jangan gunakan daftar sebagai bukti data aman:** versi lama bot memakai read-modify-write seluruh daftar dan DELETE/INSERT tanpa transaksi. Jalur bot versi ini memakai transaksi per anggota, termasuk perpindahan cadangan saat keluar/bergabung, dan menolak mutasi map melalui API generik. Hal ini hanya melindungi penulis yang mengikuti aturan tersebut: hentikan semua instans versi lama sebelum upgrade, dan jangan jalankan migrasi atau SQL manual bersamaan. Tidak ada perbaikan otomatis untuk data yang sudah hilang. Backup dan prosedur pemulihan yang diuji tetap diperlukan. Tes scheduler menggunakan Discord tiruan, bukan pengujian penjadwalan atau pengiriman live.

Transaksi Birthday PostgreSQL mengunci guild dan memperbarui satu anggota. Saat memindahkan atau memulihkan, backup yang rusak, berakhir masa berlaku, atau berbenturan dengan tanggal aktif ditolak untuk ditinjau tanpa overwrite. Data legacy birthday yang ambigu juga ditolak saat operasi. Kegagalan event keluar/bergabung dicatat tetapi tidak dicoba ulang otomatis; event yang hilang atau diterima tidak berurutan masih perlu pemulihan manual. `/birthday list` dan `/birthday next` tidak lagi menghapus tanggal hanya karena Discord gagal menemukan anggota. Penyimpanan backup bukan pengganti backup database, dan hasil commit ketika koneksi terputus bisa tidak diketahui.

Saat edit/hapus tanggal, API menolak jika entri sudah berubah atau hilang sejak daftar dimuat, jika backup anggota keluar masih ada, atau jika data legacy ambigu. Setelah konflik, muat ulang; jangan menimpa tanpa pemeriksaan. Pemeriksaan tanggal berbasis nilai tidak mendeteksi perubahan A→B→A. Pengecekan anggota Discord tidak atomik dengan transaksi database; anggota dapat keluar sesudah pemeriksaan. Event keluar/bergabung dan operasi dashboard yang memakai versi ini berbagi kunci transaksi; instans lama atau SQL langsung tidak dilindungi. Hasil commit yang terputus bisa tidak diketahui. Halaman daftar memeriksa konflik legacy dalam snapshot baca per halaman, tetapi bukan snapshot stabil antarhalaman.

### Menambah tanggal lewat web

Panel **Tambah tanggal** bekerja dalam dua langkah, untuk anggota yang belum mempunyai tanggal:

1. Masukkan ID Discord anggota (17–20 digit) lalu **PERIKSA ANGGOTA**. Server bertanya langsung ke Discord (bukan cache) dan menampilkan nama anggota itu. Jawaban hanya menyebut apakah tanggal sudah ada, tidak menampilkan tanggalnya.
2. Isi hari dan bulan, lalu konfirmasi. Dialog konfirmasi menyebut tanggal, nama dan ID.

Yang ditolak, tanpa mengubah data apa pun:

| Keadaan | Hasil |
|---|---|
| Anggota sudah punya tanggal | 409. Pakai **KELOLA** pada daftar; penambahan tidak pernah menimpa tanggal yang sudah ada, termasuk yang baru saja diisi anggota lewat `/birthday set`. |
| Ada cadangan saat anggota keluar untuk ID itu | 409, perlu ditinjau. Cadangan dapat berisi tanggal lain dan tidak ditimpa. |
| Bukan anggota server, atau Discord tidak dapat memastikan | 409 |
| Akun bot | 400 |
| Tanggal tidak ada di kalender (30 Februari, 31 April), isi tidak lengkap, atau tanpa konfirmasi | 400 |
| Data legacy Birthday yang ambigu | 409 |
| Database tidak tersedia | 503 |

Batasnya: pemeriksaan anggota dan penyimpanan bukan satu transaksi. Anggota yang keluar tepat di antara keduanya dapat tetap tercatat; scheduler melewati anggota yang sudah tidak ada, tetapi catatannya tinggal sampai dihapus lewat **KELOLA**. Jika koneksi terputus saat menyimpan, hasilnya bisa tidak diketahui: muat ulang daftar dan periksa sebelum mengulang. Pencarian anggota berdasarkan nama belum ada; ID diambil dari Discord (Mode Pengembang → Salin ID Pengguna).

### Catatan audit perubahan

Setiap tambah, ubah dan hapus dari dashboard dikirim ke channel audit bot sebagai event `moderation.config`, berisi aksi, anggota yang datanya diubah dan admin yang melakukannya. **Tanggalnya sendiri tidak ditulis** ke channel, karena itu data pribadi. Catatan ini best-effort: tidak terkirim bila logging mati, event itu dinonaktifkan, channel audit belum diatur, atau bot tidak punya izin; kegagalan mengirim tidak membatalkan perubahan dan tidak ditampilkan di dashboard. Ini bukan riwayat yang lengkap atau tahan-ubah, dan perubahan lewat perintah bot (`/birthday set`, `/birthday remove`) tidak dicatat di sini.

### 29 Februari dan tanggal UTC

Aturannya ada di satu tempat, `src/utils/birthdayDates.js`, dan dipakai oleh web, `/birthday set`, `/birthday next`, daftar "hari ini" dan scheduler:

- 29 Februari selalu dapat disimpan, di tahun apa pun. `/birthday set` tidak lagi menolaknya pada tahun non-kabisat.
- Pada tahun tanpa 29 Februari, ulang tahun itu dirayakan pada **28 Februari**. Pada tahun kabisat dirayakan pada 29 Februari saja. Jadi tepat satu pengumuman per tahun. Untuk memakai 1 Maret, ubah `LEAP_DAY_FALLBACK` di file tersebut.
- "Hari ini" dan "berapa hari lagi" memakai tanggal kalender **UTC**, bukan zona waktu mesin. `/birthday next` sekarang sepakat dengan scheduler tentang siapa yang berulang tahun hari ini.
- Scheduler harian dipatok ke **06.00 UTC** (13.00 WIB). Sebelumnya ia berjalan pukul 06.00 zona waktu mesin tetapi mencocokkan tanggal UTC, sehingga pada mesin ber-zona WIB yang diumumkan adalah ulang tahun hari sebelumnya. Pada mesin yang sudah UTC tidak ada perubahan jam.

Belum ada pengaturan zona waktu per server: anggota di WIB menerima ucapan pukul 13.00 pada tanggal yang benar menurut UTC. Scheduler tidak mencatat tanggal terakhir yang sudah diumumkan; bot yang mati pada pukul 06.00 UTC melewatkan hari itu dan tidak mengejarnya.

## Giveaway PostgreSQL

Buka **Fitur bot → Giveaway** sebagai owner atau administrator. Daftar memuat maksimal 50 record per halaman menurut ID pesan; bukan snapshot lintas halaman. Status, waktu dan jumlah entri adalah data tersimpan, bukan verifikasi kondisi Discord, keanggotaan atau kelayakan peserta. Identitas peserta/pemenang tidak dikirim dalam daftar. Preview statis tidak mengakses database.

Dashboard dapat **mengakhiri** giveaway aktif atau **mengundi ulang** giveaway yang pengirimannya tercatat `delivered`. Setelah data terbaru dibaca, pengguna harus mengonfirmasi bahwa bot akan mengedit pesan dan mengirim atau memperbarui pengumuman Discord. Aksi memakai autentikasi, origin, CSRF, validasi, dan pemeriksaan revisi. Pemenang dipilih di server dalam transaksi, bukan di browser. Jika data berubah selama pemeriksaan, muat ulang. Revisi berbasis isi dan ID tidak mendeteksi A→B→A.

Database dan Discord tidak atomik. Bila hasil simpan/pengiriman tidak diketahui atau bertanda `pending`, periksa Discord sebelum tindakan apa pun; bot tidak pernah mengulang sendiri. Hasil lama tanpa catatan pengiriman `delivered` belum bisa diundi ulang. Ketersediaan pesan dan izin Discord dapat berubah setelah pemeriksaan.

### Membuat, menghapus dan memperbaiki pengiriman

Semua aksi di bawah memakai autentikasi, Origin, CSRF, konfirmasi, dan revisi dari data yang baru dibaca. Setiap pesan galat menyebut sisi mana (Discord atau database) yang mungkin sudah berubah.

**Buat.** Panel **Buat Giveaway** meminta channel, hadiah, jumlah pemenang (1–10) dan durasi (5 menit sampai 30 hari, batas yang sama dengan `/gcreate`). Hanya channel teks tempat bot boleh melihat, mengirim pesan dan menyematkan tautan yang ditawarkan, dan izin itu diperiksa lagi saat membuat. Host adalah admin yang login. Bot mengirim pesan publik lebih dulu, lalu menyimpan catatan:

| Yang terjadi | Hasil |
|---|---|
| Discord menolak pesan | Tidak ada pesan, tidak ada catatan. |
| Pengiriman pesan timeout | Pesan mungkin ada; catatan tidak ditulis. Periksa channel dan hapus pesannya bila ada. |
| Catatan gagal disimpan dan dipastikan tidak ada | Bot menghapus lagi pesannya. Tidak ada yang tertinggal. |
| Catatan tidak dapat dipastikan (database terputus) | Pesan dibiarkan dan ID-nya ditampilkan. Periksa daftar; bila catatan tidak ada, hapus pesan di Discord. |
| Commit berhasil tetapi balasannya hilang | Dianggap berhasil setelah catatan terbaca. |

Dua pembuatan bersamaan dalam satu proses bot ditolak salah satunya. Jika browser kehilangan balasan, periksa daftar sebelum mengulang; pengulangan membuat giveaway kedua.

**Hapus.** Bot menandai catatan (sejak itu tombol Join, akhiri, undi ulang dan scheduler menolak giveaway tersebut), menghapus pesan Giveaway di Discord, lalu menghapus catatan beserta semua entrinya. Pengumuman pemenang yang sudah ada **tidak** dihapus. Tidak ada pemulihan setelah terhapus.

- Pesan atau channel yang sudah tidak ada di Discord tidak menghalangi: catatannya tetap dihapus.
- Jika Discord tidak dapat diperiksa, atau pesan itu ternyata bukan milik bot, tidak ada yang diubah. Halaman lalu menawarkan **HAPUS CATATAN SAJA**, yang tidak menyentuh Discord sama sekali; pesan yang masih ada harus dihapus sendiri.
- Jika Discord menolak penghapusan (izin), tanda dicabut lagi dan giveaway tetap berjalan.
- Jika terhenti di tengah (timeout, database terputus), baris tampil sebagai **PENGHAPUSAN BELUM SELESAI** dan tetap beku sampai **LANJUTKAN HAPUS** atau **HAPUS CATATAN SAJA** dijalankan.
- Jika ada yang bergabung atau giveaway berakhir setelah halaman dimuat, penghapusan ditolak dan harus dikonfirmasi ulang.

**Pengiriman tertunda.** Setelah memeriksa channel, admin memilih salah satu:

- **TANDAI TERKIRIM**: pengumuman pemenang memang sudah ada. Bot tidak mengirim apa pun; pemenang tidak berubah. Sesudahnya giveaway bisa diundi ulang.
- **KIRIM ULANG**: pengumuman belum ada. Bot mengedit pesan giveaway dan mengumumkan pemenang **yang sama**, tanpa undian baru. Bila pengumuman pertama ternyata sudah terkirim, akan ada dua pengumuman.
- **HAPUS**: membuang giveaway itu.

Ketiganya ditolak selama dua menit sejak pengiriman dimulai, karena pengiriman itu mungkin masih berjalan. Kirim ulang yang gagal kembali tertunda dan baru bisa dicoba lagi dua menit kemudian.

**Catatan audit.** Buat, hapus, tandai terkirim dan kirim ulang dari dashboard dikirim ke channel audit bot (event `giveaway.create`, `giveaway.delete`, `giveaway.winner`) bila logging aktif. Best-effort: kegagalan mencatat tidak membatalkan aksi dan tidak tampil di dashboard.

**Yang belum ada:** mengubah giveaway yang sudah dibuat; menghapus catatan yang datanya rusak (ditandai PERLU DIPERIKSA; masih perlu SQL manual); pengaman pembuatan ganda antar-proses; pembersihan pesan yatim pada `/gcreate`.

**Upgrade:** hentikan semua instance lama dan penulis lain, backup dan periksa data, timestamp UTC serta catatan legacy sebelum memakai versi ini. Penulis lama dan SQL langsung masih bisa mengabaikan protokol. Lihat [`docs/giveaway-pg.md`](giveaway-pg.md) untuk syarat, perilaku pembuatan, scheduler dan batas pemulihan. Pengujian memakai PostgreSQL lokal dan Discord mock, belum Discord atau deployment nyata.

## Join to Create PostgreSQL — pengaturan trigger dan inventaris

Buka **Fitur bot → Join to Create** sebagai owner/admin. Halaman menampilkan konfigurasi key utama dan hingga 50 channel sementara per halaman, berdasarkan ID, dari PostgreSQL. ID pemilik tidak dikirim ke browser. Respons `GET /dashboard/api/bot/join-to-create` memakai autentikasi dan `no-store`; preview statis tidak meminta data. Inventaris ini tidak memiliki endpoint atau tombol perubahan; pengaturan trigger berada pada panel terpisah di halaman yang sama (lihat di bawah). Fallback ditampilkan untuk bidang yang tidak ada pada objek tersimpan; nilai ini bukan bukti fitur berjalan. PostgreSQL yang tidak tersedia ditolak, bukan dianggap konfigurasi kosong. Record kedaluwarsa ditandai terpisah; data invalid, wrapper legacy atau lebih dari 512 KiB ditolak untuk pemeriksaan. Keberadaan key channel terpisah atau key dalam cache diberi peringatan, bukan digabung otomatis. Deteksi ini terbatas pada key yang dikenal, bukan audit menyeluruh.

Data adalah inventaris tersimpan, **bukan status Discord aktual**: channel bisa sudah dihapus, hilang dari data, memiliki izin berbeda atau tersisa setelah kegagalan. Pagination membaca ulang record dan bukan snapshot antarhalaman. Periksa Discord secara langsung sebelum tindakan. Kategori yang tercatat pada data lama tidak dipakai untuk pembuatan channel: bot memakai parent trigger. Cleanup tetap berjalan saat fitur nonaktif, tetapi event yang gagal diproses tidak diulang sampai bot menyala lagi. Jangan menganggap halaman ini menjamin cleanup atau fungsi otomatis berjalan.

Semua penulis bot sekarang memakai satu protokol transaksi PostgreSQL, sehingga perubahan bersamaan dari perintah dan event tidak lagi saling menimpa. Panel **Pengaturan trigger** memakai protokol yang sama: mengaktifkan Join to Create pada channel suara yang sudah ada, mengubah template nama, batas user dan bitrate, serta melepas trigger. Perubahan memerlukan login owner/admin, Origin, CSRF dan konfirmasi; simpan ditolak bila pengaturan berubah sejak halaman dimuat. Web tidak membuat atau menghapus channel Discord, dan channel sementara tidak dapat dikelola dari web. Perintah `/jointocreate` tetap tersedia. SQL langsung dan restore tidak menghormati kunci protokol. Halaman ini tidak memperbaiki data. Pengujian menggunakan PostgreSQL lokal dan Discord tiruan, bukan deployment atau Discord live.

Rincian protokol, pemulihan dan risiko: lihat [`docs/join-to-create-pg.md`](join-to-create-pg.md).

Inventaris Join to Create juga memperingatkan metadata create tertunda bila ditemukan, dengan ID channel hanya bila sudah tercatat dan tanpa token atau ID pemilik. Status ini bukan verifikasi Discord; metadata yang tidak valid ditolak. Create tertunda wajar terlihat selama beberapa detik; bot menyelesaikannya sendiri pada event berikutnya atau saat menyala. Web tidak menyediakan pembatalan atau rekonsiliasi.

Jika metadata pending memuat ID channel (tahap `created`; runtime bot saat ini tidak mencatat tahap ini, jadi tombol ini biasanya tidak muncul), tidak ada konflik key dan record tidak memiliki TTL, owner/admin dapat memilih **Periksa ID di Discord**. Pemeriksaan hanya membaca ID yang sedang tersimpan, memanggil Discord dengan fresh fetch, lalu membandingkan ulang record database. Hasil “channel suara” hanya menunjukkan respons Discord pada saat pemeriksaan, bukan bukti bahwa channel dibuat oleh operasi tersebut, siapa pemiliknya, izin yang berlaku, atau bahwa channel masih ada setelah itu. Gagal/mismatch/timeout bukan bukti channel tidak ada; periksa manual sebelum mengambil tindakan. Tidak ada pembatalan, perbaikan, atau retry create dari tombol ini.

`GET /dashboard/api/bot/join-to-create/pending-check?channelId=…` memerlukan login owner/admin dan `no-store`; ID dari browser hanya pembanding, sementara ID untuk Discord diambil dari database. Pemeriksaan ditolak pada data invalid, konflik key, TTL, perubahan record, atau bot tidak siap. Perbandingan isi tidak mendeteksi A→B→A; kondisi Discord juga bisa berubah sesaat setelah fetch. Pembatas satu request aktif dan jeda dua detik bersifat per proses, bukan batas terdistribusi; timeout delapan detik tidak membatalkan permintaan Discord yang sudah berjalan. Jika request itu macet, pemeriksaan berikutnya diblokir sampai selesai atau proses restart. Pengujian menggunakan Discord mock, bukan Discord live. Alur penulis pending masih prototipe dan belum diaktifkan pada bot.

## Role hadiah leveling

Rincian audit: [`docs/audit/reward-role.md`](audit/reward-role.md).

- **Halaman leveling** menampilkan setiap role hadiah yang tersimpan dengan keadaannya: dapat diberikan, atau alasan bot tidak dapat atau tidak boleh memberikannya (role hilang, dikelola integrasi, memiliki izin pengelolaan atau moderasi, berada di atas role bot, bot tanpa Manage Roles). Keadaan dibaca dari cache role bot.
- **Menambah dan menghapus hadiah** dilakukan di kolom "Hadiah role" (satu baris `level:ID role`) atau lewat `/level dashboard` di Discord. Halaman web mengirim seluruh daftar saat disimpan. Role yang tidak dapat atau tidak boleh diberikan ditolak dengan menyebut level dan alasannya; selama daftar masih memuat role seperti itu, pengaturan leveling tidak dapat disimpan dari web.
- **Halaman usang:** bila pengaturan leveling berubah di tempat lain setelah halaman dimuat (misalnya hadiah ditambahkan lewat `/level dashboard`), simpan ditolak (409) dan halaman harus dimuat ulang. Tanpa ini halaman lama menghapus perubahan tersebut.
- **Tombol "Sinkronkan role hadiah"** memberikan role yang belum dimiliki anggota yang levelnya sudah mencukupi. Meminta konfirmasi, berjalan di latar belakang, hanya menambah role, dan hasilnya (anggota diperiksa, role diberikan, role bermasalah, error) tampil di halaman. Satu sinkronisasi per server pada satu waktu; setelah selesai, tunggu satu menit sebelum mengulang. Riwayatnya hilang saat bot dinyalakan ulang.
- **Ubah level anggota** (pencarian anggota) memberikan role hadiah setelah level tersimpan dan menampilkan jumlah role yang diberikan dan yang tidak. Menurunkan level tidak mencabut role.

## Ekonomi — role premium

Rincian audit: [`docs/audit/ekonomi.md`](audit/ekonomi.md).

- **Tab ekonomi** memuat satu pengaturan: role premium, yaitu role yang diberikan bot kepada anggota yang membeli item Premium Role dengan `/buy`.
- **Role yang tidak dapat dijual** tetap tampil di daftar dengan keterangan "tidak dapat dijual" dan pilihannya dinonaktifkan: role dengan izin pengelolaan atau moderasi server, role yang tidak berada di bawah role bot, dan semua role bila bot tidak memiliki Manage Roles. Role integrasi dan `@everyone` tidak ditampilkan. Aturannya sama dengan role hadiah leveling.
- **Keadaan role tersimpan** ditulis di bawah pilihan: belum dipilih (item tidak dapat dibeli), dapat diberikan, atau tidak dapat dijual beserta alasannya. Bila role tersimpan tidak dapat dijual, pembelian ditolak tanpa memotong saldo sampai role diganti. Keadaan dibaca dari cache role bot dan dimuat ulang setelah menyimpan.
- **Menyimpan** role yang tidak dapat dijual ditolak server (400) dengan alasannya, juga bila permintaan tidak datang dari halaman ini. Mengosongkan pilihan diperbolehkan.
- **Ubah wallet dan bank anggota** (pencarian anggota) tidak berubah dalam audit ini.
- Simbol dan nama mata uang tidak ada di web; keduanya disetel lewat `/economy dashboard` di Discord dan hanya berlaku di panel itu.

## Overview — pemakaian sistem dan akses cepat

Susunan halaman ringkasan sejak 14 November 2026: "01 / KONDISI SERVER", "02 / PEMAKAIAN SISTEM", lalu "03 / AKSES CEPAT" di paling bawah. Bagian "03 / HOSTING" dan "Dibuat untuk lebih dekat." dihapus; tautan ke Fitur bot, AI studio dan Pengaturan sekarang hanya ada di AKSES CEPAT.

| Yang ditampilkan | Asal | Catatan |
|---|---|---|
| CPU, RAM, jaringan, disk | `GET /dashboard/api/bot/system-usage`, setiap 3 detik | Hanya owner bot. Admin lain melihat "KHUSUS OWNER BOT" dan halaman berhenti bertanya. |
| "● LIVE · RUNNING" | Status server dari panel hosting | Hanya bila `HOSTING_*` diisi; tanpa itu "● LIVE". |
| "—" | Nilai yang tidak diketahui | Bacaan pertama (belum ada selisih), berkas yang tidak terbaca, folder yang masih dihitung. Tidak pernah ditulis 0. |
| Label "· TINGGI" dan batang lime | Pemakaian 90% atau lebih dari batasnya | Tanpa batas (kuota disk kosong) batang tetap kosong. |

- Preview statis (`/preview/`) menampilkan angka contoh berlabel "CONTOH" dan tidak memanggil apa pun.
- Halaman berhenti bertanya saat tab tersembunyi atau halaman lain dibuka, dan mulai lagi saat kembali. Setelah galat ia mencoba lagi tiap 15 detik.
- Semua nilai dari server ditulis sebagai teks.
- Cara menghitung tiap angka dan batasannya: [`docs/hosting.md`](hosting.md), bagian "Pemakaian sistem di halaman ringkasan".
- Endpoint lama `GET /dashboard/api/bot/hosting` tetap ada; hanya tombol "Periksa koneksi" di Pengaturan yang memakainya.
- Tes: `tests/system-usage.test.js` (17) dan `tests/system-usage-dashboard.test.js` (15).

## Pengaturan utama — pusat kendali baca-saja

Halaman `#settings` pada `/dashboard/` membaca `GET /dashboard/api/bot/control-center`. Di luar `/dashboard/` halaman tetap berupa kartu statis berlabel "Preview statis" dan tidak mengirim permintaan apa pun.

Halaman ini **tidak menyimpan dan tidak mengubah apa pun**. Setiap pengaturan tetap diubah di halaman fiturnya; halaman ini menyediakan pintasan ke sana.

### Yang ditampilkan dan asalnya

| Panel | Isi | Asal |
|---|---|---|
| Server di Discord | Nama, ID, jumlah anggota, owner, status gateway, ping, lama aktif, peran tertinggi bot dan jumlah peran di atasnya, 14 izin bot | Cache Discord milik bot pada saat permintaan. Bukan data tersimpan. |
| Penyimpanan | Jenis database (`postgresql`, `sqlite`, `memory`, `none`) dan status `connected`, `degraded` (bot jatuh ke mode cadangan) atau `unavailable` | Status wrapper database bot. |
| Akses & izin | Akun, dasar akses (owner server atau Administrator), apakah owner bot, waktu sesi berakhir, daftar peran ber-Administrator (maksimum 50) | Sesi dashboard dan peran server di Discord. |
| Koneksi hosting | Sudah dikonfigurasi atau belum; tombol "Periksa koneksi" yang memanggil endpoint statistik hosting yang sudah ada | Environment bot. Hanya owner bot (`OWNER_IDS`); orang lain menerima `null`. |

Nilai yang tidak dapat dibaca dikembalikan sebagai `null` dan ditampilkan sebagai "tidak tersedia", bukan sebagai nol atau "baik".

### Batasan

- Izin bot yang ditampilkan adalah izin **tingkat server**. Pengaturan per channel dan urutan peran tetap dapat menghalangi bot di tempat tertentu; halaman ini tidak memeriksanya.
- Kolom "contoh pemakai" pada tabel izin adalah petunjuk, bukan daftar lengkap fitur yang memerlukan izin tersebut.
- Status penyimpanan berasal dari status internal bot, bukan dari kueri baru ke database saat halaman dibuka.
- Jumlah anggota dan daftar peran berasal dari cache bot dan dapat tertinggal dari Discord.
- "Dikonfigurasi" pada hosting berarti nilai environment ada dan bentuknya benar. Itu tidak membuktikan panel menjawab; gunakan tombol periksa.
- URL panel, ID server, kunci API dan nilai environment lain tidak pernah dikirim ke browser.
- Halaman tidak memperbarui diri; gunakan "Muat ulang".
- Prefix perintah tidak ditampilkan dan tidak dapat diubah dari halaman ini.
- Diuji dengan Discord tiruan dan jsdom saja, belum pada server Discord atau browser nyata.

## Audit simulasi — halaman fitur dan AI Studio

Pertanyaan audit: di dashboard yang sudah login (`/dashboard/`), opsi mana yang masih simulasi, dan opsi mana yang terhubung tetapi diberi label simulasi.

**Hasil singkat.** Tidak ada opsi simulasi yang tersisa di dashboard login. Semua formulir simulasi hanya dirender di preview statis, dan di sana sudah berlabel. Yang salah di dashboard login adalah **keterangannya**: halaman yang terhubung masih menyebut dirinya "mungkin simulasi", beberapa tab membuka formulir yang sama dengan nama berbeda, dan AI Studio menampilkan formulir yang tampak dapat dipakai kepada admin yang bukan owner bot.

### Cara mengukur

| Pengukuran | Hasil |
|---|---|
| Elemen simulasi (`data-form`, `data-ai-form`, `data-sim-action`, `data-ai-action`) di setiap tab dashboard login | 0 di 30 tab (17 tab fitur, 12 tab AI, halaman provider) |
| Setiap tab dimuat dari router dashboard yang asli dengan PostgreSQL | Semua pembacaan dijawab 200, kecuali riwayat logging (404 karena channel audit tidak dikonfigurasi di lingkungan tes) |
| Setiap kontrol formulir diubah satu per satu, lalu permintaan yang terkirim dibandingkan | 27 formulir, 174 kontrol: 168 mengubah permintaan; 6 tidak dapat ditunjukkan di jsdom (lihat di bawah) |

Enam kontrol yang tidak dapat ditunjukkan otomatis, masing-masing sudah diperiksa di kode:

- Music, **Mode 24/7**: dikirim sebagai permintaan kedua setelah permintaan loop berhasil, jadi memerlukan player aktif.
- Pengetahuan, **OCR satu halaman PDF** dan **nomor halaman**: formulir tidak mengirim apa pun sebelum file dipilih.
- Image studio tab edit, **instruksi, ukuran, gaya**: sama, memerlukan gambar yang dipilih. Ketiga kontrol yang sama pada tab buat terbukti terkirim.

Formulir Join to Create tidak ikut pengukuran kontrol ini karena formulir setup berubah menjadi formulir trigger setelah simpan pertama; isi permintaannya sudah diuji tersendiri di `tests/dashboard-jointocreate-settings-ui.test.js`.

Dua kontrol hanya berlaku pada pilihan lain di formulir yang sama, dan halaman sudah menyebutkannya: **bahasa terjemahan** di AI tools ("Hanya untuk terjemahan") dan **izin dasar role** di Server builder ("hanya tindakan atur izin").

### Yang diperbaiki

| Sebelum | Sesudah |
|---|---|
| Semua tab fitur yang terhubung berlabel "PENGATURAN INI TERHUBUNG KE BOT · BAGIAN LAIN MUNGKIN MASIH SIMULASI"; Giveaway "… BAGIAN LAIN BELUM TERHUBUNG" | Label per tab yang menyebut apa yang dilakukan tab itu: hanya baca, tersimpan, atau langsung berlaku di Discord |
| Ticket: tab **Kotak masuk** dan **Transcript** membuka daftar tiket yang sama. Music: tab **Player** dan **Pengaturan** membuka halaman yang sama | Satu tab per tampilan: "Tiket & transcript", "Player & pengaturan" |
| AI Studio: **Agent channel / Chat DM / Persona & memori** membuka satu formulir; **Rangkuman / Bahasa & fakta** satu formulir; **Rancang / Preview struktur** satu formulir | "Channel, DM & persona"; "Tools teks" dan "Pencarian web"; "Rancang & terapkan". Activities: "Preview ronde" menjadi "Status ronde" |
| Indeks AI Studio: tujuh kartu "LIHAT PREVIEW", "BEBERAPA FITUR AI MASIH SIMULASI", dan catatan "beberapa opsi masih simulasi" | "BUKA FITUR" untuk ruang yang modulnya termuat, "FITUR AI TERHUBUNG · KHUSUS OWNER BOT", dan catatan yang menjelaskan arti kedua label |
| Indeks fitur: "TERHUBUNG SEBAGIAN"; tujuh kategori tanpa halaman ditampilkan dengan panah seperti tautan dan disebut "rencana" | "10 FITUR TERHUBUNG KE BOT"; kategori tanpa halaman berlabel "BELUM ADA HALAMAN", tanpa panah, dengan keterangan bahwa perintahnya tersedia di Discord |
| Admin yang bukan owner bot melihat formulir AI lengkap; penolakan baru muncul setelah menekan simpan | Setiap halaman AI Studio berlabel "KHUSUS OWNER BOT · AKUN INI BUKAN OWNER BOT · SIMPAN DAN UJI DITOLAK". `/dashboard/api/me` kini menyertakan `botOwner` |
| Overview: baris status tetap "BOT STATUS / BELUM TERHUBUNG" selama memuat dan saat gagal | "MEMUAT", lalu status bot, atau "TIDAK TERSEDIA" bila gagal |
| Deskripsi Moderation "rancang tindakan moderator", padahal tindakan langsung dijalankan | "Tinjau kasus dan tindakan moderator"; label tab menyebut tindakan langsung dijalankan di Discord |

Bila skrip sebuah ruang AI gagal dimuat, ruang itu tetap menampilkan formulir contoh dengan label simulasi, kartunya berlabel "LIHAT PREVIEW", dan indeks menyebut "SEBAGIAN RUANG AI TIDAK TERMUAT".

Preview statis tidak berubah perilakunya: semua tab lama tetap ada, semua berlabel simulasi, dan tidak ada permintaan ke API.

### Batas

- Label "terhubung" berarti halaman mengirim ke bot dan bot menjawab. Itu bukan bukti Discord, Lavalink atau provider AI berfungsi; semuanya tiruan atau tidak tersedia dalam tes.
- Formulir AI tetap ditampilkan kepada admin yang bukan owner bot, hanya diberi label. Penolakannya dilakukan server, seperti sebelumnya.
- `botOwner` dibaca dari `OWNER_IDS` saat permintaan; label mengikuti nilai saat halaman dimuat.
- Saat audit ini ada tujuh kategori tanpa halaman. Server Stats sejak itu sudah punya halaman ([`docs/audit/server-stats.md`](audit/server-stats.md)), lalu Reaction Roles ([`docs/audit/reaction-roles.md`](audit/reaction-roles.md)) dan Fun ([`docs/audit/fun.md`](audit/fun.md)), sehingga angka audit ini bertambah menjadi 33 tab, 31 formulir dan 187 kontrol. Search sudah diaudit dan sengaja tidak diberi halaman ([`docs/audit/search.md`](audit/search.md)); angka tidak berubah. Utility juga sudah diaudit dan tidak diberi halaman ([`docs/audit/utility.md`](audit/utility.md)); angka tetap. Community lalu mendapat halaman ([`docs/audit/community.md`](audit/community.md)): angka sekarang 14 ruang fitur, 34 tab, 35 formulir dan 214 kontrol, dan indeks berbunyi "14 FITUR TERHUBUNG KE BOT". Tools sudah diaudit dan tidak diberi halaman ([`docs/audit/tools.md`](audit/tools.md)); angka tetap, dan tidak ada lagi kategori berlabel "belum ada halaman".

### Tes

- `tests/dashboard-simulation-labels.test.js` (10, jsdom): tidak ada elemen atau label simulasi di dashboard login, satu tab per tampilan, isi label per tab, halaman indeks, ruang yang skripnya tidak termuat, akun bukan owner, baris status overview, preview statis, dan `botOwner` di `/api/me`.
- `tests/postgres-dashboard-live-walk.test.js` (2, memerlukan PostgreSQL): setiap tab dimuat dari router asli tanpa galat skrip, dan setiap kontrol mengubah permintaan yang terkirim. Daftar pengecualian di atas tertulis di tes beserta alasannya; kontrol baru yang tidak terkirim membuat tes gagal.
