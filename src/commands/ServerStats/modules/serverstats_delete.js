import { getColor } from '../../../config/bot.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import { deleteCounter } from '../../../services/serverStats/manage.js';
import { readCounters } from '../../../services/serverStats/store.js';
import { logger } from '../../../utils/logger.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { begin, replyCounterError, typeDisplay } from './shared.js';

export async function handleDelete(interaction, client) {
    const guild = interaction.guild;
    const counterId = interaction.options.getString('counter-id');

    if (!await begin(interaction, 'delete')) return;

    try {
        const { counters } = await readCounters(client, guild.id);
        const counter = counters.find((entry) => entry.id === counterId);
        if (!counter) throw Object.assign(new Error('Counter not found'), { code: 'SERVERSTATS_MISSING' });

        const channel = guild.channels.cache.get(counter.channelId);
        const embed = createEmbed({
            title: 'Delete Counter & Channel',
            description: [
                'Are you sure you want to delete this counter and its channel?',
                '',
                `**ID:** \`${counter.id}\``,
                `**Type:** ${typeDisplay(counter.type)}`,
                `**Channel:** ${channel || 'Already deleted'}`,
                '',
                'The channel is deleted from Discord. This cannot be undone.',
            ].join('\n'),
            color: getColor('error'),
        });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`counter-delete:confirm:${counter.id}:${interaction.user.id}`)
                .setLabel('Confirm Delete')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`counter-delete:cancel:${counter.id}:${interaction.user.id}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary),
        );

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components: [row] }).catch(logger.error);
    } catch (error) {
        await replyCounterError(interaction, error, 'The counters could not be read. Nothing was changed.');
    }
}

/** Delete a counter and describe the outcome. Throws the coded errors of `deleteCounter`. */
export async function performDeletionByCounterId(client, guild, counterId, actor = 'unknown') {
    const { counter, channelName, channelDeleted, channelKept } = await deleteCounter(client, guild, counterId, { actor });
    let channelLine = '**Channel:** Already deleted';
    if (channelDeleted) channelLine = `**Channel:** ${channelName} (deleted)`;
    else if (channelKept) channelLine = `**Channel:** ${channelName} (kept: it is not a voice or text channel)`;
    return {
        message: `✅ **Counter Deleted Successfully!**\n\n**ID:** \`${counter.id}\`\n**Type:** ${typeDisplay(counter.type)}\n${channelLine}`,
    };
}
