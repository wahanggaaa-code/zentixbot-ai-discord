import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { plainText } from '../../services/searchLookup.js';

const NEEDED = 'I need the **View Channel** and **Read Message History** permissions in this channel to find its first message.';
// Missing Access, Missing Permissions.
const PERMISSION_CODES = new Set([50001, 50013]);

export default {
    data: new SlashCommandBuilder()
        .setName("firstmsg")
        .setDescription("Get a link to the first message in this channel")
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),
    category: "Utility",

    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`FirstMsg interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'firstmsg'
            });
            return;
        }

        const channel = interaction.channel;
        if (!channel || typeof channel.messages?.fetch !== 'function') {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: NEEDED });
        }

        const me = interaction.guild?.members?.me;
        const permissions = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
        if (permissions && !permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: NEEDED });
        }

        let messages;
        try {
            messages = await channel.messages.fetch({ limit: 1, after: '1', cache: false });
        } catch (error) {
            logger.warn(`FirstMsg could not read the channel: ${error.message}`, { channelId: interaction.channelId, guildId: interaction.guildId, code: error.code });
            if (PERMISSION_CODES.has(error.code)) {
                return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: NEEDED });
            }
            return await replyUserError(interaction, { type: ErrorTypes.DISCORD_API, message: 'Discord did not return the messages of this channel. Please try again later.' });
        }

        const firstMessage = messages.first();

        if (!firstMessage) {
            logger.info(`FirstMsg - no messages found in channel`, {
                userId: interaction.user.id,
                channelId: interaction.channelId,
                guildId: interaction.guildId
            });
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed('First Message', "No messages found in this channel!")],
            });
        }

        const messageLink = `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${firstMessage.id}`;

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    `First Message in #${plainText(String(channel.name ?? 'this channel'), 100)}`,
                    `Message Link: ${messageLink}`
                ),
            ],
        });

        logger.info(`FirstMsg command executed`, {
            userId: interaction.user.id,
            channelId: interaction.channelId,
            messageId: firstMessage.id,
            guildId: interaction.guildId
        });
    },
};
