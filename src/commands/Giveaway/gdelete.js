import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { ZentixBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { getGuildGiveaways, deleteGiveaway } from '../../utils/giveaways.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import {isPostgresGiveawayBackend} from '../../services/storage/postgresGiveawayTransactions.js';
import {isSQLiteGiveawayBackend} from '../../services/storage/sqliteGiveaways.js';
import { deletePostgresGiveaway } from '../../services/postgresGiveawayManagement.js';

/** What to tell the moderator for each outcome; every text says what was changed. */
const POSTGRES_DELETE_ERRORS = {
    GIVEAWAY_MISSING: 'No giveaway was found with that message ID. Nothing was deleted.',
    GIVEAWAY_IN_PROGRESS: 'A result delivery for this giveaway may still be running. Wait two minutes and try again. Nothing was deleted.',
    GIVEAWAY_DISCORD_UNVERIFIED: 'The giveaway message could not be checked or deleted by the bot. Nothing was deleted. If the message is unreachable, remove the record from the dashboard.',
    GIVEAWAY_DELETE_UNFINISHED: 'Deletion is not finished: the record is marked for deletion and still exists. Check the channel, then run the command again.',
    GIVEAWAY_INVALID: 'The stored giveaway data needs review. Nothing was deleted.',
    GIVEAWAY_LEGACY: 'Legacy giveaway data needs review. Nothing was deleted.',
};

async function deleteOnPostgres(interaction) {
    if (!await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral })) {
        throw new ZentixBotError('Interaction not acknowledged', ErrorTypes.DATABASE, 'Could not acknowledge the Discord interaction. Nothing was deleted.');
    }
    const messageId = interaction.options.getString('messageid');
    if (!messageId || !/^\d{17,20}$/.test(messageId)) {
        throw new ZentixBotError('Invalid message ID format', ErrorTypes.VALIDATION, 'Please provide a valid message ID.', { providedId: messageId });
    }

    let result;
    try {
        result = await deletePostgresGiveaway(interaction.client, interaction.guildId, messageId, interaction.user.id);
    } catch (error) {
        const text = POSTGRES_DELETE_ERRORS[error.code]
            ?? 'The outcome is unknown. Check the channel and the dashboard list before trying again.';
        throw new ZentixBotError(`Giveaway deletion failed: ${error.code ?? error.message}`, ErrorTypes.DATABASE, text, { messageId });
    }

    logEvent({
        client: interaction.client,
        guildId: interaction.guildId,
        eventType: EVENT_TYPES.GIVEAWAY_DELETE,
        data: {
            description: `Giveaway deleted: ${result.prize}`,
            channelId: result.channelId,
            userId: interaction.user.id,
            fields: [
                { name: 'Prize', value: result.prize || 'Unknown', inline: true },
                { name: 'Entries', value: String(result.entries), inline: true },
            ],
        },
    }).catch((logError) => logger.debug('Error logging giveaway deletion:', logError));

    const messageText = result.discord === 'deleted'
        ? 'Its message was deleted.'
        : 'Its message was already gone.';
    const resultText = result.winners > 0
        ? `It already had ${result.winners} winner(s); the winner announcement was left in the channel.`
        : result.ended ? 'It had ended without winners.' : 'No winner was picked.';
    return InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('Giveaway Deleted', `Deleted the giveaway for **${result.prize}** and its ${result.entries} stored entries. ${messageText} ${resultText}`)],
        flags: MessageFlags.Ephemeral,
    });
}
export default {
    data: new SlashCommandBuilder()
        .setName("gdelete")
        .setDescription(
            "Deletes a giveaway message and removes it from the database.",
        )
        .addStringOption((option) =>
            option
                .setName("messageid")
                .setDescription("The message ID of the giveaway to delete.")
                .setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            throw new ZentixBotError(
                'Giveaway command used outside guild',
                ErrorTypes.VALIDATION,
                'This command can only be used in a server.',
                { userId: interaction.user.id }
            );
        }

        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            throw new ZentixBotError(
                'User lacks ManageGuild permission',
                ErrorTypes.PERMISSION,
                "You need the 'Manage Server' permission to delete a giveaway.",
                { userId: interaction.user.id, guildId: interaction.guildId }
            );
        }

        if (isPostgresGiveawayBackend(interaction.client)) {
            return deleteOnPostgres(interaction);
        }

        // SQLite: message deletion and storage deletion cannot be coordinated yet.
        // Refuse before either side effect until a recoverable protocol exists.
        if (isSQLiteGiveawayBackend(interaction.client)) throw new ZentixBotError('Persistent giveaway deletion unavailable',ErrorTypes.DATABASE,'Giveaway deletion is temporarily unavailable for persistent storage. No message or data was deleted.');

        logger.info(`Giveaway deletion started by ${interaction.user.tag} in guild ${interaction.guildId}`);

        const messageId = interaction.options.getString("messageid");

        if (!messageId || !/^\d+$/.test(messageId)) {
            throw new ZentixBotError(
                'Invalid message ID format',
                ErrorTypes.VALIDATION,
                'Please provide a valid message ID.',
                { providedId: messageId }
            );
        }

        const giveaways = await getGuildGiveaways(interaction.client, interaction.guildId);
        const giveaway = giveaways.find(g => g.messageId === messageId);

        if (!giveaway) {
            throw new ZentixBotError(
                `Giveaway not found: ${messageId}`,
                ErrorTypes.VALIDATION,
                "No giveaway was found with that message ID.",
                { messageId, guildId: interaction.guildId }
            );
        }

        let deletedMessage = false;
        let channelName = "Unknown Channel";

        const tryDeleteFromChannel = async (channel) => {
            if (!channel || !channel.isTextBased() || !channel.messages?.fetch) {
                return false;
            }

            const message = await channel.messages.fetch(messageId).catch(() => null);
            if (!message) {
                return false;
            }

            await message.delete();
            channelName = channel.name || 'unknown-channel';
            deletedMessage = true;
            return true;
        };

        try {
            const channel = await interaction.client.channels.fetch(giveaway.channelId).catch(() => null);
            if (await tryDeleteFromChannel(channel)) {
                logger.debug(`Deleted giveaway message ${messageId} from channel ${channelName}`);
            }

            if (!deletedMessage && interaction.guild) {
                const textChannels = interaction.guild.channels.cache.filter(
                    ch => ch.id !== giveaway.channelId && ch.isTextBased() && ch.messages?.fetch
                );

                for (const [, guildChannel] of textChannels) {
                    const foundAndDeleted = await tryDeleteFromChannel(guildChannel).catch(() => false);
                    if (foundAndDeleted) {
                        logger.debug(`Deleted giveaway message ${messageId} via fallback lookup in #${channelName}`);
                        break;
                    }
                }
            }
        } catch (error) {
            logger.warn(`Could not delete giveaway message: ${error.message}`);
        }

        const removedFromDatabase = await deleteGiveaway(
            interaction.client,
            interaction.guildId,
            messageId,
        );

        if (!removedFromDatabase) {
            throw new ZentixBotError(
                `Failed to delete giveaway from database: ${messageId}`,
                ErrorTypes.UNKNOWN,
                'The giveaway could not be removed from the database. Please try again.',
                { messageId, guildId: interaction.guildId }
            );
        }

        const giveawaysAfterDelete = await getGuildGiveaways(interaction.client, interaction.guildId);
        const stillExistsInDatabase = giveawaysAfterDelete.some(g => g.messageId === messageId);

        if (stillExistsInDatabase) {
            throw new ZentixBotError(
                `Giveaway still exists after deletion: ${messageId}`,
                ErrorTypes.UNKNOWN,
                'Deletion did not persist in the database. Please try again.',
                { messageId, guildId: interaction.guildId }
            );
        }

        const statusMsg = deletedMessage
            ? `and the message was deleted from #${channelName}`
            : `but the message was already deleted or the channel was inaccessible.`;

        const winnerIds = Array.isArray(giveaway.winnerIds) ? giveaway.winnerIds : [];
        const hasWinners = winnerIds.length > 0;
        const wasEnded = giveaway.ended === true || giveaway.isEnded === true || hasWinners;

        const winnerStatusMsg = hasWinners
            ? `This giveaway already had ${winnerIds.length} winner(s) selected.`
            : wasEnded
                ? 'This giveaway was ended with no valid winners.'
                : 'No winner was picked before deletion.';

        logger.info(`Giveaway deleted: ${messageId} in ${channelName}`);

        try {
            await logEvent({
                client: interaction.client,
                guildId: interaction.guildId,
                eventType: EVENT_TYPES.GIVEAWAY_DELETE,
                data: {
                    description: `Giveaway deleted: ${giveaway.prize}`,
                    channelId: giveaway.channelId,
                    userId: interaction.user.id,
                    fields: [
                        {
                            name: 'Prize',
                            value: giveaway.prize || 'Unknown',
                            inline: true
                        },
                        {
                            name: 'Entries',
                            value: (giveaway.participants?.length || 0).toString(),
                            inline: true
                        }
                    ]
                }
            });
        } catch (logError) {
            logger.debug('Error logging giveaway deletion:', logError);
        }

        return InteractionHelper.safeReply(interaction, {
            embeds: [
                successEmbed(
                    "Giveaway Deleted",
                    `Successfully deleted the giveaway for **${giveaway.prize}** ${statusMsg}. ${winnerStatusMsg}`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};