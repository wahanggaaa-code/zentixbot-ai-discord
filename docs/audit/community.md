# Audit Community (lamaran role)

Tanggal audit: 2026-11-13. Cakupan: dua perintah di `src/commands/Community/` (`/apply`, `/app-admin`), tombol, menu pilihan dan formulir lamaran, penyimpanan lamaran, entri log, pesan langsung ke pelamar, dan halaman Community di dashboard.

Audit dilakukan dengan membaca kode dan menjalankan tes dengan Discord tiruan dan PostgreSQL 16 sungguhan. **Tidak ada yang diuji pada server Discord nyata.** Halaman dashboard diuji dengan jsdom, bukan browser sungguhan.

Dokumen ini adalah bagian keenam dari butir checklist "Audit dan integrasikan kategori Community, Fun, Reaction Roles, Search, Server Stats, Tools dan Utility satu per satu". Satu kategori lain (Tools) belum dikerjakan.

## Cara kerja fitur

- Server menyediakan **formulir lamaran**, satu per role (paling banyak 25). Tiap formulir punya nama, satu sampai lima pertanyaan, dan dapat dibuka atau ditutup.
- `/apply list` menampilkan formulir yang terbuka. `/apply submit` membuka formulir isian; jawabannya disimpan sebagai lamaran berstatus `pending`. `/apply status` menampilkan lamaran milik pemanggil.
- `/app-admin setup` membuat formulir. `/app-admin dashboard` membuka panel pengaturan di Discord (aktif/nonaktif, role pengelola, channel log, masa simpan, pertanyaan, nama, tutup, hapus). `/app-admin list` dan `/app-admin review` untuk melihat dan memutuskan lamaran.
- Menyetujui lamaran memberi role kepada pelamar. Setiap keputusan dikirim ke pelamar lewat pesan langsung dan dicatat di channel log bila logging aktif.
- Data disimpan di tabel `temp_data` dengan key `guild:<id>:applications:…`: `settings`, `roles` (daftar formulir), `role:<roleId>:settings`, dan satu baris per lamaran.
- Izin: pemilik server dan anggota dengan Manage Server boleh mengatur. Anggota dengan **role pengelola** boleh melihat dan memutuskan lamaran, tetapi tidak mengatur.

## Ringkasan

Dua puluh tiga masalah diperbaiki dan diuji; semuanya dibuktikan lebih dulu dengan menjalankan kode lama. Kode lamaran ditulis ulang: dua berkas lama (1.608 baris) dan blok penyimpanan lama di `src/utils/database.js` (430 baris) dihapus, diganti empat berkas layanan, satu berkas penangan interaksi, dan dua perintah.

| Pemeriksaan | Hasil |
| --- | --- |
| Tes baru kategori Community | 56 tes di 3 berkas, semuanya lulus |
| Tes penjaga SQLite (ditulis ulang) | 3 tes, lulus di Node 22 |
| Regresi penuh, Node 22 | 1001 tes: 997 lulus, 0 gagal, 4 dilewati (tes TLS) |
| Node 20.20.2, lima berkas terkait | 68 dari 68 lulus |
| Uji mutasi | 169 perubahan sengaja-salah, 169 tertangkap tes |
| Dashboard | Halaman baru "Community". Angka sekarang: 14 ruang fitur, 34 tab, 35 formulir, 214 kontrol |

Catatan regresi: sebelum audit ini jumlahnya 947 tes. Tes penjaga SQLite yang lama (5 tes) menguji fungsi penyimpanan yang sudah dihapus dan diganti 3 tes; ditambah 56 tes baru, hasilnya 1001.

Catatan Node 20: berkas penjaga SQLite tidak dijalankan di Node 20, karena SQLite bawaan Node baru ada sejak 22.5. Ini sudah berlaku sebelum audit ini.

Catatan uji mutasi: pada putaran pertama tujuh mutasi lolos. Enam menunjukkan tes yang kurang tajam, dan tesnya dipertajam:

1. Pemeriksaan bentuk ID lamaran dilonggarkan.
2. Pemeriksaan "formulir ditutup" di dalam transaksi penyimpanan dihapus (pemeriksaan yang sama sebelum formulir dibuka masih menangkapnya, jadi tidak ada tes yang gagal).
3. Penolakan diperlakukan seperti persetujuan setelah keputusan tersimpan: yang terlihat anggota tidak berubah, tetapi log bot memuat baris galat palsu "role could not be given".
4. Kegagalan membaca pengaturan log saat lamaran dikirim tidak ditangkap.
5. Formulir "channel log" dibuka untuk formulir lamaran yang sudah dihapus.
6. `setup` dan `dashboard` dibiarkan melewati penjaga izin router: perintahnya sendiri tetap menolak, hanya kalimat penolakannya berbeda.

Yang ketujuh menunjukkan kode ganda: batas 25 formulir diperiksa dua kali (di layanan dan di penyimpanan). Pemeriksaan di layanan dihapus; yang di penyimpanan tetap ada dan diuji. Setelah itu ke-169 mutasi tertangkap dalam satu putaran penuh.

## Masalah yang diperbaiki

Semua kutipan "kode lama" berasal dari menjalankan kode lama pada tanggal audit.

| No | Masalah pada kode lama | Sekarang |
| --- | --- | --- |
| C1 | Jawaban pendek ditolak: nama "Budi" dan umur "17" menghasilkan "Please provide meaningful answers (at least 10 characters)." | Tidak ada panjang minimum. Jawaban hanya tidak boleh kosong. |
| C2 | Mencoba melamar saat lamaran dinonaktifkan tetap memulai masa tunggu: setelah diaktifkan lagi, "Please wait 1440 minute(s)". Masa tunggu juga berlaku lintas server: anggota yang melamar di satu server ditolak di server lain. | Masa tunggu (24 jam, dari `src/config/bot.js`) dihitung dari lamaran yang benar-benar tersimpan, per server. |
| C3 | Bila pembacaan database gagal: `/apply list` melempar galat "Applications are disabled"; `/app-admin list` menjawab bahwa tidak ada yang dikonfigurasi dan menunjuk ke `/app-admin roles add`, subperintah yang tidak ada. | Pembacaan yang gagal dijawab: "The applications data could not be read or saved right now. Nothing was changed; please try again later." |
| C4 | Membuat formulir saat satu pembacaan gagal: daftar dua formulir yang tersimpan diganti dengan formulir baru saja. | Tiap perubahan adalah satu transaksi dengan kunci per server, dari baca sampai tulis. Pembacaan yang gagal menghentikan perubahan. |
| C5 | Penyimpanan gagal, bot tetap menjawab berhasil: "Application Created", "Application Submitted" dengan ID, padahal tidak ada yang tersimpan. Persetujuan menjawab "Application approved", memberi role dan mengirim pesan langsung, sementara status tetap `pending`; mengulanginya memberi role dan pesan lagi. | Hasil penyimpanan diperiksa. Bila gagal: "Nothing was changed". Bila database tidak mengonfirmasi commit: "may or may not have been saved". Role dan pesan langsung hanya menyusul keputusan yang sudah tersimpan. |
| C6 | Setuju dan tolak ditekan bersamaan: keduanya menjawab berhasil. Status akhir `denied`, role tetap diberikan, dua pesan langsung terkirim. | Hanya satu keputusan yang tersimpan. Yang kedua dijawab "This application was already approved by …" (atau denied). |
| C7 | Role gagal diberikan (bot tanpa izin) atau pelamar sudah keluar: jawabannya tetap "Application approved", pesan langsung bilang disetujui, role tidak ada. | Diperiksa sebelum menyimpan: bila role tidak dapat diberikan atau pelamar sudah keluar, persetujuan ditolak dan lamaran tetap `pending`. Bila Discord menolak setelah keputusan tersimpan, jawabannya peringatan "Approved, but the role was not given", lamaran ditandai "(role not given)", dan pesan langsung mengatakan hal yang sama. |
| C8 | Formulir yang ditutup tetap tampil di `/apply list`, dapat dibuka dan diterima. | Formulir tertutup tidak tampil dan ditolak: "That application is currently closed." Diperiksa lagi saat menyimpan. |
| C9 | Anggota dengan role pengelola tetapi tanpa Manage Server ditolak penjaga izin router ("You do not have permission to use this command."), jadi role pengelola tidak berguna. | `review` dan `list` memeriksa aksesnya sendiri dan menerima role pengelola. `setup` dan `dashboard` tetap memerlukan Manage Server. |
| C10 | Anggota dengan Manage Server (posisi role 30) membuat formulir untuk role Administrator (posisi 40), melamar, menyetujui lamarannya sendiri, dan mendapat role itu. Formulir juga dapat dibuat untuk role di atas role bot, role terkelola (booster), dan `@everyone`. | Menawarkan role memerlukan Manage Roles dan role tertinggi yang lebih tinggi dari role itu (pemilik server dikecualikan). Role yang tidak dapat diberikan bot ditolak. Memutuskan lamaran sendiri ditolak. |
| C11 | Enam pertanyaan tersimpan menghasilkan formulir enam baris tanpa galat. Discord hanya menerima lima; bahwa Discord akan menolaknya adalah kesimpulan dari batas itu, tidak dijalankan terhadap Discord. | Paling banyak lima pertanyaan, diberlakukan saat menyimpan dan saat formulir dibangun. |
| C12 | `/app-admin review id:settings` menjawab "This application has already been processed." (baris pengaturan dibaca sebagai lamaran). Tiga jawaban berisi 600 garis bawah ditolak "Each answer must be less than 1000 characters", karena teks di-escape sebelum diukur dan disimpan dalam bentuk ter-escape. Tanggal ditulis dalam format server. | ID diperiksa bentuknya; ID lain dijawab "Application not found." Jawaban disimpan seperti diketik (sampai 1000 karakter) dan di-escape saat ditampilkan. Tanggal memakai format waktu Discord. |
| C13 | Panel pengaturan memasang pendengar tombol baru tiap kali digambar ulang: 3 setelah dibuka, 6 setelah satu kali tekan, 12 setelah dua kali. "Edit questions" lalu diproses 4 kali dan menjawab galat. | Tidak ada pendengar per pesan. Tiap tombol membawa tujuannya sendiri dan diproses sekali oleh router. |
| C14 | Masa simpan "12abc" diterima sebagai 12 hari. Panel kedua yang menyimpan role pengelola mengembalikan masa simpan ke 30 / 30. | Masa simpan harus bilangan bulat 1–3650. Tiap penyimpanan hanya mengubah bagian yang dimaksud. |
| C15 | Menghapus formulir dengan 60 lamaran melaporkan "Deleted: **50** applications"; 10 lamaran tertinggal. | Semua lamaran formulir itu ikut terhapus dalam transaksi yang sama, dan jumlah yang dilaporkan adalah jumlah sebenarnya. Penghapusan memerlukan kotak konfirmasi. |
| C16 | Baris baru dalam jawaban dibuang tanpa spasi ("first linesecond line of the answer"). | Baris baru dipertahankan (paling banyak satu baris kosong berturut-turut). |
| C17 | Channel log lamaran tersimpan tetapi logging tidak pernah dinyalakan: 0 entri, tanpa pemberitahuan. Dengan logging menyala: entri tanpa tombol. | Memilih channel log dari panel menyalakan logging dan mengatakannya. Panel menampilkan bila logging mati. Entri lamaran baru membawa tombol **Review**, dan diperbarui setelah keputusan. |
| C18 | Pertanyaan diubah saat formulir sedang terbuka: jawaban tersimpan di bawah pertanyaan baru (jawaban tentang warna tersimpan di bawah "How old are you?"). | Formulir membawa sidik pertanyaannya. Bila pertanyaan berubah, tidak ada yang tersimpan dan anggota diminta membuka formulir lagi. |
| C19 | Satu `/apply status` untuk anggota dengan 10 lamaran menjalankan 177 kueri. | Data server dibaca sekali per perintah. |
| C20 | Anggota keluar saat baris indeksnya kosong: lamarannya tertinggal. | Lamaran dicari dari isinya, bukan dari indeks. Semua lamaran anggota yang keluar dihapus. |
| C21 | Setelah bot dimulai ulang, tombol Approve pada tampilan review tidak diproses apa pun. | Tombol diproses router dari ID-nya dan tetap bekerja setelah mulai ulang. |
| C22 | `/app-admin list role:<nama yang tidak ada>` menjawab "Showing 2 applications." (saringan diabaikan). | Saringan role dan pengguna diterapkan; nama yang tidak dikenal menghasilkan daftar kosong. |
| C23 | Masa simpan tersimpan `0.0001` atau `'abc'`: lamaran `pending` berumur tiga jam dibiarkan, tanpa aturan yang jelas. | Nilai tersimpan yang bukan bilangan dibaca sebagai 30 hari; nilai di luar batas dibulatkan ke 1–3650. |

Tentang C2: kode lama memakai 24 jam di jalur ini, sedangkan nilai bawaan di berkas konfigurasi lama menyebut `cooldown: 7`. Perbedaan itu dibaca dari kode, tidak dijalankan. Sekarang hanya ada satu nilai, `applicationCooldown: 24`.

## Perubahan perilaku yang perlu diketahui

Semua ini adalah keputusan yang dapat diubah bila tidak sesuai.

- **Role pengelola hanya untuk meninjau.** Mereka dapat memakai `/app-admin review`, `/app-admin list` dan tombol Review; tidak dapat mengatur.
- **Menawarkan role memerlukan Manage Roles** dan role yang lebih tinggi. Manage Server saja tidak lagi cukup untuk membuat formulir.
- **Persetujuan ditolak** bila role tidak dapat diberikan atau pelamar sudah keluar. Lamaran itu masih dapat ditolak (deny).
- **Tidak ada lagi minimum 10 karakter** untuk jawaban.
- **Nama formulir unik** tanpa membedakan huruf besar-kecil. Formulir pertama menyalakan lamaran di server.
- **Pemilih role pengelola menggantikan seluruh daftar.** Pemilih channel log yang dikosongkan menghapus channel itu.
- Pertanyaan per formulir; bila kosong, dipakai pertanyaan server, lalu pertanyaan bawaan.
- `/apply status` tetap bekerja saat lamaran dinonaktifkan. ID milik orang lain dijawab "Application not found." `/apply list` tetap terlihat seluruh channel; jawaban lain pribadi.
- **Anggota yang keluar kehilangan semua lamarannya**, termasuk yang sudah diputuskan.
- `/app-admin` hanya tersedia sebagai perintah garis miring.
- Teks yang diketik anggota di-escape terhadap format dan tautan tersembunyi. Mention (`@everyone`, `<@id>`) dibiarkan seperti diketik; di dalam embed, mention tidak memberi notifikasi.
- Tiap perubahan pengaturan yang tersimpan menulis satu baris di log bot, `Application settings changed`, dengan server, pelaku, sumber (`discord` atau `dashboard`) dan jenis perubahan.
- **Lamaran role memerlukan PostgreSQL.** Di SQLite semua pintu masuk menolak dengan pesan "could not be read or saved".
- Kunci konfigurasi lama untuk lamaran (warna status, role pengelola bawaan, masa hapus) dihapus dari `src/config/bot.js`. Yang tersisa: `defaultQuestions` dan `applicationCooldown`.

## Dashboard

Halaman baru **Community** (`#features/community/applications`), satu tab, hanya untuk pemilik server atau anggota dengan Manage Server.

- **Pengaturan**: aktif/nonaktif, role pengelola, masa simpan lamaran `pending` dan yang sudah diputuskan. Halaman meminta konfirmasi; bila masa simpan diperpendek, konfirmasinya menyebut bahwa lamaran yang lebih tua akan hilang.
- **Formulir**: daftar formulir dengan nama, buka/tutup, lima kolom pertanyaan, jumlah lamaran tersimpan dan yang `pending`, serta tombol hapus. Formulir baru: pilih role (role yang tidak dapat ditawarkan dinonaktifkan di pilihan), nama, pertanyaan.
- **Yang sengaja tidak ada di web**: isi lamaran dan keputusan. Lamaran dibaca dan diputuskan di Discord. Channel log juga diatur di Discord atau di halaman Logging; halaman ini hanya menampilkan keadaannya.
- Tiap penulisan memerlukan sesi, token CSRF, `confirmed: true`, kunci isi yang tepat, dan `revision`. Bila pengaturan berubah di tempat lain sejak halaman dimuat, penulisan ditolak (409) dan tidak ada yang disimpan.
- Data tersimpan yang tidak dapat dibaca dijawab 409 "Data lamaran yang tersimpan tidak dapat dibaca. Tidak ada yang diubah.", bukan dianggap kosong.

Indeks fitur sekarang berbunyi "14 FITUR TERHUBUNG KE BOT". "BELUM ADA HALAMAN" tinggal Tools. "TANPA HALAMAN SENDIRI" tetap Search dan Utility.

Angka penelusuran dashboard (tes dengan router asli): 14 ruang, 34 tab (21 fitur, 12 AI, 1 penyedia), 35 formulir, 214 kontrol. Sebelumnya 13 / 33 / 31 / 187. Empat formulir baru berasal dari halaman ini pada data uji (pengaturan, dua formulir tersimpan, formulir baru). Tambahan kontrol tidak seluruhnya dari halaman ini: dua role yang ditambahkan ke data uji juga menambah pilihan di halaman lain.

## Keterbatasan yang dicatat

| No | Keterbatasan |
| --- | --- |
| K1 | Discord dan database bukan satu transaksi. Urutannya tetap: keputusan disimpan, lalu role, lalu pesan langsung dan log. Role yang gagal setelah keputusan tersimpan dilaporkan sebagai peringatan dan harus diberikan dengan tangan. |
| K2 | Pesan langsung dan entri log bersifat usaha terbaik. Kegagalannya tidak membatalkan keputusan; jawaban kepada peninjau menyebut bila pelamar tidak dapat dihubungi. |
| K3 | Masa tunggu antar-lamaran (24 jam) adalah nilai di berkas konfigurasi, sama untuk semua server; tidak ada pengaturannya di Discord atau web. |
| K4 | Formulir pembuatan di Discord hanya punya tiga kolom pertanyaan; pertanyaan keempat dan kelima ditambahkan lewat "Edit questions" atau lewat web. |
| K5 | Lamaran yang melewati masa simpan tidak ditampilkan lagi sejak saat itu, tetapi barisnya baru dihapus ketika ada lamaran baru atau ketika `/app-admin list` dijalankan. Tidak ada penjadwal. |
| K6 | Memperpendek masa simpan lewat Discord tidak meminta konfirmasi; lewat web diminta. |
| K7 | `/app-admin` terdaftar di Discord dengan izin bawaan Manage Server. Agar anggota dengan role pengelola melihat perintah itu, server harus mengizinkannya di Pengaturan Server → Integrasi. Tombol Review di channel log tidak memerlukan itu. |
| K8 | Mention dalam teks yang diketik anggota tidak di-escape (lihat di atas). |
| K9 | Baris indeks lama `users:<id>` tidak lagi dipakai atau ditulis. Baris yang sudah ada dibiarkan sampai anggotanya keluar atau data server dihapus. |
| K10 | Baris lamaran lama dengan status tak dikenal atau milik server lain dilewati saat membaca, tidak diperbaiki dan tidak dihapus. |
| K11 | Kunci per server memakai kunci penasihat PostgreSQL; dua proses bot terhadap satu database tidak diuji. |
| K12 | Web tidak menampilkan lamaran. Server yang ingin meninjau dari web belum terlayani. |

## Berkas

Baru:

- `src/services/applications/store.js`: penyimpanan (transaksi, kunci per server, batas, kode galat `APP_*`).
- `src/services/applications/service.js`: aturan (siapa boleh apa, role mana yang boleh ditawarkan, melamar, memutuskan, mengatur).
- `src/services/applications/view.js`: embed, formulir, kalimat penolakan.
- `src/services/applications/notify.js`: entri log dan pesan langsung.
- `src/handlers/applicationHandlers.js` dan tiga berkas `src/interactions/{buttons,selectMenus,modals}/applications/app.js`: tombol, menu, formulir.
- `src/dashboard/applicationsApi.js`, `dashboard-preview/applications-live.js`: API dan halaman web.
- `tests/helpers/community-fixture.js`, `tests/community-applications.test.js`, `tests/community-applications-settings.test.js`, `tests/postgres-dashboard-applications.test.js`.

Ditulis ulang: `src/commands/Community/apply.js`, `src/commands/Community/app-admin.js`, `tests/sqlite-applications-guard.test.js`.

Dihapus: `src/commands/Community/modules/app_dashboard.js`, `src/services/applicationService.js`, blok penyimpanan lamaran di `src/utils/database.js`, empat pembuat key di `src/utils/database/keys.js`, kunci konfigurasi lama di `src/config/bot.js`.

Diubah:

- `src/events/interactionCreate.js`: cabang lamaran lama dibuang; interaksi `app:…` lewat jalur umum.
- `src/events/guildMemberRemove.js`: menghapus lamaran anggota yang keluar.
- `src/utils/permissionGuard.js`: perintah dapat menyatakan bahwa ia memeriksa aksesnya sendiri (`checksOwnAccess`). Saat ini hanya dipakai `/app-admin review` dan `list`.
- `src/services/loggingService.js`: entri log dapat membawa tombol.
- `src/utils/postgresDatabase.js`: `client.db.set` / `delete` umum menolak key lamaran.
- `src/dashboard/router.js`, `dashboard-preview/features.js`, `dashboard-preview/index.html`: pemasangan API dan halaman.
- `tests/dashboard-simulation-labels.test.js`, `tests/postgres-dashboard-live-walk.test.js`: angka dan data uji baru.

## Tes

| Berkas | Jumlah | Isi |
| --- | --- | --- |
| `tests/community-applications.test.js` | 28 | Melamar, masa tunggu, pertanyaan berubah, status, daftar, meninjau, setuju/tolak bersamaan, role gagal, pelamar keluar, log, pesan langsung, masa simpan, data lama, kegagalan baca dan tulis |
| `tests/community-applications-settings.test.js` | 16 | Membuat, mengubah dan menghapus formulir; izin; role yang boleh ditawarkan; role pengelola; channel log; masa simpan; dua panel sekaligus; dua tes lewat router `interactionCreate.js` yang asli |
| `tests/postgres-dashboard-applications.test.js` | 12 | 6 tes API (sesi, CSRF, konfirmasi, revisi, data tak terbaca) dan 6 tes halaman dengan jsdom |
| `tests/sqlite-applications-guard.test.js` | 3 | Di SQLite dan tanpa database semua pintu masuk menolak; key lamaran tidak dapat disentuh lewat jalur umum |

Cara menjalankan: `node --test --test-concurrency=1 <berkas>` dengan `ZENTIX_TEST_PG_SOCKET` menunjuk ke PostgreSQL uji. Tanpa PostgreSQL, tes yang memerlukannya dilewati.

## Yang belum diuji

- Server Discord nyata: batas formulir Discord, tampilan embed, pesan langsung, urutan role sungguhan, izin perintah di Integrasi.
- Dua proses bot terhadap satu database.
- Data lamaran lama dari produksi. Tes memakai baris berbentuk lama yang dibuat dari pembacaan kode lama.
- Server dengan lebih dari 250 role atau channel.
- Browser sungguhan; halaman hanya diuji dengan jsdom.
- Perintah awalan (prefix): kedua perintah hanya garis miring.
