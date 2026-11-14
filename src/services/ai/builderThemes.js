// Ready-made server layouts for the Server Builder. Picking one costs no AI request, and the closest one
// stands in when the AI gives no usable plan (see builder.js).
//
// Every theme is an ordinary plan: it passes validatePlan() and goes through the same review, edit and
// confirmation steps as a plan the AI wrote. Themes use text and voice channels only, so they also work on
// servers that have not switched on Discord's Community feature.
const text = (name, topic) => (topic ? { name, type: 'text', topic } : { name, type: 'text' });
const voice = (name) => ({ name, type: 'voice' });
const role = (name, color) => ({ name, color });

const NEWS = text('pengumuman', 'Kabar penting dari pengelola server.');
const RULES = text('aturan', 'Baca dulu sebelum ikut ngobrol.');

const THEME_LIST = [
    {
        id: 'gaming', label: 'Gaming', emoji: '🎮',
        keywords: ['game', 'gaming', 'gamer', 'mabar', 'esport', 'esports', 'push rank', 'valorant', 'mobile legends', 'mlbb', 'pubg', 'free fire', 'minecraft', 'roblox', 'genshin', 'turnamen', 'squad', 'clan'],
        plan: {
            categories: [
                { name: '📢 INFO', channels: [NEWS, RULES] },
                { name: '🎮 GAMING', channels: [
                    text('ngobrol-game', 'Obrolan seputar game apa saja.'),
                    text('cari-tim', 'Cari teman main: sebut game, mode dan jam mainnya.'),
                    text('klip-dan-momen', 'Bagikan klip dan tangkapan layar terbaikmu.'),
                    text('turnamen', 'Info dan pendaftaran turnamen.'),
                ] },
                { name: '🔊 RUANG MABAR', channels: [voice('Mabar 1'), voice('Mabar 2'), voice('Santai')] },
            ],
            roles: [role('🎮 Gamer', '#57F287'), role('🏆 Pro Player', '#F1C40F'), role('🎥 Streamer', '#9B59B6')],
        },
    },
    {
        id: 'komunitas', label: 'Komunitas', emoji: '👥',
        keywords: ['komunitas', 'community', 'umum', 'nongkrong', 'ngobrol', 'santai', 'teman', 'tongkrongan', 'circle'],
        plan: {
            categories: [
                { name: '📌 INFORMASI', channels: [NEWS, RULES, text('perkenalan', 'Kenalkan dirimu ke anggota lain.')] },
                { name: '💬 OBROLAN', channels: [
                    text('ngobrol-umum', 'Obrolan bebas dan santai.'),
                    text('berbagi-foto', 'Foto, meme dan hal menarik.'),
                    text('saran', 'Usul dan masukan untuk server.'),
                ] },
                { name: '🔊 SUARA', channels: [voice('Ruang Santai'), voice('Ngobrol Bareng')] },
            ],
            roles: [role('👥 Member', '#3498DB'), role('🤝 Kontributor', '#2ECC71'), role('🛡️ Moderator', '#E67E22')],
        },
    },
    {
        id: 'aesthetic', label: 'Aesthetic', emoji: '🌸',
        keywords: ['aesthetic', 'estetik', 'cute', 'soft', 'vibes', 'pastel', 'kawaii', 'lucu', 'gemas'],
        plan: {
            categories: [
                { name: '🌸 welcome', channels: [text('selamat-datang', 'Senang kamu ada di sini.'), RULES, text('perkenalan', 'Ceritakan sedikit tentang dirimu.')] },
                { name: '☁️ lounge', channels: [
                    text('obrolan', 'Ngobrol santai sehari-hari.'),
                    text('moodboard', 'Gambar dan warna yang kamu suka.'),
                    text('playlist', 'Lagu untuk menemani hari.'),
                    text('curhat', 'Tempat bercerita; saling menjaga, ya.'),
                ] },
                { name: '🌙 voice', channels: [voice('Ruang Teduh'), voice('Karaoke')] },
            ],
            roles: [role('🌸 Sakura', '#FFB7C5'), role('☁️ Awan', '#A9D6E5'), role('🌙 Luna', '#CDB4DB')],
        },
    },
    {
        id: 'study', label: 'Belajar', emoji: '📚',
        keywords: ['belajar', 'study', 'sekolah', 'kuliah', 'kampus', 'tugas', 'ujian', 'les', 'kelas', 'pelajar', 'mahasiswa', 'bimbel', 'pelajaran'],
        plan: {
            categories: [
                { name: '📌 INFO KELAS', channels: [NEWS, RULES, text('jadwal', 'Jadwal belajar, ujian dan tenggat.')] },
                { name: '📚 BELAJAR', channels: [
                    text('tanya-jawab', 'Tanyakan soal atau materi yang belum paham.'),
                    text('materi', 'Rangkuman, tautan dan bahan belajar.'),
                    text('tugas', 'Diskusi tugas; bantu memahami, bukan menyalin.'),
                    text('catatan', 'Bagikan catatanmu.'),
                ] },
                { name: '🔊 RUANG BELAJAR', channels: [voice('Belajar Bareng'), voice('Fokus Senyap')] },
            ],
            roles: [role('📚 Pelajar', '#3498DB'), role('🧑‍🏫 Mentor', '#E67E22'), role('⭐ Rajin', '#F1C40F')],
        },
    },
    {
        id: 'musik', label: 'Musik', emoji: '🎵',
        keywords: ['musik', 'music', 'lagu', 'band', 'nyanyi', 'karaoke', 'playlist', 'gitar', 'cover', 'produser', 'musisi'],
        plan: {
            categories: [
                { name: '📌 INFO', channels: [NEWS, RULES] },
                { name: '🎵 MUSIK', channels: [
                    text('ngobrol-musik', 'Obrolan tentang musik dan musisi.'),
                    text('rekomendasi-lagu', 'Lagu yang layak didengar orang lain.'),
                    text('karya-sendiri', 'Pamerkan lagu, cover atau aransemenmu.'),
                    text('cari-kolaborasi', 'Cari rekan untuk berkarya bersama.'),
                ] },
                { name: '🔊 STUDIO', channels: [voice('Dengar Bareng'), voice('Jam Session'), voice('Ruang Karaoke')] },
            ],
            roles: [role('🎵 Pendengar', '#1ABC9C'), role('🎤 Vokalis', '#E91E63'), role('🎸 Musisi', '#E67E22')],
        },
    },
    {
        id: 'seni', label: 'Seni', emoji: '🎨',
        keywords: ['seni', 'art', 'gambar', 'menggambar', 'ilustrasi', 'desain', 'design', 'lukis', 'artist', 'komik', 'fotografi', 'kreatif'],
        plan: {
            categories: [
                { name: '📌 INFO', channels: [NEWS, RULES] },
                { name: '🎨 GALERI', channels: [
                    text('pamer-karya', 'Karya yang sudah jadi.'),
                    text('karya-proses', 'Sketsa dan karya yang masih dikerjakan.'),
                    text('kritik-saran', 'Minta masukan; beri masukan dengan sopan.'),
                    text('referensi', 'Tutorial, kuas dan bahan rujukan.'),
                ] },
                { name: '🖌️ KOMUNITAS', channels: [
                    text('ngobrol-seni', 'Obrolan seputar seni dan berkarya.'),
                    text('komisi', 'Buka atau cari jasa komisi.'),
                    text('tantangan-mingguan', 'Tema berkarya setiap minggu.'),
                ] },
                { name: '🔊 SUARA', channels: [voice('Gambar Bareng')] },
            ],
            roles: [role('🎨 Seniman', '#E91E63'), role('🖌️ Ilustrator', '#9B59B6'), role('📷 Fotografer', '#607D8B')],
        },
    },
    {
        id: 'teknologi', label: 'Teknologi', emoji: '💻',
        keywords: ['teknologi', 'tech', 'gadget', 'komputer', 'laptop', 'android', 'iphone', 'hardware', 'rakit pc', 'smartphone', 'elektronik'],
        plan: {
            categories: [
                { name: '📌 INFO', channels: [NEWS, RULES] },
                { name: '💻 TEKNOLOGI', channels: [
                    text('ngobrol-tech', 'Obrolan seputar teknologi.'),
                    text('berita-tech', 'Kabar dan rilis terbaru.'),
                    text('gadget', 'Ulasan dan tanya beli perangkat.'),
                    text('rakit-pc', 'Racikan, harga dan pamer rakitan.'),
                    text('bantuan-teknis', 'Minta bantuan untuk masalah perangkat.'),
                ] },
                { name: '🔊 SUARA', channels: [voice('Ngobrol Tech')] },
            ],
            roles: [role('💻 Tech Enthusiast', '#3498DB'), role('🔧 Teknisi', '#95A5A6'), role('📱 Reviewer', '#1ABC9C')],
        },
    },
    {
        id: 'crypto', label: 'Crypto', emoji: '🪙',
        keywords: ['crypto', 'kripto', 'bitcoin', 'btc', 'eth', 'ethereum', 'trading', 'trader', 'saham', 'investasi', 'nft', 'web3', 'forex'],
        plan: {
            categories: [
                { name: '📌 INFO', channels: [NEWS, RULES, text('waspada-penipuan', 'Pengelola tidak pernah meminta dana atau kata sandi lewat DM.')] },
                { name: '📈 PASAR', channels: [
                    text('diskusi-pasar', 'Obrolan pergerakan pasar; bukan nasihat keuangan.'),
                    text('analisis', 'Analisis lengkap dengan alasannya.'),
                    text('berita-kripto', 'Kabar dari sumber yang jelas.'),
                    text('belajar-dasar', 'Pertanyaan pemula dipersilakan.'),
                ] },
                { name: '🔊 SUARA', channels: [voice('Ruang Diskusi')] },
            ],
            roles: [role('📈 Trader', '#F1C40F'), role('🪙 Holder', '#E67E22'), role('🎓 Pemula', '#2ECC71')],
        },
    },
    {
        id: 'anime', label: 'Anime', emoji: '🍥',
        keywords: ['anime', 'manga', 'wibu', 'otaku', 'weeb', 'donghua', 'manhwa', 'cosplay', 'jepang', 'waifu', 'light novel'],
        plan: {
            categories: [
                { name: '📌 INFO', channels: [NEWS, RULES] },
                { name: '🍥 ANIME', channels: [
                    text('ngobrol-anime', 'Obrolan anime musim ini dan yang lama.'),
                    text('manga-manhwa', 'Bacaan yang sedang diikuti.'),
                    text('rekomendasi', 'Tontonan dan bacaan yang layak dicoba.'),
                    text('fanart', 'Karya penggemar; sebutkan pembuatnya.'),
                    text('spoiler', 'Bahas bebas di sini, jangan di channel lain.'),
                ] },
                { name: '🔊 SUARA', channels: [voice('Nobar'), voice('Ngobrol Wibu')] },
            ],
            roles: [role('🍥 Wibu', '#E91E63'), role('📖 Pembaca Manga', '#9B59B6'), role('🎭 Cosplayer', '#1ABC9C')],
        },
    },
    {
        id: 'roleplay', label: 'Roleplay', emoji: '🎭',
        keywords: ['roleplay', 'role play', 'rp', 'cerita', 'dnd', 'fantasi', 'karakter', 'rpg', 'dungeon', 'petualangan'],
        plan: {
            categories: [
                { name: '📌 PANDUAN', channels: [NEWS, text('aturan-rp', 'Aturan bermain peran di server ini.'), text('daftar-karakter', 'Daftarkan karaktermu sebelum bermain.')] },
                { name: '🎭 DUNIA CERITA', channels: [
                    text('kota-utama', 'Tempat cerita bermula.'),
                    text('hutan-terlarang'),
                    text('kedai-petualang'),
                    text('arena'),
                ] },
                { name: '💬 DI LUAR CERITA', channels: [text('ooc-ngobrol', 'Obrolan di luar peran.'), text('ide-cerita', 'Usul alur dan dunia cerita.')] },
                { name: '🔊 SUARA', channels: [voice('Sesi Cerita')] },
            ],
            roles: [role('🎭 Pemain', '#9B59B6'), role('📜 Narator', '#E67E22'), role('🐉 Game Master', '#E74C3C')],
        },
    },
    {
        id: 'bisnis', label: 'Bisnis', emoji: '💼',
        keywords: ['bisnis', 'usaha', 'jualan', 'toko', 'umkm', 'dagang', 'olshop', 'online shop', 'reseller', 'dropship', 'marketing', 'pelanggan', 'wirausaha'],
        plan: {
            categories: [
                { name: '📌 INFO', channels: [NEWS, RULES] },
                { name: '💼 BISNIS', channels: [
                    text('diskusi-bisnis', 'Obrolan seputar menjalankan usaha.'),
                    text('promosi', 'Promosikan produkmu sesuai aturan.'),
                    text('tanya-usaha', 'Pertanyaan modal, izin, harga dan lainnya.'),
                    text('peluang-kerja-sama', 'Cari mitra, pemasok atau reseller.'),
                    text('tips-pemasaran', 'Cara menjangkau pelanggan.'),
                ] },
                { name: '🔊 SUARA', channels: [voice('Ruang Rapat')] },
            ],
            roles: [role('💼 Pengusaha', '#3498DB'), role('🛒 Pembeli', '#2ECC71'), role('🤝 Mitra', '#F1C40F')],
        },
    },
    {
        id: 'coding', label: 'Coding', emoji: '⌨️',
        keywords: ['coding', 'ngoding', 'programmer', 'programming', 'pemrograman', 'developer', 'kode', 'code', 'python', 'javascript', 'software', 'github', 'open source'],
        plan: {
            categories: [
                { name: '📌 INFO', channels: [NEWS, RULES] },
                { name: '⌨️ NGODING', channels: [
                    text('ngobrol-dev', 'Obrolan seputar pemrograman.'),
                    text('tanya-kode', 'Sertakan kode, pesan galat dan yang sudah dicoba.'),
                    text('pamer-proyek', 'Tunjukkan yang sedang kamu bangun.'),
                    text('sumber-belajar', 'Kursus, artikel dan dokumentasi.'),
                    text('lowongan', 'Lowongan dan proyek lepas.'),
                ] },
                { name: '🔊 SUARA', channels: [voice('Ngoding Bareng'), voice('Ruang Fokus')] },
            ],
            roles: [role('⌨️ Developer', '#3498DB'), role('🐛 Bug Hunter', '#E74C3C'), role('🚀 Kontributor', '#2ECC71')],
        },
    },
    {
        id: 'kesehatan', label: 'Kesehatan', emoji: '💪',
        keywords: ['kesehatan', 'sehat', 'olahraga', 'gym', 'fitness', 'diet', 'lari', 'workout', 'yoga', 'nutrisi', 'sepeda', 'kebugaran'],
        plan: {
            categories: [
                { name: '📌 INFO', channels: [NEWS, RULES] },
                { name: '💪 HIDUP SEHAT', channels: [
                    text('ngobrol-sehat', 'Obrolan gaya hidup sehat; bukan pengganti dokter.'),
                    text('olahraga', 'Program latihan dan tips bergerak.'),
                    text('pola-makan', 'Menu, resep dan kebiasaan makan.'),
                    text('progres-harian', 'Catat kemajuanmu dan saling menyemangati.'),
                    text('kesehatan-mental', 'Saling mendukung dengan hormat.'),
                ] },
                { name: '🔊 SUARA', channels: [voice('Olahraga Bareng')] },
            ],
            roles: [role('💪 Pejuang Sehat', '#2ECC71'), role('🏃 Pelari', '#1ABC9C'), role('🧘 Yogi', '#9B59B6')],
        },
    },
    {
        id: 'keluarga', label: 'Keluarga', emoji: '🏠',
        keywords: ['keluarga', 'family', 'rumah', 'saudara', 'sepupu', 'kerabat', 'arisan', 'reuni', 'sahabat', 'teman dekat'],
        plan: {
            categories: [
                { name: '🏠 RUMAH', channels: [
                    text('kabar-keluarga', 'Kabar penting untuk semua.'),
                    text('ngobrol', 'Obrolan sehari-hari.'),
                    text('foto-kenangan', 'Foto dan video kebersamaan.'),
                    text('rencana-acara', 'Atur kumpul, liburan dan acara.'),
                    text('resep', 'Resep andalan keluarga.'),
                ] },
                { name: '🔊 SUARA', channels: [voice('Ruang Keluarga'), voice('Telepon Bareng')] },
            ],
            roles: [role('🏠 Keluarga', '#E67E22'), role('🤗 Sahabat', '#E91E63')],
        },
    },
    {
        id: 'startup', label: 'Startup & tim kerja', emoji: '🚀',
        keywords: ['startup', 'tim', 'team', 'kerja', 'kantor', 'proyek', 'project', 'produk', 'perusahaan', 'organisasi', 'remote', 'karyawan'],
        plan: {
            categories: [
                { name: '📌 UMUM', channels: [NEWS, text('umum', 'Obrolan seluruh tim.'), text('perkenalan', 'Sambut anggota tim baru.')] },
                { name: '🚀 KERJA TIM', channels: [
                    text('produk', 'Arah produk dan prioritas.'),
                    text('engineering', 'Pembahasan teknis.'),
                    text('desain', 'Rancangan dan masukan.'),
                    text('pemasaran', 'Kampanye dan konten.'),
                    text('dukungan-pelanggan', 'Laporan dan pertanyaan pelanggan.'),
                ] },
                { name: '🔊 RAPAT', channels: [voice('Rapat Harian'), voice('Rapat Tim'), voice('Ruang Fokus')] },
            ],
            roles: [role('🚀 Tim Inti', '#E74C3C'), role('🧑‍💻 Engineer', '#3498DB'), role('🎨 Desainer', '#9B59B6')],
        },
    },
];

const copy = (plan) => ({
    categories: plan.categories.map((category) => ({ name: category.name, channels: category.channels.map((channel) => ({ ...channel })) })),
    roles: plan.roles.map((entry) => ({ ...entry })),
});
const counts = (plan) => ({
    categories: plan.categories.length,
    channels: plan.categories.reduce((total, category) => total + category.channels.length, 0),
    roles: plan.roles.length,
});

/** The theme used when nothing in a description points to another one. */
export const DEFAULT_THEME_ID = 'komunitas';
export const THEME_IDS = Object.freeze(THEME_LIST.map((theme) => theme.id));

/** What a picker needs: no plan, only names and sizes. */
export function listThemes() {
    return THEME_LIST.map(({ id, label, emoji, plan }) => ({ id, label, emoji, ...counts(plan) }));
}

/** A theme with a fresh copy of its plan, or null. The caller may change the copy. */
export function getTheme(id) {
    const theme = typeof id === 'string' ? THEME_LIST.find((entry) => entry.id === id) : null;
    return theme ? { id: theme.id, label: theme.label, emoji: theme.emoji, plan: copy(theme.plan) } : null;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A keyword counts only as a whole word: "rp" must not be found inside "kerja" or "sherpa".
const MATCHERS = THEME_LIST.map((theme) => ({
    id: theme.id,
    patterns: theme.keywords.map((keyword) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}])`, 'u')),
}));

/**
 * The theme whose keywords appear most often in a description; the first listed wins a tie and the
 * community theme is used when nothing matches. Returns the id and the number of keywords found.
 */
export function pickTheme(description) {
    const haystack = typeof description === 'string' ? description.toLowerCase() : '';
    let best = { id: DEFAULT_THEME_ID, hits: 0 };
    for (const { id, patterns } of MATCHERS) {
        const hits = patterns.reduce((total, pattern) => total + (pattern.test(haystack) ? 1 : 0), 0);
        if (hits > best.hits) best = { id, hits };
    }
    return best;
}
