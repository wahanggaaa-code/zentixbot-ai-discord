import { getColor } from '../../../config/bot.js';
import { createEmbed } from '../../../utils/embeds.js';
import { getCounterEmoji } from '../../../services/serverstatsService.js';
import { inspectCounters, pruneMissingCounters } from '../../../services/serverStats/manage.js';
import { logger } from '../../../utils/logger.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { begin, replyCounterError, typeDisplay } from './shared.js';

const FOOTER = 'Counter System • Names follow the member count; Discord limits how often a channel can be renamed';

/** What the list says about one counter. */
function statusOf(counter) {
    if (!counter.known) return 'Unknown type (not updated)';
    if (!counter.channel) return 'Channel not visible to me';
    if (counter.enabled === false) return 'Disabled';
    if (counter.botCanManage === false) return 'I cannot rename this channel (need View Channel and Manage Channels)';
    if (counter.count === null) return 'Member list could not be read';
    if (counter.current) return 'Up to date';
    if (counter.nextRenameAt) return `Rename waiting for Discord's limit, <t:${Math.ceil(counter.nextRenameAt / 1000)}:R>`;
    return 'Will be renamed at the next refresh';
}

export async function handleList(interaction, client) {
    const guild = interaction.guild;

    if (!await begin(interaction, 'view')) return;

    try {
        // Records of channels that Discord reports as deleted are removed first, as before.
        await pruneMissingCounters(client, guild);
        const { counters, rejected } = await inspectCounters(client, guild);

        if (counters.length === 0) {
            const embed = createEmbed({
                title: 'Server Counters',
                description: 'No counters have been set up for this server yet.\n\nUse `/serverstats create` to set up your first counter!',
                color: getColor('warning'),
            });
            embed.addFields({
                name: '**Available Counter Types**',
                value: '**Members + Bots** - Total server members\n**Members Only** - Human members only\n**Bots Only** - Bot members only',
                inline: false,
            });
            embed.addFields({
                name: '**Usage Examples**',
                value: '`/serverstats create type:members channel_type:voice category:Stats`\n`/serverstats create type:bots channel_type:text category:Server Info`\n`/serverstats list`',
                inline: false,
            });
            embed.setFooter({ text: FOOTER });
            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] }).catch(logger.error);
            return;
        }

        const embed = createEmbed({
            title: `Server Counters (${counters.length})`,
            description: 'The counters of this server and what their channels show right now.',
            color: getColor('info'),
        });

        counters.forEach((counter, index) => {
            const created = Date.parse(counter.createdAt);
            embed.addFields({
                name: `${getCounterEmoji(counter.type)} Counter #${index + 1} - ${counter.channel?.name ?? 'channel not visible'}`,
                value: [
                    `**ID:** \`${counter.id}\``,
                    `**Type:** ${typeDisplay(counter.type)}`,
                    `**Channel:** ${counter.channel ?? `\`${counter.channelId}\``}`,
                    `**Current Count:** ${counter.count ?? 'unknown'}`,
                    `**Status:** ${statusOf(counter)}`,
                    `**Created:** ${Number.isFinite(created) && created > 0 ? `<t:${Math.floor(created / 1000)}:R>` : 'unknown'}`,
                ].join('\n'),
                inline: false,
            });
        });

        embed.addFields({
            name: '**Statistics**',
            value: [
                `**Total Counters:** ${counters.length}`,
                `**Up to date:** ${counters.filter((counter) => counter.current).length}`,
                ...(rejected > 0 ? [`**Unreadable stored entries:** ${rejected}`] : []),
            ].join('\n'),
            inline: false,
        });
        embed.addFields({
            name: '**Management Commands**',
            value: '`/serverstats create` - Create new counter\n`/serverstats update` - Update existing counter\n`/serverstats delete` - Delete counter',
            inline: false,
        });
        embed.setFooter({ text: FOOTER });
        embed.setTimestamp();

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] }).catch(logger.error);
    } catch (error) {
        await replyCounterError(interaction, error, 'The counters could not be read. Nothing was changed.');
    }
}
