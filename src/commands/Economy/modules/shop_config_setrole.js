import { PermissionsBitField } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { getGuildConfig, setGuildConfig } from '../../../services/config/guildConfig.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';
import { checkPremiumRole } from '../../../services/economy/premiumRole.js';

import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
export default {
    async execute(interaction, config, client) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Server** permissions to set the premium role.' });
        }

        const role = interaction.options.getRole('role');
        const guildId = interaction.guildId;

        // The bot hands this role to whoever pays for it, so it must be a role
        // the bot can give and one that grants no server control.
        const verdict = checkPremiumRole(interaction.guild, role);
        if (!verdict.ok) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: `${role?.toString?.() ?? 'That role'} cannot be the premium role. ${verdict.message}`,
            });
        }

        try {
            const currentConfig = await getGuildConfig(client, guildId);
            currentConfig.premiumRoleId = role.id;
            await setGuildConfig(client, guildId, currentConfig);

            return InteractionHelper.safeReply(interaction, {
                embeds: [successEmbed('Premium Role Set', `The **Premium Shop Role** has been set to ${role.toString()}. Members who purchase the Premium Role item will be granted this role.`)],
                ephemeral: true,
            });
        } catch (error) {
            logger.error('shop_config_setrole error:', error);
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not save the guild configuration.' });
        }
    },
};