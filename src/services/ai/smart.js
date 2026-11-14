// The runtime behind the "Fitur pintar" room of AI Studio. One per bot.
//
//   faq        answers kept by the owner, given without an AI request
//   cache      the same question again soon → the earlier answer, without an AI request
//   usage      the AI usage report
//   menu       message menu: translate, explain, fact check, recap
//   digest     news and a fact every morning
//   greeting   a greeting word in another language on AI Welcome / Goodbye, and time spent in the server
//   translate  automatic translation in chosen channels
//
// Every part has its own switch on the dashboard and is off until the owner turns it on.
import { PermissionFlagsBits } from 'discord.js';
import { createKV } from './kv.js';
import { createSmartStore, defaultSmart, validateSmartSection } from './smartSettings.js';
import { createReplyCache, looksLikeQuestion, matchFaq } from './faq.js';
import { createUsage } from './usage.js';
import { createRecap } from './recap.js';
import { createMenus } from './menus.js';
import { createDigest } from './digest.js';
import { createAutoTranslate } from './autoTranslate.js';
import { decorateGreeting } from './greetings.js';
import { logger as defaultLogger } from '../../utils/logger.js';

const SETTINGS_TTL_MS = 15000;
const FAQ_REPEAT_MS = 2 * 60000;   // the same entry is not repeated in a channel more often than this

export function createSmart({
    client,
    kv = createKV(client),
    store = createSmartStore(client, kv),
    foundation = () => client.aiFoundation,
    searchService = () => client.aiSearchService,
    interactiveSettings = async () => client.aiInteractive?.settings?.() ?? null,
    now = () => Date.now(),
    random = Math.random,
    logger = defaultLogger,
} = {}) {
    let cached = { at: -Infinity, value: null };
    let warnedAt = -Infinity;
    const faqSaid = new Map(); // channelId|entryId -> timestamp

    /** Current settings. On a storage failure everything counts as off, unless `strict` asks for the error. */
    async function settings({ strict = false } = {}) {
        if (cached.value && now() - cached.at < SETTINGS_TTL_MS) return cached.value;
        try {
            cached = { at: now(), value: await store.read(client.homeGuildId) };
            return cached.value;
        } catch (error) {
            if (strict) throw error;
            if (now() - warnedAt >= 10 * 60000) { warnedAt = now(); logger.warn(`AI smart features: settings could not be read (${error.message})`); }
            return defaultSmart();
        }
    }

    /** Checks and saves one section; the next message already sees it. Resolves to all settings. */
    async function saveSection(section, value, guild) {
        validateSmartSection(section, value, guild);
        const saved = await store.saveSection(client.homeGuildId, section, value);
        cached = { at: now(), value: saved };
        return saved;
    }

    const usage = createUsage({ kv, now, enabled: async () => (await settings()).usage.enabled });
    const replyCache = createReplyCache({ now });
    const recap = createRecap({ client, foundation, now });
    const menus = createMenus({ client, settings, recap, interactiveSettings, foundation, searchService });
    const digest = createDigest({ client, settings, kv, foundation, searchService, now, logger });
    const translate = createAutoTranslate({ client, settings, foundation, now, logger });

    /** The FAQ entry that answers `text`, or null (also when the FAQ is off). */
    async function faqFor(text, options) {
        const cfg = (await settings()).faq;
        return cfg.enabled ? matchFaq(text, cfg.entries, options) : null;
    }

    /** True when the FAQ would answer this message by itself (auto-answer channel, a question, a clear match). */
    async function faqWouldAnswer(message) {
        const cfg = (await settings()).faq;
        if (!cfg.enabled || !cfg.autoAnswer || !cfg.channelIds.includes(message.channel?.id)) return null;
        const text = String(message.content ?? '');
        if (!looksLikeQuestion(text)) return null;
        return matchFaq(text, cfg.entries, { strict: true });
    }

    async function answerFaq(message) {
        const match = await faqWouldAnswer(message);
        if (!match) return false;
        // A reply to another member, or a message that mentions somebody, is their conversation.
        const botId = client.user.id;
        if ((message.mentions?.repliedUser && message.mentions.repliedUser.id !== botId) || [...(message.mentions?.users?.keys?.() ?? [])].some((id) => id !== botId)) return false;
        const key = `${message.channel.id}|${match.id}`;
        if (now() - (faqSaid.get(key) ?? -Infinity) < FAQ_REPEAT_MS) return false;
        const me = message.guild.members?.me;
        const perms = me ? message.channel.permissionsFor?.(me) : null;
        if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return false;
        const payload = { content: match.answer.slice(0, 1900), allowedMentions: { parse: [], repliedUser: false } };
        if (perms.has(PermissionFlagsBits.ReadMessageHistory)) await message.reply({ ...payload, failIfNotExists: false });
        else await message.channel.send(payload);
        if (faqSaid.size > 500) faqSaid.clear();
        faqSaid.set(key, now());
        usage.saved({ guildId: message.guild.id, how: 'faq' });
        return true;
    }

    /**
     * For messages the interactive AI left alone: the FAQ answers by itself, or the message is translated.
     * Resolves to 'faq', 'translate' or null. Never throws.
     */
    async function handleMessage(message) {
        try {
            if (!message?.guild || message.guild.id !== client.homeGuildId || !client.user) return null;
            if (!message.author || message.author.bot || message.system || message.webhookId) return null;
            if (await answerFaq(message)) return 'faq';
            if (await translate.handleMessage(message)) return 'translate';
            return null;
        } catch (error) {
            if (now() - warnedAt >= 10 * 60000) { warnedAt = now(); logger.warn(`AI smart features: message skipped (${error?.status ? error.message : 'unexpected error'})`); }
            return null;
        }
    }

    return {
        store, settings, saveSection, usage, recap, menus, digest,
        faqFor, faqWouldAnswer, handleMessage,
        /** Reply cache for the interactive AI: null when the cache is off or has nothing. */
        async cachedReply(text) {
            const cfg = (await settings()).cache;
            return cfg.enabled ? replyCache.get(client.homeGuildId, text, cfg.minutes) : null;
        },
        async rememberReply(text, answer) {
            return (await settings()).cache.enabled ? replyCache.set(client.homeGuildId, text, answer) : false;
        },
        /** A finished AI Welcome / Goodbye text with the extras that are switched on. */
        async decorateGreeting(content, member, kind) {
            const cfg = (await settings()).greeting;
            return decorateGreeting(content, { kind, settings: cfg, member, random, now: now() });
        },
    };
}
