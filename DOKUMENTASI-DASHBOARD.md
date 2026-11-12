# Dashboard web — inventaris integrasi

Inventaris kode per perubahan dashboard ini, bukan sertifikasi produksi. **Live** di bawah berarti halaman memiliki jalur ke bot/API saat dashboard disajikan bot melalui `/dashboard/`; ia tetap memerlukan login Discord, izin, database dan layanan pendukung. Pengujian lokal memakai PostgreSQL disposable, Discord tiruan dan jsdom; event keluar juga diuji dengan pengiriman Discord tiruan. Belum membuktikan OAuth, Discord, Lavalink, provider, Neon atau Wispbyte pada deployment sebenarnya. Preview statis (`dashboard-preview/` disajikan sendiri) hanya simulasi; jangan masukkan rahasia atau data pribadi.

## Status awal pekerjaan bertahap

| Area | Yang sudah punya jalur live | Batas utama / sisa pekerjaan |
|---|---|---|
| Overview | Status bot dan sumber hosting jika dikonfigurasi | Resource tidak tersedia bukan berarti host mati; koneksi hosting sebenarnya belum diuji. |
| Welcome & verification | Welcome, **Goodbye non-AI**, verification dan pengiriman panel verification | Goodbye hanya PostgreSQL; tampilan preview lokal tanpa mengirim. Perubahan pengaturan tidak membuktikan pesan berhasil dikirim saat anggota keluar. |
| Moderation | Daftar kasus dan tindakan melalui operasi dashboard | Efek Discord dan penyimpanan bukan transaksi bersama; pemeriksaan izin/hierarki dan hasil nyata perlu diuji. |
| Ticket | Konfigurasi, panel, daftar/detail, aksi dan transcript terbatas | Transcript bergantung channel yang tersedia; tindakan Discord dan database dapat berbeda hasilnya. |
| Leveling & economy | Pengaturan leveling, leaderboard, pencarian anggota serta sebagian pengelolaan | Reward role tidak disinkronkan otomatis; saldo/wallet dan penulis ekonomi lain masih perlu audit. Jangan sambungkan poin Activities ke wallet. |
| Music | Player, antrean, pencarian dan kontrol yang didukung | Memerlukan Lavalink dan Discord; perilaku langsung dan resource hosting belum diuji. |
| Logging | Pengaturan dan riwayat terbatas dari channel audit | Bukan riwayat lengkap semua event; bergantung pada izin dan pesan yang tersedia. |
| AI Studio | Jalur untuk welcome/goodbye AI, Activities, chat, pengetahuan, tools, gambar, builder dan fondasi provider | Fitur dan opsi parsial, beberapa fungsi memerlukan provider/biaya/izin dan konfirmasi. Lihat `DOKUMENTASI-TAHAP-8.md`; label live tidak membuktikan provider sehat. |
| Pengaturan utama | Halaman utama pengaturan masih placeholder | Server, akses/izin dan kartu pengaturan belum menjadi panel pengelolaan umum. Pengaturan provider AI ada di AI Studio. |
| Kategori lainnya | Birthday, Community, Core, Fun, Giveaway, Join to Create, Reaction Roles, Search, Server Stats, Tools, Utility masih berupa daftar rencana | Belum ada halaman dashboard terpadu untuk setiap kategori; integrasikan dan uji satu per satu. |

## Goodbye non-AI

Buka **Fitur bot → Welcome & verification → Goodbye** pada dashboard bot yang telah login. Admin server dapat memilih channel, pesan, ping, gambar HTTPS dan tampilan embed. Pratinjau hanya contoh lokal, tidak mengirim pesan atau memuat URL gambar. Bot memakai teks biasa jika tidak memiliki izin embed. URL gambar dikirim ke Discord ketika pesan dikirim; jangan gunakan URL yang mengandung rahasia atau token. Pengaturan ini berbagi record PostgreSQL dengan welcome dan autorole; ketika AI Goodbye aktif, AI Goodbye menggantikan pesan non-AI ini. Cek izin channel dan konfigurasi AI sebelum mencoba langsung.

API `GET /dashboard/api/bot/goodbye` dan `PATCH /dashboard/api/bot/goodbye` memakai autentikasi dashboard; PATCH juga memerlukan Origin dan CSRF valid. Saat menyimpan, transaksi mengunci guild lalu welcome dan menolak revisi yang usang. Perubahan welcome melalui bot atau dashboard membuat revisi goodbye usang; salin perubahan yang belum disimpan, muat ulang, lalu terapkan kembali. Pemeriksaan revisi berbasis isi tidak mendeteksi A→B→A dan tidak memaksa SQL langsung/bot lama mengikuti aturan. Data goodbye yang bentuknya rusak ditolak untuk ditinjau, tidak di-reset. Jika koneksi putus saat commit, hasil penyimpanan bisa tidak diketahui; muat ulang dan periksa sebelum mengulang. Field lain pada record dipertahankan. SQLite belum didukung untuk halaman ini dan tetap ditunda.

Tidak ada tombol tes Discord dalam integrasi ini. Discord dan PostgreSQL tidak berada dalam satu transaksi; pesan dapat gagal, event dapat terduplikasi, dan event join/leave lama masih punya fallback default ketika pembacaan database gagal. Pengujian langsung di server uji, serta prosedur pemulihan dan hosting, masih diperlukan sebelum produksi.
