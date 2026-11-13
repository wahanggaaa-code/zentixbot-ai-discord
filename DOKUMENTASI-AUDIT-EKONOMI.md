# Audit penulis ekonomi (wallet, bank, toko, role premium)

Tanggal audit: 2026-11-13. Cakupan: seluruh kode yang mengubah saldo atau isi akun ekonomi, yaitu perintah di `src/commands/Economy/`, layanan di `src/services/economy/` dan `src/services/economyService.js`, `src/utils/economy.js`, serta pengaturan role premium di dashboard web (`src/dashboard/modulesApi.js`, `dashboard-preview/operations-live.js`).

Audit dilakukan dengan membaca kode dan menjalankan tes terhadap PostgreSQL lokal, SQLite dan Discord tiruan. **Tidak ada yang diuji pada server Discord nyata.**

Dokumen ini adalah bagian ketiga dan terakhir dari butir checklist "Audit fitur tiket, reward role dan seluruh penulis ekonomi". Tiket ada di `DOKUMENTASI-AUDIT-TIKET.md`, reward role di `DOKUMENTASI-AUDIT-REWARD-ROLE.md`.

## Ringkasan

Sepuluh masalah diperbaiki dan diuji. Tiga belas keterbatasan dicatat tanpa diperbaiki.

Yang paling penting:

- **`/economy dashboard` menulis teks dari Discord ke dalam file sumber bot.** Menu "Change Currency Symbol" mengganti isi `src/config/bot.js` dengan teks yang diketik pengguna, tanpa penyaringan. Simbol `"` menghasilkan `symbol: """,`, yaitu JavaScript yang tidak valid, sehingga bot gagal menyala pada restart berikutnya. Ini dibuktikan dengan menjalankan kode lama: file itu benar-benar berubah. Siapa pun yang berizin Manage Server bisa melakukannya.
- **Pembelian role premium tidak aman.** Role diberikan dulu, lalu seluruh akun disimpan dari salinan lama dan hasil simpannya tidak diperiksa. Bila simpan gagal, role didapat gratis; uang yang masuk selama pembelian berlangsung hilang.
- **Role premium tidak diperiksa.** Role apa pun bisa dijadikan role premium, termasuk role ber-izin Administrator, lalu dibeli siapa saja dengan uang dalam game.
- **Batas pembelian toko tidak pernah berlaku.** Upgrade bank "sekali beli" dan batas jumlah item bisa dilewati.

Sebelum audit, perintah berikut sudah memakai transaksi baris (`withEconomyTransaction`) dan tidak diubah: `/beg`, `/crime`, `/daily`, `/deposit`, `/withdraw`, `/fish`, `/gamble`, `/mine`, `/slut`, `/work`, `/rob`, transfer `/pay`, tambah dan kurang saldo di `/economy dashboard`, dan `/buy` untuk item selain role.

## Masalah yang diperbaiki

| ID | Masalah | Dampak sebelumnya | Perbaikan |
|---|---|---|---|
| E1 | `/buy premium_role` membaca akun, memberikan role, lalu menyimpan seluruh akun dari salinan yang dibaca tadi. Hasil simpan tidak diperiksa. | Simpan gagal: role didapat tanpa membayar. Uang yang masuk di antara baca dan simpan (misalnya `/pay` dari anggota lain) tertimpa dan hilang. Dua `/buy` bersamaan bisa memotong dua kali. | Pembelian menjadi protokol tiga langkah (lihat "Pembelian role premium"). Uang dipotong dulu dalam transaksi baris, role diberikan, lalu catatan ditutup. |
| E2 | Role premium tidak diperiksa di `/shop-config setrole`, di dashboard web, maupun saat pembelian. | Role ber-izin Administrator, Manage Server, Ban Members dan sejenisnya bisa dijual seharga item toko. Role di atas role bot atau role integrasi membuat pembelian gagal setelah proses berjalan. | Aturan yang sama dengan role hadiah leveling dipakai di tiga tempat itu. Role yang tidak boleh atau tidak bisa diberikan ditolak saat disetel, dan pembelian ditolak tanpa memotong saldo bila role tersimpan menjadi tidak aman. |
| E3 | Batas pembelian toko tidak diberlakukan: `maxQuantity` item dan sifat "sekali beli" pada upgrade tidak pernah diperiksa. | Upgrade bank bisa dibeli berulang; item berbatas bisa ditumpuk tanpa batas. | Batas diperiksa di dalam transaksi yang sama dengan pemotongan saldo, sehingga pembelian bersamaan juga tidak bisa melewatinya. Aturan: upgrade sekali; alat sekali (kecuali `bank_note`); barang habis pakai sampai `maxQuantity`. |
| E4 | Di PostgreSQL, akun dibaca lewat lapisan key-value umum yang menjawab query gagal dengan "tidak ada data". Fungsi simpan seluruh akun (`setEconomyData`) masih tersedia. | Gangguan database sesaat menampilkan saldo 0 atau saldo awal, dan penulis lama bisa menyimpan akun kosong itu di atas akun asli. | Akun PostgreSQL dibaca langsung; query gagal melempar error. Bila PostgreSQL ditandai tidak dapat dipakai, baca juga melempar error. `setEconomyData` di PostgreSQL menolak dengan kode `ECONOMY_LEGACY_WRITE_DISABLED`; tidak ada pemanggilnya lagi di `src/`. |
| E5 | `/eleaderboard` membaca satu akun per query, menganggap query gagal sebagai "belum ada data", dan menaruh peringkat pemanggil di footer embed. | Lambat pada server besar; gangguan database tampil sebagai papan kosong; peringkat tidak pernah terlihat karena bot ini tidak menampilkan footer. | Di PostgreSQL satu query untuk seluruh server; query gagal menjadi pesan error; peringkat pemanggil ada di deskripsi. |
| E6 | `/pay` menampilkan saldo dari pembacaan terpisah sebelum dan sesudah transfer. | Angka yang ditampilkan bisa berbeda dari yang tersimpan bila ada perubahan lain di antaranya; gagal baca setelah transfer menampilkan error padahal transfer berhasil. | `/pay` menampilkan saldo yang dikembalikan transaksi transfernya sendiri. |
| E7 | Menu "Change Currency Symbol" dan "Change Currency Name" di `/economy dashboard` menyunting `src/config/bot.js` dengan teks dari pengguna tanpa penyaringan. | Simbol `"`, `\` atau `$'` merusak file sumber sehingga bot gagal menyala pada restart berikutnya. Pola untuk nama tidak cocok dengan isi file saat ini, sehingga ubah nama melaporkan berhasil tanpa mengubah apa pun. Pada hosting dengan sistem file sementara, perubahan hilang. | File sumber tidak pernah ditulis. Simbol dan nama disimpan di pengaturan server (`economyCurrency`) dengan penyaringan: simbol 1–3 huruf, angka, tanda mata uang atau emoji; nama 1–20 huruf, angka, spasi atau tanda hubung. Nilai diperiksa lagi saat dibaca. |
| E8 | `/economy dashboard` hanya mengandalkan izin bawaan perintah (`setDefaultMemberPermissions`). | Izin bawaan bisa diubah di pengaturan Integrations server; setelah itu tidak ada pemeriksaan sama sekali untuk perintah yang membuat dan menghapus uang. | Izin Manage Server diperiksa saat perintah dibuka, pada setiap pilihan menu, dan saat formulir dikirim. |
| E9 | Jumlah di `/economy dashboard` dibaca dengan `parseInt` tanpa batas atas. | `12abc` dibaca 12, `1e9` dibaca 1, `1.000` dibaca 1. Angka sangat besar ditolak jauh di dalam dengan pesan umum "Failed to add money". | Hanya digit, 1 sampai 1.000.000.000.000 (batas yang sama dengan dashboard web). Pemisah ribuan ditolak agar `1.000` tidak ditafsirkan. |
| E10 | Statistik `/economy dashboard` meminta data anggota ke Discord satu per satu untuk setiap akun dan membaca akun satu per satu; kegagalan ditampilkan sebagai 0. | Lambat dan rawan rate limit pada server besar, diulang setiap kali panel disegarkan; gangguan database tampil sebagai "tidak ada uang beredar". | Di PostgreSQL satu query. Bot disaring dari cache anggota tanpa bertanya ke Discord. Bila gagal, kolom menampilkan `unavailable`. |

## Pembelian role premium

Discord dan database bukan satu transaksi. Pembelian dibuat agar boleh berhenti di titik mana pun tanpa kehilangan uang dan tanpa memberikan role gratis:

1. Satu transaksi akun memotong harga dan mencatat pembelian sebagai `pending` di akun (`purchases.premium_role`).
2. Role diberikan lewat Discord.
3. Catatan diubah menjadi `delivered`.

| Yang terjadi | Hasil |
|---|---|
| Discord menolak dan anggota terbukti tidak memegang role | Harga dikembalikan satu kali, catatan dihapus. Pesan menyebut jumlah yang dikembalikan dan saldo sekarang. |
| Discord error tetapi anggota ternyata sudah memegang role | Tidak ada pengembalian; pembelian dianggap berhasil. |
| Discord tidak menjawab sama sekali (pemberian dan pengecekan gagal) | Tidak ada pengembalian. Catatan tetap `pending`; `/buy` berikutnya memberikan role tanpa memotong lagi. |
| Pengembalian gagal disimpan | Catatan tetap `pending`; `/buy` berikutnya menyelesaikannya. |
| Role premium belum disetel, atau tidak lagi aman | Tidak ada yang dipotong. Bila ada pembayaran `pending` lama, pembayaran itu dikembalikan. |
| Anggota sudah memegang role | Ditolak tanpa memotong; catatan `pending` yang tertinggal ditutup. |
| Pembelian kedua dalam 60 detik setelah yang pertama selesai | Ditolak tanpa memotong, walaupun role belum terlihat di data anggota yang dipegang bot. |

Setiap pesan gagal menyatakan apa yang terjadi pada uangnya.

## Role yang boleh menjadi role premium

Aturannya sama dengan role hadiah leveling. Ditolak: role yang sudah tidak ada, `@everyone`, role yang dikelola integrasi, role dengan izin Administrator, Manage Server, Manage Roles, Manage Channels, Manage Webhooks, Ban Members atau Kick Members, role yang tidak berada di bawah role tertinggi bot, dan semua role bila bot tidak memiliki Manage Roles.

- `/shop-config setrole` menolak role seperti itu dan role tersimpan tidak berubah.
- Dashboard web (tab ekonomi) menandai role yang tidak dapat dijual, menonaktifkan pilihannya, dan menampilkan keadaan role yang tersimpan. `PATCH settings/economy` menolak dengan status 400 dan teks yang diawali `Role premium tidak dapat dipakai:`.
- Role yang sudah tersimpan lalu menjadi tidak aman (misalnya diberi izin Administrator belakangan) tetap tersimpan, tetapi pembelian ditolak tanpa memotong saldo sampai role diganti.

## Perubahan perilaku yang perlu diketahui staf

- Upgrade dan alat yang sudah dimiliki kini ditolak saat dibeli lagi; barang habis pakai ditolak di atas batasnya. Anggota yang sudah memiliki lebih dari batas (dari sebelum perbaikan) tidak dikurangi.
- `/economy dashboard`: jumlah harus digit saja. `1,000` dan `1.000` ditolak.
- Simbol dan nama mata uang yang disetel lewat `/economy dashboard` sekarang tersimpan per server dan langsung berlaku di panel itu tanpa restart. **Perintah ekonomi lain tetap menampilkan `$`** (lihat K5); balasan menu menyatakan hal ini. Nilai di `src/config/bot.js` menjadi nilai bawaan.
- Peringkat pemanggil di `/eleaderboard` kini terlihat.
- Pada gangguan database, `/balance`, `/inventory` dan `/eleaderboard` menampilkan error, bukan saldo kosong.

## Keterbatasan yang dicatat, belum diperbaiki

| ID | Keterbatasan |
|---|---|
| K1 | Pembayaran `pending` hanya diselesaikan saat anggota menjalankan `/buy premium_role` lagi. Tidak ada tugas latar belakang yang menyelesaikannya dan tidak ada tampilan untuk staf yang mendaftar pembayaran tertunda. |
| K2 | Role premium tidak pernah dicabut dan tidak memiliki masa berlaku. Bila admin mengganti role premium, pembeli lama tetap memegang role lama. Pembayaran `pending` yang dilanjutkan memberikan role yang sedang disetel, dengan harga yang dulu dibayar. |
| K3 | Kunci per anggota hanya berlaku di dalam satu proses bot. Antarproses, catatan `pending` yang mencegah potongan ganda. Hanya satu skenario antarproses yang diuji, dan itu dengan meniru proses kedua lewat SQL. |
| K4 | Bonus premium `/daily` diberikan kepada siapa pun yang memegang role yang disetel, tanpa melihat apakah role itu dibeli atau diberikan staf, dan tanpa pemeriksaan keamanan role. |
| K5 | Simbol dan nama mata uang hanya dipakai `/economy dashboard`. Semua perintah ekonomi lain menulis `$` langsung di kodenya. Menyambungkannya adalah pekerjaan tersendiri yang menyentuh sekitar 20 file. |
| K6 | `/deposit` membaca jumlah dengan `parseInt`: `100abc` dibaca 100 dan `1e5` dibaca 1. Hanya memindahkan uang milik sendiri dari dompet ke bank, dan balasan menyebut jumlah yang benar-benar disetor. |
| K7 | `/gamble` tidak memiliki taruhan maksimum. |
| K8 | `EconomyService.claimDaily` (dengan `DAILY_AMOUNT = 1000`) masih ada tetapi tidak dipanggil perintah mana pun; `/daily` memakai `claimDailyAtomic`. Kode mati dengan angka yang berbeda dari konfigurasi. |
| K9 | Keadaan role di dashboard web dibaca dari cache role bot. Role yang baru dihapus atau diubah izinnya bisa tampak "dapat dijual" sesaat; pembelian memeriksanya lagi. |
| K10 | `/eleaderboard` dan statistik `/economy dashboard` di PostgreSQL memuat saldo semua akun server ke memori dalam satu query. Anggota yang sudah keluar tetap dihitung. Di SQLite jalur lama (satu baca per akun) masih dipakai. |
| K11 | Backend lama selain PostgreSQL dan SQLite (tidak dipakai bot yang berjalan) masih menjawab gagal baca dengan akun kosong dan masih mengizinkan simpan seluruh akun. |
| K12 | Ubah wallet dan bank lewat web (`POST members/:id`) dibaca tetapi tidak diubah: sudah memakai kunci baris, pemeriksaan nilai usang (409), kapasitas bank dan batas 1.000.000.000.000. |
| K13 | Daftar izin berbahaya sama dengan role hadiah: tidak mencakup Timeout Members, Manage Messages, Mention Everyone dan izin lain. Role dengan izin itu masih bisa dijual. |

Tetap terpisah atas keputusan sebelumnya: poin Activities tidak disambungkan ke wallet.

Di luar cakupan dan tidak diperiksa: besaran hadiah dan peluang (`/work`, `/crime`, `/gamble`, `/rob`), cooldown, tampilan `/shop`, dan pemakaian item dari inventaris.

## Tes

| File | Jumlah | Isi |
|---|---:|---|
| `tests/postgres-economy-writers.test.js` | 23 | Role premium (urutan potong lalu beri, uang kurang, Discord menolak, error setelah role terpasang, hasil tidak diketahui lalu dilanjutkan, pengembalian gagal disimpan, pembayaran yang sudah diselesaikan proses lain, sudah memegang role, belum disetel atau tidak aman, `/pay` selama pembelian, tiga pembelian bersamaan), teks `/buy`, batas toko termasuk pembelian bersamaan, `/shop-config setrole`, gagal baca dan simpan lama ditolak, `/pay`, `/eleaderboard`, pengaturan role premium di web, `/economy dashboard` (izin di tiga titik, jumlah, statistik, mata uang dan file sumber yang tidak berubah). |
| `tests/sqlite-economy-shop.test.js` | 5 | Aturan yang sama di SQLite: pembelian role premium, pengembalian, hasil tidak diketahui, role tidak aman, tiga pembelian bersamaan, batas toko, `/eleaderboard`, statistik dan mata uang `/economy dashboard`. |
| `tests/dashboard-economy-ui.test.js` | 4 | Tab ekonomi dengan jsdom: role yang tidak dapat dijual ditandai dan dinonaktifkan, nama role dan alasan di-escape, keadaan role tersimpan, simpan dengan token CSRF dan penyegaran keadaan, penolakan server. |

Fixture `tests/helpers/leveling-postgres-fixture.js` kini juga mengembalikan `query` (SQL langsung yang tidak terkena penyuntikan kegagalan). Tidak ada tes lama yang diubah.

Pemeriksaan bahwa tes benar-benar mendeteksi masalahnya (kode lama atau satu pengaman dimatikan sementara, tes dijalankan, lalu kode baru dikembalikan dan dibandingkan byte demi byte):

| Yang dikembalikan atau dimatikan | Tes yang gagal |
|---|---|
| `buy.js` dan `utils/economy.js` versi sebelum audit | 4 |
| `economy_dashboard.js` dan `economy.js` versi sebelum audit | 3; `src/config/bot.js` benar-benar berubah menjadi `symbol: """,` dan dipulihkan |
| `modulesApi.js` dan `operations-live.js` versi sebelum audit | 5 (1 API, 4 halaman) |
| `pay.js`, `eleaderboard.js`, `shop_config_setrole.js` versi sebelum audit | masing-masing 1 |
| Catatan `pending` tidak ditulis | 7 |
| Pengembalian tidak mengembalikan uang | 3 |
| Pengembalian tanpa melihat catatan `pending` | 1 |
| Pengecekan anggota setelah pemberian gagal dimatikan | 2 |
| Hasil tidak diketahui diperlakukan sebagai "tidak diberikan" | 1 |
| Pemeriksaan keamanan role dimatikan | 2 |
| Batas toko dimatikan | 2 |
| Kunci per anggota dimatikan | 1 |
| Pengaman 60 detik setelah pembelian selesai dimatikan | 1 |
| Pemeriksaan izin `/economy dashboard` dimatikan, satu per satu di tiga titik | masing-masing 1 |
| Error saat PostgreSQL ditandai tidak dapat dipakai dimatikan | 1 |
| Escape pada teks keadaan role di halaman dimatikan | 1 |

Dua pengaman pada awalnya tidak terdeteksi tes mana pun (kunci per anggota, dan pengembalian tanpa melihat catatan `pending`). Tesnya diperkuat sampai keduanya terdeteksi; saat memperkuat tes pertama ditemukan potongan ganda yang nyata, yang diperbaiki dengan pengaman 60 detik di atas.

Yang **tidak** diuji: seluruh perilaku pada Discord nyata (urutan role, rate limit, izin, formulir modal dan menu yang di sini ditiru); dua proses bot yang benar-benar berjalan bersamaan; setiap item toko satu per satu (yang diuji: satu upgrade, satu alat, satu barang habis pakai, role premium); bonus `/daily`; tes SQLite pada Node 20 (SQLite memerlukan Node 22.5).

Hasil pada 2026-11-13, PostgreSQL 16 sekali pakai tanpa TLS, Discord tiruan:

- regresi penuh Node 22: lihat tabel di `DOKUMENTASI-PROGRES-PROYEK.md` bagian 6;
- Node 20.20: 64 dari 64 tes lulus (`postgres-economy-writers`, `dashboard-economy-ui`, `tahap8-economy-transaction`, `postgres-economy-audit`, `tahap6-modules`, `tahap6-operations`).

PostgreSQL untuk tes dapat disiapkan dengan `source scripts/setup-test-postgres.sh`.
