import { randomInt } from 'node:crypto';
import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { plainText } from '../../services/searchLookup.js';

const SNOWFLAKE = /^\d{17,20}$/;
const ROLES_SHOWN = 5;

/** Members the bot knows of that match: bots only when asked for, and holders of `roleId` when one is given. */
export function candidates(guild, { roleId = null, includeBots = false } = {}) {
    return [...guild.members.cache.values()].filter((member) => {
        if (member.user?.bot && !includeBots) return false;
        if (roleId && !member.roles?.cache?.has?.(roleId)) return false;
        return true;
    });
}

/**
 * The answer for one draw, or null when nobody matches. The button carries who asked and the
 * filters, so "Pick Another User" needs nothing kept in memory. `pick(n)` is for tests.
 */
export function drawPayload(guild, ownerId, { roleId = null, includeBots = false, mention = false }, pick = randomInt) {
    const pool = candidates(guild, { roleId, includeBots });
    if (pool.length === 0) return null;
    const member = pool[pick(pool.length)];
    const user = member.user;
    const roles = [...(member.roles?.cache?.values?.() ?? [])]
        .filter((role) => role.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map((role) => `<@&${role.id}>`);
    const shownRoles = roles.length === 0
        ? 'No roles'
        : roles.slice(0, ROLES_SHOWN).join(' ') + (roles.length > ROLES_SHOWN ? ` and ${roles.length - ROLES_SHOWN} more` : '');
    const known = guild.members.cache.size;
    const partial = Number.isInteger(guild.memberCount) && guild.memberCount > known;
    const drawnFrom = partial
        ? `Drawn from ${pool.length} matching of the ${known} members I currently know of (the server has ${guild.memberCount}).`
        : `Drawn from ${pool.length} matching member(s).`;

    const embed = createEmbed({
        title: 'Random User Selected',
        description: `${mention ? `<@${user.id}>` : `**${plainText(user.username, 80)}**`}\n\n${drawnFrom}`,
        fields: [
            { name: 'Username', value: plainText(user.username, 80) || 'Unknown', inline: true },
            { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true },
            { name: `Roles (${roles.length})`, value: shownRoles, inline: false },
        ],
        color: 'primary',
    });
    const avatar = user.displayAvatarURL?.({ size: 256 });
    if (avatar) embed.setThumbnail(avatar);

    const flags = (includeBots ? 1 : 0) | (mention ? 2 : 0);
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`randomuser:again:${ownerId}:${roleId ?? '0'}:${flags}`)
            .setLabel('Pick Another User')
            .setStyle(ButtonStyle.Primary),
    );
    return {
        content: mention ? `<@${user.id}>, you've been chosen!` : null,
        embeds: [embed],
        components: [row],
        allowedMentions: { parse: [], users: mention ? [user.id] : [] },
    };
}

const nobody = (interaction, guild, roleId) => replyUserError(interaction, {
    type: ErrorTypes.USER_INPUT,
    message: roleId && guild.roles?.cache?.has?.(roleId)
        ? `Nobody I know of has the role <@&${roleId}> (bots are left out unless you ask for them).`
        : 'I could not find any member matching your filters.',
});

/** `randomuser:again:<ownerId>:<roleId|0>:<flags>` */
export async function randomUserButton(interaction, client, args) {
    const [action, ownerId, role, flagText] = args;
    const flags = /^[0-3]$/.test(flagText ?? '') ? Number(flagText) : null;
    if (action !== 'again' || !SNOWFLAKE.test(ownerId ?? '') || flags === null || !(role === '0' || SNOWFLAKE.test(role ?? '')) || !interaction.guild) {
        return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'This button is no longer valid. Use `/randomuser` again.' });
    }
    if (interaction.user.id !== ownerId) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Only the member who ran this command can pick again. Use `/randomuser` for your own draw.' });
    }
    const roleId = role === '0' ? null : role;
    const payload = drawPayload(interaction.guild, ownerId, { roleId, includeBots: (flags & 1) === 1, mention: (flags & 2) === 2 });
    if (!payload) return nobody(interaction, interaction.guild, roleId);
    await interaction.update(payload);
}

export default {
    data: new SlashCommandBuilder()
        .setName('randomuser')
        .setDescription('Select a random user from the server')
        .addRoleOption((option) =>
            option.setName('role')
                .setDescription('Limit selection to users with this role')
                .setRequired(false))
        .addBooleanOption((option) =>
            option.setName('bots')
                .setDescription('Include bots in the selection (default: false)')
                .setRequired(false))
        .addBooleanOption((option) =>
            option.setName('mention')
                .setDescription('Mention the selected user (default: false)')
                .setRequired(false))
        .setDMPermission(false),

    async execute(interaction) {
        if (!interaction.guild) {
            return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'This command can only be used in a server.' });
        }
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn('RandomUser interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId, commandName: 'randomuser' });
            return;
        }

        const roleId = interaction.options.getRole('role')?.id ?? null;
        const payload = drawPayload(interaction.guild, interaction.user.id, {
            roleId,
            includeBots: interaction.options.getBoolean('bots') === true,
            mention: interaction.options.getBoolean('mention') === true,
        });
        if (!payload) return nobody(interaction, interaction.guild, roleId);
        await InteractionHelper.safeEditReply(interaction, payload);
    },
};
