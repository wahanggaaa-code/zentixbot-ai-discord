# Fondasi transaksi Giveaway PostgreSQL — belum diaktifkan

`src/services/storage/postgresGiveawayTransactions.js` adalah prototipe yang **belum dipanggil oleh bot, scheduler, maupun dashboard**. Ini bukan perbaikan runtime Giveaway yang sudah aktif dan bukan persetujuan mengaktifkan tombol aksi web. Kode lama masih mempunyai risiko yang dicatat di `DOKUMENTASI-DASHBOARD.md`. Jangan memanggil prototipe berdampingan dengan penulis lama: `client.db.set` untuk `guild_giveaways` masih menghapus dan membuat ulang seluruh map, scheduler masih memiliki jalur update lain, dan SQL langsung tidak mengikuti protokol.

## Kemampuan prototipe

- Pendaftaran peserta dan klaim akhir/undi ulang mengunci satu baris giveaway. Pada penulis yang semuanya mengikuti protokol, entri berbeda tidak saling menimpa; user yang sama tidak didaftarkan dua kali. Klaim dan join bersaing pada baris yang sama. Jam database dibaca **setelah** lock diperoleh; klaim terjadwal menolak giveaway yang belum jatuh tempo.
- Klaim memilih pemenang dengan `crypto.randomInt`, menyimpan status selesai, pemenang, aksi, dan token unik berstatus `pending` dalam transaksi sebelum pemanggil boleh menjalankan efek Discord. Hanya klaim yang berhasil dikomit dan mengembalikan token boleh dilanjutkan. Penanda `delivered` hanya dapat diberikan untuk token pending yang sesuai, setelah seluruh efek Discord yang diharapkan diketahui berhasil. Aksi baru ditolak selama pengiriman pending. Token tidak ditampilkan di dashboard.
- Data yang tidak jelas ditolak: ID/scope, daftar peserta, hasil, status, serta kesesuaian timestamp JSON dan kolom PostgreSQL (kolom ditafsirkan UTC) harus valid. Batas JSON 256 KiB dan 10.000 peserta. Update memakai patch JSONB sehingga field lain, termasuk bilangan berpresisi besar, tidak ditulis ulang lewat JavaScript. Ini bukan validasi menyeluruh atas semua field atau bukti bahwa data historis memiliki timezone yang benar.
- Respons commit yang hilang bisa berarti transaksi berhasil ataupun tidak; **jangan kirim Discord atau ulang klaim otomatis** jika hasilnya tidak diketahui. Periksa database dan Discord. `pending` tidak membuktikan pesan sudah dikirim ataupun belum; perlu prosedur rekonsiliasi operator yang belum dibuat. Memanggil ack tanpa bukti semua efek sukses akan menghasilkan status salah.

## Pekerjaan sebelum cutover dan aksi web

1. Audit dan migrasikan **semua** penulis PostgreSQL: pembuatan, tombol join/end/reroll, `/gend`, `/greroll`, scheduler, penghapusan, generic map `set/delete`, serta penulis lain. Tutup jalur lama agar tidak dapat menimpa transaksi. Pastikan semua instance lama dihentikan sebelum upgrade.
2. Rancang pembuatan dan penghapusan yang dapat direkonsiliasi lintas database dan Discord. Penulisan dan efek Discord tidak dapat dikomit atomik. Rancang juga pengurutan refresh pesan setelah join agar refresh terlambat tidak mengganti pesan giveaway yang sudah selesai.
3. Buat cara operator memeriksa dan menyelesaikan `pending`, termasuk pengiriman parsial, timeout yang tidak diketahui, serta risiko pesan/mention ganda. Jangan otomatis mengulang efek tidak pasti. Tentukan prosedur audit dan otorisasi sebelum expose di web.
4. Periksa data lama/legacy, perbedaan timestamp dan timezone, kesiapan DB, backup/restore; uji transaksi dan batas aktual secara menyeluruh. Setelah seluruh jalur dipindahkan, uji integrasi dengan Discord nyata, proses ganda, crash, dan gangguan jaringan sebelum penggunaan produksi.

Tes terisolasi memakai PostgreSQL lokal dan simulasi, bukan Discord hidup. Tidak ada jaminan untuk penulis yang tidak mengikuti protokol, perubahan SQL manual, versi lama, atau recovery otomatis.
