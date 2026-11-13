import { ChannelType, MessageFlags, PermissionsBitField } from 'discord.js';
import { successEmbed, warningEmbed } from '../../../utils/embeds.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { EVENT_TYPES, isEventEnabled, setLogChannel } from '../../../services/loggingService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { REPORT_CHANNEL_PERMISSIONS } from './report.js';

const NOT_SAVED = 'Could not save the channel configuration. Look at `/logging dashboard` to see which report channel is set before trying again.';

export default {
    async execute(interaction, config, client) {
        if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Server** permissions to set the report channel.' });
        }

        const channel = interaction.options.getChannel('channel');
        const guildId = interaction.guildId;

        // Saving talks to the database; that can take longer than Discord waits for a first answer.
        if (!(await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral }))) {
            logger.warn('Report setchannel interaction defer failed', { userId: interaction.user.id, guildId });
            return;
        }

        // Reports are only ever posted to an ordinary text channel.
        if (!channel || channel.type !== ChannelType.GuildText) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Please choose a text channel of this server.' });
        }

        // A channel the bot cannot post in would swallow every report.
        const me = interaction.guild?.members?.me ?? await interaction.guild?.members?.fetchMe?.().catch(() => null);
        const permissions = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
        const missing = REPORT_CHANNEL_PERMISSIONS.filter(([flag]) => !permissions?.has(flag)).map(([, name]) => `**${name}**`);
        if (missing.length > 0) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: `I cannot post reports in ${channel}: I am missing ${missing.join(', ')} there. The report channel was **not** changed.` });
        }

        let saved;
        try {
            // setLogChannel answers `false` when the save failed; it does not throw.
            saved = await setLogChannel(client, guildId, 'reports', channel.id);
        } catch (error) {
            logger.error('report_setchannel error:', error);
            saved = false;
        }
        if (saved !== true) {
            return await replyUserError(interaction, { type: ErrorTypes.DATABASE, message: NOT_SAVED });
        }

        // The channel is stored. Whether reports are switched on is a second setting; when it
        // cannot be read right now, the answer says only what is known.
        const current = await getGuildConfig(client, guildId).catch(() => null);
        if (current && !isEventEnabled(current, EVENT_TYPES.REPORT_FILE)) {
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [warningEmbed(
                    'Report Channel Set, Reports Still Off',
                    `The report channel is now ${channel}, but user reports are switched off in the logging settings, so nothing will arrive yet.\nSwitch them on in \`/logging dashboard\`.`,
                )],
            });
        }

        return await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(
                'Report Channel Set',
                `All new reports will now be sent to ${channel}.\nYou can also manage this from \`/logging dashboard\`.`,
            )],
        });
    },
};
