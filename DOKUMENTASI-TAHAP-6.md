# Tahap 6 — Integrasi bot (bagian awal)

Ini **belum seluruh integrasi Tahap 6**. Bagian yang sudah terhubung saat dashboard disajikan dari proses bot:

- Overview: status bot, jumlah anggota yang tersedia dalam cache Discord, ping gateway, uptime proses, dan status koneksi DB. Angka tidak ditampilkan bila tidak tersedia. Statistik hosting tidak menampilkan angka contoh di mode terhubung dan masih belum terintegrasi.
- Welcome: baca dan simpan enabled, channel teks, pesan, ping, URL gambar HTTPS, maksimal satu autorole, judul/footer/warna embed. Simpan ke tabel PostgreSQL yang digunakan bot; form mempertahankan bidang welcome lain. Data database sementara/degraded ditolak. Verifikasi/auto-verify aktif tidak dapat dipasangkan dengan autorole baru; role harus dapat dikelola bot.
- Tombol tes memerlukan konfirmasi dan menggunakan pengaturan **yang sudah disimpan**, menggunakan akun admin yang login untuk sampel; tes tidak mengirim ping. Pesan saat member bergabung dan tes berbagi pembangun payload. Jika bot tidak memiliki izin embed, bot mengirim pesan sebagai teks biasa. Cek izin channel dilakukan sebelum tes.

Login dan setup: lihat `DOKUMENTASI-TAHAP-5.md`. Butuh PostgreSQL aktif dan akun admin/owner server. Pada penggunaan nyata, uji dengan server percobaan dan periksa izin channel serta role bot sebelum aktivasi. API memvalidasi input, memeriksa ulang izin anggota setiap request, membatasi server, dan memeriksa CSRF/Origin untuk tindakan.

**Belum terintegrasi:** verification dan pengiriman/perbarui panelnya, moderasi, ticket/transcript, economy, leveling, music, logging, pengaturan lain, Wispbyte dan seluruh AI. Tampilan modul tersebut tetap diberi label simulasi dan tidak menyimpan/menjalankan aksi Discord. Preview statis tanpa proses bot juga tetap simulasi tanpa login. Tidak ada key atau token hosting yang dikirim ke browser.

Batasan: daftar channel dan role menggunakan cache Discord; bisa tidak lengkap sampai cache tersedia. Jika ada lebih dari satu autorole tersimpan, web tidak mengubahnya agar tidak menimpa data. Pemeriksaan konflik autorole berlaku pada simpan melalui dashboard, bukan jaminan terhadap perubahan yang dilakukan melalui command lain. Sesi masih di memori dan satu proses. Lihat catatan keamanan Tahap 5.

Pengujian: `node --test tests/tahap5.test.js tests/tahap6.test.js`; tes Discord, HTTP, dan database memakai mock; DOM diuji menggunakan jsdom. Belum diuji dengan server Discord, PostgreSQL, Lavalink, Wispbyte, HTTPS/proxy atau browser nyata. Backup database sebelum deploy.
