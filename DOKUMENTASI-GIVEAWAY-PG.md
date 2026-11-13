# Giveaway PostgreSQL — cutover bertahap

Versi ini menghubungkan transaksi per giveaway ke `/gcreate`, pendaftaran melalui tombol, `/gend`, `/greroll`, `/gdelete`, tombol end/reroll, scheduler PostgreSQL dan aksi dashboard (buat, akhiri, undi ulang, hapus, perbaikan pengiriman tertunda). Penulisan dan penghapusan map Giveaway penuh melalui adapter PostgreSQL dinonaktifkan. Ini hanya berlaku untuk jalur yang disebut dan diuji; bukan jaminan seluruh penulis eksternal mengikuti protokol.

## Penting sebelum upgrade

1. **Hentikan semua instance bot versi lama**, scheduler lama, alat migrasi, dan penulis lain terlebih dahulu. Instance lama atau SQL langsung dapat menghapus/menimpa data meskipun versi baru memakai lock. Siapkan dan uji backup serta recovery. Jangan melakukan migrasi atau restore bersamaan dengan penulis aktif.
2. Tinjau data Giveaway historis dan timestamp. Record harus memiliki ID guild/pesan/channel/host yang sesuai, hadiah, kedua boolean `ended` dan `isEnded` yang sama, `winnerCount`, peserta unik dengan ID valid, serta `endsAt` bilangan milidetik aman. Jika ada `endTime`, nilainya harus sama. Kolom `ends_at` harus sama persis setelah ditafsirkan sebagai **UTC**. Record cacat, JSON di atas 256 KiB, daftar di atas 10.000 peserta dan key legacy persis `guild:<id>:giveaways` di temp/cache menolak operasi. Pemeriksaan itu tidak mencakup semua bentuk key lama atau backup dan bukan bukti timezone historis benar.
3. Hasil lama tanpa `deliveryStatus: delivered` tidak dapat diundi ulang menggunakan versi ini. Tombol **TANDAI TERKIRIM** hanya berlaku untuk status `pending`, bukan untuk hasil lama tanpa status sama sekali; hasil seperti itu hanya bisa dihapus. Jangan mengubah status database secara sembarangan.
4. Uji di server Discord uji, bukan produksi langsung. Tes otomatis memakai PostgreSQL lokal dan Discord mock; koneksi, permissions, rate limit, interaksi aktual, crash jaringan, Neon dan hosting belum dibuktikan.

## Cara kerja dan batas

- Pendaftaran peserta dan klaim end/reroll mengunci baris yang sama. Join yang lolos disimpan tanpa mengedit pesan publik; angka di pesan publik bisa tertinggal hingga giveaway berakhir. Balasan privat memberi jumlah tersimpan, bukan verifikasi kelayakan atau keanggotaan peserta. End dan reroll memakai `crypto.randomInt`; tidak ada verifikasi tambahan tentang peserta.
- Sebelum klaim, bot memeriksa channel dan pesan milik bot pada server, lalu membandingkan revisi dengan snapshot yang diambil. Perubahan peserta atau record selama pemeriksaan menolak klaim. Revisi berbasis isi dan ID baris, bukan nomor versi monotonic; perubahan A→B→A pada baris yang sama tidak terdeteksi.
- Klaim menyimpan pemenang dan token `pending` sebelum edit/kirim Discord. Setelah edit pesan dan pengumuman diketahui berhasil, token yang sama ditandai `delivered`. Saat reroll, bot mengedit pesan pemenang yang tercatat jika ada; bila tidak bisa memverifikasi pesan tersebut, reroll tidak dimulai. Untuk pemenang yang belum punya pesan tersimpan, bot mengirim pengumuman baru. Mention dibatasi ke pemenang. Ini bukan transaksi atomik dengan Discord.
- Jika koneksi putus saat commit atau Discord timeout, hasil bisa tidak diketahui. **Jangan ulangi otomatis.** `pending` bisa berarti pengiriman belum terjadi, sebagian terjadi, atau sudah terjadi tetapi ack database gagal. Periksa Discord, lalu selesaikan dari dashboard (lihat "Pengiriman tertunda" di bawah). Perubahan SQL manual tidak dijamin aman.
- `/gcreate` masih mengirim pesan Discord terlebih dahulu untuk memperoleh ID pesan sebelum insert. Kegagalan atau hasil commit yang tidak diketahui bisa meninggalkan pesan tanpa record atau record yang statusnya belum diketahui. Periksa channel dan database sebelum mengulang. Pembuatan lewat web memakai urutan yang sama tetapi membersihkan pesannya bila catatan dipastikan tidak tersimpan (lihat di bawah); `/gcreate` belum.
- Scheduler memilih hingga 1.000 kandidat per siklus berdasarkan kolom `ends_at` UTC dan flag tersimpan; kandidat tidak valid yang terus gagal pada awal daftar dapat menunda yang lain. Kegagalan ditulis ke log dan perlu pemeriksaan operator. Pengumuman tidak dicoba ulang setelah hasil diklaim `pending`. Tidak ada riwayat audit khusus untuk semua aksi ini.
- Login dashboard owner/admin divalidasi kembali, dan aksi memerlukan Origin serta CSRF. Pengguna mengonfirmasi setelah data terbaru diambil; revisi yang berubah ditolak. Klik dapat menghasilkan edit dan pengumuman Discord. Database saja tidak membuktikan keadaan pesan Discord saat ini.

## Membuat, menghapus dan pengiriman tertunda

Kode: `src/services/postgresGiveawayManagement.js` (urutan Discord/database) dan bagian akhir `src/services/storage/postgresGiveawayTransactions.js` (transaksi). Cara pakai dari dashboard ada di `DOKUMENTASI-DASHBOARD.md`.

### Hapus: tandai → Discord → buang

1. `beginPostgresGiveawayDeletion` menulis `deletion: {token, by, at}` ke catatan, hanya bila revisinya masih sama dengan yang dikonfirmasi admin. Sejak commit ini `join`, `claim`, `complete` dan scheduler menolak catatan itu (`GIVEAWAY_DELETING`), jadi tidak ada pemenang yang diumumkan untuk giveaway yang sedang dihapus.
2. Bot menghapus pesan Giveaway. "Unknown Message/Channel" dihitung sudah terhapus. Penolakan izin mencabut tanda lagi (`cancelPostgresGiveawayDeletion`). Kegagalan lain membiarkan tanda, karena pesannya mungkin sudah terhapus.
3. `finishPostgresGiveawayDeletion` menghapus baris, hanya dengan token yang sama.

Proses yang mati di antara langkah 1 dan 3 meninggalkan catatan bertanda. Memanggil hapus lagi memakai token yang sudah ada dan menyelesaikannya. `/gdelete` memakai fungsi yang sama tanpa pemeriksaan revisi.

Sebelum langkah 1 bot membaca pesannya dan menolak tanpa mengubah apa pun bila Discord tidak dapat dibaca atau penulis pesan bukan bot ini. Mode "catatan saja" melewati Discord seluruhnya.

### Pengiriman tertunda

`claim` kini juga menyimpan `deliveryClaimedAt` (jam database). Selama `GIVEAWAY_PENDING_SETTLE_MS` (120 detik) sesudahnya, hapus, tandai terkirim dan kirim ulang ditolak dengan `GIVEAWAY_IN_PROGRESS`. Catatan `pending` lama tanpa nilai itu memakai `endedAt`/`rerolledAt`; bila itu pun tidak ada, dianggap sudah lewat.

- `markPostgresGiveawayDelivered`: mengubah `pending` menjadi `delivered` dan mencatat `deliveryResolvedBy/At`. Tidak ada permintaan ke Discord, pemenang tidak berubah. `winnerPingMessageId` tetap kosong bila belum tercatat, sehingga undian ulang berikutnya mengirim pengumuman baru.
- `retryPostgresGiveawayDelivery`: mengganti `deliveryToken` (token lama tidak bisa lagi menyelesaikan pengiriman), lalu runtime mengulang edit pesan dan pengumuman dengan `winnerIds` yang tersimpan. Tidak ada undian.

Bot tetap tidak pernah mengulang pengiriman dengan sendirinya; kedua jalan itu hanya dijalankan atas konfirmasi admin.

### Batas yang masih ada

- Tidak ada yang atomik antara Discord dan PostgreSQL; urutan di atas hanya memastikan keadaan setengah jadi terlihat dan bisa dilanjutkan.
- Jendela 120 detik adalah perkiraan, bukan kunci: proses yang macet lebih lama dari itu masih bisa mengirim setelah admin bertindak. Token mencegah pengiriman lama tercatat selesai, tetapi tidak mencegah pesannya muncul.
- Pengaman pembuatan ganda hanya berlaku dalam satu proses bot.
- Catatan yang gagal validasi (`GIVEAWAY_INVALID`) tidak bisa dihapus lewat protokol ini.
- Semua ini diuji dengan PostgreSQL lokal dan Discord tiruan, belum di server Discord nyata.

Penulis tidak kooperatif, versi lama, SQL manual, kegagalan Discord, anomali data lama, dan proses pemulihan bukan bagian dari jaminan konkurensi. Jangan anggap tes lokal sebagai validasi operasional produksi.
