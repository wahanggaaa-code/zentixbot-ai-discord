import { createEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { codeSpan, encodeQuery } from '../../../services/searchLookup.js';

export const MAX_QUERY_LENGTH = 200;

export default {
    async execute(interaction) {
        const query = (interaction.options.getString('query') ?? '').trim();

        if (!query || query.length > MAX_QUERY_LENGTH) {
            return await replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: `Please enter a search of 1 to ${MAX_QUERY_LENGTH} characters.`,
            });
        }

        // The bot does not search anything; it only builds the link. The link text is fixed and the
        // query is shown in a code span, so what a member types can never become the text of a link.
        const searchUrl = `https://www.google.com/search?q=${encodeQuery(query)}`;

        const embed = createEmbed({
            title: 'Google Search',
            description: `Search: ${codeSpan(query, MAX_QUERY_LENGTH)}\n[Open this search on Google](${searchUrl})`,
            color: 'info'
        })
        .setFooter({ text: 'Google Search Results' });

        await InteractionHelper.safeReply(interaction, { embeds: [embed] });

        logger.info('Google search link generated', {
            userId: interaction.user.id,
            query: query,
            guildId: interaction.guildId,
            commandName: 'google'
        });
    },
};
