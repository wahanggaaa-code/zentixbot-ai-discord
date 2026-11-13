# Audit Fun (permainan hitung, dadu, duel, koin)

Tanggal audit: 2026-11-13. Cakupan: perintah `/count` (`setup`, `disable`, `status`, `reset`, `leaderboard`), penilaian pesan di channel hitung, penyimpanan permainan hitung, perintah `/roll`, `/fight` dan `/flip`, serta halaman dashboard baru untuk permainan hitung.

Audit dilakukan dengan membaca kode dan menjalankan tes terhadap PostgreSQL lokal dan Discord tiruan. **Tidak ada yang diuji pada server Discord nyata.**

Dokumen ini adalah bagian ketiga dari butir checklist "Audit dan integrasikan kategori Community, Fun, Reaction Roles, Search, Server Stats, Tools dan Utility satu per satu". Empat kategori lain (Community, Search, Tools, Utility) belum dikerjakan.

## Cara kerja fitur

- **Permainan hitung.** Satu channel teks per server. Anggota menulis angka berikutnya secara bergantian. Angka benar dibiarkan di channel dan menambah satu poin di papan skor. Pesan yang salah dihapus, urutan kembali ke 1, dan bot mengumumkannya lewat pesan yang dihapus sendiri setelah 10 detik.
- Yang dianggap salah: pesan anggota apa pun yang bukan angka berikutnya (termasuk obrolan biasa), dan anggota yang sama menghitung dua kali berturut-turut.
- Delapan sistem penulisan angka: Decimal, Hexadecimal, Binary, Base36, Base64, Roman, Math Expressions (perhitungan seperti `4*4` atau `4*4=16`) dan Alphabet (A, B, … Z, AA).
- Data disimpan di tabel `temp_data` PostgreSQL, satu baris per server, dengan kunci `countingGame:{server}`: aktif atau tidak, channel, sistem, angka berikutnya, penghitung terakhir, urutan saat ini, rekor, dan papan skor.
- Izin pengguna: `/count` terdaftar dengan izin bawaan Manage Server. Mengubah permainan (`setup`, `disable`, `reset`) selalu menuntut Manage Server, diperiksa lagi oleh bot. Halaman web mengikuti aturan dashboard: owner server atau Administrator.
- Izin bot di channel hitung: View Channel, Send Messages dan Manage Messages.
- **`/roll`, `/fight`, `/flip`** tidak menyimpan apa pun. Hasilnya acak dan hanya dibalas ke channel.

## Ringkasan

Dua puluh masalah diperbaiki dan diuji. Dua puluh keterbatasan dicatat tanpa diperbaiki. Empat belas masalah pertama (F1–F14) dibuktikan lebih dulu dengan menjalankan kode lama pada lingkungan tes yang sama; enam sisanya (F15–F20) didapat dari pembacaan kode dan hanya perilaku barunya yang diuji.

| Pemeriksaan | Hasil |
| --- | --- |
| Tes baru kategori Fun | 52 tes di 4 berkas, semuanya lulus |
| Regresi penuh, Node 22 | 877 tes: 873 lulus, 0 gagal, 4 dilewati (tes TLS) |
| Node 20.20.2, enam berkas terkait | 64 dari 64 lulus |
| Uji mutasi | 58 perubahan sengaja-salah, 58 tertangkap tes |
| Dashboard | 13 ruang fitur, 33 tab, 31 formulir, 187 kontrol |

Catatan uji mutasi: pada putaran pertama 57 dari 58 tertangkap. Mutasi yang lolos ("pemenang `/fight` tidak mengikuti damage") menunjukkan cacat pada tes, bukan pada kode: pengganti `Math.random` dari tes sebelumnya tertinggal, sehingga 200 duel yang seharusnya acak berjalan dengan angka tetap. Tesnya diperbaiki, diberi penjaga yang menolak `Math.random` tiruan di awal setiap tes, lalu seluruh 58 mutasi dijalankan ulang.

## Masalah yang diperbaiki

### Dibuktikan pada kode lama

| No | Masalah pada kode lama | Sekarang |
| --- | --- | --- |
| F1 | Satu kegagalan baca database saat mencatat angka benar menimpa permainan dengan data kosong: permainan mati, channel hilang, skor anggota lain terhapus, rekor 9 menjadi 1. | Kegagalan baca dilempar sebagai galat. Permainan tidak disentuh. |
| F2 | `/count disable` dengan satu kegagalan baca menjawab "has been disabled" dan menyimpan data kosong: papan skor dan rekor terhapus. | Satu transaksi; bila gagal, jawabannya "Database Error" dan tidak ada yang berubah. |
| F3 | `/count disable` saat database gagal menjawab "already disabled", padahal permainan masih aktif. | "Database Error". |
| F4 | `/count reset` saat simpan gagal menjawab "has been reset", padahal angka tersimpan tetap 5. | "Database Error". |
| F5 | `/count setup` saat simpan gagal menjawab "Counting Game Enabled", padahal tidak ada yang tersimpan. | "Database Error". |
| F6 | Dua anggota mengirim angka yang sama bersamaan: keduanya diterima, tetapi hanya satu poin yang tercatat. | Penilaian memakai kunci per server; tepat satu yang diterima, yang lain memutus urutan. |
| F7 | Pesan sistem Discord di channel hitung (anggota bergabung, pin, boost, thread) dihapus dan memutus urutan. | Hanya pesan yang ditulis anggota yang dinilai. |
| F8 | Hexadecimal dan Base36 menolak huruf kecil: `a` untuk angka 10 memutus urutan. Roman dan Alphabet sudah menerima huruf kecil. | Huruf besar dan kecil diterima di Hexadecimal, Base36, Roman dan Alphabet. Base64 tetap membedakan (di sana `B` = 1 dan `b` = 27). |
| F9 | `/count setup` ulang di channel yang sama menghapus papan skor, rekor dan urutan tanpa peringatan. | Pengaturan yang sama: tidak ada yang berubah. Ganti sistem: urutan mulai dari 1, papan skor dan rekor tetap. |
| F10 | Angka salah saat simpan gagal: pesan dihapus dan "reset to 1" diumumkan, padahal urutan tersimpan tetap 5. | Reset disimpan dulu. Bila simpan gagal, tidak ada yang dihapus dan tidak ada pengumuman. |
| F11 | Papan skor menulis `nama#diskriminator`; pada tes tampil `user002#undefined`. Discord sudah tidak memakai diskriminator untuk akun biasa. | Papan skor memakai mention (`<@id>`), yang di dalam embed tidak mengirim notifikasi. |
| F12 | `/count setup` diterima di channel tempat bot tidak punya Send Messages dan Manage Messages; pesan salah lalu tidak dapat dihapus. | Ditolak, dengan nama izin yang kurang. |
| F13 | `/count reset start:50000000` diterima. Dalam sistem Roman angka itu sepanjang 50.000 karakter, melebihi batas pesan Discord. | Angka awal dibatasi 1 sampai 1.000.000. Angka yang terlalu panjang dipotong saat ditampilkan. |
| F14 | Nilai tersimpan yang rusak (bukan objek) dibaca sebagai "belum diatur", sehingga tulisan berikutnya menimpanya. | Ditolak dengan galat tersendiri dan tidak ditimpa. |

### Dari pembacaan kode

| No | Masalah pada kode lama | Sekarang |
| --- | --- | --- |
| F15 | Sistem Math menjalankan teks anggota sebagai kode JavaScript lewat `Function()`, dijaga hanya oleh saringan karakter. Tidak ditemukan cara menembus saringan itu, tetapi satu kesalahan pada saringan berarti kode anggota berjalan di proses bot. | Pengurai aritmetika sendiri: angka, `+ - * /`, `**` atau `^`, kurung. Tidak ada kode yang dijalankan. Panjang dibatasi 200 karakter, kedalaman kurung 40. |
| F16 | Tidak ada catatan di channel log saat permainan diatur, dimatikan atau direset. | Setiap perubahan dari perintah maupun web ditulis ke channel log, dengan pelaku dan sumbernya. |
| F17 | Lapisan penyimpanan umum (`client.db.set` / `delete`) dapat menimpa atau menghapus permainan. | Lapisan umum menolak kunci ini; hanya penyimpanan khusus yang menulis. Membaca tetap bisa. |
| F18 | `/count status` tidak memberi tahu bila channel sudah dihapus atau bot kehilangan izin. | Status menampilkan peringatan dan nama izin yang kurang. |
| F19 | `/roll 1d20-3` menulis `+ (-3)`. | Ditulis `- 3`. |
| F20 | `/fight`: pemenang diundi terpisah dari damage yang ditampilkan, tertulis "Best of N rounds" tanpa arti, dan nama pengguna dapat memicu format teks (`__nama__`). | Pemenang adalah yang damage-nya lebih besar (seri diundi dan disebutkan), tertulis "N rounds", nama ditampilkan sebagai teks biasa. |

### Urutan efek pada pesan yang salah

1. Reset disimpan ke database dalam satu transaksi.
2. Pesan anggota dihapus.
3. Pengumuman dikirim.

Bila langkah 1 gagal, langkah 2 dan 3 tidak dijalankan. Bila langkah 2 atau 3 ditolak Discord, reset tetap tersimpan dan galatnya hanya dicatat di log bot.

## Perubahan perilaku yang perlu diketahui

- `/count setup` tidak lagi menghapus papan skor dan rekor. Untuk mengosongkannya ada pilihan baru `/count reset clear_scores:true`.
- `/count reset start` dibatasi sampai 1.000.000.
- `/count setup` ditolak bila bot tidak punya View Channel, Send Messages dan Manage Messages di channel itu.
- Dua angka sama yang datang bersamaan: yang kedua kini selalu memutus urutan. Dulu keduanya bisa lolos.
- Pengumuman kini menyebut sebabnya: angka yang seharusnya, atau "anggota yang sama tidak boleh dua kali berturut-turut".
- `/count status` dan `/count leaderboard` tidak lagi diperiksa ulang oleh bot terhadap Manage Server. Siapa yang boleh menjalankan `/count` tetap ditentukan Discord, dan bawaannya tetap Manage Server.
- `/fight`: pemenang mengikuti damage yang ditampilkan.
- Definisi perintah `/count` berubah (pilihan `clear_scores`, batas `start`). Perintah didaftarkan ulang oleh bot saat menyala.

## Halaman dashboard baru

Ruang "Fun" (nomor 13), satu tab "Permainan hitung", berkas `dashboard-preview/counting-live.js`.

- Keadaan saat halaman dimuat: status, channel, sistem, angka berikutnya, urutan, rekor, penghitung terakhir. Halaman menyebut bahwa angka itu bukan tampilan langsung.
- Formulir pengaturan: channel dan sistem. Channel yang izin botnya kurang ditampilkan nonaktif beserta izin yang kurang.
- Formulir mulai ulang: angka awal dan centang "Kosongkan papan skor". Tombol nonaktifkan.
- Papan skor sepuluh besar.
- Setiap perubahan meminta konfirmasi yang menyebut apa yang hilang dan apa yang tetap.
- Halaman ini hanya mengubah pengaturan tersimpan. Ia tidak mengirim, mengubah atau menghapus pesan Discord; itu dilakukan bot saat anggota menulis di channel.

| Rute (`/dashboard/api/bot`) | Guna | Isi permintaan |
| --- | --- | --- |
| `GET /counting` | Membaca permainan, kesehatan, papan skor, pilihan channel dan sistem | tidak ada |
| `PUT /counting` | Mengaktifkan atau mengganti sistem | `confirmed`, `revision`, `channelId`, `system` |
| `POST /counting/reset` | Memulai ulang urutan | `confirmed`, `revision`, `start`, `clearScores` |
| `POST /counting/disable` | Menonaktifkan | `confirmed`, `revision` |

Semua rute tulis menuntut sesi, CSRF, `confirmed: true`, kunci isi yang persis, `revision` yang masih berlaku, dan anggota yang terverifikasi (403 bila tidak ada, sebelum database dibaca). `revision` hanya mencakup aktif/tidak, channel dan sistem, supaya halaman tidak kedaluwarsa setiap kali ada yang menghitung.

Kode galat: `COUNTING_SYSTEM`, `COUNTING_CHANNEL`, `COUNTING_START` (400); `COUNTING_BOT_PERMISSION`, `COUNTING_ACTIVE_ELSEWHERE`, `COUNTING_NOT_ENABLED`, `COUNTING_STALE`, `COUNTING_INVALID` (409); `COUNTING_UNAVAILABLE`, `COUNTING_UNCERTAIN` (503).

Halaman pengaturan Logging di web mengambil daftar event dari kode, sehingga event baru `counting.config` otomatis mendapat dua sakelar di sana (kategori dan event). Itu sebabnya jumlah kontrol dashboard bertambah 6: empat di halaman Fun, dua di halaman Logging.

## Keterbatasan yang dicatat

| No | Keterbatasan |
| --- | --- |
| K1 | Obrolan biasa di channel hitung tetap memutus urutan. Ini aturan lama yang dipertahankan; mengubahnya adalah keputusan produk. |
| K2 | Pesan dinilai menurut urutan bot memprosesnya, bukan urutan Discord. Dua pesan yang hampir bersamaan dapat dinilai terbalik. |
| K3 | Angka yang sudah diterima lalu diedit atau dihapus pengirimnya tidak terdeteksi. |
| K4 | Saat database gagal, pesan dibiarkan di channel tanpa dinilai dan tidak ada yang diberi tahu. Log bot mencatat paling banyak satu baris per server per menit. |
| K5 | Bila bot kehilangan Manage Messages setelah pengaturan, pesan salah tidak terhapus (reset tetap tersimpan dan diumumkan). Peringatannya hanya terlihat bila seseorang membuka `/count status` atau halaman web. |
| K6 | Penghapusan pengumuman setelah 10 detik memakai pengatur waktu di memori. Bila bot mati dalam 10 detik itu, pengumuman tertinggal. Tidak diuji. |
| K7 | Bila channel hitung dihapus, permainan tetap tercatat aktif pada channel yang hilang. Perlu dinonaktifkan lalu diatur ulang; tidak ada pembersihan otomatis. |
| K8 | Hanya PostgreSQL. Tanpa PostgreSQL, perintah menjawab "database tidak dapat dihubungi" dan pesan tidak dinilai. Kode lama diam-diam memakai penyimpanan apa pun yang tersedia. |
| K9 | `revision` tidak mencakup angka dan papan skor: reset dari halaman yang dibuka sebelum banyak hitungan tetap diterima. Perubahan A→B→A tidak terdeteksi. |
| K10 | Bila jawaban COMMIT hilang, hasilnya tidak diketahui. Perintah dan web mengatakannya; untuk pesan hitungan, pesan dibiarkan seperti pada K4 meskipun hitungannya mungkin sudah tersimpan. |
| K11 | Event log `counting.config` punya sakelar di halaman Logging web, tetapi tidak di tombol kategori `/logging` di Discord; di sana ia mengikuti sakelar utama. |
| K12 | Keberadaan channel dan izin bot dibaca dari cache bot, bukan ditanyakan langsung ke Discord. |
| K13 | Math memakai angka pecahan biasa (`0.1+0.2` tidak sama dengan `0.3`), dan `010` dibaca sebagai 10. Roman di atas 3999 ditulis `MMMM…`, bukan bentuk baku. |
| K14 | Papan skor tetap memuat anggota yang sudah keluar. Web menampilkan nama dari cache anggota bot, selain itu ID. Hanya sepuluh besar yang ditampilkan; tidak ada penghapusan per anggota. |
| K15 | Data lama dengan angka berikutnya di atas 1.000.000 tidak dikoreksi otomatis; tampilannya dipotong dan `/count reset` memperbaikinya. |
| K16 | Pesan di channel hitung tidak mendapat XP leveling dan tidak dijalankan sebagai perintah prefix. Perilaku lama, tidak diubah. |
| K17 | Pemindahan permainan aktif ke channel lain tetap harus lewat nonaktifkan lalu atur ulang, seperti sebelumnya. |
| K18 | Efek samping: kunci `countingGame:{server}` kini dikenali pengurai kunci, sehingga pengimpor eksperimental PostgreSQL→SQLite (`src/services/migration/postgresBotKvImport.js`) akan menyalinnya, bukan berhenti dengan "requires review". Tidak diuji. |
| K19 | `/roll`, `/fight` dan `/flip` tidak punya batas pemakaian sendiri; hanya perlindungan umum bot yang berlaku, dan itu tidak diperiksa dalam audit ini. |
| K20 | Teks perintah `/count`, pengumuman di channel dan catatan log tetap berbahasa Inggris seperti perintah lain; halaman web berbahasa Indonesia. |

## Berkas

Baru:

- `src/services/countingGame/systems.js`: delapan sistem angka dan pengurai aritmetika.
- `src/services/countingGame/store.js`: baca dan tulis langsung ke PostgreSQL; `mutateGame` = satu transaksi dengan kunci per server.
- `src/services/countingGame/manage.js`: aturan permainan untuk perintah, penilai pesan dan web; daftar pesan galat (Inggris dan Indonesia).
- `src/services/countingGame/audit.js`: catatan channel log; tidak pernah menggagalkan perubahan.
- `src/dashboard/countingApi.js`, `dashboard-preview/counting-live.js`.
- `tests/helpers/counting-fixture.js`, `tests/counting-systems.test.js`, `tests/fun-commands.test.js`, `tests/postgres-counting.test.js`, `tests/postgres-dashboard-counting.test.js`.

Diubah:

- `src/commands/Fun/count.js` (ditulis ulang), `fight.js`, `roll.js`, `flip.js` (hanya impor yang tidak terpakai dibuang).
- `src/events/messageCreate.js`: penilai pesan dipindahkan ke `manage.js`.
- `src/services/loggingService.js`: event `counting.config`.
- `src/utils/database/keyParser.js`, `src/utils/postgresDatabase.js`: kunci permainan dikenali dan ditolak oleh penulisan umum.
- `src/dashboard/router.js`, `dashboard-preview/features.js`, `dashboard-preview/index.html`.
- `tests/dashboard-simulation-labels.test.js`, `tests/postgres-dashboard-live-walk.test.js`.

Dihapus: `src/services/countingGameService.js`.

## Tes

| Berkas | Jumlah | Isi |
| --- | --- | --- |
| `tests/counting-systems.test.js` | 6 | Tiap sistem menerima tulisannya sendiri dan menolak angka tetangga; huruf besar/kecil; aturan aritmetika; masukan yang bukan aritmetika ditolak dan tidak dijalankan. Tanpa database. |
| `tests/fun-commands.test.js` | 6 | `/roll` (jumlah, pengubah, batas, notasi salah), `/fight` (pemenang mengikuti damage pada 200 duel, seri, nama, lawan tidak sah), `/flip`. Tanpa database. |
| `tests/postgres-counting.test.js` | 26 | Penyimpanan (gagal baca, nilai rusak, transaksi, lapisan umum), aturan setup/disable/reset/revision, penilaian pesan (benar, salah, dua kali, obrolan, pesan sistem, database gagal, bersamaan, Discord menolak), dan `/count` (izin, jawaban, galat database, status, papan skor, log). |
| `tests/postgres-dashboard-counting.test.js` | 14 | Delapan tes API (baca, setup, reset, disable, bot belum siap, database gagal, log, JSON rusak, tanpa anggota) dan enam tes halaman di jsdom (formulir, konfirmasi, penolakan, nama dari Discord sebagai teks, gagal baca, preview statis). |

Bukti kode lama (F1–F14) dijalankan dengan tes sementara yang tidak disimpan di repositori.

## Yang belum diuji

- Server Discord nyata: izin sungguhan, penghapusan pesan, batas laju Discord saat banyak pesan salah berturut-turut.
- Browser nyata. Halaman hanya diuji di jsdom.
- Penghapusan pengumuman setelah 10 detik (K6).
- Dua proses bot terhadap satu database. Kunci per server ada di PostgreSQL sehingga seharusnya tetap aman, tetapi itu tidak dijalankan.
- Data produksi lama.
- Server dengan lebih dari 250 channel teks (daftar di web dipotong).
- Pendaftaran ulang perintah `/count` ke Discord.
- Pengimpor PostgreSQL→SQLite dengan kunci permainan hitung (K18).
