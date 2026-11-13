import { createEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { handleInteractionError, replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { getJson, LookupError, LookupFailure, lookupFailureMessage, plainText, codeSpan, encodeQuery } from '../../../services/searchLookup.js';

export const MAX_TERM_LENGTH = 100;
const DEFINITION_LIMIT = 2000;
const EXAMPLE_LIMIT = 500;
const numbers = new Intl.NumberFormat('en-US');

/** Urban Dictionary is written by its users and is often explicit; it is only shown where Discord age-gates the channel. */
export function isAgeRestricted(channel) {
    return channel?.nsfw === true || channel?.parent?.nsfw === true;
}

/** Urban Dictionary marks cross-references as [term]; the brackets are dropped. */
const unbracket = (value) => (typeof value === 'string' ? value.replace(/\[|\]/g, '') : '');

/** The entry's own page, and only that: an https link on urbandictionary.com. */
function permalinkOf(entry) {
    try {
        const url = new URL(entry.permalink);
        const host = url.hostname.toLowerCase();
        if (url.protocol === 'https:' && (host === 'urbandictionary.com' || host.endsWith('.urbandictionary.com'))) return url.href;
    } catch { /* not a URL */ }
    return null;
}

const usable = (entry) => entry && typeof entry === 'object'
    && typeof entry.word === 'string' && entry.word.trim()
    && unbracket(entry.definition).trim();

export default {
    async execute(interaction) {
        const term = (interaction.options.getString('term') ?? '').trim();
        try {
            if (!isAgeRestricted(interaction.channel)) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.PERMISSION,
                    message: 'Urban Dictionary often contains adult content, so this command only works in an age-restricted channel.',
                });
            }

            if (term.length < 2 || term.length > MAX_TERM_LENGTH) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.USER_INPUT,
                    message: `Please enter a term of 2 to ${MAX_TERM_LENGTH} characters.`,
                });
            }

            const deferred = await InteractionHelper.safeDefer(interaction);
            if (!deferred) {
                return;
            }

            const notFound = () => replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: `No definitions found for ${codeSpan(term)} on Urban Dictionary.`,
            });

            let data;
            try {
                data = await getJson(`https://api.urbandictionary.com/v0/define?term=${encodeQuery(term)}`);
            } catch (error) {
                if (!(error instanceof LookupError)) throw error;
                if (error.kind === LookupFailure.NOT_FOUND) return await notFound();
                logger.warn('Urban Dictionary lookup failed', {
                    kind: error.kind,
                    status: error.status,
                    reason: error.reason,
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    commandName: 'urban'
                });
                return await replyUserError(interaction, {
                    type: error.kind === LookupFailure.RATE_LIMITED ? ErrorTypes.RATE_LIMIT : ErrorTypes.NETWORK,
                    message: lookupFailureMessage(error, 'Urban Dictionary'),
                });
            }

            if (!Array.isArray(data.list)) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.NETWORK,
                    message: lookupFailureMessage(null, 'Urban Dictionary'),
                });
            }

            const entry = data.list.find(usable);
            if (!entry) {
                return await notFound();
            }

            const definition = plainText(unbracket(entry.definition).replace(/\n\s*\n/g, '\n\n'), DEFINITION_LIMIT);
            const example = plainText(unbracket(entry.example).replace(/\s*\n\s*/g, ' '), EXAMPLE_LIMIT);

            const fields = [{
                name: 'Example',
                value: example ? `*"${example}"*` : '*No example provided*',
                inline: false
            }];
            if (Number.isFinite(entry.thumbs_up) && Number.isFinite(entry.thumbs_down)) {
                fields.push({
                    name: 'Votes',
                    value: `${numbers.format(entry.thumbs_up)} up • ${numbers.format(entry.thumbs_down)} down`,
                    inline: true
                });
            }
            fields.push({
                name: 'Author',
                value: plainText(entry.author, 100) || 'Anonymous',
                inline: true
            });

            const embed = createEmbed({
                title: plainText(entry.word, 250),
                description: definition,
                color: 'info'
            })
            .addFields(fields)
            .setFooter({
                text: 'Urban Dictionary',
                iconURL: 'https://i.imgur.com/8aQrX3a.png'
            });

            const permalink = permalinkOf(entry);
            if (permalink) embed.setURL(permalink);

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });

            logger.info('Urban Dictionary definition retrieved', {
                userId: interaction.user.id,
                term: term,
                guildId: interaction.guildId,
                commandName: 'urban'
            });

        } catch (error) {
            logger.error('Urban Dictionary error', {
                error: error.message,
                stack: error.stack,
                userId: interaction.user.id,
                term: term,
                guildId: interaction.guildId,
                commandName: 'urban'
            });

            await handleInteractionError(interaction, error, {
                commandName: 'urban',
                source: 'urban_dictionary_api'
            });
        }
    },
};
