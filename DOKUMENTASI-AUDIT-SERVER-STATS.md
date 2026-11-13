# Audit Server Stats (counter jumlah anggota)

Tanggal audit: 2026-11-13. Cakupan: perintah `/serverstats` (`create`, `list`, `update`, `delete`), tombol konfirmasi hapus, penyimpanan counter, pembaruan nama channel saat anggota masuk/keluar dan lewat penjadwal 15 menit, pembersihan saat channel dihapus, serta halaman dashboard baru untuk fitur ini.

Audit dilakukan dengan membaca kode dan menjalankan tes terhadap PostgreSQL lokal dan Discord tiruan. **Tidak ada yang diuji pada server Discord nyata**, termasuk batas ganti nama channel milik Discord.

Dokumen ini adalah bagian pertama dari butir checklist "Audit dan integrasikan kategori Community, Fun, Reaction Roles, Search, Server Stats, Tools dan Utility satu per satu". Enam kategori lain belum dikerjakan.

## Cara kerja fitur

- Counter adalah channel suara atau teks yang namanya memuat angka, misalnya `Members & Bots-128`. Ada tiga jenis: anggota + bot (`members`), anggota saja (`members_only`), bot saja (`bots`). Paling banyak satu counter per jenis.
- Catatan counter disimpan sebagai satu daftar JSON di kolom `guilds.counters` PostgreSQL.
- Izin pengguna: Manage Channels untuk semua subperintah. Halaman dashboard mengikuti aturan dashboard: owner server atau Administrator.
- Izin bot: View Channel dan Manage Channels pada kategori (saat membuat) dan pada channel counter (saat mengganti nama atau menghapus).

## Ringkasan

Lima belas masalah diperbaiki dan diuji. Lima belas keterbatasan dicatat tanpa diperbaiki. Sebelum mengubah kode, sembilan masalah pertama (S1–S9) dibuktikan lebih dulu dengan menjalankan kode lama pada lingkungan tes yang sama; enam sisanya (S10–S15) didapat dari pembacaan kode dan hanya perilaku barunya yang diuji.

Yang paling penting:

- **Gangguan database sesaat menghapus counter lain.** `/serverstats create` membaca daftar lewat lapisan key-value umum, yang menjawab query gagal dengan "tidak ada data". Daftar yang dianggap kosong itu lalu disimpan kembali berisi satu counter baru. Counter lama hilang dari bot, sedangkan channel-nya tetap ada di Discord dan tidak pernah diperbarui lagi.
- **Simpan yang gagal dilaporkan berhasil.** Hasil simpan tidak diperiksa. Pengguna melihat "Counter Created Successfully", channel dibuat, tetapi tidak ada yang tersimpan.
- **Handler anggota masuk/keluar menunggu Discord.** Nama channel diganti langsung di dalam handler. Discord membatasi ganti nama channel, dan discord.js tidak menolak permintaan yang melewati batas melainkan menahannya sampai batas berakhir. Selama itu langkah sesudahnya di handler ikut tertahan: pemindahan data ulang tahun, pembersihan lamaran dan penghapusan data level anggota yang keluar.
- **Tombol "Confirm Delete" tidak memeriksa izin lagi**, dan penghapusan membuang catatan lebih dulu: bila Discord menolak menghapus channel, counter hilang dari bot tetapi channel-nya tertinggal.

## Masalah yang diperbaiki

| ID | Masalah | Dampak sebelumnya | Perbaikan |
|---|---|---|---|
| S1 | Daftar counter dibaca lewat lapisan key-value umum; query gagal dibaca sebagai daftar kosong, lalu seluruh daftar ditulis ulang. | Terukur pada kode lama: satu query gagal saat `create` menyisakan hanya counter baru; counter `bots` yang sudah ada hilang. | `src/services/serverStats/store.js` membaca dan menulis kolom `guilds.counters` langsung. Query gagal dilempar sebagai galat. Tidak ada channel yang dibuat bila daftar tidak terbaca. |
| S2 | Nilai balik simpan diabaikan (`saveServerCounters` selalu menjawab berhasil). | Terukur: balasan "Success", daftar tersimpan kosong, channel `Members & Bots-4` tertinggal di Discord. | Simpan yang gagal dilempar. Channel yang baru dibuat dihapus lagi; bila itu juga gagal, balasan menyebut channel yang harus dihapus manual. |
| S3 | Tidak ada kunci dari baca sampai tulis. | Terukur: tiga `create` bersamaan untuk tiga jenis menyimpan satu counter dan membuat tiga channel; dua `create` jenis yang sama membuat dua channel. | Setiap perubahan adalah satu transaksi dengan kunci baris (`SELECT … FOR UPDATE`). Aturan satu-per-jenis diperiksa lagi di dalam transaksi; channel milik permintaan yang kalah dihapus. |
| S4 | Nama channel diganti langsung di handler `guildMemberAdd` dan `guildMemberRemove`, sekali per counter, masing-masing dengan mengambil seluruh daftar anggota. | Terukur: handler keluar tidak selesai selama ganti nama tertahan. Dua penyegaran untuk dua counter mengambil daftar anggota empat kali. | Handler hanya meminta penyegaran (`counterRefresher.schedule`) dan langsung lanjut. Penyegaran berjalan terpisah, satu per server pada satu waktu, dan permintaan yang berdekatan digabung. |
| S5 | Tidak ada pembatasan ganti nama. Untuk channel teks, nama yang diminta selalu dibandingkan dengan nama yang sudah ditulis ulang Discord, sehingga selalu dianggap berbeda. | Terukur pada Discord tiruan: channel teks diganti nama pada setiap penyegaran walau angkanya tetap. | Satu channel diganti nama paling banyak sekali per 305 detik, paling banyak satu permintaan ganti nama yang menunggu per channel, dan angka terakhir diterapkan oleh penyegaran susulan. Nama yang dikembalikan Discord untuk permintaan terakhir diingat, sehingga angka yang tetap tidak memicu ganti nama. |
| S6 | `/serverstats list` menilai status dari adanya `:` pada nama channel, padahal pola namanya `{name}-{count}`. | Terukur: setiap counter tampil "Not Updated" dan "Active Counters: 0". | Status dihitung dari perbandingan nama channel dengan nama yang seharusnya, dan menyebut sebabnya bila tertinggal (menunggu batas Discord, izin bot kurang, daftar anggota tidak terbaca, channel tidak terlihat). |
| S7 | `channelDelete` berhenti kecuali untuk channel suara dan kategori. | Terukur: counter channel teks yang dihapus manual tetap tersimpan sampai `list` atau penjadwal berjalan. | Pencarian memakai ID channel untuk semua jenis channel. Channel yang bukan counter tidak menyebabkan penulisan apa pun. |
| S8 | Tombol konfirmasi hanya memeriksa siapa yang memulai, bukan izinnya saat tombol ditekan. | Terukur: pengguna yang izinnya sudah dicabut tetap dapat menghapus counter dan channel. | Manage Channels diperiksa lagi saat konfirmasi. |
| S9 | Saat menghapus, catatan dibuang dulu, baru channel dihapus; kegagalan hapus channel hanya dicatat. | Terukur: balasan "(failed to delete)", catatan hilang, channel tetap ada dan tidak lagi dikelola bot. | Channel dihapus dulu. Bila Discord menolak, tidak ada yang berubah dan pengguna diberi tahu. Izin bot diperiksa sebelum permintaan dikirim. |
| S10 | Pembersihan di penjadwal dan di `list` menganggap channel hilang bila tidak ada di cache bot, dan penjadwal tidak menyimpan kembali counter ber-`enabled: false`. | Dari pembacaan kode: counter nonaktif terhapus saat ada pembersihan; cache yang belum lengkap dapat menghapus counter yang channel-nya masih ada. | Catatan hanya dibuang bila Discord sendiri menjawab channel tidak ada (kode 10003). Channel yang sekadar gagal diperiksa dibiarkan. Counter nonaktif dan jenis tak dikenal tetap tersimpan dan tidak disentuh. Catatan yang berubah selama pemeriksaan tidak ikut terhapus. |
| S11 | Izin bot tidak diperiksa sebelum membuat channel. | Galat Discord tampil sebagai "An error occurred". | Diperiksa lebih dulu; pesannya menyebut izin yang kurang dan bahwa tidak ada yang diubah. |
| S12 | Bila daftar anggota gagal diambil, hitungan bot memakai cache yang mungkin tidak lengkap. | Dari pembacaan kode: nama channel dapat menampilkan angka yang salah. | Bila daftar tidak lengkap dan tidak dapat diambil, counter `bots` dan `members_only` dibiarkan dengan nama lamanya. Counter `members` tetap diperbarui dari jumlah yang dilaporkan Discord. Pengambilan daftar dibatasi 15 detik, dan dilewati bila cache sudah lengkap atau bila tidak ada counter yang memerlukannya. |
| S13 | Channel dibuat dengan nama dasar lalu langsung diganti nama. | Satu dari jatah ganti nama channel baru langsung terpakai. | Channel dibuat langsung dengan nama akhirnya bila angkanya diketahui. |
| S14 | Nilai tersimpan yang bukan daftar dibaca sebagai kosong. | Dari pembacaan kode: simpan berikutnya menimpa data yang tidak dipahami. | Nilai seperti itu ditolak (`SERVERSTATS_INVALID`) dan dibiarkan apa adanya. Entri yang rusak di dalam daftar dilewati dan dihitung. |
| S15 | Kunci `guild:{id}:counters` masih dapat ditulis lewat `client.db.set`. | Kode lain dapat menimpa seluruh daftar tanpa kunci. | Jenis kunci `counters` masuk daftar `PROTOCOL_ONLY_KEY_TYPES`; `set` dan `delete` umum menolaknya. Membaca tetap bisa. |

## Halaman dashboard baru

Server Stats dipindahkan dari daftar "belum ada halaman" menjadi ruang ke-11 di Fitur Bot (`#features/server-stats`).

- Rute: `GET /dashboard/api/bot/server-stats`, `POST …/counters`, `PATCH …/counters/:id`, `DELETE …/counters/:id` di `src/dashboard/serverStatsApi.js`. Halaman: `dashboard-preview/serverstats-live.js`.
- **Halaman ini bertindak di Discord**: membuat counter membuat channel, menghapus counter menghapus channel. Spanduknya menyebut itu, dan setiap aksi meminta konfirmasi yang menyebut apa yang dibuat atau dihapus.
- Rute memakai fungsi yang sama dengan `/serverstats` (`src/services/serverStats/manage.js`), jadi pemeriksaan dan urutan efeknya sama.
- Membaca tidak mengubah apa pun: tidak membuang catatan, tidak mengganti nama.
- Ubah dan hapus mengirim `revision` daftar yang sedang ditampilkan; halaman yang sudah usang ditolak (409) dan diminta memuat ulang.
- Semua penulisan memerlukan sesi, CSRF dan `confirmed: true`; isi permintaan dengan kunci tambahan ditolak. Pesan galat internal tidak dikirim ke browser.
- Alasan di audit log Discord memuat nama dan ID pengguna dashboard.
- Di preview statis ruang ini berupa kartu berlabel preview dan tidak memanggil API.

## Keterbatasan yang dicatat

| ID | Keterbatasan |
|---|---|
| K1 | Batas ganti nama channel Discord (umumnya disebut dua kali per sepuluh menit per channel) tidak diperiksa terhadap dokumentasi resmi maupun Discord nyata. Jeda 305 detik adalah konstanta di `refresh.js`, bukan pengaturan. |
| K2 | Ingatan penyegar (kapan terakhir ganti nama, nama yang dikembalikan Discord) hanya ada di memori. Setelah restart, ganti nama pertama setiap channel tidak ditahan, dan channel teks dapat diganti nama sekali tanpa perlu. |
| K3 | Cara Discord menulis ulang nama channel teks (huruf kecil, tanda hubung) hanya ditiru oleh Discord tiruan di tes; aturan aslinya tidak diperiksa. |
| K4 | Channel counter tidak diberi izin khusus; ia mewarisi izin kategorinya. Balasan dan halaman menyebut hal itu. Blok `counters.permissions`, `counters.types`, `counters.messages` dan sebagian `counters.defaults` di `src/config/bot.js` tidak dipakai kode mana pun dan dibiarkan. |
| K5 | Discord dan database bukan satu transaksi. Buat: channel dulu, lalu catatan; bila catatan gagal channel dihapus lagi, dan bila itu gagal pengguna diminta menghapus manual. Hapus: channel dulu, lalu catatan; bila catatan gagal dibuang, event hapus channel atau penjadwal membuangnya kemudian. Bila jawaban COMMIT hilang, hasilnya tidak diketahui dan pengguna diminta memuat ulang. |
| K6 | `revision` adalah hash isi daftar, bukan nomor versi: perubahan A→B→A tidak terdeteksi. Perintah slash tidak memakai `revision`. |
| K7 | `enabled: false` hanya dihormati; tidak ada perintah atau halaman untuk menyetelnya. |
| K8 | Dashboard tidak punya tombol "segarkan sekarang". Akses dashboard (owner atau Administrator) lebih ketat daripada perintah slash (Manage Channels). |
| K9 | Pembatasan ganti nama berlaku per proses. Dua proses bot untuk server yang sama akan mengirim ganti nama dua kali lipat. Kunci baris database tetap melindungi daftar tersimpan. |
| K10 | Penjadwal `*/15` di `src/app.js` tidak dijalankan dalam tes karena mengimpor berkas itu menyalakan bot. Yang diuji adalah fungsi yang dipanggilnya (`maintainCounters`); pemanggilannya hanya diperiksa lewat teks sumber. |
| K11 | Jumlah total memakai `guild.memberCount` dari gateway; jumlah bot memakai daftar anggota dan memerlukan intent Guild Members. Pada server besar, pengambilan daftar dapat melewati 15 detik; counter bot dan anggota-saja lalu tertinggal sampai daftar terbaca. |
| K12 | Hanya PostgreSQL. Backend lain dijawab `SERVERSTATS_UNAVAILABLE`; startup bot memang sudah menolak SQLite. |
| K13 | Membuat, mengubah dan menghapus counter tidak menulis entri ke channel log bot; jejaknya hanya alasan di audit log Discord. Ganti nama tetap menulis event `counter.update` seperti sebelumnya. |
| K14 | Balasan perintah slash tetap berbahasa Inggris seperti sebelumnya; halaman dashboard berbahasa Indonesia. |
| K15 | Counter dengan jenis tak dikenal (data lama) dapat dihapus atau diubah jenisnya, tetapi tidak diperbarui. |

## Berkas

| Berkas | Isi |
|---|---|
| `src/services/serverStats/store.js` | Baca, tulis dan validasi daftar counter; transaksi dengan kunci baris; `revision`. |
| `src/services/serverStats/refresh.js` | Hitungan anggota, penyegar nama channel (penggabungan permintaan, jeda ganti nama, ganti nama yang tertahan). |
| `src/services/serverStats/manage.js` | Buat, ubah jenis, hapus, periksa, buang catatan channel yang hilang, perawatan terjadwal; kode galat dan pesannya. |
| `src/services/serverstatsService.js` | Tinggal label jenis dan pola nama channel. |
| `src/commands/ServerStats/modules/*.js`, `src/handlers/counterButtons.js` | Perintah dan tombol, kini memanggil layanan di atas. |
| `src/events/channelDelete.js`, `guildMemberAdd.js`, `guildMemberRemove.js`, `src/app.js` | Pembersihan dan permintaan penyegaran. |
| `src/utils/postgresDatabase.js` | `counters` ditambahkan ke `PROTOCOL_ONLY_KEY_TYPES`. |
| `src/dashboard/serverStatsApi.js`, `src/dashboard/router.js`, `dashboard-preview/serverstats-live.js`, `dashboard-preview/features.js`, `dashboard-preview/index.html` | Halaman dashboard. |

Kode galat: `SERVERSTATS_TYPE`, `SERVERSTATS_CHANNEL_TYPE`, `SERVERSTATS_CATEGORY`, `SERVERSTATS_BOT_PERMISSION`, `SERVERSTATS_DUPLICATE`, `SERVERSTATS_LIMIT`, `SERVERSTATS_MISSING`, `SERVERSTATS_STALE`, `SERVERSTATS_INVALID`, `SERVERSTATS_UNAVAILABLE`, `SERVERSTATS_CHANNEL_FAILED`, `SERVERSTATS_CHANNEL_LEFT`.

Hasil penyegaran per counter: `current`, `renamed`, `deferred` (dengan `retryAt`), `pending`, `slow`, `failed`, `no_permission`, `count_unknown`, `missing`, `unreachable`.

## Tes

| Berkas | Jumlah | Isi |
|---|---:|---|
| `tests/postgres-serverstats.test.js` | 38 | Penyimpanan (query gagal, simpan gagal, bersamaan, data rusak, lapisan umum ditolak), `list`, ubah jenis, hapus dan tombol, event hapus channel, penyegar (jeda, penggabungan, ganti nama tertahan, izin, daftar anggota tidak terbaca), perawatan terjadwal, handler anggota masuk/keluar. |
| `tests/postgres-dashboard-serverstats.test.js` | 14 | Rute API terhadap router asli, dan halaman asli di jsdom yang berbicara dengan router itu: buat, ubah, hapus, konfirmasi ditolak, penolakan server, halaman usang, teks dari Discord tidak dibaca sebagai HTML, preview statis. |
| `tests/helpers/serverstats-fixture.js` | — | PostgreSQL sekali pakai dan Discord tiruan dengan channel yang dapat dibuat, diganti nama dan dihapus, serta daftar anggota berisi bot. |
| `tests/postgres-dashboard-live-walk.test.js`, `tests/dashboard-simulation-labels.test.js` | disesuaikan | Dashboard kini 31 tab, 28 formulir dan 177 kontrol; formulir buat counter ikut diperiksa bahwa setiap kontrolnya mengubah permintaan. |

Pemeriksaan mutasi: 22 perubahan yang sengaja merusak kode (antara lain menghapus kunci baris, jeda ganti nama, pemeriksaan izin tombol, pemeriksaan `revision`, escape nama channel, CSRF pada PATCH) masing-masing membuat sedikitnya satu tes gagal, lalu dikembalikan.

Hasil terakhir ada di tabel pemeriksaan `DOKUMENTASI-PROGRES-PROYEK.md`.

## Yang belum diuji

- Server Discord nyata: pembuatan, ganti nama dan penghapusan channel, batas ganti nama, izin, penulisan ulang nama channel teks, event gateway anggota.
- Browser sungguhan; halaman hanya dijalankan di jsdom.
- Penjadwal 15 menit yang benar-benar berjalan, restart bot, dan dua proses bot sekaligus.
- Server besar (pengambilan daftar anggota yang lama).
