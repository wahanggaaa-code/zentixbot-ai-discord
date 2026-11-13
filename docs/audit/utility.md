# Audit Utility (to-do, laporan, cuaca, info server dan pengguna)

Tanggal audit: 2026-11-13. Cakupan: delapan perintah di `src/commands/Utility/` (`/todo`, `/report`, `/weather`, `/userinfo`, `/serverinfo`, `/firstmsg`, `/avatar`, `/wipedata`), tombol dan formulir daftar to-do bersama, penyimpanan to-do, dan tempat kategori ini di dashboard.

Audit dilakukan dengan membaca kode dan menjalankan tes dengan Discord tiruan dan PostgreSQL 16 sungguhan. **Tidak ada yang diuji pada server Discord nyata, dan layanan cuaca (Open-Meteo) tidak dihubungi sama sekali** (lingkungan audit tidak punya akses ke sana). Alamat permintaan cuaca tidak diubah dari kode lama; bentuk jawabannya diambil dari anggapan kode lama, bukan diperiksa ulang.

Dokumen ini adalah bagian kelima dari butir checklist "Audit dan integrasikan kategori Community, Fun, Reaction Roles, Search, Server Stats, Tools dan Utility satu per satu". Dua kategori lain (Community, Tools) belum dikerjakan.

## Cara kerja fitur

- `/todo add | list | complete | remove`: daftar to-do pribadi tiap anggota. Satu baris per anggota di tabel `temp_data`, key `todo_{userId}`. Daftar ini tidak terikat server.
- `/todo share …`: daftar bersama. Pembuatnya menjadi pemilik dan menambahkan anggota lain; semua anggota daftar boleh menambah, menyelesaikan dan menghapus tugas. Key `shared_todo_{listId}`, ditambah `user_shared_lists_{userId}` yang mencatat daftar mana saja yang diikuti seseorang. Tampilan daftar bersama punya tiga tombol (Add Task, Complete Task, Remove Task) yang membuka formulir.
- `/report file` mengirim laporan tentang seorang pengguna ke channel laporan server dan menyebut (mention) pemilik server. `/report setchannel` memilih channel itu; pengaturannya sama dengan "Channel reports" di halaman Logging dashboard.
- `/weather` mencari koordinat kota lalu cuaca saat ini di Open-Meteo.
- `/userinfo`, `/serverinfo`, `/avatar`, `/firstmsg`: hanya membaca data Discord.
- `/wipedata`: sudah dinonaktifkan sebelum audit ini; ia hanya menjawab bahwa tidak ada data yang dihapus. Tidak diubah.
- Izin: semua anggota boleh memakai semuanya, kecuali `/report setchannel` yang memerlukan Manage Server. Tiap perintah dapat dimatikan per server di "Akses perintah".

## Ringkasan

Dua puluh tiga masalah diperbaiki dan diuji. Dua puluh tiga keterbatasan dicatat tanpa diperbaiki. Sembilan belas masalah pertama (U1–U19) dibuktikan lebih dulu dengan menjalankan kode lama; empat sisanya (U20–U23) didapat dari pembacaan kode dan hanya perilaku barunya yang diuji.

| Pemeriksaan | Hasil |
| --- | --- |
| Tes baru kategori Utility | 50 tes di 3 berkas, semuanya lulus |
| Regresi penuh, Node 22 | 947 tes: 943 lulus, 0 gagal, 4 dilewati (tes TLS) |
| Node 20.20.2, lima berkas terkait | 62 dari 62 lulus |
| Uji mutasi | 156 perubahan sengaja-salah, 156 tertangkap tes |
| Dashboard | Tidak ada halaman baru. Angka tetap: 13 ruang fitur, 33 tab, 31 formulir, 187 kontrol |

Catatan uji mutasi: pada putaran pertama lima mutasi lolos (tanpa rollback, mode degradasi database diterima, ID daftar tidak diperiksa saat mengubah, nama daftar tidak di-escape, pilihan `page` diabaikan pada daftar bersama). Kelimanya menunjukkan tes yang kurang tajam, bukan kode yang salah. Tesnya dipertajam, lalu ke-156 mutasi tertangkap.

## Masalah yang diperbaiki

### Dibuktikan pada kode lama

| No | Masalah pada kode lama | Sekarang |
| --- | --- | --- |
| U1 | `/todo add`: bila pembacaan database gagal sesaat, daftar dianggap kosong, lalu disimpan ulang berisi tugas baru saja. Daftar `one, two` menjadi `three`, dan bot menjawab "Task Added". | Pembacaan yang gagal menghentikan perintah: "To-do lists are unavailable right now. Nothing was changed." Daftar tetap utuh. `/todo list` juga tidak lagi menampilkan "kosong" saat pembacaan gagal. |
| U2 | Penyimpanan gagal, tetapi bot tetap menjawab "Task Added", "Task Completed", "Task Removed". | Hasil penyimpanan diperiksa. Bila gagal: "Nothing was changed". Bila database tidak mengonfirmasi commit: "may or may not have been saved". |
| U3 | Lima tugas ditambahkan bersamaan ke satu daftar bersama: lima jawaban "Task Added", hanya empat yang tersimpan. | Tiap perubahan adalah satu transaksi dengan kunci dari baca sampai tulis. Kelimanya tersimpan dengan nomor berbeda. |
| U4 | Daftar to-do **pribadi** ditampilkan ke seluruh channel. | Semua jawaban `/todo` hanya terlihat pemanggil. Daftar bersama juga, kecuali diminta dengan `public: True`. |
| U5 | Di daftar pribadi, tugas selesai tampak sama dengan yang belum: penandanya hanya emoji, dan emoji dibuang oleh pembersih embed bot. Barisnya juga memuat tanda kode yang tidak ditutup (`` `[11/13/2026` ``). | Tugas selesai ditulis `~~teks~~ · done` (daftar bersama: `done by @anggota`). Tanggal memakai format waktu Discord. |
| U6 | Tidak ada batas: tugas 6000 karakter diterima, dan dari 31 tugas hanya 13 yang tampil karena embed dipotong diam-diam di 4096 karakter. | Tugas 1–200 karakter, paling banyak 50 tugas per daftar, tampil 10 per halaman dengan pilihan `page`. Diuji: daftar penuh dengan teks terpanjang tetap muat tanpa terpotong. |
| U7 | Judul dan isi tertukar: daftar kosong berjudul "Your to-do list is empty!" dengan isi "Your To-Do List"; daftar bersama yang kosong menaruh seluruh isinya di judul. | Judul tetap ("Your To-Do List", "Shared To-Do List"); isi di badan pesan, anggota di kolom tersendiri. |
| U8 | Bot dapat dijadikan anggota daftar bersama ("Added somebot"). | Ditolak. |
| U9 | ID daftar bersama hanya muncul sekali saat dibuat; catatan `user_shared_lists_…` ditulis tetapi tidak pernah dibaca. Tidak ada cara keluar dari daftar, menghapus daftar, atau mencabut anggota. | Subperintah baru: `share lists`, `share leave`, `share delete`, `share removemember`, `share complete`. |
| U10 | Formulir tugas membawa ID pesan di dalam ID-nya, dan bot menggambar ulang pesan dengan ID itu tanpa memeriksa pesan apa itu. Formulir dengan ID pesan lain mengubah pesan bot yang lain (di tes: pesan "Giveaway") menjadi tampilan daftar. | Yang digambar ulang hanya pesan asal tombol, dan hanya bila pesan itu milik bot dan memang tampilan daftar yang sama. |
| U11 | `/report file` menjawab "successfully filed and sent to the moderation team" padahal laporan tidak terkirim, dalam lima keadaan: logging dimatikan, jenis log laporan dimatikan, bot tanpa izin di channel, Discord menolak pesan, channel sudah dihapus. | Hasil pengiriman diperiksa. Bila tidak terkirim: "the moderation team has **not** received it. Please contact a moderator directly." |
| U12 | Satu anggota dapat mengirim laporan tanpa batas, tiap laporan menyebut pemilik server (enam berturut-turut di tes). Melaporkan diri sendiri diterima. | Paling banyak 5 laporan per 10 menit per anggota per server. Melaporkan diri sendiri ditolak. |
| U13 | `/report setchannel` menerima channel tempat bot tidak dapat menulis, sehingga semua laporan berikutnya hilang. | Diperiksa dulu: View Channel, Send Messages, Embed Links. Bila kurang, channel tidak diubah dan izin yang kurang disebut. |
| U14 | `/report setchannel` menjawab "Report Channel Set" padahal penyimpanan gagal. | Hasil penyimpanan diperiksa. Bila jenis log laporan sedang dimatikan, jawabannya peringatan "Reports Still Off". |
| U15 | `/weather`: nama kota yang diketik anggota ditulis ulang mentah dan tebal di pesan yang terlihat semua orang; tempat tanpa negara tampil "Bogor, undefined"; kolom Humidity selalu "N/A%"; kode cuaca 77 menjadi "Unknown conditions". | Nama kota ditulis ulang sebagai kode. Bagian yang tidak ada dilewati. Kolom Humidity hanya muncul bila ada nilainya (lihat K2). Semua kode cuaca Open-Meteo punya nama. |
| U16 | `/weather`: layanan menjawab 503 atau bukan JSON, atau tempat tanpa koordinat → galat lolos dari perintah. Nama kota 3000 karakter tetap dikirim. Permintaan tanpa batas waktu. | Tiga jawaban berbeda (terlalu banyak permintaan, tidak terjangkau, jawaban tidak dapat dipakai). Nama kota 2–100 karakter. Batas waktu, ukuran dan pengalihan sama dengan `/search`. |
| U17 | `/userinfo`: anggota yang tidak ada di cache bot ditulis "Not in server". Daftar peran memuat `@everyone`, tidak berurutan, tanpa spasi; anggota tanpa peran punya "Highest Role: @everyone". | Memakai data anggota yang dikirim Discord bersama perintah. Peran diurutkan dari yang tertinggi, tanpa `@everyone`, paling banyak 10 lalu "and N more". |
| U18 | `/userinfo` dan `/serverinfo` di pesan langsung: galat `Cannot read properties of null`. `/serverinfo` gagal seluruhnya bila pemilik server tidak dapat diambil, dan menghitung thread sebagai channel. | Keduanya ditandai khusus server dan menjawab "can only be used in a server". Pemilik yang gagal diambil ditulis sebagai mention; kolom lain tetap tampil. Thread tidak dihitung. |
| U19 | `/firstmsg`: bot tanpa izin membaca channel → galat lolos dari perintah. | Izin diperiksa dulu; jawabannya menyebut View Channel dan Read Message History. Kegagalan lain dari Discord punya pesan sendiri. |

Tentang U5: yang terlihat pada kode lama adalah daftar tanpa penanda sama sekali (`#1 buy milk…`). Daftar itu tidak memuat tugas selesai; bahwa penanda "selesai" ikut terbuang diperiksa terpisah dengan menjalankan pembersih embed pada kedua penanda.

Tentang U10: yang dibuktikan adalah bahwa handler lama menggambar ulang pesan mana pun yang ID-nya ada di ID formulir. Apakah Discord membiarkan seorang anggota mengirim formulir dengan ID yang diubah **tidak diuji**; perbaikan ini pengaman, bukan bukti bahwa celahnya dapat dipakai.

Tentang U15: yang dibuktikan adalah teks yang dikirim bot. Bahwa Discord merendernya sebagai tautan bertopeng mengikuti aturan markdown Discord; itu tidak dilihat di klien Discord sungguhan.

Tentang U16, U18 dan U19: "galat lolos dari perintah" berarti perintah melempar galat ke penangan umum bot. Pesan yang akhirnya dilihat anggota dari penangan umum itu tidak diperiksa.

### Dari pembacaan kode

| No | Masalah pada kode lama | Sekarang |
| --- | --- | --- |
| U20 | Baris to-do dapat ditimpa lewat `client.db.set` / `delete` umum, yang menjawab kegagalan dengan `false` atau "tidak ada data". | Key `todo_…`, `shared_todo_…`, `user_shared_lists_…` hanya dapat ditulis oleh `src/services/todo/store.js`; penulisan umum ditolak. Membaca tetap bisa. |
| U21 | Nama pengguna, nama server, nama channel, nama daftar, isi tugas dan alasan laporan dimasukkan mentah ke embed. | Semuanya di-escape: tidak dapat memformat diri atau menyembunyikan tautan. |
| U22 | Tombol daftar bersama membuka formulir untuk siapa saja; penolakan baru muncul setelah formulir dikirim. Isian "1.5" dibaca sebagai tugas 1. | Formulir hanya dibuka untuk anggota daftar. Nomor tugas harus bilangan bulat (boleh diawali `#`). |
| U23 | Menambah anggota menulis dua baris (daftar dan catatan anggota) tanpa transaksi; kegagalan di tengah meninggalkan setengahnya. | Satu transaksi; diuji bahwa kegagalan tulisan kedua membatalkan yang pertama. |

## Perubahan perilaku yang perlu diketahui

Semua butir di bawah adalah keputusan audit, bukan permintaan pemilik bot. Masing-masing dapat diubah bila tidak diinginkan.

- **Semua jawaban `/todo` kini pribadi**, termasuk tampilan daftar bersama. Untuk menaruh daftar bersama di channel (agar anggota lain memakai tombolnya di sana), pakai `/todo share view public: True`. Sebelumnya semuanya terlihat seluruh channel.
- **Batas baru**: tugas 1–200 karakter dan satu baris; 50 tugas per daftar; nama daftar 1–50 karakter; 25 anggota per daftar; satu anggota paling banyak di 25 daftar bersama. Data lama yang melebihi batas tidak dihapus (lihat K16).
- **Subperintah baru**: `/todo share lists`, `leave`, `delete`, `removemember`, `complete`. Pilihan baru: `page` pada `/todo list` dan `/todo share view`, `public` pada `/todo share view`.
- Bot tidak dapat dijadikan anggota daftar bersama. Pemilik tidak dapat keluar dari daftarnya; ia menghapusnya dengan `/todo share delete`.
- `/report file`: 5 laporan per 10 menit per anggota per server; tidak dapat melaporkan diri sendiri. Mention pemilik server pada tiap laporan **dipertahankan**.
- `/report setchannel` menolak channel tempat bot tidak dapat menulis.
- `/weather`: kolom Humidity hilang (dulu selalu "N/A%"). Deskripsi cuaca lebih rinci ("Overcast", "Heavy rain", "Snow grains"). Nama kota 2–100 karakter.
- `/userinfo`: peran ditampilkan sebagai mention, berurutan, tanpa `@everyone`.
- `/serverinfo`: kolom Owner berisi nama dan mention; jumlah channel tidak lagi memuat thread.
- Pesan galat berubah di banyak tempat (lihat tabel di atas).
- Definisi perintah berubah (`/todo`, `/weather`, `/userinfo`, `/serverinfo`). Perintah didaftarkan ulang oleh bot saat menyala.

## Dashboard

Utility tidak dibuatkan halaman:

- Daftar to-do adalah data pribadi anggota dan tidak terikat server. Admin server tidak punya alasan untuk melihat atau mengubahnya dari web.
- Satu-satunya pengaturan server di kategori ini, channel laporan, sudah ada di halaman Logging ("Channel reports"). Tes penelusuran dashboard kini memeriksa bahwa pilihan itu memang ada di sana.

Yang diubah di halaman indeks fitur:

- Utility dipindah dari daftar "BELUM ADA HALAMAN" ke blok "TANPA HALAMAN SENDIRI", di samping Search. Keterangannya tidak menyebut "tidak menyimpan apa pun" (karena itu tidak benar untuk Utility), melainkan: tidak punya pengaturan server sendiri, to-do adalah data pribadi, channel `/report` diatur di Logging. Ada dua tautan: Logging dan Akses perintah.
- Daftar "BELUM ADA HALAMAN" kini berisi dua kategori: Community dan Tools.

## Keterbatasan yang dicatat

| No | Keterbatasan |
| --- | --- |
| K1 | Layanan cuaca tidak dihubungi. Alamat permintaan sama dengan kode lama; bentuk jawaban (`results[0].latitude`, `current_weather.temperature`, dst.) diambil dari kode lama. |
| K2 | Kelembapan tidak ditampilkan karena permintaan yang ada tidak memintanya. Menambahkannya berarti mengubah parameter permintaan, yang tidak dapat diuji dari lingkungan ini. Kode sudah menampilkan kolomnya bila nilainya datang. |
| K3 | `/weather` memakai hasil pencarian pertama yang punya koordinat. Tidak ada cara memilih negara; satuan selalu metrik. |
| K4 | Perintah prefix (`!todo …`) tidak diuji. Dari kode adaptor, jawaban perintah prefix adalah pesan biasa di channel, jadi daftar pribadi akan terlihat orang lain lewat jalur itu. |
| K5 | Mention di dalam teks tugas (`<@id>`, `@everyone`) tidak dinetralkan. Menurut aturan Discord, mention di dalam embed tidak memberi notifikasi; itu tidak dilihat di klien sungguhan. Tampilan daftar bersama juga dikirim dengan `allowedMentions` kosong. |
| K6 | Emoji di teks tugas tersimpan, tetapi tidak tampil: pembersih embed bot (`src/utils/embeds.js`) membuang emoji dari semua embed. Perilaku lama, tidak diubah. |
| K7 | Daftar bersama tidak terikat server. Anggota daftar dapat memakainya di server mana pun yang ada botnya. Hak akses ditentukan keanggotaan daftar, bukan server. |
| K8 | Menambahkan seseorang ke daftar tidak memerlukan persetujuannya dan tidak memberi tahu dia. Ia dapat keluar dengan `/todo share leave`. |
| K9 | `/todo share lists` membaca catatan `user_shared_lists_…`. Keanggotaan yang hilang dari catatan itu (akibat kode lama yang tanpa kunci) tidak muncul di sana, walaupun daftarnya tetap dapat dibuka dengan ID-nya. Sebaliknya, isi catatan yang bukan keanggotaan sungguhan diabaikan dan dibersihkan saat catatan ditulis berikutnya. |
| K10 | Pesan tampilan daftar yang sudah ada di channel tidak dibersihkan. Setelah daftar dihapus, tombolnya menjawab "not found"; anggota yang sudah keluar masih dapat membaca pesan lama itu. |
| K11 | Setelah formulir dikirim, pesan menampilkan halaman tempat tugas yang berubah. Tidak ada tombol pindah halaman; halaman lain dibuka dengan `/todo share view page:`. |
| K12 | Pembatas kecepatan (formulir to-do: 5 per 30 detik; laporan: 5 per 10 menit) disimpan di memori proses. Ia kembali ke nol saat bot dinyalakan ulang dan tidak dibagi antara dua proses bot. |
| K13 | Pembatas laporan menghitung percobaan, termasuk laporan yang gagal terkirim. |
| K14 | Tiap laporan menyebut pemilik server. Tidak ada pengaturan untuk memilih siapa yang disebut, atau mematikannya. |
| K15 | `/report setchannel` menyalakan logging server (`logging.enabled = true`) sebagai efek samping, karena itulah yang dilakukan `setLogChannel` di layanan logging. Bila logging sengaja dimatikan, log lain yang channel-nya sudah diatur ikut menyala. Tidak diubah; layanan logging di luar cakupan kategori ini. |
| K16 | Data lama: tugas yang lebih panjang dari 200 karakter tetap tersimpan utuh tetapi tampil terpotong di 250 karakter; daftar dengan lebih dari 50 tugas tidak dapat ditambah sampai jumlahnya turun. Entri tugas yang rusak (tanpa nomor atau tanpa teks) tidak ditampilkan dan hilang saat daftar ditulis berikutnya. |
| K17 | Channel laporan yang dipilih lewat halaman Logging di web tidak diperiksa izinnya oleh perubahan ini (kode halaman itu tidak disentuh). Bila bot tidak dapat menulis di sana, `/report file` kini mengatakannya kepada pelapor. |
| K18 | `/wipedata` tetap nonaktif. Anggota tidak punya satu perintah untuk menghapus semua data to-do miliknya; ia menghapus tugas satu per satu dan menghapus daftar bersama miliknya. |
| K19 | Dua proses bot sekaligus tidak diuji. Kunci yang dipakai adalah kunci PostgreSQL, yang berlaku lintas proses, tetapi itu belum dibuktikan dengan dua proses. |
| K20 | `/firstmsg` mengandalkan Discord mengembalikan pesan tertua untuk `after: 1, limit: 1`. Itu perilaku kode lama dan tidak diperiksa terhadap Discord. Thread dan forum tidak diuji. |
| K21 | `/userinfo` menulis "Not in server" bila Discord tidak mengirim data anggota dan cache bot juga tidak punya. Bahwa Discord selalu mengirim data anggota untuk pengguna yang ada di server tidak diperiksa terhadap Discord. |
| K22 | `/serverinfo`: jumlah channel masih memuat kategori; jumlah peran masih memuat `@everyone`. Tidak diubah. |
| K23 | Menggambar ulang pesan dari formulir memakai `interaction.update()` pada pengiriman formulir. Di tes ini ditirukan; perilakunya pada Discord sungguhan (terutama untuk pesan pribadi) belum dilihat. Bila penggambaran ulang gagal, perubahan tetap tersimpan dan tetap dikonfirmasi. |

## Berkas

Baru:

- `src/services/todo/store.js`: baca dan tulis langsung ke PostgreSQL, transaksi dengan kunci, pemeriksaan data tersimpan.
- `src/services/todo/lists.js`: semua operasi daftar (pribadi dan bersama), batas, alasan penolakan.
- `src/services/todo/view.js`: tampilan daftar, halaman, kalimat penolakan dan kegagalan.
- `tests/postgres-todo.test.js`, `tests/postgres-report.test.js`, `tests/utility-commands.test.js`, `tests/helpers/utility-fixture.js`.
- `docs/audit/utility.md`.

Diubah:

- `src/commands/Utility/todo.js`, `src/handlers/todoButtons.js`: ditulis ulang di atas layanan baru.
- `src/commands/Utility/modules/report.js`, `report_setchannel.js`: pemeriksaan hasil, batas, izin bot.
- `src/commands/Utility/weather.js`: ditulis ulang; memakai `src/services/searchLookup.js`.
- `src/commands/Utility/userinfo.js`, `serverinfo.js`, `firstmsg.js`, `avatar.js`.
- `src/utils/postgresDatabase.js`: key to-do ditolak oleh penulisan umum.
- `dashboard-preview/features.js`: Utility di blok "TANPA HALAMAN SENDIRI".
- `tests/dashboard-simulation-labels.test.js`, `tests/postgres-dashboard-live-walk.test.js`.

Tidak diubah: `src/commands/Utility/report.js`, `wipedata.js`, `src/events/interactionCreate.js`, layanan logging.

## Tes

| Berkas | Jumlah | Isi |
| --- | --- | --- |
| `tests/postgres-todo.test.js` | 25 | Dengan PostgreSQL. Daftar pribadi: simpan, tampil, pribadi, nomor tidak dipakai ulang, pembacaan gagal, penyimpanan gagal, commit tanpa jawaban, penambahan bersamaan, batas, daftar penuh muat di satu pesan, escape, data tersimpan yang rusak. Daftar bersama: buat, lihat, pribadi atau publik, hak pemilik, bukan anggota (sembilan percobaan), ID tidak sah tanpa query, siapa menambah dan menyelesaikan, hapus, catatan keanggotaan, batas anggota dan daftar, tambah anggota semua-atau-tidak. Tombol dan formulir: hanya anggota, gambar ulang pesan asal, nomor tidak sah, halaman tugas yang berubah, pesan asing tidak disentuh, pembatas kecepatan, gambar ulang gagal, penyimpanan gagal. Penulisan umum ditolak. Satu tes melewati router interaksi bot yang asli (`src/events/interactionCreate.js`): tiga tombol dan tiga formulir sampai ke handler-nya dengan ID daftar yang benar. |
| `tests/postgres-report.test.js` | 6 | Dengan PostgreSQL. Laporan terkirim dan dikonfirmasi pribadi, escape alasan dan nama; enam keadaan tidak terkirim; tanpa channel, diri sendiri, alasan kosong; batas 5 per 10 menit; `setchannel` (izin pemanggil, izin bot, jenis channel, tersimpan); penyimpanan gagal dan laporan dimatikan. |
| `tests/utility-commands.test.js` | 19 | Tanpa database. `/weather` (permintaan dan batasnya, semua kode cuaca, tempat tidak ditemukan, kolom yang hilang atau berbahaya, tiap jenis kegagalan, batas nama kota); `/userinfo` dan `/serverinfo` (data anggota, peran, pesan langsung, pemilik gagal diambil); `/firstmsg` (tautan, izin, kegagalan); `/avatar`; definisi `/todo`; database tidak tersedia; pembersihan teks; pembacaan data tersimpan; pengenalan pesan daftar; kalimat penolakan. `axios.get` diganti tiruan. |

Bukti kode lama (U1–U19) dijalankan dengan tes sementara yang tidak disimpan di repositori.

## Yang belum diuji

- Open-Meteo yang sebenarnya: bentuk jawaban, kecepatan, pembatasan.
- Server Discord nyata: tampilan embed, coretan dan mention di klien Discord; pesan pribadi (ephemeral); tombol dan formulir sungguhan, termasuk menggambar ulang pesan pribadi; pendaftaran ulang perintah.
- Apakah Discord menerima formulir dengan ID yang diubah (lihat U10).
- Perintah prefix (`!todo`, `!report`, dst.).
- Dua proses bot sekaligus.
- Data to-do produksi lama.
- Browser nyata untuk perubahan halaman indeks fitur (hanya jsdom).
