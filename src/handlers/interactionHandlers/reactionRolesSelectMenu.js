import { EmbedBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { getColor } from '../../config/bot.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';
import { applyMemberChoice, roleReason } from '../../services/reactionRoles/manage.js';

const names = (entries) => entries.map((entry) => (entry.name ? `**${entry.name}**` : `\`${entry.id}\``)).join(', ');

/**
 * What the member is told. The title and colour follow what really happened:
 * success only when every wanted change was made.
 */
export function describeChoice(outcome) {
    const changed = outcome.added.length + outcome.removed.length;
    const problems = outcome.skipped.length + outcome.failed.length;
    const lines = [];
    if (outcome.added.length) lines.push(`✅ **Added:** ${names(outcome.added)}`);
    if (outcome.removed.length) lines.push(`❌ **Removed:** ${names(outcome.removed)}`);
    for (const entry of outcome.skipped) {
        lines.push(`⚠️ **Not changed:** ${entry.name ? `**${entry.name}**` : `\`${entry.id}\``} — ${roleReason(entry.reason)}`);
    }
    for (const entry of outcome.failed) {
        lines.push(`⚠️ **Could not ${entry.wanted ? 'add' : 'remove'}:** **${entry.name}** — Discord refused the change.`);
    }
    if (problems) lines.push('\nPlease tell a server administrator about the roles that could not be changed.');

    let title = '🎭 **Roles updated successfully!**';
    let color = 'success';
    if (!changed && !problems) {
        title = '🎭 **No changes were made to your roles.**';
        color = 'info';
    } else if (changed && problems) {
        title = '🎭 **Some of your roles were updated.**';
        color = 'warning';
    } else if (problems) {
        title = '🎭 **Your roles could not be updated.**';
        color = 'error';
    }
    return { description: [title, '', ...lines].join('\n').trim(), color };
}

export async function handleReactionRolesSelectMenu(interaction, client) {
    try {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) return;

        if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
            throw createError(
                'Reaction role interaction used outside a guild context',
                ErrorTypes.VALIDATION,
                'This reaction role menu can only be used inside a server.',
                { userId: interaction.user.id },
            );
        }

        const member = interaction.member;
        let outcome;
        try {
            outcome = await applyMemberChoice(client, interaction.guild, member, interaction.message.id, interaction.values);
        } catch (error) {
            // The panel may well be active: a database problem is not "no panel".
            logger.error(`[REACTROLES] Could not read panel ${interaction.message.id}:`, error);
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setDescription('❌ Your roles could not be changed right now. Nothing was changed. Please try again in a moment.')
                    .setColor(getColor('error'))],
            });
            return;
        }

        if (!outcome) {
            logger.warn(`Reaction role data not found for message ${interaction.message.id} in guild ${interaction.guildId}`);
            await interaction.editReply({
                embeds: [new EmbedBuilder().setDescription('❌ This reaction role message is no longer active.').setColor(getColor('error'))],
            });
            return;
        }

        const { description, color } = describeChoice(outcome);
        await interaction.editReply({ embeds: [new EmbedBuilder().setDescription(description).setColor(getColor(color)).setTimestamp()] });

        if (outcome.added.length > 0 || outcome.removed.length > 0) {
            try {
                await logEvent({
                    client,
                    guildId: interaction.guildId,
                    eventType: EVENT_TYPES.REACTION_ROLE_UPDATE,
                    data: {
                        description: `Reaction roles updated for ${member.user.tag}`,
                        userId: member.user.id,
                        channelId: interaction.channelId,
                        fields: [
                            { name: '👤 Member', value: `${member.user.tag} (${member.user.id})`, inline: false },
                            ...(outcome.added.length ? [{ name: '✅ Roles Added', value: outcome.added.map((entry) => entry.name).join(', ').slice(0, 1024), inline: false }] : []),
                            ...(outcome.removed.length ? [{ name: '❌ Roles Removed', value: outcome.removed.map((entry) => entry.name).join(', ').slice(0, 1024), inline: false }] : []),
                        ],
                    },
                });
            } catch (logError) {
                logger.warn('Failed to log reaction role update:', logError);
            }
        }

        logger.info(`Reaction roles for ${member.user.tag}: +${outcome.added.length}, -${outcome.removed.length}, skipped ${outcome.skipped.length}, failed ${outcome.failed.length}`);
    } catch (error) {
        await handleInteractionError(interaction, error, { type: 'select_menu', customId: 'reaction_roles' });
    }
}
