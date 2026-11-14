# Hosting di panel (Wispbyte dan sejenisnya)

Tanggal: 2026-11-13. Dokumen ini menjelaskan variabel lingkungan yang dibutuhkan bot, cara bot memilih port, cara membuka dashboard pada alamat `http://ip:port`, batas permintaan server web, dan arti pesan saat login gagal.

**Yang sudah terlihat di hosting sungguhan.** Pada 13 November 2026 (UTC) pemilik bot menjalankannya di sebuah panel hosting dan mengirim log konsol serta dua tangkapan layar. Dari kiriman itu terlihat:

- bot selesai startup dengan database tersambung, login ke Discord, dan mendaftarkan 100 perintah ke server;
- empat dari enam node Lavalink tersambung (`vinster`, `serenetia`, `trinium`, `millohost`); `nazha` menolak dengan 403 dan `jirayu` terputus;
- dashboard terjangkau pada `http://ip:port`, dan Discord mengembalikan peramban ke alamat callback `http://` itu;
- login lalu gagal dengan "Login tidak valid atau kedaluwarsa.", dan halaman dashboard menjawab `Too many requests`. Dua hal ini yang diperbaiki pada bagian [Batas permintaan](#batas-permintaan) dan [Bila login gagal](#bila-login-gagal).

Itu pengamatan dari kiriman pemilik, bukan pengujian yang dijalankan di sini. Perbaikannya sendiri baru diuji dengan Discord tiruan dan PostgreSQL lokal; apakah login di panel itu kini berhasil belum diketahui. Perintah, musik, fitur AI dan pemakaian memori di panel itu belum diperiksa. Keterangan tentang panel Wispbyte (image Node, tempat mengisi variabel, RAM 512 MB, alamat `http://ip:port`) diambil dari panduan hosting proyek referensi `whyuangga/Zypher-AI-Bot-Discord` dan tidak diperiksa sendiri.

## Yang dibutuhkan bot

- Node.js 20.10 ke atas. Regresi penuh dijalankan pada Node 22, jadi pilih image Node 22 bila tersedia.
- Berkas utama `index.js` (atau perintah `npm start`).
- Database PostgreSQL dari luar panel. Tanpa database bot berhenti saat startup; SQLite belum dapat dipilih.
- Dua intent khusus dinyalakan di Discord Developer Portal: Server Members dan Message Content.
- Disk sekitar 175 MB setelah `npm ci`.

## Variabel lingkungan

Wajib:

| Variabel | Isi |
| --- | --- |
| `DISCORD_TOKEN` | Token bot |
| `CLIENT_ID` | Application ID |
| `GUILD_ID` | ID satu server yang dilayani bot |
| `NODE_ENV` | `production` |
| `POSTGRES_URL` | Alamat database, misalnya `postgresql://user:password@host/namadb?sslmode=require` |

Disarankan:

| Variabel | Isi |
| --- | --- |
| `OWNER_IDS` | ID Discord pemilik bot. Halaman AI, pemakaian sistem di halaman ringkasan dan statistik hosting di dashboard hanya untuk ID ini; login dashboard dengan token bertindak atas nama ID pertama |
| `DASHBOARD_TOKEN` | Rahasia minimal 12 karakter untuk login dashboard. Lihat "Login dashboard dengan token" |
| `NODE_OPTIONS` | `--max-old-space-size=384` pada container 512 MB. Saran panduan referensi; diisi di panel, bukan di berkas `.env`. Pemakaian memori bot ini belum pernah diukur |
| `AI_GROQ_API_KEY`, `AI_GEMINI_API_KEY`, `AI_OPENROUTER_API_KEY`, `AI_NVIDIA_API_KEY` | Minimal satu bila fitur AI dipakai. Tiap provider cadangan memerlukan kuncinya sendiri; lihat "Provider chat AI" |

Untuk dashboard:

| Variabel | Isi |
| --- | --- |
| `DISCORD_CLIENT_SECRET` | Client Secret dari halaman OAuth2 di Developer Portal |
| `DASHBOARD_URL` | Alamat dashboard, tanpa path: `https://bot.example.com` atau `http://203.0.113.5:16954` |
| `DASHBOARD_ALLOW_HTTP` | `true` hanya bila alamatnya `http://` publik. Lihat bagian "Dashboard lewat HTTP" |

Musik tidak memerlukan variabel: bot memakai enam node Lavalink publik yang tercantum di `lavalink/nodes.json` (vinster, trinium, nazha, serenetia, jirayu, millohost), diambil dari daftar di `lavalink.darrennathanael.com`. Node itu milik pihak ketiga dan belum diuji dari bot ini; untuk menggantinya, ubah berkas itu atau isi `LAVALINK_NODES`. Nama `LAVALINK_URI` dan `LAVALINK_NODE_NAME` tidak dibaca bot.

Opsional: transkrip suara, pencarian web dan gambar (lihat bagian berikut), `HOSTING_PANEL_URL` + `HOSTING_SERVER_ID` + `HOSTING_API_KEY`, `DISK_LIMIT_MB` (kuota disk untuk halaman ringkasan), `TMDB_API_KEY`, `LOG_LEVEL`, `SENTRY_DSN`. Daftar lengkap ada di `.env.example`.

## Provider chat AI: satu utama dan sampai tiga cadangan

Diatur di dashboard, **AI Studio → Provider & fallback**, bukan di `.env`. Di `.env` hanya kuncinya.

| Di dashboard | Isi |
| --- | --- |
| Provider utama + Model utama | Dicoba lebih dulu |
| Provider cadangan 1, 2, 3 + modelnya | Dicoba berurutan bila yang sebelumnya gagal. "Tidak ada" = slot dilewati |

Provider yang tersedia ada empat: Groq, Gemini, OpenRouter dan NVIDIA NIM. Satu provider hanya boleh dipakai sekali, jadi utama ditambah tiga cadangan berarti keempatnya terpakai.

- **Provider tanpa kunci di `.env` dilewati**, tanpa pesan. Baris "Kunci server" di halaman itu menunjukkan kunci mana yang terbaca. Cadangan Gemini, misalnya, hanya bekerja bila `AI_GEMINI_API_KEY` terisi.
- **Kapan bot pindah ke cadangan:** provider tidak menjawab dalam batas waktu, jaringan gagal, atau jawabannya 401, 403, 404, 408, 429 atau 5xx. Itu mencakup kuota habis, kunci salah dan ID model yang tidak dikenal.
- **Kapan bot tidak pindah:** provider menolak isi permintaan (jawaban 4xx lain) atau memblokir jawabannya. Permintaan itu gagal tanpa mencoba cadangan.
- **Waktu tunggu** berlaku per provider. Dengan batas 20 detik dan empat provider yang semuanya macet, satu permintaan dapat menunggu sampai 80 detik.
- **Kuota harian** dihitung satu kali per permintaan, berapa pun provider yang dicoba.
- Tombol **Tes koneksi** memakai rantai yang sama dan menyebut provider mana yang menjawab. Ia tidak menguji tiap cadangan satu per satu: bila provider utama menjawab, cadangan tidak disentuh.

Pengaturan yang disimpan sebelum 14 November 2026 (satu cadangan) tetap terbaca; cadangan 2 dan 3 dianggap kosong sampai diisi dan disimpan.

## AI interaktif: bot yang ikut mengobrol di channel

Sejak 14 November 2026 bot dapat menjawab pesan biasa tanpa perintah. Menyalakannya:

1. **AI Studio → Provider & fallback**: AI aktif dan disetujui (sama seperti untuk `/aichat`).
2. **AI Studio → Agent & chat → tab "AI interaktif"**: nyalakan "Aktifkan AI interaktif", centang channel chat, pilih cara yang diinginkan, lalu **Simpan**. Berlaku pada pesan berikutnya, tanpa restart.

| Yang diinginkan | Saklar |
|---|---|
| Bot membalas saat di-mention atau pesannya di-reply | "Balas saat di-mention atau di-reply" (sudah nyala); "…di semua channel" bila tidak hanya di channel chat |
| Bot nimbrung sendiri di tengah obrolan | "Ikut nimbrung", dengan peluang dan jedanya |
| Bot menyapa saat channel sepi | "Menyapa saat channel sepi", dengan lama sepi, jam aktif dan batas per hari |
| Bot mengomentari gambar di channel galeri | "Baca gambar" dan centang channel galeri |
| Bot tahu jam | Selalu; pilih zona WIB, WITA atau WIT |
| Bot menyapa dengan nama | "Panggil anggota dengan namanya" (sudah nyala) |

Yang perlu diketahui sebelum menyalakannya:

- Pesan anggota di channel yang dipilih dikirim ke provider AI tanpa persetujuan per pesan. Beri tahu anggota.
- Setiap jawaban memakai kuota harian. Dengan "Ikut nimbrung" 20 % di channel yang ramai, kuota anggota (bawaan 20 per hari) dan kuota server (bawaan 200) cepat habis; naikkan kuota atau turunkan peluangnya. "Batas pesan bot per jam" adalah rem terakhir.
- Gambar memerlukan model yang bisa membaca gambar pada provider utama. Model teks saja membuat komentar galeri tidak muncul.
- Video tidak dibaca.
- Bot memerlukan izin **View Channel**, **Send Messages** dan sebaiknya **Read Message History** di channel itu, dan **Message Content Intent** harus menyala di Discord Developer Portal (bot ini memang memintanya saat start).
- Mematikan: matikan "Aktifkan AI interaktif" lalu simpan. Bot langsung berhenti membaca pesan untuk AI.

Bila bot diam, lihat log. Contoh baris:

```text
12:00:03  WARN   AI interactive: reply skipped (AI belum diaktifkan atau belum disetujui.)
12:00:03  WARN   AI interactive: reply skipped (Semua provider gagal atau timeout.)
12:00:03  WARN   AI interactive: gallery skipped (Provider menolak permintaan.)
```

Tidak ada baris sama sekali berarti bot memang memutuskan diam: fitur mati, channel tidak dicentang, batas per jam tercapai, kuota anggota habis, atau bot tidak punya izin menulis. Rinciannya ada di [tahap-8.md](tahap-8.md).

### Tambahan AI interaktif (14 November 2026)

Di tab yang sama ada delapan pengaturan baru, semuanya mati sampai dicentang dan disimpan:

| Yang diinginkan | Saklar |
|---|---|
| Bot tidak menyela obrolan orang lain dan tidak menanggapi perintah bot lain | "Etika anti-nimbrung" |
| Bot menjawab bila namanya disebut, tanpa @mention | "Jawab saat namanya disebut"; isi "Nama panggilan" (dipisah koma, paling banyak 5) bila ingin nama lain |
| Tidak perlu me-mention lagi untuk pertanyaan lanjutan | "Obrolan lanjutan", dengan lamanya (30–300 detik) |
| "@bot rangkum https://…" | "Rangkum link saat dipanggil" |
| "@bot cari berita …" | "Cari berita saat dipanggil"; perlu `AI_BRAVE_SEARCH_KEY` atau Tavily (lihat "Suara, pencarian web dan gambar") |
| "@bot rangkum obrolan tadi" | "Rangkum obrolan yang tertinggal"; bot perlu izin **Read Message History** |

## Fitur pintar: FAQ, menu pesan, koran pagi, terjemahan, laporan

Sejak 14 November 2026 ada ruang kesembilan di dashboard: **AI Studio → Fitur pintar**. Khusus akun di `OWNER_IDS`. Setiap fitur punya saklar sendiri dan mati sampai dinyalakan; setiap tab disimpan sendiri dan berlaku tanpa restart (paling lambat 15 detik kemudian). Tidak ada variabel `.env` baru.

| Tab | Menyalakannya | Syarat |
|---|---|---|
| FAQ & cache | Tambah entri (pertanyaan + jawaban), nyalakan "Aktifkan FAQ". Untuk jawaban tanpa dipanggil: "Jawab otomatis tanpa dipanggil" dan centang channelnya. "Aktifkan cache jawaban" punya formulir sendiri di bawahnya | FAQ saat dipanggil dan cache memerlukan AI interaktif menyala |
| Menu pesan | Centang entri yang diinginkan, pilih bahasa terjemahan, simpan | AI aktif; "Cek fakta" lebih berguna dengan kunci pencarian |
| Koran pagi | Centang satu atau beberapa channel, isi jam dan zona, simpan; **Kirim tes** untuk melihat hasilnya sekarang | AI aktif; berita perlu kunci pencarian |
| Sapaan multibahasa | Dua saklar | AI Welcome / AI Goodbye menyala di ruang **Welcome & Goodbye** |
| Terjemahan otomatis | Centang satu atau beberapa channel, pilih bahasa tujuan dan batas permintaan AI per jam | AI aktif |
| Laporan pemakaian | "Catat pemakaian AI" | PostgreSQL (atau SQLite) tersedia |

Yang perlu diketahui sebelum menyalakannya:

- **Menu pesan memerlukan scope `applications.commands`**, yang sudah dipakai untuk perintah slash. Menu muncul di klik kanan pesan → **Apps**. Setelah menyimpan, Discord kadang perlu beberapa menit atau aplikasi perlu dibuka ulang. Bila halaman menulis "menu belum bisa didaftarkan ke Discord", restart bot: perintah didaftarkan ulang saat start, dan baris `Slash commands: 100 registered for server … (+2 message menu)` menyebut jumlahnya.
- **Terjemahan otomatis mengirim pesan anggota ke provider AI** tanpa persetujuan per pesan dan memakai kuota harian anggota yang menulis. Di channel yang ramai kuota anggota (bawaan 20 per hari) cepat habis; batas per jam per channel menghitung setiap permintaan AI, juga yang tidak menghasilkan terjemahan. Pilih channel yang memang dipakai lintas bahasa, bukan channel umum.
- **Koran pagi** dikirim atas nama bot dan memakai satu permintaan AI dan satu pencarian per hari. Bila provider gagal pada menit itu, edisi hari itu tidak diulang.
- **Laporan pemakaian** mencatat ID anggota dan jumlah permintaan per hari selama 45 hari, tanpa isi pesan. Hari berganti pukul 07.00 WIB (UTC).
- FAQ dicocokkan berdasarkan kata, bukan makna. Coba dahulu dengan memanggil bot sebelum menyalakan "Jawab otomatis".
- Izin bot di channel yang dipilih: **View Channel**, **Send Messages**, dan **Read Message History** untuk rangkuman.

Baris log fitur ini, tanpa isi pesan (koran pagi: satu baris per edisi yang gagal; terjemahan: paling sering sekali per 10 menit):

```text
07:00:02  WARN   AI digest: skipped (Koran pagi tidak dapat dibuat: Kunci Brave Search belum dikonfigurasi.)
12:00:03  WARN   AI auto-translate: skipped (Semua provider gagal atau timeout.)
12:00:03  WARN   Message menu: settings could not be read, none registered (…)
```

Rinciannya, termasuk batas tiap fitur, ada di [tahap-8.md](tahap-8.md#fitur-pintar-14-november-2026).

## Server Builder: tema siap pakai, riwayat dan bongkar

Membuat kategori, channel dan role dari tema atau deskripsi, lewat dashboard: **AI Studio → Server Builder**. Khusus akun di `OWNER_IDS`; anggota lain, termasuk admin, ditolak. Rinciannya ada di [tahap-8.md](tahap-8.md#server-builder).

Yang perlu disiapkan:

1. **Restart bot** setelah pembaruan, lalu muat ulang halaman dashboard.
2. Bot memerlukan izin **Kelola Channel** dan **Kelola Role**. Untuk membongkar role, role bot harus berada di atas role yang dibuat.
3. Tema langsung bisa dipakai tanpa AI. Untuk "Rancang dengan AI", AI harus aktif di **Provider & fallback**. Dengan **batas output** bawaan (256 token) AI hanya diminta rancangan kecil (6 channel); naikkan ke 1024 atau lebih untuk rancangan yang lebih besar. Bila AI gagal, dipakai tema terdekat dan alasannya ditampilkan.
4. Riwayat memerlukan database. Bila database tidak tersedia, penerapan ditolak, karena hasilnya tidak akan bisa dibongkar.

**Bongkar bersifat permanen**: channel dihapus beserta pesannya. Belum pernah dijalankan pada Discord nyata: coba dulu satu tema lalu bongkar di server uji atau saat server sepi.

Tidak ada perintah slash untuk builder. Bot ini sudah mendaftarkan tepat 100 perintah slash, batas Discord per server; perintah ke-101 tidak ditambahkan Discord, dan pemuat perintah bot memotong daftar pada 100 sehingga perintah yang dimuat paling akhir (`/welcome`) yang hilang. Menambah perintah baru berarti lebih dulu menggabungkan atau melepas satu perintah lama.

## Perintah `/…` yang menjawab "that command does not exist"

Bot ini mendaftarkan perintahnya hanya untuk server di `GUILD_ID`. Bila aplikasi Discord yang sama pernah dipakai program bot lain, perintah **global** program itu tetap tersimpan di Discord dan tetap ditawarkan saat mengetik `/`, tetapi bot ini tidak mengenalnya. Contoh nyata (14 November 2026): `/ai chat`, `/ai config` dan `/ai status` muncul di samping `/aichat` milik bot ini.

Sejak 14 November 2026 bot menghapus perintah global seperti itu setiap kali start, setelah perintah server terdaftar, dan melaporkannya sekali:

```text
04:48:22  START  Slash commands: 1 global command left by another program removed (/ai)
```

- Perintah titik masuk Activity (jenis 4) tidak dihapus.
- Bila penghapusan gagal, bot tetap menyala dan menulis satu baris `WARN`.
- `KEEP_GLOBAL_COMMANDS=true` mematikan penghapusan ini. Pakai hanya bila program lain yang masih berjalan dengan aplikasi yang sama memang memerlukan perintah globalnya.
- Aplikasi Discord dapat menyimpan daftar lama sebentar. Tutup dan buka lagi bila perintah yang sudah dihapus masih ditawarkan.

## Suara, pencarian web dan gambar: pilihan penyedia

Tiga fitur AI ini memakai layanan di luar empat penyedia chat. Masing-masing dipilih dengan satu variabel; bila variabel itu kosong, bot memakai penyedia semula, sehingga pemasangan lama tidak berubah.

| Fitur | Variabel pilihan | Nilai | Yang harus diisi |
| --- | --- | --- | --- |
| Transkrip suara | `AI_AUDIO_PROVIDER` | `openai` (bawaan) | `AI_AUDIO_API_KEY`, `AI_AUDIO_MODEL` |
| | | `groq` | `AI_GROQ_API_KEY` (key chat yang sama). `AI_AUDIO_MODEL` boleh kosong: `whisper-large-v3-turbo` |
| Pencarian web | `AI_SEARCH_PROVIDER` | `brave` (bawaan) | `AI_BRAVE_SEARCH_KEY` |
| | | `tavily` | `AI_TAVILY_API_KEY` |
| Gambar | `AI_IMAGE_PROVIDER` | `openai` (bawaan) | `AI_IMAGE_API_KEY`, `AI_IMAGE_MODEL` |
| | | `cloudflare` | `AI_CLOUDFLARE_API_TOKEN`, `AI_CLOUDFLARE_ACCOUNT_ID`. `AI_IMAGE_MODEL` boleh kosong: `@cf/black-forest-labs/flux-1-schnell` |
| | | `pollinations` | Tidak ada |

Contoh untuk memakai ketiga alternatif tanpa OpenAI dan Brave:

```
AI_AUDIO_PROVIDER=groq
AI_SEARCH_PROVIDER=tavily
AI_TAVILY_API_KEY=tvly-...
AI_IMAGE_PROVIDER=cloudflare
AI_CLOUDFLARE_API_TOKEN=...
AI_CLOUDFLARE_ACCOUNT_ID=...
```

Aturan yang berlaku:

- Setiap penyedia hanya membaca kuncinya sendiri. Key OpenAI tidak dikirim ke Groq atau Cloudflare, dan sebaliknya.
- Nilai yang tidak dikenal (salah ketik) mematikan fitur itu; bot tidak diam-diam kembali ke penyedia lain. Log startup menyebutkannya.
- Saat startup bot menulis satu baris per fitur, misalnya `AI speech-to-text: Groq configured (whisper-large-v3-turbo)` atau `AI images: OpenAI off (missing or invalid: AI_IMAGE_API_KEY, AI_IMAGE_MODEL)`. "configured" berarti variabelnya terisi; bot tidak menghubungi penyedia saat startup, jadi kunci atau model yang salah baru terlihat saat fitur dipakai.
- Jika `AI_AUDIO_PROVIDER=groq` tetapi `AI_AUDIO_MODEL` masih berisi nama model OpenAI, Groq akan menolaknya. Kosongkan `AI_AUDIO_MODEL` atau isi dengan model Groq.
- Ketiga fitur tetap memerlukan fondasi AI yang aktif di dashboard dan ikut memakai batas harian yang sama.

Batas tiap alternatif gambar:

- **Edit gambar hanya dengan OpenAI.** Dengan Cloudflare atau Pollinations, permintaan edit ditolak sebelum ada yang dikirim.
- **Cloudflare** (model bawaan): bot hanya mengirim instruksi; ukuran ditentukan model dan hasilnya JPEG. Pilihan ukuran di dashboard tidak diteruskan. Model lain dapat diisi di `AI_IMAGE_MODEL` dengan bentuk `@cf/<vendor>/<model>`, tetapi hanya format model bawaan yang dibaca dari dokumentasinya; model lain belum tentu cocok.
- **Pollinations** (API "Classic" tanpa key): luas paling besar 768 × 768 piksel, JPEG dengan logo kecil, dan dibatasi per alamat IP. Di hosting bersama, alamat IP dipakai bersama pelanggan lain, jadi batas itu bisa sudah terpakai. Instruksi menjadi bagian alamat web, dan hasilnya dapat dibuka siapa pun yang memiliki alamat itu. Jangan dipakai untuk instruksi yang berisi hal pribadi.
- Dashboard menampilkan nama penyedia dan ukuran hasil, dan memberi catatan bila ukurannya berbeda dari yang diminta.

Kuota gratis yang dibaca dari halaman resmi tiap layanan pada 13 November 2026 (dapat berubah):

- Groq: transkripsi tersedia di paket gratis; berkas paling besar 25 MB. Angka batas harian tidak dibaca dari halaman resminya.
- Tavily: satu pencarian `basic` memakai 1 kredit. Jumlah kredit gratis per bulan tidak dibaca dari halaman resminya.
- Cloudflare Workers AI: 10.000 Neuron per hari tanpa biaya; di paket gratis permintaan gagal setelah jatah habis. Model bawaan dihargai 4,80 Neuron per petak 512 × 512 dan 9,60 Neuron per langkah.
- Pollinations Classic: satu gambar pada satu waktu, berjarak paling sedikit 45 detik, per alamat IP; di atas itu layanan menjawab 402 dan bot menampilkan waktu tunggunya.

## Port

Bot memakai nilai pertama yang sah dari `WEB_PORT`, `PORT`, `SERVER_PORT`, dalam urutan itu. Bila tidak ada yang diisi, port 3000.

- `SERVER_PORT` adalah nama yang diisi sendiri oleh panel bergaya Pterodactyl. Bila panel mengisinya, port tidak perlu diatur manual.
- Kosong dan `0` berarti "belum diisi". Nilai lain yang bukan angka port 1–65535 dilewati, dan nama variabelnya ditulis di log.
- Log startup menyebut dari mana port diambil, misalnya `Web port 16954 taken from SERVER_PORT`.
- `.env.example` berisi `PORT=3000`. Bila berkas itu disalin apa adanya, `PORT` menang atas `SERVER_PORT`. Hapus baris `PORT` atau isi dengan port dari panel.

## Login dashboard dengan token (cara termudah)

Cara ini mengikuti proyek referensi: satu rahasia di `.env`, diketik di halaman login. Tidak perlu Discord Developer Portal, client secret, atau alamat redirect.

1. Isi `DASHBOARD_TOKEN` dengan rahasia buatan sendiri, minimal 12 karakter. Makin panjang dan acak makin baik.
2. Isi `OWNER_IDS` dengan ID akun Discord kamu (Pengaturan Discord → Lanjutan → Mode Pengembang, lalu "Salin ID Pengguna" pada profil). Akun itu harus anggota server yang dilayani bot.
3. Mulai ulang bot, buka `http://IP:PORT/dashboard/`, ketik token, tekan Masuk.

Yang perlu diketahui:

- **Siapa pun yang tahu token dapat memakai dashboard**, termasuk fitur moderasi. Jangan kirim token lewat chat atau screenshot. Untuk menggantinya, ubah `DASHBOARD_TOKEN` lalu mulai ulang bot; semua sesi ikut berakhir.
- Dashboard bertindak atas nama akun pertama di `OWNER_IDS`: nama itu yang tercatat sebagai moderator, pembuat giveaway, dan sebagainya. Akun itu tidak harus Administrator server, tetapi harus masih menjadi anggota; begitu keluar dari server, sesi ditolak.
- Sesi berlaku 12 jam dan hilang saat bot dimulai ulang.
- Percobaan login dibatasi 30 kali per 15 menit per alamat IP (lihat "Batas permintaan").
- Lewat `http://`, token dan sesi berjalan tanpa enkripsi; bot menulis peringatan di log saat startup. Risikonya sama seperti pada bagian berikut, ditambah bahwa yang dapat terbaca adalah tokennya sendiri, bukan hanya sesi 12 jam.
- `DASHBOARD_URL` tidak wajib untuk cara ini. Bila diisi, login dan perubahan hanya diterima dari alamat itu, jadi isinya harus sama dengan alamat yang kamu buka.
- Bila dashboard dibuka lewat alamat `https://`, isi `DASHBOARD_URL` dengan alamat itu: cookie sesi lalu hanya dikirim lewat HTTPS, dan catatan "Tanpa enkripsi" di halaman Pengaturan tidak muncul.
- Login lewat Discord tetap ada. Bila keduanya dikonfigurasi, halaman login menampilkan tautan "Masuk dengan akun Discord".

### Tautan login

Token dapat juga dibawa di alamat, seperti pada proyek referensi:

```text
http://IP:PORT/masuk/TOKEN
```

Membuka alamat itu langsung membuat sesi dan meneruskan ke dashboard, tanpa mengetik. `http://IP:PORT/dashboard/masuk/TOKEN` adalah alamat yang sama dalam bentuk panjang.

- **Alamat ini sama rahasianya dengan token.** Peramban menyimpannya di riwayat dan dapat menawarkannya lagi saat kamu mengetik. Pakai hanya di perangkat sendiri, misalnya sebagai bookmark.
- **Jangan tempel tautan ini di chat**, termasuk di Discord: aplikasi chat membuka tautan untuk membuat pratinjau, dan semua yang dapat membaca chat itu ikut mendapat token.
- Bot tidak pernah menulis token ke log, dan jawaban server tidak mengulanginya. Yang tidak dapat dicegah bot adalah riwayat peramban dan log perantara di jalur HTTP.
- Token yang berisi karakter selain huruf, angka, `-` dan `_` harus ditulis dengan percent-encoding di tautan (misalnya `@` menjadi `%40`). Lebih mudah memakai token dari huruf dan angka saja.
- Tautan yang salah menampilkan halaman login dengan pesan "Token di tautan tidak cocok." dan dihitung sebagai percobaan login.
- Bila `DASHBOARD_URL` diisi, tautan hanya diterima di alamat itu.

Bila halaman login menolak:

| Pesan | Sebab |
| --- | --- |
| "Token salah." | Yang diketik tidak sama dengan `DASHBOARD_TOKEN`. Periksa juga apakah bot sudah dimulai ulang setelah `.env` diubah. |
| "Login dengan token belum aktif: DASHBOARD_TOKEN harus minimal 12 karakter." | Token terlalu pendek. |
| "Login dengan token belum aktif: isi OWNER_IDS …" | `OWNER_IDS` kosong atau bukan ID Discord (17 sampai 20 angka). |
| "Akun di OWNER_IDS (…) bukan anggota server yang dikonfigurasi …" | ID di `OWNER_IDS` bukan anggota server pada `GUILD_ID`. |
| "Login hanya diterima dari …" | Dashboard dibuka lewat alamat yang berbeda dari `DASHBOARD_URL`. |
| "Bot belum siap memverifikasi server." | Bot belum tersambung ke Discord; tunggu sampai log menulis ONLINE. |

### Perbaikan 14 November 2026: formulir menolak, tautan diterima

Sampai versi sebelumnya, mengetik token di `/dashboard/login` selalu dijawab "Login hanya diterima dari …" (atau "Permintaan tidak valid …" bila `DASHBOARD_URL` kosong), walaupun alamatnya benar. Tautan `/masuk/TOKEN` tetap bisa dipakai.

Sebabnya: halaman login dikirim dengan kebijakan `Referrer-Policy: no-referrer`. Dengan kebijakan itu peramban berbasis Chromium (Chrome, Brave, Edge) mengirim formulir dengan header `Origin: null`, bukan alamat dashboard, dan server menolak karena `null` tidak sama dengan alamat dashboard. Tes yang ada mengirim alamat yang benar atau tidak mengirim `Origin` sama sekali, sehingga tidak menangkapnya.

Yang berubah:

- Halaman login dan halaman lain sebelum dashboard terbuka kini memakai `Referrer-Policy: same-origin`, sehingga peramban menyebut alamat dashboard saat mengirim formulir. Dashboard sendiri tetap `no-referrer`.
- `Origin: null` pada formulir login diterima bila permintaan sampai di alamat dashboard (header `Host` sama dengan `DASHBOARD_URL` bila itu diisi), dan ditolak bila peramban menandainya sebagai permintaan dari situs lain (`Sec-Fetch-Site`; header ini hanya dikirim lewat HTTPS dan di `localhost`). Ini menolong tab login lama yang masih terbuka dan peramban yang menyembunyikan asal halaman.
- Lewat HTTP biasa, formulir di situs lain jadi bisa mengirim token ke halaman login. Yang didapatnya tidak ada: jawabannya tidak bisa dibaca situs itu, percobaan tetap dihitung per alamat IP (30 per 15 menit), dan siapa pun yang tahu token memang bisa masuk. Perubahan di dalam dashboard (simpan, hapus, keluar) tetap menuntut `Origin` yang sama persis dengan alamat dashboard.

### Tampilan halaman login

Halaman login, halaman "login gagal", "login belum dikonfigurasi" dan "terlalu banyak percobaan" memakai sistem desain yang sama dengan dashboard (warna, huruf, panel bergaris tanpa sudut membulat, tombol lime). Sumbernya `src/dashboard/loginPage.js`; nilainya disalin dari `:root` pada `dashboard-preview/style.css`, dan tes gagal bila keduanya tidak lagi sama. Halaman itu satu dokumen utuh: tanpa skrip dan tanpa mengambil berkas lain, karena ditampilkan kepada orang yang belum login.

## Dashboard lewat HTTP

Bagian ini tentang login lewat Discord. Bawaan: login itu hanya aktif pada alamat `https://` (atau `http://localhost` saat pengembangan). Dengan `DASHBOARD_URL=http://ip:port` saja, halaman login menjawab 503 dan menjelaskan sebabnya.

Untuk panel yang hanya memberi alamat `http://ip:port`:

1. Isi `DASHBOARD_URL=http://IP:PORT` persis seperti alamat server di panel, tanpa garis miring atau path di belakangnya.
2. Isi `DASHBOARD_ALLOW_HTTP=true`.
3. Di Discord Developer Portal → OAuth2 → Redirects, tambahkan `http://IP:PORT/dashboard/callback`.
4. Mulai ulang bot, lalu buka `http://IP:PORT/dashboard/`.

Langkah 3 terlihat bekerja pada kiriman pemilik bot tanggal 13 November 2026: setelah Authorize, Discord mengembalikan peramban ke `http://IP:PORT/dashboard/callback`. Login sampai masuk ke dashboard belum terkonfirmasi.

**Risikonya.** Lewat HTTP, sesi login berjalan tanpa enkripsi. Pihak di jaringan yang sama (Wi-Fi umum, jaringan kantor) atau di antara peramban dan server dapat membaca cookie sesi dan memakai dashboard dengan hak Anda sampai sesi berakhir. Proyek referensi punya kelemahan yang sama dengan kata sandi dashboard-nya.

Yang tetap berlaku pada mode ini:

- Login lewat Discord tidak memakai kata sandi bersama. (Login dengan token pada bagian sebelumnya memakainya.)
- Hanya owner server dan pemegang izin Administrator yang dapat masuk, dan izin itu diperiksa ulang ke Discord pada setiap permintaan.
- Sesi paling lama 8 jam dan hilang saat bot dimulai ulang.
- Login yang sedang menunggu juga hilang saat bot dimulai ulang, dan berlaku paling lama 10 menit.
- Setiap perubahan tetap memerlukan token sesi dan harus datang dari alamat dashboard yang sama.

Yang ditambahkan agar mode ini tidak aktif tanpa disadari:

- Bot menulis peringatan di log saat startup.
- Halaman Pengaturan menampilkan catatan "Tanpa enkripsi" pada bagian akses.

Saran pemakaian: buka dashboard dari jaringan yang dipercaya, tekan KELUAR setelah selesai, dan pindah ke alamat `https://` bila hosting menyediakannya. Setelah pindah, kosongkan `DASHBOARD_ALLOW_HTTP`.

## Halaman dashboard yang berputar tanpa henti (diperbaiki 14 November 2026)

Sejak dashboard pertama kali ditambahkan (commit `3d3e924`), server web mengalihkan `/dashboard/` ke `/dashboard/` itu sendiri. Akibatnya halaman dashboard tidak pernah dapat dibuka lewat bot yang berjalan: setelah login berhasil, peramban berputar sampai menyerah, dan dengan pembatas permintaan yang lama putaran itu menghabiskan jatah 100 permintaan sehingga muncul `{"error":"Too many requests"}`.

Kesalahan ini lolos karena semua tes memasang dashboard langsung, tanpa baris pengalih milik `src/app.js`. Sekarang pemasangannya satu fungsi (`mountDashboard` di `src/dashboard/router.js`) yang dipakai `src/app.js` dan tes, dan hanya `/dashboard` tanpa garis miring yang dialihkan.

Yang terbukti di sini: dengan kode lama, `GET /dashboard/` menjawab 302 ke `/dashboard/`; dengan kode baru, halaman terbuka setelah login (bot dijalankan dengan klien Discord tiruan). Bahwa inilah satu-satunya sebab kegagalan di panel pemilik bot belum terbukti.

## Batas permintaan

Server web membatasi jumlah permintaan per alamat IP. Ada tiga hitungan terpisah, sehingga membuka dashboard tidak menghabiskan jatah login dan sebaliknya:

| Hitungan | Berlaku untuk | Batas |
| --- | --- | --- |
| Login | `/dashboard/login`, `/dashboard/callback` dan tautan login `/masuk/…` | 30 per 15 menit |
| Dashboard | Semua alamat lain di bawah `/dashboard` | 600 per menit |
| Umum | Alamat lain: `/`, `/health`, `/ready` | 100 per 15 menit (dari `src/config/application.js`) |

Sebelumnya hanya ada satu hitungan, 100 per 15 menit untuk semuanya. Satu kali membuka dashboard mengambil 31 berkas yang tidak di-cache, ditambah panggilan data, sehingga jatah itu habis setelah dua atau tiga kali buka dan peramban menerima `{"error":"Too many requests"}`.

Permintaan yang ditolak mendapat status 429 dan header `Retry-After`. Di bawah `/dashboard` isinya kalimat berbahasa Indonesia yang menyebut berapa lama harus menunggu: sebagai halaman bergaya dashboard untuk alamat yang dibuka orang, sebagai JSON untuk `/dashboard/api/…`. Permintaan yang ditolak tidak memperpanjang waktu tunggu. Hitungan disimpan di memori dan kembali nol saat bot dimulai ulang. Angka login dan dashboard tetap di `src/utils/webRateLimit.js`; tidak ada variabel lingkungan untuk mengubahnya.

Hitungan memakai alamat IP yang tersambung langsung ke bot. Di belakang reverse proxy, semua pengunjung terhitung sebagai satu alamat.

## Pemakaian sistem di halaman ringkasan

Blok "02 / PEMAKAIAN SISTEM" pada halaman ringkasan dashboard menampilkan CPU, RAM, jaringan dan disk, dan memperbaruinya setiap 3 detik selama halaman itu terlihat. Hanya untuk owner bot (`OWNER_IDS`); login dengan token selalu bertindak sebagai owner.

**Tidak perlu pengaturan apa pun.** Bot membaca angka kontainernya sendiri dari berkas yang disediakan kernel Linux (`/sys/fs/cgroup`, `/proc`), yaitu sumber yang sama yang dibaca panel hosting. Kunci API panel tidak diperlukan.

| Angka | Asalnya | Cara menghitung |
|---|---|---|
| CPU | `cpu.stat` kontainer (`usage_usec`), selisih dua bacaan | **100% = satu inti penuh**, seperti di panel Pterodactyl. "DARI 100%" adalah jatah CPU kontainer (`cpu.max`); tanpa jatah tertulis jumlah inti mesin |
| RAM | `memory.current` dikurangi `inactive_file` | Cache berkas yang bisa dilepas tidak dihitung, seperti di panel. Batasnya `SERVER_MEMORY` (diisi panel) bila ada dan tidak melebihi batas kontainer, kalau tidak batas kontainer (`memory.max`) |
| Jaringan | `/proc/self/net/dev`, semua antarmuka kecuali `lo` | Kecepatan masuk / keluar = selisih dua bacaan; di bawahnya total sejak kontainer menyala |
| Disk | Ukuran folder server (`/home/container` bila bot ada di dalamnya, kalau tidak folder bot) | Dihitung di latar belakang, paling sering **sekali per 5 menit**; berhenti pada 60.000 berkas dan menulis "LEBIH DARI INI" |

Yang perlu diketahui:

- **Kuota disk tidak bisa dibaca dari dalam kontainer.** Isi `DISK_LIMIT_MB` di `.env` (misalnya `5120` untuk 5 GB) agar tertulis "DARI 5 GB" dan batang terisi. Tanpa itu tertulis "KUOTA BELUM DIISI".
- Bila ketiga nilai `HOSTING_PANEL_URL`, `HOSTING_SERVER_ID` dan `HOSTING_API_KEY` diisi, bot juga bertanya ke panel paling sering sekali per 15 detik, hanya untuk dua hal: status server (tertulis di samping "LIVE") dan angka disk (pengganti hitungan folder). CPU, RAM dan jaringan tetap bacaan bot sendiri, karena itulah yang bisa diperbarui tiap 3 detik tanpa membebani panel.
- Angka pertama setelah halaman dibuka belum punya CPU dan kecepatan jaringan (perlu dua bacaan); keduanya terisi sekitar satu detik kemudian. Yang tidak diketahui ditulis "—", bukan 0.
- Di luar kontainer (VPS tanpa Docker, komputer sendiri) CPU dan RAM adalah milik **proses bot**, dibanding seluruh mesin; catatan kaki blok itu menyebutkannya. Di Windows dan macOS jaringan tertulis "TIDAK TERBACA".
- Angka bisa berbeda sedikit dari panel: panel dan bot membaca pada saat yang berbeda, dan angka disk bot bisa berumur sampai 5 menit.
- Beban: satu permintaan kecil tiap 3 detik per tab yang terbuka dan terlihat; tab tersembunyi atau halaman lain tidak bertanya. Pemeriksaan keanggotaan Discord untuk permintaan ini dipakai ulang selama 1 menit (rute lain tetap memeriksa setiap kali), jadi membiarkan halaman terbuka tidak menghabiskan jatah permintaan bot ke Discord.

Sumber: `src/services/systemUsage.js` (pembacaan), `src/dashboard/systemUsageApi.js` (`GET /dashboard/api/bot/system-usage`), `dashboard-preview/live.js` (tampilan).

## Bila login gagal

Halaman callback kini menyebut sebabnya dan memberi tautan "Mulai login lagi".

| Pesan | Artinya | Yang dilakukan |
| --- | --- | --- |
| "Browser ini tidak mengirim cookie login." | Callback tiba tanpa cookie yang dipasang saat login dimulai | Mulai login di peramban yang sama dan bukan tab private; buka dashboard lewat alamat yang sama persis dengan `DASHBOARD_URL`; izinkan cookie untuk alamat itu. Di ponsel, aplikasi Discord dapat mengembalikan Anda ke peramban bawaan, jadi mulailah dari peramban itu |
| "Login ini sudah tidak berlaku." | Server tidak lagi menyimpan login itu: halaman callback dimuat ulang, lebih dari 10 menit berlalu, atau bot dimulai ulang di tengah login | Mulai login lagi |
| "Ada login lain yang dimulai lebih baru di browser ini" | Cookie di peramban milik login yang lain | Mulai login lagi dan selesaikan yang itu |
| "Login dibatalkan di halaman Discord." | Tombol Cancel ditekan di Discord | Mulai login lagi dan tekan Authorize |
| "Alamat ini tidak lengkap." | Alamat callback dibuka tanpa kode dari Discord | Buka `/dashboard/` |
| "Login Discord gagal. Coba lagi." | Discord menolak penukaran kode | Periksa `DISCORD_CLIENT_SECRET` |
| "Akses hanya untuk owner atau administrator server." | Akun itu bukan owner atau Administrator di server `GUILD_ID` | Login dengan akun yang berhak |
| "Terlalu banyak percobaan login dari alamat ini." | Batas login di atas tercapai | Tunggu selama yang disebut pesan itu |

Tiga hal dibuat lebih longgar agar pesan-pesan itu jarang muncul:

- Membuka halaman login dua kali di peramban yang sama (tab kedua, muat ulang) memakai login yang sama selama masih menunggu. Sebelumnya login kedua menimpa cookie login pertama, sehingga login pertama gagal.
- Memuat ulang halaman callback setelah login berhasil kini membawa ke dashboard, bukan ke pesan kesalahan.
- Callback yang tiba tanpa cookie dari peramban yang memulai login (pratinjau tautan, peramban lain) ditolak tanpa menghabiskan login itu. Peramban yang memulainya masih dapat menyelesaikannya. Sebelumnya permintaan seperti itu menghanguskan login.

Setiap login tetap hanya dapat dipakai satu kali: percobaan pertama dari peramban yang memulainya menghabiskannya, berhasil atau tidak.

## Log di konsol

Setiap baris berbentuk `jam  TANDA  pesan`. Tanda selalu selebar enam huruf, sehingga pesan mulai di kolom yang sama; baris lanjutan dan jejak kesalahan menjorok ke kolom itu.

| Tanda | Arti |
| --- | --- |
| `START` | Laporan saat bot menyala. |
| `STATUS` | Bot berhenti atau menyala ulang. |
| `INFO` | Kejadian biasa. |
| `WARN` | Ada yang tidak beres tetapi bot tetap berjalan. Pemeriksaan saat menyala yang menemui kesalahan juga dicetak dengan tanda ini. |
| `ERROR` | Ada yang gagal; baris di bawahnya menunjukkan tempatnya di kode. |
| `DEBUG` | Rincian, hanya dengan `LOG_LEVEL=debug`. |

Contoh saat menyala (dari menjalankan bot di lingkungan uji dengan Discord tiruan; nama server dan alamat adalah contoh):

```text
21:20:35  START  ZentixBot 2.1.0 starting (Node v22.22.3, production mode, log level info)
21:20:35  START  Database: PostgreSQL connected, data is persistent
21:20:35  START  Web port 39117 taken from WEB_PORT
21:20:35  START  Web server: listening on 0.0.0.0:39117 (/health, /ready, /dashboard/)
21:20:35  START  Commands: 100 loaded in 20 categories, 84 subcommands
21:20:35  START    AI 1 · Birthday 1 · Community 2 · Core 7 · Economy 19 · Fun 4 · Giveaway 4 · JoinToCreate 1
21:20:35  START    Leveling 6 · Logging 1 · Moderation 16 · Music 5 · Reaction_roles 1 · Search 1 · ServerStats 1
21:20:35  START    Ticket 4 · Tools 11 · Utility 8 · Verification 3 · Welcome 4
21:20:35  START  Events: 14 registered
21:20:35  START  Interactions: 60 buttons, 5 select menus, 12 modals
21:20:35  START  Music: 6 Lavalink nodes configured (vinster, trinium, nazha, serenetia, jirayu, millohost)
21:20:35  START  Discord: logging in...
21:20:35  START  Slash commands: 100 registered for server 123456789012345678
21:20:35  START  ────────────────────────────────────────────────────────────
21:20:35  START  ZentixBot 2.1.0 is ONLINE (startup took 2.3 s)
21:20:35  START    Bot        zentix#0667
21:20:35  START    Server     Zentix Community (123456789012345678)
21:20:35  START    Loaded     100 commands, 60 buttons, 5 select menus, 12 modals
21:20:35  START    Database   PostgreSQL, persistent
21:20:35  START    Web        port 39117
21:20:35  START    Dashboard  http://203.0.113.5:39117/dashboard/ (plain HTTP)
21:20:35  START    Memory     174 MB
21:20:35  START  ────────────────────────────────────────────────────────────
21:20:35  START  Check, ticket panels: healthy 0, deleted 0, channel missing 0, recovered 0, errors 0
```

- Baris `Dashboard` pada rangkuman menyebut alamat dashboard, atau sebab login dashboard mati (misalnya `login off: DASHBOARD_URL is not set`).
- Bila Discord menolak pendaftaran slash command, rangkuman memuat baris `Warning`.
- Bila ada berkas command, event atau interaksi yang gagal dimuat, baris ringkasannya menyebut jumlahnya (`… ; 1 file not loaded, see the messages above`) dan berkasnya disebut pada baris `WARN` atau `ERROR` di atasnya.
- `LOG_LEVEL=warn` (isi `.env.example`) menampilkan `START`, `STATUS`, `WARN` dan `ERROR`. `LOG_LEVEL=info` menambah kejadian biasa, misalnya node Lavalink yang tersambung. `LOG_LEVEL=debug` menambah satu baris per command, event dan handler yang dimuat serta langkah-langkah database.
- Warna dipakai untuk jam dan tanda saja. Bila konsol panel menampilkan kode seperti `[32m`, isi `NO_COLOR=1`.
- Isi objek yang ikut dicatat (misalnya ID server pada sebuah peringatan) tidak dicetak di konsol.

## Langkah di panel (dari panduan referensi, belum diperiksa)

1. Buat server dengan egg Node.js, image Node 22.
2. Arahkan ke repositori ini, branch `main`, berkas JS `index.js`.
3. Isi variabel di tab Startup → Environment, bukan dengan mengunggah berkas `.env`.
4. Mulai server dan baca log: port yang dipakai, status database, lalu login bot.

## Berkas

- `src/utils/webPort.js` (baru): aturan port. Dipakai `src/app.js` dan `src/config/application.js`.
- `src/dashboard/origin.js` (baru): aturan alamat dashboard dan pesan saat login belum dapat dipakai. Dipakai `src/dashboard/router.js` dan `src/dashboard/settingsApi.js`.
- `dashboard-preview/settings-live.js`: catatan "Tanpa enkripsi".
- `.env.example`: `DASHBOARD_ALLOW_HTTP`, `WEB_PORT`, keterangan `SERVER_PORT`.
- `tests/hosting-port-http.test.js` (baru) dan tambahan di `tests/dashboard-settings-control-center.test.js`.
- `src/utils/webRateLimit.js`: tiga hitungan batas permintaan. Dipakai `src/app.js`.
- `src/dashboard/loginProblem.js`: sebab login gagal di callback dan halamannya. Dipakai `src/dashboard/router.js`.
- `tests/dashboard-login-and-limits.test.js`: tes untuk keduanya.

## Yang belum diuji

- Pemakaian sistem pada panel sungguhan. Pembacaan diuji dengan berkas kernel tiruan (cgroup v2, cgroup v1, tanpa cgroup) dan dijalankan di kontainer pengembangan (cgroup v2, batas RAM, tanpa jatah CPU). Bahwa angkanya sama dengan yang ditampilkan panel pemilik bot, dan bahwa `SERVER_MEMORY` terisi di panel itu, belum diperiksa. Sambungan ke API panel diuji dengan panel tiruan saja.
- Server Builder terhadap Discord sungguhan. Tesnya memakai server Discord tiruan: yang terbukti adalah apa yang diminta untuk dibuat, apa yang dicatat, dan bahwa bongkar hanya menghapus ID yang tercatat. Belum pernah dicoba: pembuatan channel forum/pengumuman/panggung, warna role, batas laju Discord saat membuat atau menghapus puluhan objek, dan rancangan dari model AI sungguhan.
- AI interaktif terhadap Discord dan provider sungguhan. Tesnya memakai pesan Discord tiruan dan provider tiruan: yang terbukti adalah kapan bot memutuskan menjawab, apa yang dikirim ke provider, dan apa yang ditulis ke channel. Belum pernah dicoba: seperti apa jawaban model sungguhan dengan prompt ini (gaya, panjang, apakah benar terasa seperti anggota), apakah model yang dipakai pemilik bot membaca gambar, apakah proxy media Discord menerima permintaan JPEG yang diperkecil seperti yang disusun bot, dan berapa kuota yang terpakai di channel yang ramai. Tampilan tab "AI interaktif" hanya diperiksa di jsdom, bukan di peramban.
- Rantai tiga cadangan terhadap provider sungguhan. Tesnya memakai provider tiruan: yang terbukti adalah urutan percobaan, provider mana yang dilewati, dan kapan rantai berhenti. Bahwa Gemini, OpenRouter atau NVIDIA menerima permintaan bot ini belum pernah dicoba.
- Penghapusan perintah global terhadap Discord sungguhan. Tesnya memakai klien REST tiruan. Bahwa `/ai` di aplikasi pemilik bot memang perintah global adalah kesimpulan dari kode (bot ini menimpa daftar perintah server setiap start dan tidak punya `/ai`), belum dilihat langsung.
- Tidak ada yang dijalankan di sini pada panel sungguhan. Yang diketahui tentang panel hanyalah kiriman pemilik bot di awal dokumen ini; batas RAM, perilaku saat restart dan pemakaian memori belum diperiksa.
- Login Discord sungguhan sampai masuk ke dashboard pada alamat `http://ip:port`, termasuk setelah perbaikan batas permintaan dan pesan login.
- Sebab login pemilik bot gagal pada 13 November 2026: satu sebab ditemukan pada 14 November (halaman `/dashboard/` berputar tanpa henti, lihat di atas). Apakah ada sebab lain, misalnya client secret, tidak diketahui.
- Kiriman pemilik bot pada 14 November 2026 (tangkapan layar, bukan pengujian di sini): dashboard terbuka di Brave pada panel setelah login, dan `/aichat` dijawab oleh provider sungguhan. Cara login yang dipakai (token, tautan atau Discord) tidak diketahui.
- Login dengan token dan tautan login di panel sungguhan dan di peramban sungguhan, termasuk apa yang tersimpan di riwayat peramban setelah tautan dibuka. Di sini diuji dengan permintaan HTTP langsung ke bot yang berjalan dengan klien Discord tiruan.
- Tampilan log di konsol panel: apakah warnanya tampil, dan baris-baris setelah login Discord sungguhan (pendaftaran slash command, rangkuman ONLINE, pemeriksaan saat menyala, node Lavalink). Di sini baris-baris itu hanya dihasilkan dengan Discord tiruan.
- Dashboard di peramban sungguhan; tesnya memakai jsdom dan permintaan HTTP langsung. Jumlah panggilan data per halaman tidak diukur; angka 31 hanya menghitung berkas yang disebut `index.html`.
- Groq (transkripsi), Tavily, Cloudflare Workers AI dan Pollinations yang sesungguhnya. Tesnya memakai penyedia tiruan: yang terbukti adalah permintaan yang disusun bot dan cara bot membaca jawaban, bukan bahwa layanan itu menerimanya. Bentuk permintaan diambil dari dokumentasi tiap layanan.
