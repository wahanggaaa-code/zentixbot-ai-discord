# Audit Search (kamus, Urban Dictionary, tautan Google)

Tanggal audit: 2026-11-13. Cakupan: perintah `/search` dengan tiga subperintahnya (`define`, `google`, `urban`), permintaan HTTP ke layanan luar, dan tempat kategori ini di dashboard.

Audit dilakukan dengan membaca kode dan menjalankan tes dengan Discord tiruan dan server HTTP lokal. **Tidak ada yang diuji pada server Discord nyata, dan kedua layanan luar tidak dihubungi sama sekali** (lingkungan audit tidak punya akses ke sana). Bentuk jawaban kedua layanan itu diambil dari anggapan kode lama, bukan diperiksa ulang.

Dokumen ini adalah bagian keempat dari butir checklist "Audit dan integrasikan kategori Community, Fun, Reaction Roles, Search, Server Stats, Tools dan Utility satu per satu". Tiga kategori lain (Community, Tools, Utility) belum dikerjakan.

## Cara kerja fitur

- `/search define word:` mengambil arti kata bahasa Inggris dari `api.dictionaryapi.dev` dan menampilkannya: paling banyak 5 jenis kata, masing-masing 3 arti.
- `/search urban term:` mengambil satu entri dari `api.urbandictionary.com`: definisi, contoh, jumlah suara, penulis, dan tautan ke halaman entri.
- `/search google query:` tidak mencari apa pun. Bot hanya menyusun tautan ke halaman pencarian Google.
- Kategori ini tidak menyimpan apa pun di database dan tidak punya pengaturan.
- Izin: semua anggota boleh memakainya. Tiap subperintah dapat dimatikan per server lewat halaman "Akses perintah" di dashboard atau perintah `/commands`.
- Batas pemakaian: hanya jeda bawaan bot, 3 detik per anggota per perintah.

## Ringkasan

Lima belas masalah diperbaiki dan diuji. Empat belas keterbatasan dicatat tanpa diperbaiki. Tiga belas masalah pertama (S1–S13) dibuktikan lebih dulu dengan menjalankan kode lama; dua sisanya (S14–S15) didapat dari pembacaan kode dan hanya perilaku barunya yang diuji.

| Pemeriksaan | Hasil |
| --- | --- |
| Tes baru kategori Search | 20 tes di 3 berkas, semuanya lulus |
| Regresi penuh, Node 22 | 897 tes: 893 lulus, 0 gagal, 4 dilewati (tes TLS) |
| Node 20.20.2, lima berkas terkait | 32 dari 32 lulus |
| Uji mutasi | 80 perubahan sengaja-salah, 80 tertangkap tes |
| Dashboard | Tidak ada halaman baru. Angka tetap: 13 ruang fitur, 33 tab, 31 formulir, 187 kontrol |

Catatan uji mutasi: putaran pertama macet pada mutasi "tanpa batas waktu keseluruhan", karena tes yang menangkapnya tidak punya batas waktu sendiri dan menunggu tanpa akhir. Tes itu diberi batas 15 detik, lalu seluruh 80 mutasi dijalankan.

## Masalah yang diperbaiki

### Dibuktikan pada kode lama

| No | Masalah pada kode lama | Sekarang |
| --- | --- | --- |
| S1 | `/search google`: teks yang diketik anggota menjadi teks tautan. Query `x](https://evil.example) [y` menghasilkan `[Search for "x](https://evil.example) [y"](…)`, yaitu tautan bertopeng ke situs pilihan anggota di dalam pesan bot. | Teks tautan tetap ("Open this search on Google"). Query ditampilkan sebagai kode, yang tidak dirender Discord sebagai tautan atau format. |
| S2 | `/search google`: tanda kurung di query tidak di-encode di dalam tautan (`f(x) = 2` menjadi `…q=f(x)%20%3D%202)`). Menurut aturan markdown, kurung tutup tanpa pasangan mengakhiri alamat tautan lebih awal. | `! ' ( ) *` ikut di-encode. Tautan membawa query persis seperti diketik. |
| S3 | `/search google`: query panjang (Discord mengizinkan sampai 6000 karakter) dipotong di 4096 karakter sebelum alamatnya, sehingga tautannya hilang sama sekali. | Query dibatasi 1–200 karakter, di Discord dan di bot. |
| S4 | `/search urban`: layanan tidak dapat dihubungi atau terlalu lama menjawab → "No definitions found". | "Urban Dictionary could not be reached. Please try again later." |
| S5 | `/search urban`: entri tanpa contoh atau tanpa jumlah suara → "No definitions found", padahal definisinya ada. | Bagian yang tidak ada dilewati; definisi tetap ditampilkan. |
| S6 | `/search urban`: nama penulis dan judul entri (ditulis pengguna Urban Dictionary) ditampilkan mentah; `[free nitro](https://evil.example)` menjadi tautan bertopeng. | Semua teks dari layanan luar di-escape: tidak dapat memformat diri atau menyembunyikan tautan. |
| S7 | `/search urban`: contoh selalu diakhiri `...` walaupun tidak dipotong. Jumlah suara tampil tanpa keterangan (`1,200 • 30`). | Tanda `…` hanya bila memang dipotong. Suara ditulis `1,200 up • 30 down`. |
| S8 | `/search define`: kata dengan arti panjang gagal total ("Something went wrong"), karena satu kolom embed melebihi 1024 karakter. | Tiap arti dipotong 220 karakter dan contoh 100; kolom selalu muat. |
| S9 | `/search define`: layanan membatasi (429), tidak terjangkau, menjawab bukan JSON, atau entri tanpa arti → semuanya "Something went wrong" dengan kode rujukan, seakan bot rusak. | Empat jawaban berbeda: tidak ditemukan, terlalu banyak permintaan, tidak terjangkau, jawaban tidak dapat dipakai. |
| S10 | `/search urban` menampilkan isi Urban Dictionary di channel mana pun. | Hanya di channel berbatas usia; di tempat lain ditolak sebelum ada permintaan keluar. Lihat "Perubahan perilaku". |
| S11 | `/search define`: `..` dikirim sebagai bagian alamat (`…/entries/en/..`), dan kata 3000 karakter tetap dikirim. | Kata harus 2–100 karakter dan memuat huruf atau angka; selain itu ditolak tanpa permintaan keluar. |
| S12 | `/search urban`: tautan entri yang bukan URL sah → "No definitions found". Galat 500 dari layanan → "Something went wrong". | Judul hanya ditautkan bila alamatnya `https` di `urbandictionary.com`; selain itu judul tanpa tautan. Galat layanan punya pesan sendiri. |
| S13 | `/search define`: kata yang tidak ditemukan ditulis ulang mentah di pesan yang terlihat semua orang; `[free nitro](https://evil.example)` menjadi tautan bertopeng. | Ditulis ulang sebagai kode. Sama untuk `/search urban`. |

Tentang S1, S2, S6 dan S13: yang dibuktikan adalah teks yang dikirim bot. Bahwa Discord merendernya sebagai tautan bertopeng mengikuti aturan markdown Discord untuk embed; itu tidak dilihat di klien Discord sungguhan.

### Dari pembacaan kode

| No | Masalah pada kode lama | Sekarang |
| --- | --- | --- |
| S14 | Permintaan HTTP hanya punya batas diam 5 detik. Tidak ada batas ukuran jawaban, dan jawaban yang datang sedikit demi sedikit tidak pernah berakhir. | Batas diam 5 detik, batas keseluruhan 8 detik, ukuran paling banyak 512 KB, paling banyak 2 pengalihan. Diuji dengan server HTTP lokal. |
| S15 | `/search urban` memakai pengatur waktu 1,5 detik untuk menunda jawaban, sehingga pesan galat kadang hanya terlihat pemanggil dan kadang terlihat semua orang, tergantung kecepatan layanan. | Urutan tetap: tolak dulu yang tidak sah (hanya terlihat pemanggil), lalu tunda, lalu jawab. |

## Perubahan perilaku yang perlu diketahui

- **`/search urban` kini hanya berjalan di channel berbatas usia** (thread mengikuti channel induknya). Ini keputusan audit, bukan permintaan pemilik bot: isi Urban Dictionary ditulis penggunanya dan sering eksplisit, dan aturan Discord menempatkan konten dewasa di channel berbatas usia. Pembatasnya satu blok di awal `src/commands/Search/modules/search_urban.js` dan dapat dicabut bila tidak diinginkan.
- `/search google` tampil berbeda: baris ``Search: `query` `` lalu tautan "Open this search on Google". Query paling panjang 200 karakter.
- `/search define` dan `/search urban` menerima paling panjang 100 karakter.
- Kolom "Stats" pada `/search urban` kini bernama "Votes".
- Pesan galat berubah (lihat S4, S9).
- Definisi perintah `/search` berubah (batas panjang, deskripsi `urban`). Perintah didaftarkan ulang oleh bot saat menyala.

## Dashboard

Search tidak menyimpan pengaturan, jadi tidak dibuatkan halaman. Yang diubah:

- Di halaman indeks fitur, Search dipindah dari daftar "BELUM ADA HALAMAN" ke blok baru "TANPA HALAMAN SENDIRI". Blok itu menyebut ketiga subperintah dan menautkan ke halaman "Akses perintah".
- Daftar "BELUM ADA HALAMAN" kini berisi tiga kategori: Community, Tools, Utility.
- Halaman "Akses perintah" yang sudah ada menampilkan `search define`, `search google` dan `search urban` satu per satu dan dapat mematikan masing-masing. Ini diuji dengan definisi perintah yang asli; kodenya tidak diubah.

## Keterbatasan yang dicatat

| No | Keterbatasan |
| --- | --- |
| K1 | Bentuk jawaban kedua layanan luar tidak diperiksa terhadap layanan aslinya. Bila layanan mengubah bentuk jawabannya, anggota akan mendapat "tidak ditemukan" atau "jawaban tidak dapat dipakai". |
| K2 | Status berbatas usia dibaca dari channel yang dikenal bot. Di pesan langsung, atau bila channel tidak ada di cache bot, `/search urban` ditolak. |
| K3 | Pembatas usia `/search urban` tidak dapat diatur dari dashboard atau perintah; mengubahnya berarti mengubah kode. Mematikan subperintahnya bisa, lewat "Akses perintah". |
| K4 | Alamat web polos di dalam teks dari layanan tetap dapat diklik (tujuannya terlihat). Mention di dalam teks itu tampil sebagai mention tetapi tidak mengirim notifikasi karena berada di embed. Escape menambah garis miring terbalik yang dapat merusak alamat web polos yang memuat `_` atau `*`. |
| K5 | Sumber teks tidak tampil. Footer "Powered by Free Dictionary API", "Urban Dictionary" dan "Google Search Results" dibuang oleh pembantu embed yang berlaku untuk seluruh bot. Tidak diubah karena menyangkut semua perintah. |
| K6 | Tidak ada batas pemakaian khusus dan tidak ada penyimpanan hasil sementara. Banyak anggota dapat membuat bot mengirim banyak permintaan, lalu layanan membatasi alamat bot; anggota mendapat pesan "terlalu banyak permintaan". |
| K7 | `/search define` hanya bahasa Inggris. `/search urban` mengambil entri pertama yang dapat ditampilkan dari jawaban layanan, bukan yang suaranya terbanyak. |
| K8 | `/search google` tidak mencari; hanya tautan. Tidak ada pengaturan SafeSearch. |
| K9 | Setelah bot menunda jawaban, pesan "tidak ditemukan" dan "layanan tidak terjangkau" terlihat semua orang. Hanya penolakan masukan dan penolakan channel yang terlihat pemanggil saja. |
| K10 | Pengalihan diikuti paling banyak dua kali, ke alamat mana pun yang disebut layanan. |
| K11 | Jalur perintah prefix (`!search …`) tidak diuji. |
| K12 | Log bot mencatat kata, istilah atau query bersama ID pengguna pada tingkat info, seperti sebelumnya. |
| K13 | Teks jawaban tetap berbahasa Inggris seperti perintah lain. |
| K14 | Batas 512 KB dan batas waktu berlaku untuk kedua layanan dan tidak dapat diatur. Entri kamus yang sangat besar akan ditolak sebagai "jawaban tidak dapat dipakai"; apakah ada kata yang jawabannya sebesar itu tidak diketahui. |

## Berkas

Baru:

- `src/services/searchLookup.js`: satu fungsi permintaan JSON dengan batas dan pengelompokan kegagalan; `plainText` (teks luar menjadi teks biasa), `codeSpan` (masukan anggota sebagai kode), `encodeQuery`.
- `tests/search-lookup.test.js`, `tests/search-commands.test.js`, `tests/postgres-search-access.test.js`.

Diubah:

- `src/commands/Search/search.js`: batas panjang pilihan, deskripsi `urban`.
- `src/commands/Search/modules/search_define.js`, `search_google.js`, `search_urban.js`: ditulis ulang.
- `dashboard-preview/features.js`, `dashboard-preview/features.css`: blok "TANPA HALAMAN SENDIRI".
- `tests/dashboard-simulation-labels.test.js`.

## Tes

| Berkas | Jumlah | Isi |
| --- | --- | --- |
| `tests/search-lookup.test.js` | 8 | Dengan server HTTP lokal: jawaban JSON, 404, 429, 500, bukan JSON, server diam, jawaban yang menetes tanpa akhir, sambungan ditolak, jawaban terlalu besar, pengalihan berulang. Tanpa server: pesan galat, escape teks, kode, encode query. |
| `tests/search-commands.test.js` | 11 | Batas pada definisi perintah; `/search google` (tautan, query buatan, batas, tanpa permintaan keluar); `/search define` (tampilan, batas Discord, escape, entri ganjil, tiap jenis kegagalan, masukan ditolak); `/search urban` (pembatas channel, tampilan, escape, bagian yang hilang, tautan entri, tiap jenis kegagalan); galat di dalam bot. `axios.get` diganti tiruan. |
| `tests/postgres-search-access.test.js` | 1 | Halaman "Akses perintah" dengan definisi `/search` asli: tiga subperintah terdaftar, masing-masing dapat dimatikan sendiri, lalu seluruh perintah dan seluruh kategori. Memakai PostgreSQL. |

Bukti kode lama (S1–S13) dijalankan dengan tes sementara yang tidak disimpan di repositori.

## Yang belum diuji

- `api.dictionaryapi.dev` dan `api.urbandictionary.com` yang sebenarnya: bentuk jawaban, kecepatan, pembatasan.
- Server Discord nyata: tampilan embed, tautan dan kode di klien Discord; pendaftaran ulang perintah `/search`.
- Channel berbatas usia sungguhan, termasuk thread dan forum.
- Perintah prefix (`!search …`).
- Browser nyata untuk perubahan halaman indeks fitur (hanya jsdom).
