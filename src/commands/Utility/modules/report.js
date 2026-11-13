import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createEmbed } from '../../../utils/embeds.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { logEvent, EVENT_TYPES, resolveLogChannel } from '../../../services/loggingService.js';
import { formatLogLine, resolveUserAuthor } from '../../../utils/logging/logEmbeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { checkRateLimit } from '../../../utils/rateLimiter.js';
import { plainText } from '../../../services/searchLookup.js';
import { logger } from '../../../utils/logger.js';

/** Reports one member may file in one server per window. Every report notifies the owner. */
export const REPORT_LIMIT = 5;
export const REPORT_WINDOW_MS = 10 * 60 * 1000;

/** The permissions the bot needs in a channel to post reports there. */
export const REPORT_CHANNEL_PERMISSIONS = [
    [PermissionFlagsBits.ViewChannel, 'View Channel'],
    [PermissionFlagsBits.SendMessages, 'Send Messages'],
    [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
];

const NOT_DELIVERED = 'Your report could not be delivered, so the moderation team has **not** received it. Please contact a moderator directly.';

export default {
    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) {
            logger.warn('Report interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId });
            return;
        }

        const targetUser = interaction.options.getUser('user');
        const reason = String(interaction.options.getString('reason') ?? '').trim();
        const guildId = interaction.guildId;

        if (!targetUser || !interaction.guild) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Choose the user you want to report, in a server.' });
        }
        if (targetUser.id === interaction.user.id) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'You cannot report yourself.' });
        }
        if (reason.length === 0) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Please give a reason for the report.' });
        }

        const guildConfig = await getGuildConfig(client, guildId);
        const reportChannelId = resolveLogChannel(guildConfig, 'reports');

        if (!reportChannelId) {
            return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: 'The report channel has not been set up. Ask a moderator to use `/report setchannel` or `/logging dashboard`.' });
        }

        if (!(await checkRateLimit(`report:${guildId}:${interaction.user.id}`, REPORT_LIMIT, REPORT_WINDOW_MS))) {
            return await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: `You can file ${REPORT_LIMIT} reports in 10 minutes. This report was **not** sent. Please try again later or contact a moderator directly.` });
        }

        const ownerId = interaction.guild.ownerId;
        const sent = await logEvent({
            client,
            guildId,
            eventType: EVENT_TYPES.REPORT_FILE,
            content: ownerId ? `<@${ownerId}> New report!` : 'New report!',
            data: {
                title: 'User Report',
                lines: [
                    formatLogLine('Reported User', `${plainText(targetUser.tag, 80)} (\`${targetUser.id}\`)`),
                    formatLogLine('Reported By', `${plainText(interaction.user.tag, 80)} (\`${interaction.user.id}\`)`),
                    formatLogLine('Channel', `<#${interaction.channelId}>`),
                ],
                // The reason is the member's own text: shown as written, unable to format itself or hide a link.
                blockFields: [{ name: 'Reason', value: plainText(reason, 1000) }],
                author: await resolveUserAuthor(client, targetUser.id),
                thumbnail: targetUser.displayAvatarURL(),
            },
        });

        // logEvent answers with the posted message, or null when it posted nothing: logging or
        // this event switched off, the channel gone, a permission missing, Discord refusing.
        if (!sent) {
            logger.warn('Report was not delivered', { userId: interaction.user.id, reportedUserId: targetUser.id, guildId, reportChannelId });
            return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: NOT_DELIVERED });
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: 'Report Submitted',
                description: `Your report against **${plainText(targetUser.tag, 80)}** has been sent to the moderation team. Thank you!`,
            })],
        });

        logger.info('Report submitted', {
            userId: interaction.user.id,
            reportedUserId: targetUser.id,
            guildId,
            reasonLength: reason.length,
        });
    },
};
