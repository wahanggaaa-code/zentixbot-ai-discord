// Greeting words for AI Welcome and AI Goodbye, and the "how long was this member here" line.
// The word, its reading and its meaning are attached by the bot itself: they never come from the AI,
// so a model cannot invent a language or a translation.

/** [word as written, reading in Latin letters or null, language (in Indonesian), meaning (in Indonesian)] */
const WELCOME = [
    ['Selamat datang', null, 'Indonesia', 'selamat datang'],
    ['Sugeng rawuh', null, 'Jawa', 'selamat datang'],
    ['Wilujeng sumping', null, 'Sunda', 'selamat datang'],
    ['Horas', null, 'Batak', 'salam sejahtera'],
    ['Om Swastiastu', null, 'Bali', 'semoga selamat dan sejahtera'],
    ['Welcome', null, 'Inggris', 'selamat datang'],
    ['Bienvenido', null, 'Spanyol', 'selamat datang'],
    ['Bienvenue', null, 'Prancis', 'selamat datang'],
    ['Willkommen', null, 'Jerman', 'selamat datang'],
    ['Benvenuto', null, 'Italia', 'selamat datang'],
    ['Bem-vindo', null, 'Portugis', 'selamat datang'],
    ['Welkom', null, 'Belanda', 'selamat datang'],
    ['Välkommen', null, 'Swedia', 'selamat datang'],
    ['Velkommen', null, 'Norwegia', 'selamat datang'],
    ['Tervetuloa', null, 'Finlandia', 'selamat datang'],
    ['Velkomin', null, 'Islandia', 'selamat datang'],
    ['Witamy', null, 'Polandia', 'kami menyambutmu'],
    ['Vítejte', null, 'Ceko', 'selamat datang'],
    ['Bun venit', null, 'Rumania', 'selamat datang'],
    ['Fáilte', null, 'Irlandia', 'selamat datang'],
    ['Croeso', null, 'Wales', 'selamat datang'],
    ['Salve', null, 'Latin', 'salam'],
    ['Bonvenon', null, 'Esperanto', 'selamat datang'],
    ['Hoş geldin', null, 'Turki', 'selamat datang'],
    ['Karibu', null, 'Swahili', 'selamat datang'],
    ['Aloha', null, 'Hawaii', 'salam penuh kasih'],
    ['Haere mai', null, 'Māori', 'selamat datang'],
    ['Talofa', null, 'Samoa', 'halo'],
    ['Maligayang pagdating', null, 'Tagalog', 'selamat datang'],
    ['Chào mừng', null, 'Vietnam', 'selamat datang'],
    ['Καλώς ήρθες', 'Kalós írthes', 'Yunani', 'selamat datang'],
    ['Добро пожаловать', 'Dobro pozhalovat', 'Rusia', 'selamat datang'],
    ['Ласкаво просимо', 'Laskavo prosymo', 'Ukraina', 'selamat datang'],
    ['Тавтай морил', 'Tavtai moril', 'Mongolia', 'selamat datang'],
    ['أهلاً وسهلاً', 'Ahlan wa sahlan', 'Arab', 'selamat datang'],
    ['ברוך הבא', 'Barukh haba', 'Ibrani', 'selamat datang'],
    ['خوش آمدید', 'Khosh amadid', 'Persia', 'selamat datang'],
    ['स्वागत है', 'Swagat hai', 'Hindi', 'selamat datang'],
    ['স্বাগতম', 'Swagotom', 'Bengali', 'selamat datang'],
    ['வணக்கம்', 'Vanakkam', 'Tamil', 'salam hormat'],
    ['ආයුබෝවන්', 'Ayubowan', 'Sinhala', 'semoga panjang umur'],
    ['ยินดีต้อนรับ', 'Yindi ton rap', 'Thai', 'selamat datang'],
    ['欢迎', 'Huānyíng', 'Mandarin', 'selamat datang'],
    ['歡迎', 'Fūnyìhng', 'Kanton', 'selamat datang'],
    ['ようこそ', 'Yōkoso', 'Jepang', 'selamat datang'],
    ['환영합니다', 'Hwanyeonghamnida', 'Korea', 'selamat datang'],
];

const GOODBYE = [
    ['Sampai jumpa', null, 'Indonesia', 'sampai jumpa'],
    ['Sugeng tindak', null, 'Jawa', 'selamat jalan'],
    ['Wilujeng angkat', null, 'Sunda', 'selamat jalan'],
    ['Goodbye', null, 'Inggris', 'selamat tinggal'],
    ['Adiós', null, 'Spanyol', 'selamat tinggal'],
    ['Au revoir', null, 'Prancis', 'sampai bertemu lagi'],
    ['Auf Wiedersehen', null, 'Jerman', 'sampai bertemu lagi'],
    ['Arrivederci', null, 'Italia', 'sampai bertemu lagi'],
    ['Adeus', null, 'Portugis', 'selamat tinggal'],
    ['Tot ziens', null, 'Belanda', 'sampai jumpa'],
    ['Hej då', null, 'Swedia', 'selamat tinggal'],
    ['Farvel', null, 'Denmark', 'selamat jalan'],
    ['Slán', null, 'Irlandia', 'selamat jalan'],
    ['Güle güle', null, 'Turki', 'pergilah dengan gembira'],
    ['Kwaheri', null, 'Swahili', 'selamat tinggal'],
    ['Aloha', null, 'Hawaii', 'salam penuh kasih'],
    ['Paalam', null, 'Tagalog', 'selamat tinggal'],
    ['Tạm biệt', null, 'Vietnam', 'selamat tinggal'],
    ['До свидания', 'Do svidaniya', 'Rusia', 'sampai bertemu lagi'],
    ['مع السلامة', 'Ma\'a as-salama', 'Arab', 'pergilah dengan selamat'],
    ['अलविदा', 'Alvida', 'Hindi', 'selamat tinggal'],
    ['ลาก่อน', 'La kon', 'Thai', 'selamat tinggal'],
    ['再见', 'Zàijiàn', 'Mandarin', 'sampai jumpa lagi'],
    ['さようなら', 'Sayōnara', 'Jepang', 'selamat tinggal'],
    ['안녕히 가세요', 'Annyeonghi gaseyo', 'Korea', 'pergilah dengan selamat'],
];

const shape = ([word, reading, language, meaning]) => ({ word, reading, language, meaning });
export const WELCOME_GREETINGS = Object.freeze(WELCOME.map(shape));
export const GOODBYE_GREETINGS = Object.freeze(GOODBYE.map(shape));

/** One greeting, picked by `random` (a function like Math.random). */
export function pickGreeting(kind = 'welcome', random = Math.random) {
    const list = kind === 'goodbye' ? GOODBYE_GREETINGS : WELCOME_GREETINGS;
    return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

/** "**Yōkoso!** (ようこそ · bahasa Jepang, artinya “selamat datang”)" */
export function greetingLine(greeting) {
    const shown = greeting.reading ?? greeting.word;
    // "Selamat datang" needs no translation into Indonesian.
    const meaning = greeting.meaning === greeting.word.toLowerCase() ? '' : `, artinya “${greeting.meaning}”`;
    const detail = [greeting.reading ? greeting.word : null, `bahasa ${greeting.language}${meaning}`].filter(Boolean).join(' · ');
    return `**${shown}!** (${detail})`;
}

/** How long somebody was a member, in words: "2 tahun 3 bulan", "5 hari", "kurang dari satu jam". Null if unknown. */
export function tenureText(joinedTimestamp, now = Date.now()) {
    if (!Number.isFinite(joinedTimestamp) || joinedTimestamp <= 0 || joinedTimestamp > now) return null;
    const minutes = Math.floor((now - joinedTimestamp) / 60000);
    const hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    if (hours < 1) return 'kurang dari satu jam';
    if (days < 1) return `${hours} jam`;
    if (days < 30) return `${days} hari`;
    const months = Math.floor(days / 30.4375);
    if (months < 12) return `${Math.max(months, 1)} bulan`;
    const years = Math.floor(months / 12), rest = months % 12;
    return `${years} tahun${rest ? ` ${rest} bulan` : ''}`;
}

/**
 * Adds the chosen extras to a finished welcome or goodbye text. `settings` is the `greeting` section.
 * The result stays inside Discord's message limit.
 */
export function decorateGreeting(content, { kind = 'welcome', settings, member, random = Math.random, now = Date.now() } = {}) {
    let text = String(content ?? '');
    if (settings?.multilingual) text = `${greetingLine(pickGreeting(kind, random))}\n${text}`;
    if (settings?.tenure && kind === 'goodbye') {
        const tenure = tenureText(member?.joinedTimestamp, now);
        if (tenure) text = `${text}\n-# Bersama kami selama ${tenure}.`;
    }
    return text.slice(0, 1900);
}
