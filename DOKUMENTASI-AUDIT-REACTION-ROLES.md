# Audit Reaction Roles (panel pilih role sendiri)

Tanggal audit: 2026-11-13. Cakupan: perintah `/reactroles` (`setup`, `dashboard`), menu pilihan pada pesan panel, penyimpanan panel, event hapus pesan, pemeriksaan panel saat bot menyala, serta halaman dashboard baru untuk fitur ini.

Audit dilakukan dengan membaca kode dan menjalankan tes terhadap PostgreSQL lokal dan Discord tiruan. **Tidak ada yang diuji pada server Discord nyata.**

Dokumen ini adalah bagian kedua dari butir checklist "Audit dan integrasikan kategori Community, Fun, Reaction Roles, Search, Server Stats, Tools dan Utility satu per satu". Lima kategori lain (Community, Fun, Search, Tools, Utility) belum dikerjakan.

## Cara kerja fitur

- Panel adalah pesan bot berisi embed dan menu pilihan. Anggota memilih role di menu; role panel yang dipilih diberikan, role panel yang tidak dipilih dilepas.
- Paling banyak 5 panel per server dan 25 role per panel. `/reactroles setup` menerima 1–5 role; role berikutnya ditambahkan lewat `/reactroles dashboard` atau halaman web.
- Catatan panel disimpan di tabel `temp_data` PostgreSQL, satu baris per panel, dengan kunci `guild:{server}:reaction_roles:{pesan}`. Catatan lama berkunci `reaction_roles:{server}:{pesan}` tetap dibaca dan dipindahkan ke kunci baru saat panel itu diubah.
- Catatan kini juga menyimpan judul dan deskripsi panel, supaya panel dapat dipasang ulang setelah pesannya terhapus.
- Izin pengguna: perintah tetap terdaftar dengan izin bawaan Administrator. Selain itu bot sendiri menuntut Manage Roles pada setiap perintah, tombol dan formulir. Halaman web mengikuti aturan dashboard: owner server atau Administrator.
- Izin bot: Manage Roles dan role bot di atas role yang ditawarkan; View Channel, Send Messages dan Embed Links di channel panel.
- Role yang tidak boleh ditawarkan: `@everyone`, role milik bot/integrasi, role yang tidak di bawah role tertinggi bot, role yang tidak di bawah role tertinggi orang yang menambahkannya (owner server dikecualikan), dan role dengan salah satu izin Administrator, Manage Server, Manage Roles, Manage Channels, Manage Webhooks, Ban Members, Kick Members atau Mention Everyone.

## Ringkasan

Dua puluh tiga masalah diperbaiki dan diuji. Enam belas keterbatasan dicatat tanpa diperbaiki. Tujuh belas masalah pertama (R1–R17) dibuktikan lebih dulu dengan menjalankan kode lama pada lingkungan tes yang sama; enam sisanya (R18–R23) didapat dari pembacaan kode dan hanya perilaku barunya yang diuji.

Yang paling penting:

- **Satu panel dapat menimpa panel lain.** Bila pesan sebuah panel hilang tanpa bot menerima event-nya, membuka `/reactroles dashboard` untuk panel itu mencari "pesan panel" di channel yang sama, menemukan pesan panel lain, lalu menyimpan daftar role panel pertama di bawah pesan panel kedua. Catatan panel pertama dihapus. Menu di Discord dan catatan bot lalu tidak cocok lagi.
- **Gangguan Discord sesaat menghapus catatan panel.** Pemeriksaan saat bot menyala menganggap setiap kegagalan mengambil pesan sebagai "pesan sudah dihapus" dan membuang catatannya, padahal pesannya masih ada.
- **Batas 5 panel dapat dilewati**, baik oleh query yang gagal (dibaca sebagai "belum ada panel") maupun oleh beberapa `setup` yang berjalan bersamaan.
- **Kegagalan dilaporkan sebagai keberhasilan.** Panel yang tidak tersimpan dilaporkan "created"; role yang gagal ditambahkan ke pesan atau gagal disimpan dilaporkan "Role Added"; panel yang pesannya gagal dihapus dilaporkan "Panel Deleted"; anggota yang role-nya ditolak Discord melihat "Roles updated successfully!" berwarna hijau.
- **Dua dashboard yang terbuka saling menimpa.** Setiap dashboard menyimpan salinan panelnya sendiri dan mendengarkan pilihan role di seluruh channel. Dari dua role yang ditambahkan lewat dua dashboard, satu hilang.
- **Tombol tidak memeriksa izin lagi.** Pengguna yang izinnya sudah dicabut tetap dapat menghapus panel lewat dashboard yang masih terbuka.

## Masalah yang diperbaiki

"Terukur" berarti perilaku lama dijalankan dan hasilnya dicatat sebelum kode diubah.

| ID | Masalah | Dampak sebelumnya | Perbaikan |
|---|---|---|---|
| R1 | Daftar panel dibaca lewat lapisan key-value umum; query gagal dibaca sebagai "tidak ada panel". | Terukur: dengan 5 panel tersimpan dan satu query gagal, `setup` menjawab "Success" dan panel ke-6 tersimpan. | `src/services/reactionRoles/store.js` membaca `temp_data` langsung. Query gagal dilempar sebagai galat (`REACTROLES_UNAVAILABLE`); tidak ada pesan yang dikirim. |
| R2 | Hasil simpan tidak diperiksa. | Terukur: simpan gagal, balasan tetap "Success … panel created", tidak ada catatan, pesan panel tertinggal di channel. | Simpan yang gagal dilempar. Pesan yang baru dikirim dihapus lagi; bila itu juga gagal, balasan memuat tautan pesan yang harus dihapus manual (`REACTROLES_MESSAGE_LEFT`). |
| R3 | Tidak ada kunci dari hitung sampai simpan. | Terukur: tiga `setup` bersamaan dengan 4 panel tersimpan menghasilkan 6 panel. | Setiap perubahan adalah satu transaksi dengan kunci per server (`pg_advisory_xact_lock`). Batas diperiksa lagi di dalam transaksi; pesan milik permintaan yang kalah dihapus. |
| R4 | Pemeriksaan saat bot menyala membuang catatan bila pesan tidak dapat diambil, apa pun sebabnya. | Terukur: Discord menjawab 500, ringkasan melaporkan `removedMessages: 1, errors: 0`, catatan hilang, pesan masih ada. | Pemeriksaan hanya menghitung (aktif, pesan hilang, channel hilang, tidak dapat diperiksa, catatan tak terbaca) dan tidak menulis apa pun. |
| R5 | Balasan untuk anggota selalu berjudul sukses. | Terukur: Discord menolak (50013), balasan "**Roles updated successfully!** No changes were made…" berwarna hijau; role tidak diberikan. | Judul dan warna mengikuti hasil: berhasil, sebagian, atau gagal. Role yang gagal disebut namanya. |
| R6 | Saat melepas role, role tidak diperiksa lagi. | Terukur: role panel yang kemudian menjadi role integrasi tetap dicoba dilepas, dan balasan menyebutnya "Removed". | Role yang kini tidak boleh ditawarkan tidak disentuh ke arah mana pun dan dilaporkan sebagai dilewati beserta sebabnya. |
| R7 | Dashboard menyimpan salinan panel; pengumpul pilihan role mendengarkan seluruh channel. | Terukur: dua dashboard menambah role 3 dan role 4, keduanya menjawab "Role Added", yang tersimpan role 1, 2, 4. | Sesi dashboard hanya menyimpan ID pesan panel dan membaca catatan lagi untuk setiap aksi. Pengumpul hanya menerima jawaban atas pertanyaan miliknya. Perubahan dilakukan di dalam transaksi. |
| R8 | Role disimpan, pesan panel gagal diubah, balasan tetap sukses. | Terukur: "Role Added", catatan 3 role, menu masih 2. | Catatan adalah acuan: perubahan disimpan dulu, lalu pesan digambar ulang. Bila gambar ulang gagal, balasan berupa peringatan yang menunjuk tombol **Refresh Panel Message**. |
| R9 | Pesan panel diubah, simpan gagal, balasan tetap sukses. | Terukur: "Role Added", catatan 2 role, menu 3. | Karena simpan dilakukan lebih dulu, simpan yang gagal berarti pesan tidak disentuh dan balasan menyebut tidak ada yang berubah. |
| R10 | Hapus panel membuang catatan walau Discord menolak menghapus pesan. | Terukur: "Panel Deleted", catatan hilang, pesan masih ada dan menunya mati. | Pesan dihapus dulu, lalu catatan. Bila Discord menolak, tidak ada yang berubah. Bila keadaan pesan tidak dapat diperiksa (`REACTROLES_UNCERTAIN`), tidak ada yang berubah. Pesan yang memang sudah tidak ada bukan halangan. |
| R11 | Tombol dan formulir dashboard tidak memeriksa izin lagi. | Terukur: setelah izin Administrator dicabut, "Delete" pada dashboard yang masih terbuka tetap menghapus panel. | Manage Roles diperiksa pada setiap tekan tombol dan setiap kirim formulir. |
| R12 | Melepas role terakhir menghapus panel secara diam-diam. | Terukur: "The panel has been deleted", catatan hilang, pesan tetap ada karena Discord menolak. | Melepas role terakhir ditolak (`REACTROLES_LAST_ROLE`); panel hanya hilang lewat aksi hapus. |
| R13 | Ubah teks melaporkan sukses walau pesan tidak berubah. | Terukur: "Panel Updated", judul di Discord tetap. | Teks disimpan di catatan; bila pesan gagal diubah balasan berupa peringatan, bukan sukses. |
| R14 | Dashboard menjawab "belum ada panel" saat daftar tidak dapat dibaca. | Terukur: query gagal, balasan "No reaction role panels found. Use `/reactroles setup` first." | Balasan menyebut panel tidak dapat dibaca saat ini. |
| R15 | Menu anggota menjawab "tidak aktif lagi" saat catatan tidak dapat dibaca. | Terukur: query gagal, balasan "This reaction role message is no longer active." | Balasan menyebut tidak ada yang diubah dan meminta mencoba lagi. "Tidak aktif" hanya untuk panel yang memang tidak tercatat. |
| R16 | Pemulihan panel dengan memindai channel. | Terukur: panel A (role 1, 2) dan B (role 3, 4) di satu channel; pesan A hilang; membuka dashboard A membuat catatan B berisi role 1, 2 dan catatan A terhapus. | Pemindaian channel dihapus. Panel yang pesannya hilang tetap tercatat dengan status "pesan hilang" dan dapat dipasang ulang atau dihapus. |
| R17 | Role yang sudah dihapus dari server tidak dapat dilepas dari panel. | Terukur: "Remove role" hanya menawarkan role yang masih ada; catatan tetap memuat role terhapus. | Role terhapus ditampilkan sebagai "Deleted role (ID)" dan dapat dilepas. |
| R18 | Tidak ada pemeriksaan terhadap posisi role orang yang menambahkan. | Dari pembacaan kode: pengguna dapat menawarkan role yang setara atau di atas role tertingginya sendiri, sesuatu yang tidak diizinkan Discord bila dilakukan langsung. | Role harus di bawah role tertinggi orang yang menambahkannya; owner server dikecualikan. Berlaku di perintah dan di halaman web. |
| R19 | Event hapus pesan langsung membuang catatan panel. | Dari pembacaan kode: pesan panel yang terhapus (termasuk tidak sengaja) menghilangkan daftar role dan teks panel. | Catatan dipertahankan; event hanya menulis log. Panel dapat dipasang ulang dengan teks dan role yang sama. |
| R20 | Kunci panel dapat ditulis lewat `client.db.set`. | Kode lain dapat menimpa panel tanpa kunci dan tanpa validasi. | Jenis kunci `reaction_role` masuk `PROTOCOL_ONLY_KEY_TYPES`; `set` dan `delete` umum menolaknya. Membaca tetap bisa. |
| R21 | Dua pilihan cepat dari satu anggota diproses bersamaan. | Dari pembacaan kode: pemberian dan pelepasan role dari dua kiriman dapat saling menyela. | Pilihan satu anggota diproses berurutan. |
| R22 | Menambah role, melepas role, mengubah teks dan memasang ulang tidak meninggalkan jejak di channel log. | Hanya buat dan hapus panel yang tercatat. | Keempat aksi itu menulis entri log yang menyebut sumber (`/reactroles` atau dashboard web), pelaku, panel dan role. Kegagalan menulis log tidak membatalkan perubahannya. |
| R23 | Memasang ulang panel yang semua role-nya sudah dihapus dijawab "Choose at least one role". | Pesan tidak menjelaskan keadaan. | Kode galat tersendiri (`REACTROLES_ROLES_GONE`) dengan penjelasan dan saran menghapus panel. |

Selain itu izin Mention Everyone ditambahkan ke daftar izin yang membuat sebuah role tidak boleh ditawarkan.

## Halaman dashboard baru

Reaction Roles dipindahkan dari daftar "belum ada halaman" menjadi ruang ke-12 di Fitur Bot (`#features/reaction-roles`).

- Rute di `src/dashboard/reactionRolesApi.js`, semuanya di bawah `/dashboard/api/bot/reaction-roles`:

  | Rute | Guna |
  |---|---|
  | `GET /` | Panel tersimpan beserta statusnya, daftar channel, daftar role beserta alasan bila tidak boleh ditawarkan, dan batas. |
  | `POST /panels` | Buat panel. |
  | `PATCH /panels/:id` | Ubah judul dan deskripsi. |
  | `POST /panels/:id/roles`, `DELETE /panels/:id/roles/:roleId` | Tambah dan lepas role. |
  | `POST /panels/:id/repost` | Pasang ulang panel yang pesannya hilang. |
  | `POST /panels/:id/refresh` | Gambar ulang pesan dari catatan. |
  | `DELETE /panels/:id` | Hapus panel dan pesannya. |

- Halaman: `dashboard-preview/reactroles-live.js`.
- **Halaman ini bertindak di Discord**: mengirim, mengubah dan menghapus pesan. Spanduknya menyebut itu, dan setiap aksi meminta konfirmasi yang menyebut panel, channel dan role yang terkena.
- Rute memakai fungsi yang sama dengan `/reactroles` (`src/services/reactionRoles/manage.js`), jadi pemeriksaan dan urutan efeknya sama.
- Membaca tidak mengubah apa pun di database maupun di Discord.
- Perubahan pada panel yang sudah ada mengirim `revision` panel yang sedang ditampilkan; halaman yang sudah usang ditolak (409) dan diminta memuat ulang.
- Semua penulisan memerlukan sesi, CSRF dan `confirmed: true`; isi permintaan dengan kunci tambahan ditolak. Permintaan tanpa anggota yang terverifikasi ditolak (403), karena aturan posisi role diperiksa terhadap anggota itu. Pesan galat internal tidak dikirim ke browser.
- Jawaban perubahan memuat keadaan pesan sesudahnya (`updated`, `failed`, `missing`, …); halaman mengatakannya dengan kata-kata, misalnya "Tersimpan, tetapi pesan panel belum dapat diperbarui".
- Role yang tidak boleh ditawarkan tampil dengan alasannya dan tidak dapat dicentang. Nama dari Discord ditampilkan sebagai teks, dan hanya tautan pesan Discord yang dijadikan tautan.
- Di preview statis ruang ini berupa kartu berlabel preview dan tidak memanggil API.

## Keterbatasan yang dicatat

| ID | Keterbatasan |
|---|---|
| K1 | Tidak ada yang diuji pada Discord nyata: pengiriman dan pengubahan pesan, menu pilihan, pemberian role, hierarki role, dan kode galat Discord hanya ditiru. |
| K2 | Discord dan database bukan satu transaksi. Buat dan pasang ulang: pesan dulu, lalu catatan; bila catatan gagal pesan dihapus lagi, dan bila itu gagal pengguna diberi tautan pesan untuk dihapus manual. Hapus: pesan dulu, lalu catatan; bila catatan gagal dibuang, panel tampil dengan status "pesan hilang" dan dapat dihapus lagi. Bila jawaban COMMIT hilang, hasilnya tidak diketahui dan pengguna diminta memeriksa ulang. |
| K3 | Ubah role dan teks: catatan dulu, lalu pesan. Bila pesan gagal diubah, pesan di Discord tertinggal dari catatan sampai seseorang menekan Refresh. Selama itu anggota melihat menu lama; pilihan mereka tetap dinilai terhadap catatan. |
| K4 | `revision` adalah hash isi panel, bukan nomor versi: perubahan A→B→A tidak terdeteksi. Perintah slash tidak memakai `revision`; ia mengandalkan transaksi dan pembacaan ulang. |
| K5 | Setiap kali halaman web atau `/reactroles dashboard` dibuka, bot menanyakan pesan setiap panel ke Discord (paling banyak 5 permintaan). Bila Discord tidak menjawab, status panel "belum dapat diperiksa" dan hapus maupun pasang ulang ditolak sampai dapat diperiksa. |
| K6 | Menu panel tidak menampilkan role yang sudah dimiliki anggota. Anggota yang mengirim satu pilihan kehilangan role panel lain yang tidak ikut dipilih. Ini perilaku lama yang dipertahankan; halaman web menyebutnya. |
| K7 | Antrean per anggota dan pengumpul pilihan hanya ada di memori satu proses. Dua proses bot untuk server yang sama tidak saling menunggu. Kunci database tetap melindungi catatan panel. |
| K8 | `src/events/roleDelete.js` tidak diubah. Role yang dihapus dari server tetap tercatat di panel dan tetap tampil di menu sampai dilepas atau pesannya digambar ulang; anggota yang memilihnya diberi tahu role itu sudah tidak ada. |
| K9 | Role yang kemudian menjadi tidak boleh ditawarkan (misalnya diberi izin Administrator) tetap tercatat di panel. Anggota tidak dapat mengambil maupun melepasnya lewat panel; dashboard menandainya dengan alasan. Tidak ada pemberitahuan otomatis. |
| K10 | Panel yang pesannya hilang tidak pernah dibersihkan otomatis dan tetap dihitung dalam batas 5 panel sampai dipasang ulang atau dihapus. |
| K11 | Panel lama yang belum menyimpan teks mengambil judul dan deskripsi dari pesannya selama pesan itu ada. Bila pesannya hilang sebelum panel pernah diubah, pemasangan ulang memakai judul dan deskripsi bawaan. |
| K12 | Akses halaman web (owner atau Administrator) berbeda dari perintah (izin bawaan Administrator, dan bot menuntut Manage Roles). Daftar channel dan role di halaman dipotong pada 250 entri. Izin channel yang ditampilkan berasal dari cache bot. |
| K13 | Entri log bersifat usaha terbaik dan bergantung pada pengaturan logging server. Buat dan hapus panel dari perintah masih memakai format entri lama; gambar ulang pesan tidak dicatat. |
| K14 | Balasan perintah slash tetap berbahasa Inggris seperti sebelumnya; halaman web berbahasa Indonesia. |
| K15 | Hanya PostgreSQL. Backend lain dijawab `REACTROLES_UNAVAILABLE`. |
| K16 | Penelusuran dashboard menyeluruh (`postgres-dashboard-live-walk.test.js`) hanya mencakup formulir buat panel, dan pengiriman pesannya sengaja digagalkan di sana. Formulir per panel diuji di berkas tes halaman ini. |

## Berkas

| Berkas | Isi |
|---|---|
| `src/services/reactionRoles/store.js` | Baca, tulis dan validasi panel di `temp_data`; kunci baru dan kunci lama; transaksi dengan kunci per server; `revision`. |
| `src/services/reactionRoles/manage.js` | Aturan role, buat, tambah/lepas role, ubah teks, gambar ulang, hapus, pasang ulang, pilihan anggota, ringkasan; kode galat dan pesannya (Inggris dan Indonesia). |
| `src/services/reactionRoles/audit.js` | Entri channel log untuk setiap perubahan panel. |
| `src/services/reactionRoleService.js` | Dihapus; isinya digantikan dua berkas di atas. |
| `src/commands/Reaction_roles/reactroles.js` | Ditulis ulang di atas `manage.js`. |
| `src/handlers/interactionHandlers/reactionRolesSelectMenu.js` | Menu anggota; balasan mengikuti hasil sebenarnya. |
| `src/events/messageDelete.js`, `ready.js`, `interactionCreate.js`, `src/services/panelHealthService.js`, `src/utils/panelStatus.js` | Catatan dipertahankan saat pesan terhapus; pemeriksaan saat menyala hanya menghitung; kode mati dibuang. |
| `src/utils/postgresDatabase.js` | `reaction_role` ditambahkan ke `PROTOCOL_ONLY_KEY_TYPES`. |
| `src/dashboard/reactionRolesApi.js`, `src/dashboard/router.js`, `dashboard-preview/reactroles-live.js`, `dashboard-preview/features.js`, `dashboard-preview/index.html` | Halaman dashboard. |

Kode galat (awalan `REACTROLES_`): `TITLE`, `DESCRIPTION`, `CHANNEL`, `BOT_PERMISSION`, `NO_ROLES`, `ROLE_LIMIT`, `ROLE_REFUSED`, `ROLE_DUPLICATE`, `ROLE_NOT_ON_PANEL`, `LAST_ROLE`, `LIMIT`, `MISSING`, `STALE`, `NOT_MISSING`, `CHANNEL_MISSING`, `ROLES_GONE`, `UNCERTAIN`, `INVALID`, `UNAVAILABLE`, `DISCORD`, `MESSAGE_LEFT`, `RECORD_LEFT`.

Status panel: `ok`, `message_missing`, `channel_missing`, `unknown`. Keadaan pesan setelah perubahan: `updated`, `failed`, `missing`, `channel_missing`, `no_roles`, `unknown`.

## Tes

| Berkas | Jumlah | Isi |
|---|---:|---|
| `tests/postgres-reactroles.test.js` | 35 | Penyimpanan (kunci lama dan baru, query gagal, transaksi, lapisan umum ditolak), `setup` (aturan role, batas, bersamaan, simpan gagal), pilihan anggota (ditolak Discord, role terlindungi, database gagal, role terhapus, dua kiriman cepat), dashboard perintah (dua dashboard, pesan tidak dapat diubah, simpan gagal, role terakhir, ubah teks, hapus, izin dicabut), panel yang pesannya hilang, pasang ulang, pemeriksaan saat menyala, event hapus pesan, autocomplete, entri log. |
| `tests/postgres-dashboard-reactroles.test.js` | 17 | Rute API terhadap router asli, dan halaman asli di jsdom yang berbicara dengan router itu: buat, ubah teks, tambah/lepas role, gambar ulang, pasang ulang, hapus, konfirmasi ditolak, penolakan server, halaman usang, administrator bukan owner, permintaan tanpa anggota, entri log, teks dari Discord tidak dibaca sebagai HTML, preview statis. |
| `tests/helpers/reactroles-fixture.js` | — | PostgreSQL sekali pakai dan Discord tiruan dengan pesan yang dapat dikirim, diubah dan dihapus, role, anggota, dan interaksi perintah/tombol/formulir. |
| `tests/postgres-dashboard-live-walk.test.js`, `tests/dashboard-simulation-labels.test.js` | disesuaikan | Dashboard kini 32 tab, 29 formulir dan 181 kontrol; formulir buat panel ikut diperiksa bahwa setiap kontrolnya mengubah permintaan. |

Pemeriksaan mutasi: 36 perubahan yang sengaja merusak kode dijalankan satu per satu terhadap dua berkas tes di atas, lalu dikembalikan. 35 membuat sedikitnya satu tes gagal. Satu tidak tertangkap: mengubah penangkap galat di `audit.js` agar melempar ulang. Penangkap itu tidak pernah tercapai karena `logEvent` sudah menangkap galatnya sendiri; perilaku "log gagal tidak membatalkan perubahan" tetap diuji lewat channel log yang menolak tulisan.

Hasil terakhir ada di tabel pemeriksaan `DOKUMENTASI-PROGRES-PROYEK.md`.

## Yang belum diuji

- Server Discord nyata: semua efek pada pesan, menu dan role; hierarki role; izin channel; event hapus pesan dari gateway.
- Browser sungguhan; halaman hanya dijalankan di jsdom.
- Restart bot dengan dashboard perintah yang masih terbuka, dan dua proses bot sekaligus.
- Data produksi lama: bentuk catatan lama hanya diuji dari contoh yang dibuat di tes, bukan dari salinan database nyata.
- Server dengan lebih dari 250 channel atau role.
