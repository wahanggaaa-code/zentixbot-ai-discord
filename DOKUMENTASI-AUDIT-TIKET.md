# Audit fitur tiket

Tanggal audit: 2026-11-13. Cakupan: `src/services/ticket.js`, `src/utils/database/tickets.js`, `src/handlers/ticketButtons.js`, `src/events/channelDelete.js`, perintah `/close`, `/claim`, `/priority`, dan rute tiket di `src/dashboard/operationsApi.js`.

Audit dilakukan dengan membaca kode dan menjalankan tes terhadap PostgreSQL lokal dan Discord tiruan. **Tidak ada yang diuji pada server Discord nyata.**

Dokumen ini adalah bagian pertama dari butir checklist "Audit fitur tiket, reward role dan seluruh penulis ekonomi". Reward role dan penulis ekonomi belum diaudit.

## Ringkasan

Dua belas masalah diperbaiki dan diuji. Sebelas keterbatasan dicatat tanpa diperbaiki. Yang paling penting dari yang diperbaiki:

- dua tindakan bersamaan pada satu tiket bisa saling menghapus perubahan di PostgreSQL;
- batas tiket per pengguna bisa dilewati dengan menekan tombol beberapa kali;
- channel tiket dihapus walaupun transcript gagal disimpan.

## Masalah yang diperbaiki

| ID | Masalah | Dampak sebelumnya | Perbaikan |
|---|---|---|---|
| T1 | `saveTicketData` di PostgreSQL menimpa seluruh record tanpa memeriksa apakah record berubah sejak dibaca. | Klaim dan tutup yang hampir bersamaan: salah satu perubahan hilang. Tiket bisa tampak tertutup di Discord tetapi `open` di database. | Record hanya disimpan bila isinya masih sama dengan yang dibaca (sama seperti backend SQLite). Jika tidak, tindakan ditolak dengan `TICKET_STALE` dan pengguna diminta mencoba lagi. Record yang tidak dibaca dari database hanya boleh membuat tiket baru. |
| T2 | Pemeriksaan batas tiket dan pembuatan tiket tidak diserialkan. | Menekan tombol beberapa kali dengan cepat membuat tiket melebihi batas. | Pembuatan tiket diantrekan per pengguna di dalam proses bot. |
| T3 | Channel dibuat sebelum record disimpan; kegagalan simpan atau kegagalan pesan pertama meninggalkan channel tanpa record. | Channel yatim yang tidak dikenali sebagai tiket. | Pesan pertama dikirim lalu record disimpan; bila salah satunya gagal, channel dihapus lagi. Bila penghapusan juga gagal, pengguna diberi tahu channel mana yang tersisa (`TICKET_CREATE_ORPHAN`). |
| T4 | Record `open` yang channelnya dihapus saat bot offline tetap dihitung. | Pengguna tidak bisa membuat tiket lagi sampai database diedit manual. | Saat batas tercapai, channel tiap tiket terbuka diperiksa. Hanya jawaban Discord "Unknown Channel" yang menandai record sebagai `deleted` (`deletedReason: channel_missing`). Jawaban lain tidak mengubah apa pun. |
| T5 | Tiket yang sudah tertutup bisa ditutup lagi. | DM dan pesan "Ticket Closed" ganda; `closedAt` dan `closedBy` tertimpa. | Penutupan kedua ditolak (`TICKET_NOT_OPEN`). Pengecualian: lihat T6. |
| T6 | Penutupan yang gagal setelah record tersimpan tidak punya jalur pemulihan yang rapi. | Tiket tertutup tanpa tombol Reopen/Delete. | Menutup tiket yang sudah tertutup tetapi belum memiliki tombol Reopen akan memasang tombol itu saja, tanpa DM kedua dan tanpa mengubah record. Pembaruan pesan pertama kini tidak menghentikan penutupan bila gagal. |
| T7 | Pesan penutupan selalu menyebut "A DM has been sent" bila DM diaktifkan. | Staf mengira pembuat tiket sudah diberi tahu padahal DM gagal. | Pesan dan log mencatat hasil DM yang sebenarnya. |
| T8 | Tiket tertutup masih bisa diklaim. | Status klaim berubah pada tiket yang sudah selesai. | Ditolak (`TICKET_NOT_OPEN`). |
| T9 | Pesan pertama tiket dicari hanya di 50 pesan terakhir. | Pada percakapan panjang, tombol Claim/Close lama tetap aktif setelah tiket ditutup dan status di embed tidak berubah. | Tiket baru menyimpan `messageId` pesan pertamanya. |
| T10 | Channel dihapus walaupun transcript gagal dibuat atau dikirim; tombol hapus bisa ditekan dua kali; log "delete" dicatat sebelum channel benar-benar terhapus. | Percakapan hilang tanpa transcript; dua penghapusan terjadwal; log tidak sesuai kenyataan. | Bila channel transcript dikonfigurasi, channel tiket hanya dihapus setelah transcript terkirim. Kegagalan diumumkan di tiket ("Deletion Cancelled"). Penghapusan kedua ditolak (`TICKET_DELETE_PENDING`). Log dicatat setelah channel terhapus. |
| T11 | Tombol tiket mengganti semua pesan error dengan kalimat umum. | "An error occurred while claiming the ticket" untuk tiket yang sudah diklaim atau izin yang kurang. | Tombol menampilkan alasan dari service. Dashboard menjawab 409 dengan alasan untuk `TICKET_STALE`, `TICKET_NOT_OPEN`, `TICKET_NOT_CLOSED`, `TICKET_CLAIMED`. |
| T12 | Log perubahan prioritas mencatat nilai baru sebagai nilai sebelumnya; batas tiket dibaca dengan dua aturan berbeda (`\|\| 3` dan `?? 3`). | Log salah; batas `0` berarti 3 di tombol tetapi 0 di service. | Nilai sebelumnya disimpan sebelum diubah. Satu fungsi `getTicketLimit`: bukan bilangan bulat positif berarti 3. |

## Perubahan perilaku yang perlu diketahui staf

- **Hapus tiket dengan channel transcript:** bila transcript tidak bisa disimpan (channel transcript terhapus, izin bot kurang, file terlalu besar), tiket **tidak** dihapus. Perbaiki channel transcript di pengaturan tiket, atau hapus channel tiket secara manual.
- **Menutup dua kali:** percobaan kedua menjawab "This ticket is already closed."
- **Klaim tiket tertutup:** ditolak; buka kembali dulu.
- **Dua staf bertindak bersamaan:** salah satu menerima pesan bahwa tiket baru saja diubah dan tindakannya tidak diterapkan.

## Keterbatasan yang dicatat, belum diperbaiki

| ID | Keterbatasan | Catatan |
|---|---|---|
| O1 | Discord dan database bukan satu transaksi. Setelah record tersimpan, langkah Discord (izin channel, edit pesan, kirim pesan) bisa gagal. | Tindakan melaporkan gagal walaupun status sudah berubah. Untuk penutupan ada pemulihan (T6). Untuk klaim, lepas klaim, buka kembali dan prioritas belum ada. |
| O2 | Antrean pembuatan tiket dan penjaga penghapusan ganda hanya berlaku dalam satu proses bot. | Bila bot dijalankan lebih dari satu proses, batas tiket masih bisa dilewati. |
| O3 | Penghapusan dijadwalkan dengan timer 3 detik di memori. | Bila bot restart dalam jeda itu, channel tidak terhapus; tekan Delete lagi. |
| O4 | Bila transcript terkirim tetapi penghapusan channel gagal, menekan Delete lagi mengirim transcript kedua. | Duplikat, bukan kehilangan. |
| O5 | Tiket lama tanpa `messageId` masih dicari di 50 pesan terakhir. | Keterbatasan T9 tetap berlaku untuk tiket yang dibuat sebelum perubahan ini. |
| O6 | Tiket tertutup yang channelnya dihapus tetap berstatus `closed` selamanya; tidak ada retensi atau pembersihan. | Status dibiarkan agar statistik tiket tertutup tidak hilang. Daftar dashboard menampilkan tiket yang channelnya sudah tidak ada. |
| O7 | Nomor tiket terpakai walaupun pembuatan gagal. | Nomor bisa melompat. |
| O8 | Transcript memuat seluruh riwayat ke memori dan hanya berisi teks; embed dan lampiran ditulis sebagai `[embed]` / `[attachment]`. | Tiket sangat panjang bisa gagal diunggah; dengan T10 hal itu kini menahan penghapusan. |
| O9 | Mengganti nama channel (prioritas, pin) dibatasi ketat oleh Discord. | Belum diuji: tindakan bisa tampak menggantung saat batas tercapai. |
| O10 | Kategori "Tickets" dipilih dari kategori pertama yang namanya mengandung "tickets" bila kategori tidak dikonfigurasi. | Bisa memilih kategori yang tidak dimaksud. |
| O11 | Backend SQLite: pembuatan dan penghapusan tiket tetap dinonaktifkan. | Tidak berubah. |

## Tes

`tests/postgres-ticket-service.test.js` (22 tes) dengan `tests/helpers/ticket-postgres-fixture.js`: skema PostgreSQL sekali pakai dan guild Discord tiruan yang menyimpan channel, pesan, izin dan DM.

Mencakup: penyimpanan bersyarat dan tindakan bersamaan, batas tiket dengan permintaan serentak, pembersihan saat pembuatan gagal, record yatim, tutup/klaim/buka kembali, pemulihan penutupan setengah jalan, percakapan panjang, penghapusan dengan dan tanpa transcript, penghapusan ganda, channel yang dihapus manual, jawaban dashboard, pesan tombol, dan batas pada tombol pembuatan.

Dua perbaikan diperiksa dengan sengaja merusaknya: tanpa perbandingan isi record, tes penyimpanan dan tes tindakan bersamaan gagal; tanpa antrean, tes batas tiket gagal.

`tests/tahap6-feedback.test.js`: tiruan penyimpanan disesuaikan dengan jalur tulis yang baru; pemeriksaannya tidak diubah.
