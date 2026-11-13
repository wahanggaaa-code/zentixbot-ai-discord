import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

/** The time zone as the runtime names it (`asia/jakarta` becomes `Asia/Jakarta`); null when it knows none by that name. */
export function resolveTimeZone(input) {
    const text = String(input ?? '').trim();
    if (!text) return null;
    try {
        return new Intl.DateTimeFormat('en-US', { timeZone: text }).resolvedOptions().timeZone;
    } catch {
        return null;
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName('time')
        .setDescription('Get the current time in a timezone')
        .addStringOption((option) =>
            option.setName('timezone')
                .setDescription('An IANA timezone, e.g. UTC, Asia/Jakarta, America/New_York (default: UTC)')
                .setMaxLength(64)
                .setRequired(false)),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) {
            logger.warn('Time interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId, commandName: 'time' });
            return;
        }

        const timeZone = resolveTimeZone(interaction.options.getString('timezone') || 'UTC');
        if (!timeZone) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'I do not know that timezone. Use an IANA name such as `UTC`, `Asia/Jakarta`, `Europe/London` or `America/New_York`. Abbreviations such as WIB or PST are not timezone names.',
            });
        }

        const now = new Date();
        const local = now.toLocaleString('en-US', {
            timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
        });
        const unix = Math.floor(now.getTime() / 1000);
        const embed = createEmbed({
            title: 'Current Time',
            description: `**${timeZone}:** ${local}\n**Your own time:** <t:${unix}:F>\n**Unix Timestamp:** \`${unix}\`\n**ISO String:** \`${now.toISOString()}\``,
            color: 'success',
        });
        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    },
};
