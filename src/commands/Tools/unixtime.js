import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName('unixtime')
        .setDescription('Get the current Unix timestamp'),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) {
            logger.warn('Unixtime interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId, commandName: 'unixtime' });
            return;
        }

        const now = new Date();
        const unix = Math.floor(now.getTime() / 1000);
        const embed = createEmbed({
            title: 'Current Unix Timestamp',
            description: `**Seconds since Unix Epoch:** \`${unix}\`\n**Milliseconds since Unix Epoch:** \`${now.getTime()}\`\n\n**Human-readable (UTC):** ${now.toUTCString()}\n**Your own time:** <t:${unix}:F>\n**ISO String:** \`${now.toISOString()}\`\n**As a Discord timestamp:** \`<t:${unix}:F>\``,
            color: 'success',
        });
        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    },
};
