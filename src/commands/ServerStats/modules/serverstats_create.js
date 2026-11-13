import { ChannelType } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { getCounterTypeLabel } from '../../../services/serverstatsService.js';
import { createCounter } from '../../../services/serverStats/manage.js';
import { logger } from '../../../utils/logger.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { begin, replyCounterError } from './shared.js';

export async function handleCreate(interaction, client) {
    const guild = interaction.guild;
    const type = interaction.options.getString('type');
    const channelType = interaction.options.getString('channel_type');
    const category = interaction.options.getChannel('category');

    if (!await begin(interaction, 'create')) return;

    try {
        const { counter, channel, count } = await createCounter(client, guild, {
            type,
            channelType,
            categoryId: category?.id,
            actor: interaction.user.tag,
        });

        const lines = [
            '**Counter Created Successfully!**',
            '',
            `**Type:** ${getCounterTypeLabel(type)}`,
            `**Channel Type:** ${channel.type === ChannelType.GuildVoice ? 'voice' : 'text'}`,
            `**Category:** ${category}`,
            `**Channel:** ${channel}`,
            `**Counter ID:** \`${counter.id}\``,
            '',
            count === null
                ? 'The member list could not be read yet; the count will be added to the channel name at the next refresh.'
                : 'The name follows the member count. Discord limits how often a channel can be renamed, so a change can take a few minutes to show.',
            'The channel uses the permissions of its category: lock the category if members should not join or write there.',
        ];
        await InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(lines.join('\n'))] }).catch(logger.error);
    } catch (error) {
        const where = error?.code === 'SERVERSTATS_DUPLICATE' && guild.channels.cache.get(error.channelId)
            ? ` It is in ${guild.channels.cache.get(error.channelId)}.` : '';
        const left = error?.code === 'SERVERSTATS_CHANNEL_LEFT' ? ` Channel: <#${error.channelId}>.` : '';
        await replyCounterError(interaction, error, 'The counter could not be created. Nothing was changed.', where + left);
    }
}
