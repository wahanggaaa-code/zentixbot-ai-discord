import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { LookupError, codeSpan, getText, lookupFailureMessage } from '../../services/searchLookup.js';

const SHORTENER_URL = 'https://is.gd/create.php';
const SERVICE = 'The URL shortener (is.gd)';
export const URL_LIMIT = 2000;
// is.gd accepts custom endings of 5 to 30 letters, digits and underscores.
const CUSTOM_ENDING = /^[A-Za-z0-9_]{5,30}$/;
// The only thing accepted as a result: one is.gd link, nothing before or after it.
const SHORT_LINK = /^https:\/\/is\.gd\/[A-Za-z0-9_-]{1,40}$/;

/** A web address a member may shorten: http or https, with a host, no credentials. Returns the URL or null. */
export function shortenableUrl(input) {
    if (typeof input !== 'string' || input.length > URL_LIMIT) return null;
    let url;
    try {
        url = new URL(input.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password) return null;
    return url;
}

/** What is.gd's one-line answer means: `{ link }`, or `{ refusal }` with the sentence for the member. */
export function readShortenerAnswer(text) {
    const answer = String(text ?? '').trim();
    if (SHORT_LINK.test(answer)) return { link: answer };
    if (/already exists|already taken|not available/i.test(answer)) return { refusal: 'That custom ending is already taken. Try a different one.' };
    if (/^Error:/i.test(answer)) return { refusal: `The shortener refused this address: ${codeSpan(answer.replace(/^Error:\s*/i, ''), 200)}` };
    return { refusal: null };
}

export default {
    data: new SlashCommandBuilder()
        .setName('shorten')
        .setDescription('Shorten a URL using is.gd')
        .addStringOption((option) =>
            option
                .setName('url')
                .setDescription('The URL to shorten, starting with http:// or https://')
                .setMaxLength(URL_LIMIT)
                .setRequired(true),
        )
        .addStringOption((option) =>
            option
                .setName('custom')
                .setDescription('Custom ending: 5 to 30 letters, digits or underscores (optional)')
                .setMinLength(5)
                .setMaxLength(30)
                .setRequired(false),
        )
        .setDMPermission(false),
    category: 'Tools',

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) {
            logger.warn('Shorten interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId, commandName: 'shorten' });
            return;
        }
        const refuse = (message, type = ErrorTypes.VALIDATION) => replyUserError(interaction, { type, message });

        const url = shortenableUrl(interaction.options.getString('url'));
        if (!url) return refuse(`Please give a web address that starts with http:// or https://, at most ${URL_LIMIT} characters.`);
        const custom = interaction.options.getString('custom');
        if (custom && !CUSTOM_ENDING.test(custom)) return refuse('A custom ending has 5 to 30 characters: letters, digits and underscores only.');

        let answer;
        try {
            const query = `format=simple&url=${encodeURIComponent(url.href)}${custom ? `&shorturl=${encodeURIComponent(custom)}` : ''}`;
            answer = await getText(`${SHORTENER_URL}?${query}`);
        } catch (error) {
            if (!(error instanceof LookupError)) throw error;
            logger.warn(`URL shortener request failed: ${error.message}`, { userId: interaction.user.id, guildId: interaction.guildId, reason: error.reason });
            return refuse(lookupFailureMessage(error, SERVICE), ErrorTypes.NETWORK);
        }

        const { link, refusal } = readShortenerAnswer(answer.text);
        if (!link) {
            logger.warn('URL shortener gave no link', { userId: interaction.user.id, guildId: interaction.guildId, status: answer.status });
            return refuse(refusal ?? lookupFailureMessage(null, SERVICE), refusal ? ErrorTypes.VALIDATION : ErrorTypes.NETWORK);
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({ title: 'URL Shortened', description: `Short link: ${link}\nPoints to: ${codeSpan(url.href, 300)}`, color: 'success' })],
        });
    },
};
