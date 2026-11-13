import { successEmbed } from '../../../utils/embeds.js';
import { changeCounterType } from '../../../services/serverStats/manage.js';
import { logger } from '../../../utils/logger.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { begin, describeRefresh, replyCounterError, typeDisplay } from './shared.js';

export async function handleUpdate(interaction, client) {
    const guild = interaction.guild;
    const counterId = interaction.options.getString('counter-id');
    const newType = interaction.options.getString('type');

    if (!await begin(interaction, 'update')) return;

    if (!newType) {
        await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'You must provide a new counter type to update.' }).catch(logger.error);
        return;
    }

    try {
        const { counter, changed, previousType, refresh } = await changeCounterType(client, guild, counterId, newType);
        const channel = guild.channels.cache.get(counter.channelId);
        const lines = [
            changed ? '**Counter Updated Successfully!**' : '**Nothing to change:** the counter already has that type.',
            '',
            `**Counter ID:** \`${counter.id}\``,
            changed ? `**Type Changed:** ${typeDisplay(previousType)} → ${typeDisplay(newType)}` : `**Type:** ${typeDisplay(newType)}`,
            `**Channel:** ${channel ?? 'not visible to me'}`,
            '',
            describeRefresh(refresh),
        ];
        await InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(lines.join('\n'))] }).catch(logger.error);
    } catch (error) {
        const where = error?.code === 'SERVERSTATS_DUPLICATE' && guild.channels.cache.get(error.channelId)
            ? ` It is in ${guild.channels.cache.get(error.channelId)}.` : '';
        await replyCounterError(interaction, error, 'The counter could not be updated. Nothing was changed.', where);
    }
}
