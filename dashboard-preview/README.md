# ZentixBot — Preview Dashboard Tahap 2

Preview tampilan dengan gaya editorial, latar #A9A9A9, teks hitam dan aksen lime. Menu desktop mengambang; menu mobile memakai hamburger glassmorphism.

Tahap 2 menambahkan rancangan overview resource Wispbyte (CPU, RAM, disk, jaringan), beserta simulasi tampilan owner/admin dan kondisi offline. **Angka sepenuhnya contoh statis.** Belum ada login, akses owner yang nyata, refresh otomatis, atau koneksi bot/hosting. Simulasi owner/admin bukan fitur keamanan.

Jalankan preview lokal:

```bash
cd dashboard-preview
python3 -m http.server 4174
```

Buka http://localhost:4174. Jangan gunakan preview sebagai dashboard produksi.
