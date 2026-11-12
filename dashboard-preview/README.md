# ZentixBot — Preview Dashboard Tahap 4

Preview UI editorial: latar #A9A9A9, teks hitam, aksen lime, menu mengambang desktop dan hamburger glassmorphism mobile.

- Tahap 1: fondasi desain dan navigasi.
- Tahap 2: overview dan simulasi resource hosting.
- Tahap 3: halaman fitur bot utama.
- Tahap 4: halaman AI Studio (Welcome/Goodbye, Activities, Agent & Chat, Pengetahuan, AI Tools, Image Studio, Server Builder, Provider & Fallback).

**Semua data, izin, form, tindakan dan angka adalah simulasi.** Tidak ada komunikasi dengan bot, Discord, provider AI, database, Lavalink, atau Wispbyte. Form hanya mempertahankan draft sementara di memori browser selama halaman terbuka; tidak tersimpan permanen. Simulasi fallback tidak memanggil provider. Tidak ada login maupun kontrol akses nyata. Jangan masukkan token, API key, informasi pribadi, atau dokumen sensitif ke preview.

Jalankan preview lokal:

```bash
cd dashboard-preview
python3 -m http.server 4174
```

Buka http://localhost:4174. Jangan gunakan preview ini sebagai dashboard produksi.
