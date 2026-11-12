# ZentixBot — Dashboard tahap 8

Saat disajikan dari proses bot pada `/dashboard/`, fungsi utama bot terhubung; beberapa tab/opsi lanjutan dan sebagian fitur AI masih simulasi; fondasi AI dan beberapa fitur AI terhubung, sebagian khusus owner. Perincian, pengaturan hosting, batasan, dan panduan uji ada di `../DOKUMENTASI-TAHAP-5.md`, `../DOKUMENTASI-TAHAP-6.md`, `../DOKUMENTASI-TAHAP-7.md`, dan `../DOKUMENTASI-TAHAP-8.md`.

Menjalankan `python3 -m http.server 4174` pada folder ini menghasilkan preview statis tanpa autentikasi: **semua** data dan tindakan adalah contoh. Jangan masukkan token, informasi pribadi, atau data sensitif ke preview dan jangan gunakan sebagai dashboard produksi.

## Integrasi AI dan batasan

- Pengaturan tersedia hanya melalui dashboard bot yang diautentikasi; tindakan owner mengharuskan CSRF dan, untuk pengiriman/perubahan berisiko, konfirmasi. Memulai DM, mengirim lampiran, mengakses dokumen atau mengaktifkan memori melibatkan pilihan pengguna. Memori DM dan channel terpisah di RAM, kedaluwarsa dan hilang saat restart.
- Riset memakai cuplikan Brave, bukan verifikasi fakta. Rangkuman URL hanya HTTPS publik dan tidak mengikuti redirect; alamat DNS diperiksa dan dipin, ada batas ukuran/waktu, namun ini bukan jaminan keamanan lengkap. Jangan gunakan URL privat atau bertoken. Panggilan AI/pencarian/transkripsi memakai kuota dan dapat berbiaya.
- Pilihan ukuran gambar bergantung pada model `AI_IMAGE_MODEL`; gaya ditambahkan sebagai instruksi prompt, bukan jaminan hasil. Ketersediaan dan harga harus diperiksa pada provider.
- Preview Activities menampilkan ronde terbaru, bukan simulasi ketika dashboard disajikan oleh bot. Poin Activities bukan saldo ekonomi. OCR PDF scan langsung, pengambilan transkrip video otomatis, serta pengeditan/penghapusan/rollback Server Builder belum tersedia. Lihat dokumentasi Tahap 8 untuk batasan lengkap.
