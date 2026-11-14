// Things a member can ask for when calling the interactive AI, each with its own switch:
//   "@bot rangkum https://…"            → summary of a public web page
//   "@bot cari berita gempa hari ini"   → web search, summarised with its sources
//   "@bot rangkum obrolan tadi"         → summary of the last messages of the channel
// This file only recognises the request; interactive.js carries it out.
import { recapCount } from './recap.js';

const URL = /https:\/\/[^\s<>()]+/i;
const SUMMARY_WORD = /(^|[^\p{L}])(rangkum\p{L}*|ringkas\p{L}*|intisari|inti(nya)?|summar\p{L}+|tl;?dr|rekap\p{L}*|recap)(?=$|[^\p{L}])/iu;
const CHAT_WORD = /(^|[^\p{L}])(obrolan|chat|chatnya|percakapan|diskusi|pesan|tadi|barusan|ketinggalan|tertinggal|kelewat|terlewat|channel|disini|di sini)(?=$|[^\p{L}])/iu;
const MISSED = /(^|[^\p{L}])(ketinggalan|tertinggal|kelewat|terlewat)(?=$|[^\p{L}])|(^|[^\p{L}])(ada|bahas|ngomongin|ngobrolin) apa (tadi|aja|saja|barusan)(?=$|[^\p{L}])/iu;
const SEARCH = /^(?:tolong |coba |bisa |please )?(?:cari(?:kan|in)?|search(?: for)?|googling|berita)\s+(?:berita |info |informasi |kabar )?(?:tentang |soal |mengenai |about )?(.{3,200})$/iu;

/** The first https link of a text, without trailing punctuation, or null. */
export function firstLink(text) {
    const found = URL.exec(String(text ?? ''));
    return found ? found[0].replace(/[.,!?;:'"]+$/, '') : null;
}

/**
 * What the member asked for, or null for ordinary conversation.
 * `text` is the message without the bot's mention; `cfg` holds the three switches.
 * `repliesToOther` is true when the message is a reply to somebody else's message (which may hold the link).
 */
export function detectTool(text, cfg, { repliesToOther = false } = {}) {
    const said = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!said) return null;
    const link = firstLink(said);
    const wantsSummary = SUMMARY_WORD.test(said);
    if (cfg.linkSummaryEnabled && wantsSummary && link) return { tool: 'link', url: link };
    if (cfg.recapEnabled && !link && ((wantsSummary && CHAT_WORD.test(said)) || MISSED.test(said))) return { tool: 'recap', count: recapCount(said) };
    // "rangkum ini" as a reply to a message: the link is looked for in that message.
    if (cfg.linkSummaryEnabled && wantsSummary && !link && repliesToOther) return { tool: 'link', url: null };
    if (cfg.newsSearchEnabled && !link) {
        const found = SEARCH.exec(said);
        if (found) return { tool: 'search', query: found[1].replace(/[?!.]+$/, '').trim() };
    }
    return null;
}
