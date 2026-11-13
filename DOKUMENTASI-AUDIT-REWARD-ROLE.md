# Audit reward role (role hadiah leveling)

Tanggal audit: 2026-11-13. Cakupan: `src/services/leveling/` (`xpSystem.js`, `leveling.js`, `levelRoleSyncService.js`, dan dua file baru `rewardRoles.js`, `postgresLevels.js`), perintah `/leveladd`, `/levelremove`, `/levelset`, menu role hadiah di `/level dashboard`, serta rute leveling di `src/dashboard/modulesApi.js` dan `src/dashboard/operationsApi.js`.

Audit dilakukan dengan membaca kode dan menjalankan tes terhadap PostgreSQL lokal dan Discord tiruan. **Tidak ada yang diuji pada server Discord nyata.**

Dokumen ini adalah bagian kedua dari butir checklist "Audit fitur tiket, reward role dan seluruh penulis ekonomi". Tiket ada di `DOKUMENTASI-AUDIT-TIKET.md`, penulis ekonomi di `DOKUMENTASI-AUDIT-EKONOMI.md`.

## Ringkasan

Dua belas masalah diperbaiki dan diuji. Sebelas keterbatasan dicatat tanpa diperbaiki. Dua masalah ditemukan di luar role hadiah itu sendiri tetapi berada di jalur yang sama, dan keduanya menyangkut data level anggota:

- di PostgreSQL, **kegagalan baca sesaat mengembalikan anggota ke level 0**: lapisan penyimpanan umum menjawab query yang gagal dengan "tidak ada data", lalu XP pesan berikutnya disimpan di atas record asli;
- di PostgreSQL, **kegagalan simpan tidak terlihat**: lapisan yang sama menjawab `false` tanpa melempar error, sehingga naik level diumumkan dan role diberikan untuk level yang tidak pernah tersimpan.

Yang paling penting dari sisi role hadiah:

- lewat `/level dashboard`, pengguna dengan izin Manage Server bisa menjadikan role apa pun sebagai hadiah level 1, termasuk role ber-izin Administrator, lalu memperolehnya dengan mengirim pesan;
- mengubah level lewat `/leveladd`, `/levelset` atau web tidak memberikan role hadiah sama sekali.

## Masalah yang diperbaiki

| ID | Masalah | Dampak sebelumnya | Perbaikan |
|---|---|---|---|
| R1 | Record level di PostgreSQL dibaca lewat lapisan key-value umum, yang menjawab query gagal dengan "tidak ada data". | Satu query yang gagal membuat anggota dianggap level 0; XP berikutnya disimpan di atas record asli. Level hilang tanpa error. | Record level PostgreSQL dibaca langsung. Query yang gagal melempar error dan tidak ada yang ditulis. |
| R2 | Penyimpanan level lewat lapisan yang sama menjawab `false` saat gagal, dan nilainya tidak diperiksa. Role dan pengumuman dikirim **sebelum** penyimpanan. | Anggota memegang role hadiah dan menerima ucapan untuk level yang tidak tersimpan. | Perubahan level di PostgreSQL kini satu transaksi (`SELECT … FOR UPDATE` sampai `UPDATE`). Role, pengumuman dan log baru dicoba setelah commit. |
| R3 | Cooldown XP di PostgreSQL diperiksa sebelum dan di luar transaksi penambahan XP. Cooldown `0` dibaca sebagai 60 detik, padahal `/level dashboard` menyatakan `0` berarti XP di setiap pesan. | Beberapa pesan yang tiba bersamaan semuanya mendapat XP. Server dengan cooldown `0` diam-diam memakai 60 detik. | Cooldown diperiksa di dalam transaksi yang sama dengan penambahan XP, seperti backend SQLite. Nilai tersimpan dipakai apa adanya, termasuk `0`; bila tidak ada, 20 detik (nilai bawaan pengaturan). |
| R4 | `/leveladd`, `/levelremove`, `/levelset` dan ubah level lewat web tidak memakai kunci yang sama dengan XP pesan. | XP pesan yang sedang diproses menimpa level yang baru diatur staf. | Semua penulis level memakai transaksi baris yang sama; di dalam proses bot juga satu kunci per anggota. |
| R5 | Role hadiah hanya diberikan untuk level yang tepat dilewati saat itu. | Role yang gagal diberikan (izin bot, gangguan Discord) atau hadiah yang ditambahkan belakangan tidak pernah menyusul sampai bot dinyalakan ulang. | Setiap naik level memberikan **semua** role hadiah sampai level baru yang belum dimiliki anggota. |
| R6 | `/leveladd`, `/levelset` dan ubah level lewat web tidak memberikan role hadiah. | Anggota yang dinaikkan staf tidak menerima role sampai bot dinyalakan ulang. | Ketiganya memberikan role hadiah setelah level tersimpan dan melaporkan hasilnya (role yang diberikan, role yang tidak diberikan beserta alasannya). |
| R7 | Menu "Add Role Reward" di `/level dashboard` menerima role apa pun. | Pengguna ber-izin Manage Server (tanpa Manage Roles) bisa menjadikan role Administrator sebagai hadiah level 1 dan memperolehnya sendiri. Role terkelola integrasi, `@everyone`, dan role di atas bot juga diterima lalu gagal diam-diam. | Satu pemeriksaan (`checkRewardRole`) dipakai di `/level dashboard`, di web, dan **setiap kali role akan diberikan**. Lihat "Role yang boleh menjadi hadiah". |
| R8 | Web hanya memeriksa bahwa role dapat dikelola bot, bukan izin role itu. | Role ber-izin pengelolaan server bisa disimpan sebagai hadiah. | Web menolak dengan menyebut level dan alasannya. Halaman leveling menampilkan keadaan tiap hadiah yang tersimpan. |
| R9 | `/level dashboard` menyimpan seluruh bagian leveling dari salinan yang dibaca saat dashboard dibuka. | Perubahan dari web selama dashboard Discord terbuka (hingga beberapa menit) terhapus oleh klik berikutnya di Discord, termasuk daftar role hadiah. | Simpan ditolak bila bagian leveling yang tersimpan sudah berbeda dari yang dibaca (`LEVELING_CONFIG_STALE`): "Leveling settings were changed somewhere else. Nothing was saved." Setelah simpan gagal, salinan di dashboard yang terbuka dikembalikan ke keadaan terakhir yang tersimpan. |
| R10 | Pengaturan leveling yang gagal dibaca di PostgreSQL dijawab dengan pengaturan bawaan. | `/level setup` yang dijalankan saat itu menimpa pengaturan asli, termasuk role hadiah. | Kegagalan baca melempar error di PostgreSQL (SQLite sudah demikian). |
| R11 | Sinkronisasi saat bot menyala mengambil daftar anggota lewat `list()`, yang di PostgreSQL menjawab daftar kosong saat query gagal; role yang tidak bisa diberikan dicoba ke setiap anggota. | Sinkronisasi yang gagal terlihat seperti "tidak ada yang perlu disinkronkan"; satu role bermasalah menghasilkan satu error per anggota. | Di PostgreSQL daftar diambil langsung dan hanya anggota yang levelnya mencapai hadiah terendah. Query gagal dihitung sebagai error. Role yang tidak boleh atau tidak bisa diberikan dihitung sekali (`unusableRewardEntries`) dan tidak dicoba. |
| R12 | Kebalikan dari R9: halaman leveling web mengirim seluruh formulir, termasuk daftar role hadiah, tanpa memeriksa apakah pengaturan berubah sejak halaman dimuat. | Halaman web yang lama terbuka lalu disimpan menghapus hadiah yang baru ditambahkan lewat `/level dashboard`. | Halaman menerima `revision` (sidik jari pengaturan tersimpan) dan mengirimnya saat menyimpan. Bila tidak cocok, server menjawab 409 "Pengaturan leveling sudah diubah di tempat lain… Tidak ada yang disimpan." Pemeriksaan dilakukan di dalam transaksi simpan. |

## Role yang boleh menjadi hadiah

Sebuah role ditolak sebagai hadiah, dan tidak diberikan walaupun sudah tersimpan, bila:

| Kode | Arti |
|---|---|
| `ROLE_MISSING` | Role sudah tidak ada di server. |
| `ROLE_EVERYONE` | Role `@everyone`. |
| `ROLE_MANAGED` | Role dikelola integrasi (role bot, booster, dan sejenisnya). |
| `ROLE_DANGEROUS` | Role memiliki salah satu izin: Administrator, Manage Server, Manage Roles, Manage Channels, Manage Webhooks, Ban Members, Kick Members. Daftar ini sama dengan yang dipakai reaction roles. |
| `BOT_NO_MANAGE_ROLES` | Bot tidak memiliki izin Manage Roles. |
| `ROLE_TOO_HIGH` | Posisi role tidak di bawah role tertinggi bot. |
| `BOT_MEMBER_UNKNOWN` | Data bot di server belum tersedia. |

Pengaturan **tidak pernah dipangkas otomatis**: hadiah yang bermasalah tetap tersimpan, ditampilkan dengan alasannya di halaman leveling, dan dilewati saat pemberian.

## Perubahan perilaku yang perlu diketahui staf

- **Role hadiah hanya ditambahkan, tidak pernah dicabut.** Menurunkan level, menghapus hadiah dari pengaturan, atau mengganti role untuk suatu level tidak mencabut role yang sudah dipegang anggota. Balasan `/levelremove` dan penghapusan hadiah kini menyebut hal ini.
- **Role ber-izin pengelolaan atau moderasi tidak bisa lagi dijadikan hadiah**, juga oleh administrator. Bila sebuah hadiah lama memakai role seperti itu, halaman leveling web menolak disimpan sampai baris itu dihapus, dan role itu tidak diberikan lagi. **Anggota yang sudah menerimanya tetap memegangnya; periksa secara manual.**
- **Anggota yang sudah melewati level** menerima role hadiah baru pada naik level berikutnya, saat bot dinyalakan, atau lewat tombol "Sinkronkan role hadiah" di web.
- **`/leveladd`, `/levelset`** menampilkan role hadiah yang diberikan dan yang tidak diberikan beserta alasannya. Level tetap tersimpan walaupun role gagal diberikan.
- **`/level dashboard` yang sudah usang** (pengaturan diubah dari web atau dashboard lain setelah dibuka) menolak menyimpan. Buka ulang dashboard.
- **Halaman leveling web yang sudah usang** (pengaturan diubah dari Discord atau tab lain setelah halaman dimuat) menolak menyimpan dengan pesan untuk memuat ulang. Isi formulir yang belum tersimpan hilang saat dimuat ulang.
- **Saat database bermasalah**, perintah leveling menjawab error; sebelumnya sebagian tampak berhasil.
- **Cooldown XP `0`** sekarang benar-benar berarti tanpa cooldown (dibatasi hanya oleh pembatas 12 pesan per 10 detik per anggota). Server yang menyimpan `0` sebelumnya berjalan dengan 60 detik; periksa nilainya bila itu tidak diinginkan. Halaman web hanya menerima 1–3600.

## Sinkronisasi manual dari web

Halaman leveling di dashboard memiliki tombol **Sinkronkan role hadiah**.

- `POST /dashboard/api/bot/leveling/reward-sync` dengan `{confirmed:true}`, sesi admin dan pemeriksaan CSRF. Jawaban `202` berarti dimulai. `409` bila leveling nonaktif, belum ada hadiah tersimpan, atau sinkronisasi server ini masih berjalan. `429` bila sinkronisasi sebelumnya selesai kurang dari satu menit lalu.
- `GET /dashboard/api/bot/leveling/reward-sync` mengembalikan keadaan: berjalan atau tidak, waktu mulai dan selesai, dan ringkasan (`membersChecked`, `rolesReAwarded`, `missingRewardEntries`, `unusableRewardEntries`, `errors`).
- Sinkronisasi berjalan di latar belakang proses bot, **hanya menambah role**, aman diulang, dan memakai fungsi yang sama dengan sinkronisasi saat bot menyala.

## Keterbatasan yang dicatat, belum diperbaiki

| ID | Keterbatasan |
|---|---|
| L1 | Discord dan database bukan satu transaksi. Level tersimpan dulu; bila proses mati sebelum role diberikan, role menyusul pada naik level berikutnya, saat bot menyala, atau lewat sinkronisasi manual. Tidak ada antrean pengiriman yang tahan mati. |
| L2 | Role tidak pernah dicabut (lihat di atas). Tidak ada mode "hanya role level tertinggi". |
| L3 | Sinkronisasi mengambil anggota satu per satu dari Discord. Pada server besar ini lambat dan bisa terkena rate limit; belum diukur. Jeda satu menit antar-sinkronisasi manual hanya berlaku per server dan per proses. |
| L4 | Keadaan sinkronisasi manual disimpan di memori. Setelah bot dinyalakan ulang riwayatnya kosong; sinkronisasi yang sedang berjalan saat proses mati tidak dilanjutkan (sinkronisasi saat menyala berjalan menggantikannya). |
| L5 | Daftar izin berbahaya tidak mencakup Timeout Members, Manage Messages, Mention Everyone, Manage Nicknames dan izin lain. Role dengan izin itu masih bisa menjadi hadiah. |
| L6 | Keadaan hadiah di halaman web dibaca dari cache role bot, tanpa bertanya ke Discord. Role yang baru saja dihapus bisa tampak "dapat diberikan" sesaat. |
| L7 | Delapan tindakan lain di `/level dashboard` (channel, pesan, rentang XP, cooldown, channel yang diabaikan, role yang diabaikan, dan dua tombol) memakai fungsi simpan yang sama sehingga juga menolak simpan saat usang. Penolakannya muncul sebagai balasan susulan; formulir (modal) yang dikirim bisa menampilkan pesan gagal bawaan Discord. Hanya menu role hadiah yang diuji untuk keadaan ini. |
| L8 | Pengaturan yang disimpan dari web tidak menyetel tanda `configured`; `/level dashboard` masih meminta `/level setup` pada server yang hanya dikonfigurasi lewat web. |
| L9 | `getLeaderboard` (perintah leaderboard Discord) membaca level satu query per anggota. Tidak diubah. |
| L10 | Kunci per anggota di dalam proses hanya berlaku untuk satu proses bot. Di PostgreSQL dan SQLite transaksi baris tetap menjaga data; backend lain (tidak dipakai bot yang berjalan) hanya dijaga kunci proses. |
| L11 | `revision` pada `PATCH settings/leveling` bersifat opsional agar klien lama tetap berfungsi; permintaan tanpa `revision` tetap mengganti seluruh daftar `roleRewards` yang dikirim tanpa pemeriksaan usang. Halaman dashboard selalu mengirimnya. `/level setup` menyimpan tanpa pemeriksaan usang; jeda antara baca dan simpannya sangat pendek dan ia menolak bila leveling sudah disiapkan. |

Di luar cakupan dan tidak diperiksa: perhitungan XP dan rumus level, kartu `/rank`, multiplier XP, daftar hitam pengguna.

## Tes

| File | Jumlah | Isi |
|---|---:|---|
| `tests/postgres-reward-roles.test.js` | 20 | Naik level (urutan simpan lalu role, role yang tertinggal menyusul), kegagalan baca dan simpan, cooldown (termasuk lewat event pesan) dan penulis bersamaan, role yang ditolak, perintah `/levelset` `/leveladd` `/levelremove`, simpan pengaturan usang, sinkronisasi (anggota yang berhak saja, anggota keluar, query gagal, role hilang, leveling nonaktif), jalur backend tanpa transaksi. |
| `tests/postgres-dashboard-reward-roles.test.js` | 8 | Keadaan dan validasi hadiah di web, halaman web usang, ubah level lewat web, sinkronisasi manual (konfirmasi, CSRF, satu per satu, hasil, jeda, gagal), menu role hadiah `/level dashboard`. |
| `tests/dashboard-reward-roles-ui.test.js` | 6 | Halaman leveling dengan jsdom: daftar hadiah di-escape, tombol sinkronisasi, penolakan server, `revision` saat menyimpan, pesan formulir level anggota. |
| `tests/helpers/leveling-postgres-fixture.js` | — | Skema PostgreSQL sekali pakai dari DDL bot yang sebenarnya; guild tiruan dengan role, posisi, izin dan anggota; kegagalan dan penundaan query yang bisa disuntikkan, termasuk di dalam transaksi. |

Dua tes lama disesuaikan pada data tiruannya saja (`tests/sqlite-level-role-reconcile.test.js`, `tests/sqlite-leveling-transactions.test.js`): role tiruan kini memiliki ID berbentuk ID Discord dan bot tiruan memiliki izin Manage Roles, karena pemeriksaan role sekarang memerlukannya. Pernyataan (assert) tidak diubah.

Pemeriksaan bahwa tes benar-benar mendeteksi masalahnya (kode lama dipasang kembali sementara, tes dijalankan, lalu kode baru dikembalikan):

| Yang dikembalikan ke versi sebelum audit | Tes baru yang gagal |
|---|---|
| `xpSystem.js` dan `leveling.js` | 13 kegagalan (dari 32 tes saat pemeriksaan ini dilakukan); salah satunya adalah seluruh file tes web, yang tidak bisa dimuat dengan kode lama |
| Pemeriksaan izin berbahaya dimatikan | 6 gagal |
| `modulesApi.js` | 3 gagal |
| Pemeriksaan `revision` di server dimatikan | 1 gagal |
| Pengiriman `revision` dari halaman dimatikan | 1 gagal |
| `operationsApi.js` | 1 gagal |
| `messageCreate.js` | 1 gagal |
| Pemulihan salinan dashboard setelah simpan gagal dimatikan | 1 gagal |

Yang **tidak** diuji: pemberian role setelah ubah level lewat web pada backend SQLite (hanya jalur PostgreSQL), delapan tindakan `/level dashboard` di L7, dan seluruh perilaku pada Discord nyata (urutan role, rate limit, izin).

Hasil pada 2026-11-13, PostgreSQL 16 sekali pakai tanpa TLS, Discord tiruan:

- regresi penuh Node 22: lihat tabel di `DOKUMENTASI-PROGRES-PROYEK.md` bagian 6;
- Node 20.20: 46 dari 46 tes lulus (tiga file di atas, `tahap6-modules`, `tahap6-operations`). Tes leveling SQLite tidak termasuk (SQLite memerlukan Node 22.5).

PostgreSQL untuk tes dapat disiapkan dengan `source scripts/setup-test-postgres.sh` (Linux x86_64; mengunduh PostgreSQL 16 ke direktori cache dan membuat cluster kosong di `/tmp`).
