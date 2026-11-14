// FAQ matching and the reply cache: two ways of answering without an AI request.
// Everything here is plain text work on the bot's own machine; nothing is sent to a provider.

const STOPWORDS = new Set(('yang di ke dari itu ini dan atau untuk dengan pada adalah ada apa apakah bagaimana gimana kapan siapa kenapa mengapa berapa mana dimana kah sih dong ya yah nih deh kok tuh aja saja juga bisa boleh mau ingin saya aku gue gw kamu lo lu kita kami mereka dia nya the a an is are was were of to in on for and or how what when where who why can could do does i you we they it my your please tolong min admin kak bang mas mbak gan bro sis').split(' '));
const QUESTION_WORD = /(^|\s)(apa|apakah|bagaimana|gimana|gmn|kapan|siapa|kenapa|mengapa|berapa|mana|dimana|bisakah|bolehkah|caranya|cara|how|what|when|where|who|why|which|can|is|are|does|do)(\s|$)/;

const fold = (text) => String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** The meaningful words of a sentence: lower case, without accents, punctuation, fillers and common endings. */
export function faqTokens(text) {
    const words = fold(text).replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
    const out = new Set();
    for (const word of words) {
        if (STOPWORDS.has(word)) continue;
        const stem = word.length > 5 ? word.replace(/(nya|kah|lah)$/, '') : word;
        if (stem.length >= 2 && !STOPWORDS.has(stem)) out.add(stem);
    }
    return [...out];
}

/** True for a sentence that asks something: a question mark, or a question word. */
export function looksLikeQuestion(text) {
    const folded = fold(text).replace(/[^\p{L}\p{N}?]+/gu, ' ').trim();
    return folded.includes('?') || QUESTION_WORD.test(folded);
}

/**
 * The FAQ entry that answers `text`, or null. `strict` is for messages that were not addressed to the bot:
 * there a wrong answer is an interruption, so more of the entry's words must be present.
 * The score is the share of the entry's words found in the message.
 */
export function matchFaq(text, entries, { strict = false } = {}) {
    const asked = new Set(faqTokens(text));
    if (asked.size === 0 || !Array.isArray(entries)) return null;
    let best = null;
    for (const entry of entries) {
        const words = faqTokens(entry.question);
        if (words.length === 0) continue;
        const hits = words.filter((word) => asked.has(word)).length;
        const score = hits / words.length;
        // One shared word proves little unless the entry is a single word; a long message about something
        // else that happens to contain the words is not this question either.
        if (hits < Math.min(2, words.length)) continue;
        if (asked.size > words.length * 3 + 3) continue;
        if (score < (strict ? 0.8 : 0.6)) continue;
        if (!best || score > best.score) best = { entry, score };
    }
    return best ? { id: best.entry.id, question: best.entry.question, answer: best.entry.answer, score: best.score } : null;
}

/** A question as a cache key: case, spacing and punctuation do not make it a different question. */
export function cacheKey(text) {
    return fold(text).replace(/<@!?\d+>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Answers remembered in the process only. A restart empties it. */
export function createReplyCache({ now = Date.now, max = 300 } = {}) {
    const rows = new Map();
    return {
        /** The answer given to the same question at most `minutes` ago, or null. */
        get(scope, text, minutes) {
            const key = cacheKey(text);
            if (key.length < 6) return null;
            const row = rows.get(`${scope}|${key}`);
            if (!row) return null;
            if (now() - row.at > minutes * 60000) { rows.delete(`${scope}|${key}`); return null; }
            return row.text;
        },
        set(scope, text, answer) {
            const key = cacheKey(text);
            if (key.length < 6 || typeof answer !== 'string' || !answer) return false;
            if (rows.size >= max) rows.delete(rows.keys().next().value);
            rows.delete(`${scope}|${key}`);
            rows.set(`${scope}|${key}`, { text: answer, at: now() });
            return true;
        },
        clear() { rows.clear(); },
        get size() { return rows.size; },
    };
}
