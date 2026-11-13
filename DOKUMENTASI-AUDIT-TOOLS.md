# Audit Tools (kalkulator, hitung mundur, poll, embed builder, dan alat kecil lain)

Tanggal audit: 2026-11-13. Cakupan: sebelas perintah di `src/commands/Tools/` (`/calculate`, `/countdown`, `/poll`, `/embedbuilder`, `/shorten`, `/hexcolor`, `/baseconvert`, `/generatepassword`, `/randomuser`, `/time`, `/unixtime`), tombol dan formulirnya, pengurai rumus `src/utils/safeMathParser.js`, dan tempat kategori ini di dashboard.

Audit dilakukan dengan membaca kode dan menjalankan tes dengan Discord tiruan. Kategori ini tidak menyimpan apa pun di database, jadi tesnya tidak memakai database. **Tidak ada yang diuji pada server Discord nyata, dan layanan luar (is.gd untuk `/shorten`, dummyimage.com untuk gambar `/hexcolor`) tidak dihubungi sama sekali** (lingkungan audit tidak punya akses ke sana). Alamat permintaan is.gd tidak diubah dari kode lama; bentuk jawabannya diambil dari anggapan kode lama, bukan diperiksa ulang.

Dokumen ini adalah bagian ketujuh dan terakhir dari butir checklist "Audit dan integrasikan kategori Community, Fun, Reaction Roles, Search, Server Stats, Tools dan Utility satu per satu".

## Cara kerja fitur

- `/calculate` menghitung satu rumus. Di bawah hasil ada empat tombol (+, −, ×, ÷) untuk melanjutkan dari hasil itu.
- `/countdown` memulai hitung mundur sampai 24 jam, dengan tombol Pause/Resume dan Cancel.
- `/poll` membuat jajak pendapat dengan 2 sampai 10 pilihan; suara diberikan lewat reaksi angka.
- `/embedbuilder` (bawaan: hanya anggota dengan Manage Messages) membuka panel pribadi untuk menyusun embed, melihat pratinjaunya, lalu mempostingnya ke channel yang dipilih.
- `/shorten` memendekkan alamat web lewat is.gd. `/hexcolor` menampilkan rincian sebuah warna. `/baseconvert` mengubah bilangan bulat antar-basis. `/generatepassword` membuat kata sandi acak. `/randomuser` memilih satu anggota secara acak. `/time` dan `/unixtime` menampilkan waktu.
- Tidak ada pengaturan server untuk kategori ini. Tiap perintah dapat dimatikan per server di "Akses perintah".

## Ringkasan

Tiga puluh sembilan masalah dibuktikan dengan menjalankan kode lama, lalu diperbaiki dan diuji (T1–T39). Sembilan perbaikan lain (E1–E9) berasal dari pembacaan kode; untuk yang ini hanya perilaku barunya yang diuji. Delapan belas keterbatasan dicatat tanpa diperbaiki.

Tiga hal ternyata tidak berfungsi sama sekali pada kode lama: `/randomuser` gagal pada setiap pemanggilan (T30), tombol "Set Color" di embed builder selalu gagal (T38), dan Author serta Footer di embed builder tidak dapat diisi (T37).

| Pemeriksaan | Hasil |
| --- | --- |
| Tes baru kategori Tools | 65 tes di 4 berkas, semuanya lulus |
| Regresi penuh, Node 22 | 1066 tes: 1062 lulus, 0 gagal, 4 dilewati (tes TLS, seperti sebelumnya) |
| Node 20.20.2, berkas terkait | 77 dari 77 lulus (enam berkas: empat berkas Tools, label simulasi, penelusuran dashboard) |
| Uji mutasi | 174 perubahan sengaja-salah pada kode, 174 tertangkap tes |
| Dashboard | Tidak ada halaman baru. Angka tetap: 14 ruang fitur, 34 tab, 35 formulir, 214 kontrol |

Catatan uji mutasi: pada putaran pertama 12 dari 175 mutasi lolos. Delapan menunjukkan tes yang kurang tajam (hasil pecahan di tombol kalkulator, formulir untuk operasi selain tambah, angka terlalu besar di tengah rumus, detik negatif, tombol Resume ditekan dua kali, kesalahan program di `/shorten`, channel tujuan yang tidak berasal dari server, daftar warna bawaan); tesnya dipertajam. Empat menunjukkan kode yang tidak berpengaruh (pemeriksaan yang sudah dijamin oleh baris lain); kode itu dihapus, sehingga daftar mutasi menjadi 171. Tiga mutasi ditambahkan untuk batas 14 menit embed builder (lihat catatan di bagian Tes), menjadi 174.

## Masalah yang diperbaiki

### Dibuktikan pada kode lama

**Kalkulator**

| No | Masalah pada kode lama | Sekarang |
| --- | --- | --- |
| T1 | `-2^2` menghasilkan `4`. | `-4`, seperti di kertas: pangkat dihitung sebelum tanda minus. `(-2)^2` tetap `4`. |
| T2 | `log10(100)` ditolak, karena nama fungsi yang mengandung angka tidak dikenali. | `2`. Ditambah `log2`, `ln`, `floor`, `ceil`, `round`, dan notasi ilmiah (`1e5`, `2.5e-3`). |
| T3 | Fungsi tak dikenal, pembagian dengan nol, dan salah ketik semuanya dijawab dengan kalimat yang sama: "Failed to evaluate the expression.Please check the syntax and try again." | Tiga pesan berbeda: nama yang tidak dikenal disebutkan, hasil tak terhingga dijelaskan, dan salah sintaks diberi contoh. |
| T4 | `12345678901+1` ditampilkan `1.234568e+10`; lima digit hilang. | `12,345,678,902`. Bilangan bulat ditampilkan utuh selama JavaScript dapat menyimpannya dengan tepat. |
| T5 | Tombol tidak melanjutkan dari hasil terakhir. Setelah `2*3*4 = 24` lalu "+ 5" (29), "+ 1" menjawab `25`. | Tiap tombol membawa hasil yang sedang tampil. "+ 5" lalu "× 2" memberi 29 lalu 58. |
| T6 | Hasil lanjutan dikirim sebagai pesan publik baru; pesan aslinya tidak berubah. | Pesan yang sama diperbarui. |
| T7 | Tiap `/calculate` memasang pendengar pada seluruh channel selama 5 menit dan menyimpan rumus di memori. Setelah bot restart: "This calculation has expired." | Tidak ada pendengar dan tidak ada yang disimpan. Tombol membawa pemilik dan nilainya, jadi tetap berfungsi setelah restart. Hanya anggota yang menghitung yang dapat melanjutkan. |
| T8 | Angka kosong, `0x10` atau `Infinity` di formulir dijawab "Something Went Wrong". | Pesan yang menjelaskan apa yang salah, hanya terlihat oleh anggota itu; hasil di pesan tidak berubah. |

**Hitung mundur**

| No | Masalah pada kode lama | Sekarang |
| --- | --- | --- |
| T9 | Bot mengedit pesan setiap detik: 60 edit per menit untuk satu hitung mundur. | Pesan memakai penanda waktu Discord, yang dihitung mundur oleh aplikasi Discord sendiri. Bot mengedit sekali, saat waktu habis. |
| T10 | Setelah pesannya dihapus, bot tetap mencoba mengedit: 60 percobaan dan 60 baris error per menit, sampai waktunya habis. | Percobaan edit di akhir gagal sekali, dicatat sebagai debug, selesai. |
| T11 | Anggota yang memulai hitung mundur tidak dapat menjeda atau membatalkannya tanpa izin Manage Messages. | Pemulai boleh. Anggota lain tetap memerlukan Manage Messages. |
| T12 | Tidak ada batas: satu anggota menjalankan 21 hitung mundur sekaligus. | 5 hitung mundur per 10 menit per anggota per server, dan 500 sekaligus untuk seluruh bot. |
| T13 | Tanpa `minutes` dan `seconds`, perintah melempar error dan tidak menjawab. | "Please give a duration of at least 1 second". Nilai negatif dan lebih dari 24 jam juga ditolak dengan pesan. |
| T14 | Judul berisi `[teks](alamat)` tampil sebagai tautan tersamar. | Judul ditampilkan sebagai teks biasa, maksimal 100 karakter. |
| T15 | Setelah bot restart, tombol hitung mundur yang belum selesai menjawab "This countdown has expired or was cancelled." | Keadaan hitung mundur ada di pesan dan tombolnya, bukan di memori. Tombol tetap berfungsi setelah restart. |

**Poll**

| No | Masalah pada kode lama | Sekarang |
| --- | --- | --- |
| T16 | Pilihan `anonymous` hanya menambah kalimat "Votes are not tracked to users". Suara tetap berupa reaksi, yang dapat dilihat siapa pun. | Pilihan itu dihapus. Poll berkata terus terang: "Reactions are visible to everyone." |
| T17 | Bila bot tidak boleh menambah reaksi: poll tetap terkirim tanpa reaksi, anggota tidak mendapat jawaban, dan error dilempar. | Izin diperiksa sebelum apa pun dikirim; jawabannya menyebut izin yang kurang. Bila reaksi gagal di tengah jalan, anggota diberi tahu berapa yang berhasil. |
| T18 | Sepuluh pilihan panjang (600 karakter): teks terpotong, hanya 7 dari 10 pilihan terlihat, tetapi 10 reaksi tetap dipasang. | Pertanyaan maksimal 300 karakter dan pilihan 100. Poll terpanjang yang diterima selalu tampil utuh. |
| T19 | Pertanyaan berisi `[teks](alamat)` tampil sebagai tautan tersamar. | Pertanyaan dan pilihan ditampilkan sebagai teks biasa. |

**Pemendek URL**

| No | Masalah pada kode lama | Sekarang |
| --- | --- | --- |
| T20 | `javascript:alert(1)` dan `file:///etc/passwd` dikirim ke layanan. | Hanya alamat `http://` atau `https://`, tanpa nama pengguna dan kata sandi di dalamnya. Yang lain ditolak tanpa permintaan keluar. |
| T21 | Jawaban penolakan dari layanan ("Error: …") ditampilkan sebagai "URL Shortened — Here's your shortened URL: Error: …", termasuk tautan dan `@everyone` yang ada di dalamnya. | Berhasil hanya bila jawabannya tepat satu tautan `https://is.gd/…`. Penolakan ditampilkan sebagai penolakan, dengan kalimat layanan sebagai teks kode sehingga tautan dan mention di dalamnya tidak aktif. Jawaban yang tidak dapat dibaca tidak ditampilkan sama sekali. |
| T22 | Baris kedua jawaban ikut ditampilkan, dan jawaban 5 juta karakter diterima seluruhnya lalu dipotong. | Jawaban dibatasi 4 KB; yang lebih besar diputus sebelum selesai dibaca. Pengalihan tidak diikuti. |

**Warna, basis bilangan, kata sandi, pengguna acak, waktu**

| No | Masalah pada kode lama | Sekarang |
| --- | --- | --- |
| T23 | `/hexcolor #ABCD` dan `ABCDE` dijawab "Something Went Wrong — Failed to generate color information." | Pesan yang menyebut bentuk yang diterima: 3 atau 6 digit. |
| T24 | `#010000` (hampir hitam) diberi nama "Close to Cyan". | "Nearest named color: Black". Nama dicari dari jarak warna yang sebenarnya. |
| T25 | Warna acak tidak pernah `#FFFFFF` (nilai terbesar `#fffffe`) dan ditulis huruf kecil. | Seluruh rentang, huruf kapital, dari sumber acak sistem. |
| T26 | `/baseconvert` Base58 `lO` (dua karakter yang tidak ada di Base58) dijawab "The number is too large to process." | "`lO` is not a Base58 number", dengan daftar karakter yang sah. Base58 dan Base62 kini membedakan huruf besar dan kecil. |
| T27 | Base64 `a=b` diterima dan diubah menjadi `0`. | Ditolak. Hanya ejaan Base64 yang baku yang diterima. |
| T28 | Masukan 3000 digit: jawaban dipotong di tengah angka. | Masukan maksimal 200 karakter; pada batas itu semua baris hasil tampil utuh. |
| T29 | `/generatepassword` dengan huruf besar, angka dan simbol diminta dapat menghasilkan `!aaaaaaa` dan melaporkan "Contains: Lowercase, Symbols". Karakter pelengkap saling menimpa. | Satu karakter dari tiap jenis yang diminta dijamin ada, apa pun hasil acaknya. |
| T30 | `/randomuser` gagal pada setiap pemanggilan (`Unable to convert "primary" to a number`) dan tidak menjawab. | Berfungsi. |
| T31 | `/time asia/jakarta` menampilkan nama zona persis seperti diketik. | Nama baku (`Asia/Jakarta`). Singkatan seperti WIB ditolak dengan penjelasan. |

**Embed builder**

| No | Masalah pada kode lama | Sekarang |
| --- | --- | --- |
| T32 | Dengan dua panel terbuka, satu klik ditangani dua kali dan mengubah kedua panel. | Tiap panel dan tiap menu pilihan hanya mendengarkan pesannya sendiri. |
| T33 | Panel bertuliskan "Closes after 5 min of inactivity", tetapi kenyataannya 15 menit sejak dibuka, tanpa hitungan diam. | Tutup setelah 5 menit tanpa kegiatan, dan paling lama 14 menit (Discord hanya menerima perubahan panel selama 15 menit). Panel menyebutkan keduanya dan memberi tahu saat tutup. |
| T34 | Anggota yang tidak boleh menulis di sebuah channel dapat memposting embed di sana lewat bot. | Anggota harus punya View Channel, Send Messages dan Embed Links di channel tujuan. |
| T35 | Tidak ada jejak siapa yang memposting embed. | Satu baris log bot per embed: server, channel, pesan, dan anggota. |
| T36 | Formulir yang ditutup lalu dibuka lagi: satu kali kirim menambahkan field dua kali. | Hanya formulir yang dibuka terakhir yang dijawab. |
| T37 | Panel menampilkan baris Author dan Footer, tetapi tidak ada tombol untuk mengisinya; kodenya ada namun tidak terjangkau. | Tombol "Set Author" dan "Set Footer". |
| T38 | "Set Color" selalu gagal: "Something Went Wrong — An unexpected error occurred." Warna tidak dapat diubah. | Berfungsi; sebelas pilihan warna tampil. |
| T39 | Panel berkata Timestamp "Enabled", tetapi embed yang diposting tidak punya timestamp. Emoji di judul dan isi dihapus dan spasi ganda dirapatkan. | Embed anggota diposting persis seperti ditulis: emoji, spasi, indentasi, footer, dan timestamp. |

### Dari pembacaan kode

Untuk sembilan butir ini kode lama tidak dijalankan lebih dulu; hanya perilaku barunya yang diuji.

| No | Menurut kode lama | Sekarang |
| --- | --- | --- |
| E1 | `/generatepassword` mengambil karakter pelengkap dan posisinya dari `Math.random`, bukan dari sumber acak sistem. | Semua pilihan acak dari `crypto.randomInt`. Baris "Strength" diganti perkiraan keacakan dalam bit. |
| E2 | Embed builder: bila Discord menolak embed saat diposting, kesalahannya tidak ditangkap. | "Discord refused the embed … nothing was posted." "Embed Sent" hanya muncul setelah pesannya ada. |
| E3 | Embed builder: field dengan nama atau isi berupa spasi saja diterima. | Ditolak dengan pesan. |
| E4 | Embed builder: bila panel di-reset saat menu channel masih terbuka, embed kosong dikirim ke Discord, yang menolaknya; kesalahan itu tidak ditangkap. | Ditolak lebih dulu: "Add at least a title, description, or field". |
| E5 | Embed builder: embed dengan lebih dari 6000 karakter dikirim ke Discord dan ditolak di sana. | Ditolak lebih dulu, dengan jumlah karakternya. |
| E6 | Embed builder: ekspor JSON ditampilkan di dalam embed bot, sehingga emoji di dalamnya hilang. | Ditampilkan sebagai teks pesan, atau sebagai berkas bila panjang. Isinya sama dengan yang akan diposting. |
| E7 | `/poll` menerima dua pilihan yang sama. | Ditolak. |
| E8 | Embed bot melewati aturan gaya di `src/utils/embeds.js`, yang membuang footer kecuali berisi kata tertentu. Footer buatan anggota akan ikut terbuang. | Embed anggota tidak melewati aturan itu (lihat T39). |
| E9 | `/calculate` memasang pendengarnya lewat objek channel setelah hasil dikirim. Bila objek itu tidak tersedia, perintah gagal sesudah menjawab. | Tidak ada pendengar; perintah tidak memerlukan objek channel. |

## Perubahan perilaku yang perlu diketahui

- `/calculate`: `-2^2` sekarang `-4`. Tombol "History" dihapus. Hanya anggota yang menghitung yang dapat memakai tombolnya. Angka ditulis dengan pemisah ribuan.
- `/countdown`: tampilan berupa waktu Discord ("in 5 minutes"), bukan `mm:ss` yang diedit bot. Maksimal 24 jam. Tombol hitung mundur dari versi lama dijawab "no longer valid".
- `/poll`: pilihan `anonymous` dihapus. Poll kini adalah jawaban perintah itu sendiri, sehingga Discord menampilkan siapa yang membuatnya; dulu ia pesan terpisah tanpa nama. Pilihan ditulis "1." sampai "10." di teks; reaksinya tetap emoji angka.
- `/randomuser`: pilihan `online` dihapus, karena bot tidak meminta data status online dari Discord sehingga penyaring itu tidak pernah dapat bekerja. Tombol "Pick Another User" hanya untuk anggota yang memanggil. Jawaban menyebut berapa anggota yang diundi.
- `/baseconvert`: maksimal 200 karakter. Base58 dan Base62 membedakan huruf besar dan kecil.
- `/embedbuilder`: anggota memerlukan izin menulis di channel tujuan. Emoji, footer dan timestamp buatan anggota kini benar-benar tampil.

Keputusan yang dapat dibalik bila tidak sesuai: penghapusan `anonymous` dan `online`, penghapusan tombol History, batas 5 hitung mundur per 10 menit, dan embed anggota yang tidak lagi dibersihkan dari emoji.

## Dashboard

Tidak ada halaman baru. Tools tidak menyimpan pengaturan apa pun, jadi tidak ada yang dapat diatur.

- Di indeks Fitur, Tools pindah dari "BELUM ADA HALAMAN" ke "TANPA HALAMAN SENDIRI", bersama Search dan Utility, dengan daftar sebelas perintahnya dan tautan ke "Akses perintah".
- Bagian "BELUM ADA HALAMAN" kini kosong dan tidak ditampilkan lagi: setiap kategori sudah punya halaman atau tercatat tidak memerlukannya.
- Sebuah tes membandingkan daftar perintah di dashboard dengan isi folder `src/commands/Tools/`, dan memeriksa bahwa kesebelas perintah dapat dimatikan per server.
- Angka dashboard tetap: 14 ruang fitur, 34 tab, 35 formulir, 214 kontrol.

## Keterbatasan yang dicatat

1. **Hitung mundur setelah restart.** Perubahan pesan menjadi "Time's up!" dijadwalkan di memori. Bila bot restart sebelum waktunya habis, pesan tetap menunjukkan waktu berakhirnya (Discord menulis "5 minutes ago"), dan baru berubah bila tombolnya ditekan.
2. **Tidak ada pemberitahuan** saat hitung mundur selesai; pesannya berubah, tidak ada yang di-mention. Kode lama juga begitu.
3. **Batas hitung mundur ada di memori** satu proses bot. Restart mengosongkannya, dan beberapa proses bot tidak saling tahu.
4. **Tombol kalkulator versi lama** tidak dijawab; Discord menampilkan "interaction failed". Tombol itu memang hanya hidup 5 menit pada kode lama.
5. **Ketelitian kalkulator** adalah ketelitian angka JavaScript. `0.1+0.2` tampil `0.3` karena hasil dibulatkan ke 10 digit; bilangan bulat di atas 9.007.199.254.740.991 tidak tepat. Tidak ada faktorial dan tidak ada perkalian tanpa tanda (`2(3)`).
6. **Poll sederhana.** Suara adalah reaksi: terlihat oleh semua, satu anggota dapat memilih beberapa pilihan, tidak ada penutupan otomatis dan tidak ada rekap hasil.
7. **`/shorten` bergantung pada is.gd.** Bot tidak memeriksa ke mana tautan pendek mengarah. Jawabannya pribadi, jadi anggota sendiri yang membagikannya.
8. **Gambar `/hexcolor`** berasal dari dummyimage.com. Bila layanan itu mati, rincian warna tetap tampil tanpa gambar. Hanya 20 nama warna yang dikenal.
9. **`/baseconvert`** hanya untuk bilangan bulat tanpa tanda. Base64 dibaca sebagai bilangan; nol di depan hilang (`AAE=` menjadi `AQ==`), sama seperti `007` menjadi `7`.
10. **`/randomuser`** mengundi dari anggota yang sedang dikenal bot. Di server besar itu bisa hanya sebagian; jawaban menyebutkannya bila jumlah anggota server lebih besar.
11. **`/time`** memakai data zona waktu bawaan Node.js. Singkatan (WIB, PST) tidak dikenal; selisih seperti `+07:00` diterima.
12. **Kata sandi `/generatepassword`** dikirim lewat Discord sebagai pesan pribadi. Bot tidak menyimpan atau mencatatnya, tetapi pesan itu tetap melewati server Discord.
13. **Panel embed builder ada di memori.** Restart menutup semua panel tanpa pemberitahuan; tombolnya tidak dijawab. Satu sesi paling lama 14 menit.
14. **Embed yang diposting tidak mencantumkan penulisnya.** Jejaknya ada di log bot, bukan di channel log server.
15. **Alamat gambar di embed builder** hanya diperiksa bentuknya. Dapat tidaknya gambar dimuat ditentukan Discord.
16. **Menu hapus dan urut-ulang field** di embed builder tidak menangkap kegagalan Discord; bila itu terjadi anggota tidak mendapat pesan. Dicatat dari pembacaan kode, tidak diubah.
17. **Aturan gaya embed** di `src/utils/embeds.js` (hapus emoji, buang footer, abaikan timestamp) tetap berlaku untuk semua embed bot yang lain. Di luar cakupan audit ini.
18. **Perintah dengan awalan teks (prefix).** Jalur itu tidak diuji untuk Tools, selain satu hal: poll tidak menolak hanya karena `inGuild` tidak tersedia di sana.

## Berkas

Ditulis ulang:

- `src/commands/Tools/calculate.js`, `countdown.js`, `poll.js`, `shorten.js`, `hexcolor.js`, `baseconvert.js`, `generatepassword.js`, `randomuser.js`, `time.js`, `unixtime.js`
- `src/handlers/countdownButtons.js`, `src/interactions/buttons/countdown/countdown.js`
- `src/interactions/modals/calculate/calculate.js`

Diubah:

- `src/commands/Tools/embedbuilder.js`: pendengar per pesan, batas diam, izin anggota, log, tombol Author dan Footer, embed sebagai objek biasa, ekspor JSON.
- `src/utils/safeMathParser.js`: `MathError` berkode, urutan pangkat dan minus, fungsi baru, notasi ilmiah, batas 200 karakter.
- `src/services/searchLookup.js`: `getText` untuk jawaban teks pendek.
- `dashboard-preview/features.js`, `tests/dashboard-simulation-labels.test.js`.

Baru:

- `src/handlers/calculateHandlers.js`, `src/interactions/buttons/calculate/calculate.js`, `src/interactions/buttons/randomuser/randomuser.js`
- `tests/helpers/tools-fixture.js` dan empat berkas tes di bawah.

Dihapus: `src/handlers/calculateModals.js`.

Sepuluh perintah selain embed builder, beserta penangan tombol dan formulirnya, turun dari 1757 menjadi 1043 baris.

## Tes

| Berkas | Jumlah | Isi |
| --- | --- | --- |
| `tests/tools-calculate.test.js` | 10 | Pengurai rumus, format hasil, pesan kegagalan, tombol dan formulir lewat router asli, ID palsu |
| `tests/tools-countdown-poll.test.js` | 19 | Hitung mundur dengan jam tiruan (edit, jeda, lanjut, batal, pesan terhapus, batas, restart), poll (izin, panjang, teks biasa, reaksi gagal) |
| `tests/tools-commands.test.js` | 22 | `/shorten` dan `getText` terhadap server HTTP lokal, warna, basis, kata sandi, pengguna acak, waktu, akses perintah |
| `tests/tools-embedbuilder.test.js` | 14 | Dua panel, batas diam dan batas 14 menit, formulir ganda, Author dan Footer, izin posting, penolakan Discord, ekspor JSON, semua tombol |

Tombol dan formulir kalkulator, hitung mundur dan pengguna acak diuji lewat `interactionCreate` yang asli, dengan berkas penangan didaftarkan seperti cara pemuat bot melakukannya.

Catatan batas 14 menit: versi pertama perbaikan T33 ternyata salah. Tiap kegiatan di panel ikut memundurkan batas 14 menit, sehingga panel yang terus dipakai dapat melewati 15 menit. Ini ditemukan saat memeriksa kode discord.js, sebelum commit, lalu diperbaiki. Tesnya menjalankan pengatur waktu discord.js yang asli, dipercepat 400 kali; jam Discord sungguhan tidak diuji.

## Yang belum diuji

- Server Discord nyata: tampilan penanda waktu hitung mundur, reaksi poll, panel embed builder, dan batas waktu 15 menit Discord.
- Layanan is.gd dan dummyimage.com.
- Edit pesan hitung mundur di akhir, pada pesan yang merupakan jawaban perintah, di Discord sungguhan.
- Perintah Tools lewat awalan teks (prefix), selain satu kasus poll.
- Dashboard di browser sungguhan; tesnya memakai jsdom.
