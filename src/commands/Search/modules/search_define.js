import { createEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { handleInteractionError, replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { getJson, LookupError, LookupFailure, lookupFailureMessage, plainText, codeSpan } from '../../../services/searchLookup.js';

export const MAX_WORD_LENGTH = 100;
const MAX_MEANINGS = 5;
const MAX_DEFINITIONS = 3;
// Three definitions with examples must fit one embed field (1024 characters).
const DEFINITION_LIMIT = 220;
const EXAMPLE_LIMIT = 100;
const FIELD_LIMIT = 1024;

/** Turns the service's answer into embed fields; anything that is not shaped as expected is skipped. */
function meaningFields(entry) {
    const fields = [];
    for (const meaning of Array.isArray(entry?.meanings) ? entry.meanings : []) {
        if (fields.length === MAX_MEANINGS) break;
        const lines = [];
        for (const item of Array.isArray(meaning?.definitions) ? meaning.definitions : []) {
            if (lines.length === MAX_DEFINITIONS) break;
            const definition = plainText(item?.definition, DEFINITION_LIMIT);
            if (!definition) continue;
            const example = plainText(item?.example, EXAMPLE_LIMIT);
            lines.push(`${lines.length + 1}. ${definition}${example ? `\n*Example: ${example}*` : ''}`);
        }
        if (lines.length === 0) continue;
        fields.push({
            name: plainText(meaning?.partOfSpeech, 100) || 'Definition',
            value: lines.join('\n\n').slice(0, FIELD_LIMIT),
            inline: false,
        });
    }
    return fields;
}

export default {
    async execute(interaction) {
        const word = (interaction.options.getString('word') ?? '').trim();
        try {
            if (word.length < 2 || word.length > MAX_WORD_LENGTH || !/[\p{L}\p{N}]/u.test(word)) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.USER_INPUT,
                    message: `Please enter a word of 2 to ${MAX_WORD_LENGTH} characters.`,
                });
            }

            const deferred = await InteractionHelper.safeDefer(interaction);
            if (!deferred) {
                return;
            }

            const notFound = () => replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: `No definitions found for ${codeSpan(word)}.`,
            });

            let data;
            try {
                data = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
            } catch (error) {
                if (!(error instanceof LookupError)) throw error;
                if (error.kind === LookupFailure.NOT_FOUND) return await notFound();
                logger.warn('Dictionary lookup failed', {
                    kind: error.kind,
                    status: error.status,
                    reason: error.reason,
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    commandName: 'define'
                });
                return await replyUserError(interaction, {
                    type: error.kind === LookupFailure.RATE_LIMITED ? ErrorTypes.RATE_LIMIT : ErrorTypes.NETWORK,
                    message: lookupFailureMessage(error, 'The dictionary service'),
                });
            }

            if (!Array.isArray(data)) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.NETWORK,
                    message: lookupFailureMessage(null, 'The dictionary service'),
                });
            }

            const entry = data.find((candidate) => candidate && typeof candidate === 'object');
            const fields = meaningFields(entry);
            if (fields.length === 0) {
                return await notFound();
            }

            const phonetic = plainText(entry.phonetic, 100);
            const embed = createEmbed({
                title: plainText(entry.word, 250) || plainText(word, 250),
                description: phonetic ? `*${phonetic}*` : '',
                color: 'success'
            });
            embed.addFields(fields);
            embed.setFooter({ text: 'Powered by Free Dictionary API' });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });

            logger.info('Dictionary definition retrieved', {
                userId: interaction.user.id,
                word: word,
                guildId: interaction.guildId,
                commandName: 'define'
            });

        } catch (error) {
            logger.error('Dictionary lookup error', {
                error: error.message,
                stack: error.stack,
                userId: interaction.user.id,
                word: word,
                guildId: interaction.guildId,
                commandName: 'define'
            });

            await handleInteractionError(interaction, error, {
                commandName: 'define',
                source: 'dictionary_api'
            });
        }
    },
};
